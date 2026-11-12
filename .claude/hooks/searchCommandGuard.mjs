import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function evaluateSearchCommandGuard(command) {
  const repoRootResult = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const repoRoot = repoRootResult.status === 0 ? repoRootResult.stdout.trim() : process.cwd();
  const root = path.resolve(repoRoot);

  const tokenPattern = /"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||[\n;&|()<>`]|[^\s;&|()<>`]+/g;
  const separators = /^(?:&&|\|\||[\n;&|()<>`])$/;
  const searchCommands = new Set(['rg', 'grep', 'find', 'du']);

  const unquote = (value) => {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
    return value;
  };

  const basename = (value) => path.posix.basename(value.replaceAll('\\', '/'));
  const isRootPath = (value, cwd) => {
    const unquoted = unquote(value);
    if (unquoted === root || unquoted === `${root}/`) return true;
    if (unquoted === '$(git rev-parse --show-toplevel)' || unquoted === '`git rev-parse --show-toplevel`') return true;
    return path.resolve(cwd, unquoted) === root;
  };

  const searchesWholeTree = (paths, cwd) => {
    if (paths.length === 0) return cwd === root;
    if (paths.some((value) => isRootPath(value, cwd))) return true;
    if (paths.some((value) => /^(?:\.\/)?\*(?:\/)?$/.test(value) && cwd === root)) return true;
    if (paths.length < 2) return false;
    // An explicit list of all visible top-level directories is another spelling of a root search.
    const selected = new Set(paths.map((value) => path.resolve(cwd, value)));
    const directories = readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
    return directories.length > 0 && directories.every((entry) => selected.has(path.join(root, entry.name)));
  };

  const patternOptions = new Set(['-e', '--regexp', '-f', '--file']);
  const valueOptions = new Set([
    ...patternOptions, '-g', '--glob', '--iglob', '-t', '--type', '-T', '--type-not',
    '-m', '--max-count', '-A', '--after-context', '-B', '--before-context', '-C', '--context',
    '-j', '--threads', '--encoding', '--color', '--colors', '--sort', '--sortr',
    '--max-depth', '--max-filesize', '--exclude', '--include', '--exclude-dir',
  ]);
  const searchPaths = (args) => {
    const operands = [];
    let hasPattern = false;
    let options = true;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (options && arg === '--') { options = false; continue; }
      if (options && arg.startsWith('-')) {
        const option = arg.split('=')[0];
        if (patternOptions.has(option) || /^-[ef].+/.test(arg)) hasPattern = true;
        if (valueOptions.has(option) && !arg.includes('=')) index++;
        continue;
      }
      operands.push(arg);
    }
    return hasPattern ? operands : operands.slice(1);
  };

  const wordsForCommand = (segment) => segment.filter((token) => !separators.test(token));

  const isSearchOverRoot = (words, cwd) => {
    if (words.length === 0) return false;
    let executableIndex = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex] ?? '')) executableIndex++;
    if (words[executableIndex] === 'command') executableIndex++;
    if (words[executableIndex] === 'env') {
      executableIndex++;
      while (words[executableIndex]?.includes('=') && !words[executableIndex].startsWith('-')) executableIndex++;
    }

    const executable = basename(words[executableIndex] ?? '');
    if (executable === 'hstack-exec') {
      if (words.includes('--local')) {
        const separatorIndex = words.indexOf('--');
        if (separatorIndex === -1) return false;
        return isSearchOverRoot(words.slice(separatorIndex + 1), cwd);
      }
      return false;
    }
    if (!searchCommands.has(executable)) return false;

    const rawArgs = words.slice(executableIndex + 1);
    if (executable === 'grep' && !rawArgs.some((arg) => arg === '--recursive' || /^-[^-]*[rR]/.test(arg))) return false;
    if (executable === 'find') {
      const expressionIndex = rawArgs.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!');
      return searchesWholeTree(expressionIndex === -1 ? rawArgs : rawArgs.slice(0, expressionIndex), cwd);
    }
    if (executable === 'du') return searchesWholeTree(rawArgs.filter((arg) => !arg.startsWith('-')), cwd);
    return searchesWholeTree(searchPaths(rawArgs), cwd);
  };

  const tokens = command.match(tokenPattern) ?? [];
  let segment = [];
  let cwd = process.cwd();
  let redirectTarget = false;
  for (const token of [...tokens, ';']) {
    if (redirectTarget) { redirectTarget = false; continue; }
    if (token === '>' || token === '<') { redirectTarget = true; continue; }
    if (!separators.test(token)) {
      segment.push(unquote(token));
      continue;
    }
    const words = wordsForCommand(segment);
    if (isSearchOverRoot(words, cwd)) {
      return 'repo-wide search on controller';
    }
    if (words[0] === 'cd' && words[1]) {
      const target = unquote(words[1]);
      cwd = target.includes('git rev-parse --show-toplevel') ? root : path.resolve(cwd, target);
    }
    segment = [];
  }
  return '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(evaluateSearchCommandGuard(readFileSync(0, 'utf8')));
}
