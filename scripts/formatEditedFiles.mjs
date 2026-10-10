import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function editedPaths(payload) {
  if (['Write', 'Edit', 'MultiEdit'].includes(payload.tool_name)) {
    return typeof payload.tool_input?.file_path === 'string'
      ? [payload.tool_input.file_path]
      : [];
  }
  if (payload.tool_name !== 'apply_patch') return [];
  const patch =
    typeof payload.tool_input === 'string'
      ? payload.tool_input
      : payload.tool_input?.command;
  if (typeof patch !== 'string') return [];
  const paths = new Set();
  let previousPath;
  for (const line of patch.split(/\r?\n/)) {
    const file = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (file) {
      previousPath = file[1];
      paths.add(previousPath);
    }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      paths.delete(previousPath);
      paths.add(move[1]);
    }
  }
  return [...paths];
}

function isInsideRoot(path) {
  const within = relative(rootDir, path);
  return (
    within &&
    within !== '..' &&
    !within.startsWith(`..${sep}`) &&
    !isAbsolute(within)
  );
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  const paths = [];
  for (const editedPath of editedPaths(payload)) {
    const path = resolve(payload.cwd ?? rootDir, editedPath);
    if (!isInsideRoot(path)) continue;
    try {
      if (!(await lstat(path)).isFile()) continue;
      if (!isInsideRoot(await realpath(path))) continue;
      paths.push(path);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  if (!paths.length) return;
  await execFileAsync(
    process.execPath,
    [
      join(rootDir, 'node_modules/oxfmt/bin/oxfmt'),
      '--config',
      join(rootDir, '.oxfmtrc.json'),
      '--no-error-on-unmatched-pattern',
      ...new Set(paths),
    ],
    { cwd: rootDir },
  );
}

main().catch((error) => {
  console.error(`[format-on-edit] ${error.message}`);
  process.exitCode = 1;
});
