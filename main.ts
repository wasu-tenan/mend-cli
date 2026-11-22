// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in patch order, for the `R` output lines of section 2. */
  readonly moves: { old: string; new: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A file as lines plus its own line break and whether it ends with one (section 3). */
interface FileModel {
  lines: string[];
  br: string;
  fin: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, fin };
}

function serFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

/** Section 5: how a line reads at a tier. */
const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => trailWs(s.replace(/^[ \t]+/, ''));
const normLine = (s: string, tier: number): string => (tier === 0 ? s : tier === 1 ? trailWs(s) : bothWs(s));
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

/** Find O in the file lines: the first tier with an occurrence, and every position there. */
function findTier(fl: string[], O: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const maxT = strict ? 0 : 2;
  for (let tier = 0; tier <= maxT; tier += 1) {
    const pos: number[] = [];
    for (let i = 0; i + O.length <= fl.length; i += 1) {
      let ok = true;
      for (let j = 0; j < O.length; j += 1) {
        if (normLine(fl[i + j]!, tier) !== normLine(O[j]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

/** Tier 2 re-indentation of one new line (section 5). */
function reindent(line: string, F: string, P: string): string {
  if (line === '' || /^[ \t]*$/.test(line)) return line;
  if (line.startsWith(P)) return F + line.slice(P.length);
  return line;
}

/** One body line of a unified hunk or a V4A chunk: context, old, new or a `\` marker. */
interface Entry {
  t: ' ' | '-' | '+' | '\\';
  text: string;
  empty?: boolean;
}

const oldOf = (entries: Entry[]): string[] => entries.filter((e) => e.t === ' ' || e.t === '-').map((e) => e.text);
const newOf = (entries: Entry[]): string[] => entries.filter((e) => e.t === ' ' || e.t === '+').map((e) => e.text);

/** The lines a matched hunk or chunk writes: context from the file, `+` lines as written (re-indented at tier 2). */
function buildOut(fl: string[], pos: number, O: string[], entries: Entry[], tier: number): string[] {
  const F = leadWs(fl[pos]!);
  const P = leadWs(O[0]!);
  const out: string[] = [];
  let oi = 0;
  for (const e of entries) {
    if (e.t === ' ') {
      out.push(fl[pos + oi]!);
      oi += 1;
    } else if (e.t === '-') {
      oi += 1;
    } else if (e.t === '+') {
      out.push(tier === 2 ? reindent(e.text, F, P) : e.text);
    }
  }
  return out;
}

/** Whether a `\` line follows the hunk's last context or `+` line (section 6). */
function lastNewSlash(entries: Entry[]): boolean {
  let idx = -1;
  entries.forEach((e, i) => {
    if (e.t === ' ' || e.t === '+') idx = i;
  });
  return idx >= 0 && entries[idx + 1]?.t === '\\';
}

/** Whether a `\` line follows the last `+` line of a list of hunks (a created file, section 6). */
function lastPlusSlash(hunks: { entries: Entry[] }[]): boolean {
  let slash = false;
  for (const h of hunks) {
    h.entries.forEach((e, i) => {
      if (e.t === '+') slash = h.entries[i + 1]?.t === '\\';
    });
  }
  return slash;
}

interface UHunk {
  A: number;
  entries: Entry[];
}

interface USec {
  diffX: string | null;
  diffY: string | null;
  oldRaw: string | null;
  newRaw: string | null;
  renF: string | null;
  renT: string | null;
  newFile: boolean;
  delFile: boolean;
  pair: boolean;
  header: boolean;
  hunks: UHunk[];
}

const headerPath = (line: string): string => line.slice(4).split('\t')[0]!.trim();
const stripAB = (p: string): string => (p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p);

/** The paths of a `diff --git a/<X> b/<Y>` line, or null when it is not of that form. */
function diffGit(line: string): [string, string] | null {
  const rest = line.slice('diff --git '.length);
  if (!rest.startsWith('a/')) return null;
  const sep = rest.indexOf(' b/');
  if (sep < 0) return null;
  const x = rest.slice(2, sep);
  const y = rest.slice(sep + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

/** Section 6: read a unified diff into one edit per section. */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let hunk: UHunk | null = null;
  const endHunk = (): void => {
    if (hunk !== null) {
      while (hunk.entries.length > 0 && hunk.entries[hunk.entries.length - 1]!.empty) hunk.entries.pop();
      hunk = null;
    }
  };
  const newSec = (): USec => {
    const s: USec = {
      diffX: null, diffY: null, oldRaw: null, newRaw: null, renF: null, renT: null,
      newFile: false, delFile: false, pair: false, header: true, hunks: [],
    };
    secs.push(s);
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = diffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      cur = newSec();
      cur.diffX = dg[0];
      cur.diffY = dg[1];
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && cur.header && !cur.pair && cur.hunks.length === 0) {
        cur.oldRaw = headerPath(line);
        cur.newRaw = headerPath(lines[i + 1]!);
        cur.pair = true;
        i += 1;
        continue;
      }
      endHunk();
      cur = newSec();
      cur.oldRaw = headerPath(line);
      cur.newRaw = headerPath(lines[i + 1]!);
      cur.pair = true;
      i += 1;
      continue;
    }
    if (cur !== null && cur.header && cur.hunks.length === 0 && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[ \t].*)?$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      endHunk();
      cur.header = false;
      hunk = { A: parseInt(m[1]!, 10), entries: [] };
      cur.hunks.push(hunk);
      continue;
    }
    if (hunk !== null) {
      if (line === '') {
        hunk.entries.push({ t: ' ', text: '', empty: true });
        continue;
      }
      const c = line[0]!;
      if (c === ' ' || c === '-' || c === '+' || c === '\\') {
        hunk.entries.push({ t: c as Entry['t'], text: line.slice(1) });
        continue;
      }
      endHunk();
    }
    if (cur !== null && cur.header && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renF = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renT = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      continue;
    }
    // Any other line outside a hunk body is ignored (prose, code fences).
  }
  endHunk();
  const edits: Edit[] = [];
  for (const s of secs) {
    let oldP: string | null;
    let newP: string | null;
    if (s.pair) {
      oldP = stripAB(s.oldRaw!);
      newP = stripAB(s.newRaw!);
    } else if (s.renF !== null || s.renT !== null) {
      oldP = s.renF ?? s.diffX;
      newP = s.renT ?? s.diffY;
    } else {
      oldP = s.diffX;
      newP = s.diffY;
    }
    const isCreate = s.newFile || oldP === '/dev/null';
    const isDelete = s.delFile || newP === '/dev/null';
    edits.push((tree) => applyUnified(tree, s, isCreate, isDelete, oldP, newP, strict));
  }
  return edits;
}

function applyUnified(tree: Tree, s: USec, isCreate: boolean, isDelete: boolean, oldP: string | null, newP: string | null, strict: boolean): void {
  if (isCreate) {
    const p = newP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const outLines: string[] = [];
    for (const h of s.hunks) for (const e of h.entries) if (e.t === '+') outLines.push(e.text);
    const text = outLines.length === 0 ? '' : outLines.join('\n') + (lastPlusSlash(s.hunks) ? '' : '\n');
    tree.now.set(p, text);
    return;
  }
  if (isDelete) {
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const src = oldP!;
  const dst = newP!;
  if (!safe(src)) throw new Fail('unsafe', src);
  if (!safe(dst)) throw new Fail('unsafe', dst);
  const before = tree.get(src);
  if (before === null) throw new Fail('missing', src);
  const isMove = src !== dst;
  if (isMove && tree.get(dst) !== null) throw new Fail('exists', dst);
  const model = parseFile(before);
  const fl = model.lines;
  let fin = model.fin;
  let d = 0;
  for (const h of s.hunks) {
    const O = oldOf(h.entries);
    const N = newOf(h.entries);
    if (O.length > 0) {
      const found = findTier(fl, O, strict);
      if (found === null) throw new Fail('no-match', src);
      const target = h.A - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      const out = buildOut(fl, best, O, h.entries, found.tier);
      const reachesEnd = best + O.length === fl.length;
      fl.splice(best, O.length, ...out);
      if (reachesEnd) fin = !lastNewSlash(h.entries);
    } else {
      const add = h.entries.filter((e) => e.t === '+').map((e) => e.text);
      let at = h.A + d;
      if (at < 0) at = 0;
      if (at > fl.length) at = fl.length;
      const atEnd = at === fl.length;
      fl.splice(at, 0, ...add);
      if (atEnd) fin = !lastNewSlash(h.entries);
    }
    d += N.length - O.length;
  }
  const text = serFile({ lines: fl, br: model.br, fin });
  if (isMove) {
    tree.now.set(src, null);
    tree.now.set(dst, text);
    tree.moves.push({ old: src, new: dst });
  } else {
    tree.now.set(src, text);
  }
}

/** Section 7: read SEARCH/REPLACE blocks into one edit per block. */
function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let p: string | null = null;
    for (let j = searchLine - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      p = l.trim();
      break;
    }
    if (p === null) p = prevPath;
    if (p === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    const oldLines = lines.slice(searchLine + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const path = p;
    edits.push((tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (oldLines.length === 0) {
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path);
      if (before === null) throw new Fail('missing', path);
      const model = parseFile(before);
      const found = findTier(model.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', path);
      if (found.pos.length > 1) throw new Fail('ambiguous', path);
      const pos = found.pos[0]!;
      const F = leadWs(model.lines[pos]!);
      const P = leadWs(oldLines[0]!);
      const out = newLines.map((l) => (found.tier === 2 ? reindent(l, F, P) : l));
      model.lines.splice(pos, oldLines.length, ...out);
      tree.now.set(path, serFile(model));
    });
    prevPath = p;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

interface VSec {
  kind: 'add' | 'del' | 'upd';
  path: string;
  lineNo: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

/** Section 8: read a V4A patch into one edit per section. */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    let kind: VSec['kind'];
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'del';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'upd';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const sec: VSec = { kind, path, lineNo: i + 1, addLines: [], moveTo: null, chunks: [] };
    const content: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last && !isHeader(lines[j]!)) {
      content.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (content.length > 0 && blank(content[content.length - 1]!.text)) content.pop();
    if (kind === 'add') {
      for (const c of content) {
        if (c.text.startsWith('+')) sec.addLines.push(c.text.slice(1));
        else if (c.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${c.no}`);
      }
    } else if (kind === 'del') {
      const bad = content.find((c) => !blank(c.text));
      if (bad !== undefined) throw new Exit2(`error: parse ${bad.no}`);
    } else {
      let rest = content;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = rest[0]!.text.slice(13).trim();
        rest = rest.slice(1);
      }
      let chunk: VChunk | null = null;
      let closed = false;
      for (const c of rest) {
        const l = c.text;
        if (l.startsWith('@@')) {
          const anchor = l.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, eof: false, entries: [] };
          sec.chunks.push(chunk);
          closed = false;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${c.no}`);
          chunk.eof = true;
          closed = true;
          continue;
        }
        const ch = l[0] ?? '';
        if (l === '' || ch === ' ' || ch === '-' || ch === '+') {
          if (chunk === null) {
            if (sec.chunks.length > 0) throw new Exit2(`error: parse ${c.no}`);
            chunk = { anchor: null, eof: false, entries: [] };
            sec.chunks.push(chunk);
            closed = false;
          }
          if (closed) throw new Exit2(`error: parse ${c.no}`);
          chunk.entries.push({ t: l === '' ? ' ' : (ch as Entry['t']), text: l === '' ? '' : l.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${c.no}`);
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.lineNo}`);
    }
    secs.push(sec);
    i = j;
  }
  return secs.map((s) => (tree: Tree) => applyVSec(tree, s, strict));
}

function applyVSec(tree: Tree, s: VSec, strict: boolean): void {
  const p = s.path;
  if (!safe(p)) throw new Fail('unsafe', p);
  if (s.kind === 'add') {
    if (tree.get(p) !== null) throw new Fail('exists', p);
    tree.now.set(p, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
    return;
  }
  if (s.kind === 'del') {
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
  const before = tree.get(p);
  if (before === null) throw new Fail('missing', p);
  if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
  if (s.chunks.length === 0) {
    tree.now.set(p, null);
    tree.now.set(s.moveTo!, before);
    tree.moves.push({ old: p, new: s.moveTo! });
    return;
  }
  const model = parseFile(before);
  const fl = model.lines;
  let cursor = 0;
  for (const chunk of s.chunks) {
    if (chunk.anchor !== null) {
      const maxT = strict ? 0 : 2;
      let foundAt = -1;
      for (let tier = 0; tier <= maxT && foundAt < 0; tier += 1) {
        for (let k = cursor; k < fl.length; k += 1) {
          if (normLine(fl[k]!, tier) === normLine(chunk.anchor, tier)) {
            foundAt = k;
            break;
          }
        }
      }
      if (foundAt < 0) throw new Fail('no-match', p);
      cursor = foundAt + 1;
    }
    const O = oldOf(chunk.entries);
    if (O.length === 0) {
      const add = chunk.entries.filter((e) => e.t === '+').map((e) => e.text);
      const at = chunk.eof ? fl.length : Math.min(cursor, fl.length);
      fl.splice(at, 0, ...add);
      cursor = at + add.length;
    } else {
      const maxT = strict ? 0 : 2;
      let tierFound = -1;
      let pos = -1;
      for (let tier = 0; tier <= maxT; tier += 1) {
        const cands: number[] = [];
        for (let k = cursor; k + O.length <= fl.length; k += 1) {
          let ok = true;
          for (let jj = 0; jj < O.length; jj += 1) {
            if (normLine(fl[k + jj]!, tier) !== normLine(O[jj]!, tier)) {
              ok = false;
              break;
            }
          }
          if (ok) cands.push(k);
        }
        const valid = chunk.eof ? cands.filter((k) => k + O.length === fl.length) : cands;
        if (valid.length > 0) {
          tierFound = tier;
          pos = valid[0]!;
          break;
        }
      }
      if (pos < 0) throw new Fail('no-match', p);
      const out = buildOut(fl, pos, O, chunk.entries, tierFound);
      fl.splice(pos, O.length, ...out);
      cursor = pos + out.length;
    }
  }
  const text = serFile(model);
  if (s.moveTo !== null) {
    tree.now.set(p, null);
    tree.now.set(s.moveTo, text);
    tree.moves.push({ old: p, new: s.moveTo });
  } else {
    tree.now.set(p, text);
  }
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
    path: string;
    kind: string;
  }
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const kind = was === null ? 'A' : now === null ? 'D' : 'M';
    rows.push({ key: p, text: `${kind} ${p}`, path: p, kind });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // A successful move whose old path is gone and new path is new replaces its D and A lines with one R line.
  for (const mv of tree.moves) {
    const di = rows.findIndex((r) => r.path === mv.old && r.kind === 'D');
    const ai = rows.findIndex((r) => r.path === mv.new && r.kind === 'A');
    if (di < 0 || ai < 0) continue;
    rows.splice(Math.max(di, ai), 1);
    rows.splice(Math.min(di, ai), 1);
    rows.push({ key: mv.new, text: `R ${mv.old} -> ${mv.new}`, path: mv.new, kind: 'R' });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
