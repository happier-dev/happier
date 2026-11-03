import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// One policy for Claude and the Codex envelope adapter. This catches literal
// edit targets, not arbitrary programs or dynamically evaluated shell paths.
// The dependency refresh owner can recover escaped edits to existing patches
// only after proving patch-hash-only drift; this prevention policy still applies.
const event = JSON.parse(readFileSync(0, 'utf8') || '{}');
const tool = event.tool_name ?? event.tool;
if (process.env.HAPPIER_DEPENDENCY_APPLIER === '1' || !['Write', 'Edit', 'MultiEdit', 'apply_patch', 'Bash'].includes(tool)) process.exit(0);
const input = event.tool_input ?? event.args ?? {};
const hookRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
let primary = hookRoot;
try {
  primary = dirname(execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: hookRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch { /* Source mirrors without Git retain their checkout-local hook root. */ }
function canonical(path) {
  try { return realpathSync(path); } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}
primary = canonical(primary);
const workspacePath = join(primary, 'pnpm-workspace.yaml');
const cwd = input.cwd ?? event.cwd ?? process.cwd();
function target(path, base = cwd) {
  const absolute = canonical(resolve(base, path));
  if (absolute.startsWith(join(primary, 'patches') + sep)) return 'patch';
  return absolute === workspacePath ? 'workspace' : null;
}
function registrations(text) {
  return /^patchedDependencies:[^\n]*(?:\n(?:[ \t]+[^\n]*|[ \t]*))*/m.exec(text)?.[0].trimEnd() ?? '';
}
function workspaceChanged(edits) {
  let before;
  try { before = readFileSync(workspacePath, 'utf8'); } catch { before = ''; }
  let after = before;
  for (const edit of edits) {
    if (typeof edit.content === 'string') after = edit.content;
    else if (typeof edit.old_string === 'string' && typeof edit.new_string === 'string') {
      after = edit.old_string === '' ? after + edit.new_string : after.replaceAll(edit.old_string, edit.new_string);
    } else return true;
  }
  return registrations(before) !== registrations(after);
}
function patchBlocked(patch, base = cwd) {
  let kind = null;
  let oldLines = [];
  let newLines = [];
  const edits = [];
  const flush = () => {
    // A context-free insertion has no reliable location for this literal guard.
    if (!oldLines.length && newLines.length) edits.push({});
    else if (oldLines.length) edits.push({ old_string: oldLines.join('\n'), new_string: newLines.join('\n') });
    oldLines = []; newLines = [];
  };
  for (const line of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (file) {
      flush();
      if (kind === 'workspace' && file[1] === 'Move to') return true;
      if (kind === 'workspace' && workspaceChanged(edits)) return true;
      edits.length = 0;
      kind = target(file[2], base);
      if (kind === 'patch' || (kind === 'workspace' && file[1] !== 'Update File')) return true;
    } else if (line.startsWith('@@') || line.startsWith('***')) flush();
    else if (kind === 'workspace') {
      if (line.startsWith(' ') || line.startsWith('-')) oldLines.push(line.slice(1));
      if (line.startsWith(' ') || line.startsWith('+')) newLines.push(line.slice(1));
    }
  }
  flush();
  return kind === 'workspace' && workspaceChanged(edits);
}
let blocked = false;
if (tool === 'Bash') {
  const command = input.command ?? '';
  // Follow literal cd clauses and output redirections without evaluating shell.
  const words = [...command.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|>>?|[;&|\n]|[^\s;&|<>]+/g)].map(([word]) => word.replace(/^(['"])(.*)\1$/, '$2'));
  let base = cwd;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 'cd' && words[i + 1]) base = resolve(base, words[++i]);
    else if (/^>>?$/.test(words[i]) && words[i + 1] && target(words[++i], base)) blocked = true;
  }
  if (command.includes('*** Begin Patch')) blocked ||= patchBlocked(command, base);
} else if (tool === 'apply_patch') {
  blocked = patchBlocked(typeof input === 'string' ? input : input.patch ?? input.command ?? input.input ?? '');
} else if (typeof input.file_path === 'string') {
  const kind = target(input.file_path);
  blocked = kind === 'patch' || (kind === 'workspace' && workspaceChanged(input.edits ?? [input]));
}
if (blocked) {
  process.stderr.write('BLOCKED: prepare dependency patch changes in an outside worktree and hand the diff to Systemic; only the dependency applier sets HAPPIER_DEPENDENCY_APPLIER=1.\n');
  process.exitCode = 1;
}
