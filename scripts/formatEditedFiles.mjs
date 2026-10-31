import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);

function createdPaths(payload) {
  if (payload.tool_name === 'Write') {
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
  for (const line of patch.split(/\r?\n/)) {
    const file = /^\*\*\* Add File: (.+)$/.exec(line);
    if (file) paths.add(file[1]);
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
  for (const createdPath of createdPaths(payload)) {
    const path = resolve(payload.cwd ?? rootDir, createdPath);
    if (!isInsideRoot(path)) continue;
    try {
      if (!(await lstat(path)).isFile()) continue;
      if (!isInsideRoot(await realpath(path))) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      continue;
    }
    // PostToolUse sees the file after writing; Git owns its tracked status.
    try {
      await execFileAsync(
        'git',
        ['ls-files', '--error-unmatch', '--', relative(rootDir, path)],
        { cwd: rootDir },
      );
      continue;
    } catch (error) {
      if (error.code !== 1) throw error;
    }
    paths.push(path);
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
