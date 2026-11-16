import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Board posts are the only file → lane record lanes keep (CLAIMs and commit
// RESULTs name paths and SHAs). Git gives the write: an uncommitted file's
// writer is the lane that named it by its mtime; a committed line's writer is
// the lane that posted its blamed commit.
export function parseBoardPosts(text) {
  const posts = [];
  for (const chunk of String(text).split(/^(?=### )/m)) {
    const heading = /^### (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC — (.+?) → (.+?) — [A-Z]+ — /.exec(chunk);
    if (!heading) continue;
    const at = Date.parse(`${heading[1]}T${heading[2]}:00Z`);
    if (Number.isFinite(at)) posts.push({ at, from: heading[3].trim(), text: chunk });
  }
  return posts.sort((a, b) => b.at - a.at);
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesPath(text, path) {
  if (text.includes(path)) return true;
  const name = basename(path);
  // Generic basenames (index.ts, package.json) name too many files to attribute.
  if (name.length < 8 || /^(index|package|README)\./.test(name)) return false;
  return new RegExp(`(^|[^\\w./-])${escape(name)}(?![\\w-])`).test(text);
}

function namesCommit(text, sha) {
  for (const [token] of text.matchAll(/\b[0-9a-f]{7,40}\b/g)) if (sha.startsWith(token)) return true;
  return false;
}

async function git(repoDir, args) {
  try { return (await execFileAsync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 1 << 20 })).stdout; }
  catch { return ''; }
}

async function blamedCommit(repoDir, path, line) {
  if (Number.isSafeInteger(line) && line > 0) {
    const sha = /^([0-9a-f]{40}) /.exec(await git(repoDir, ['blame', '--porcelain', '-L', `${line},${line}`, 'HEAD', '--', path]))?.[1];
    if (sha) return sha;
  }
  return /^[0-9a-f]{40}/.exec(await git(repoDir, ['log', '-1', '--format=%H', 'HEAD', '--', path]))?.[0] ?? null;
}

/** The lane that wrote the breaking file, or null when no board post names
 * the write. `files` are the import chain's source files, newest mtime first;
 * `line` is the failing line of `module`. */
export async function attributeBreakLane({ repoDir, board, files, module, line, readBoard = path => readFile(path, 'utf8') }) {
  let text;
  try { text = await readBoard(board); } catch { return null; }
  const posts = parseBoardPosts(text).filter(post => !/^LOAD-SENTINEL/.test(post.from));
  for (const file of files) {
    const dirty = (await git(repoDir, ['status', '--porcelain', '--', file.path])).trim() !== '';
    if (dirty) {
      // A writer names its file before or around the write; later posts are
      // usually other lanes discussing the break.
      const post = posts.find(item => item.at <= file.mtimeMs + 60_000 && namesPath(item.text, file.path));
      if (post) return { lane: post.from, basis: `uncommitted ${file.path}` };
      continue;
    }
    const sha = await blamedCommit(repoDir, file.path, file.path === module ? line : undefined);
    const post = sha && posts.find(item => namesCommit(item.text, sha));
    if (post) return { lane: post.from, basis: `${file.path} at ${sha.slice(0, 11)}` };
  }
  return null;
}
