import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function evaluateStaleWriteGuard(command) {
  // Accidental-command guard, not a shell/Python interpreter. Never execute input.
  // Unrelated calls need no Git lookup or tokenization.
  if (!/\b(?:show|cat-file|archive|checkout-index|read-tree)\b/.test(command)) return '';
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = path.resolve(result.status === 0 ? result.stdout.trim() : process.cwd());
  const within = (base, target) => target === base || target.startsWith(`${base}${path.sep}`);
  const variables = new Map();
  const expand = (word) => word.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, plain) => variables.get(braced ?? plain) ?? ((braced ?? plain) === 'TMPDIR' ? (process.env.TMPDIR || '/tmp') : match));
  const resolve = (word, cwd) => path.resolve(cwd, expand(word));
  const shared = (word, cwd) => {
    const target = resolve(word, cwd);
    return within(root, target) && !within(path.join(root, '.project/tmp'), target);
  };
  const refusal = 'stale Git bytes into shared source: observe RED in an OS-temp copy or a separate git worktree add; never restore older bytes over shared source';

  // The second observed incident did not write worktree bytes: a Python command
  // seeded a private index from a literal old commit, then attached it to fresh HEAD.
  // Match that literal family only; ordinary correctly based private-index CAS stays usable.
  const stalePythonTree = /\[\s*['"]git['"]\s*,\s*['"]read-tree['"]\s*,\s*(?:['"]--reset['"]\s*,\s*)?['"][0-9a-f]{7,40}['"]\s*\]/.test(command)
    && /['"]commit-tree['"]/.test(command)
    && /['"]rev-parse['"]\s*,\s*['"]HEAD['"]/.test(command);
  if (stalePythonTree) {
    return refusal;
  }

  // Preserve mixed quoted words (e.g. :"$p") and shell clause boundaries.
  const tokens = command.match(/(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s'";&|<>])+|&&|\|\||>>|[\n;&|<>]/g) ?? [];
  const unquote = (word) => word.replace(/"((?:\\.|[^"\\])*)"|'([^']*)'/g, (_, double, single) => single ?? double.replace(/\\(["\\$])/g, '$1'));
  let cwd = process.cwd();
  let staleOutput = false;
  const staleFiles = new Set();
  let blocked = false;
  let words = [];
  const processClause = () => {
    const redirects = [];
    const args = [];
    for (let i = 0; i < words.length; i++) {
      if (words[i] === '>' || words[i] === '>>') { if (words[i + 1]) redirects.push(words[++i]); }
      else args.push(words[i]);
    }
    words = [];
    while (['do', 'then'].includes(args[0])) args.shift();
    while (/^[A-Za-z_]\w*=/.test(args[0] ?? '')) {
      const assignment = args.shift();
      const equal = assignment.indexOf('=');
      variables.set(assignment.slice(0, equal), expand(assignment.slice(equal + 1)));
    }
    if (args[0] === 'cd' && args[1]) { cwd = resolve(args[1], cwd); return; }
    let gitCwd = cwd;
    let action;
    let operands = [];
    if (args[0] === 'git') {
      let i = 1;
      while (args[i]?.startsWith('-')) {
        if (args[i] === '-C') { gitCwd = resolve(args[i + 1], gitCwd); i += 2; }
        else if (args[i] === '-c') i += 2;
        else break;
      }
      action = args[i];
      operands = args.slice(i + 1);
    }
    const blob = operands.some((arg) => !arg.startsWith('-') && arg.includes(':'));
    if ((action === 'show' || (action === 'cat-file' && operands.includes('-p'))) && blob) staleOutput = true;
    if (action === 'archive') staleOutput = true;
    if (action === 'checkout-index') {
      const prefix = operands.find((arg) => arg.startsWith('--prefix='))?.slice(9)
        ?? (operands.includes('--prefix') ? operands[operands.indexOf('--prefix') + 1] : undefined);
      // --temp only writes temporary names; --prefix scopes actual checkout writes.
      if (!operands.includes('--temp') && shared(prefix ?? '.', gitCwd)) blocked = true;
    }
    if (staleOutput) {
      for (const target of redirects) {
        if (shared(target, cwd)) blocked = true;
        staleFiles.add(resolve(target, cwd));
      }
      if (args[0] === 'tee') {
        for (const target of args.slice(1).filter((arg) => !arg.startsWith('-'))) {
          if (shared(target, cwd)) blocked = true;
          staleFiles.add(resolve(target, cwd));
        }
      }
      if (args[0] === 'tar' && args.some((arg) => arg === '--extract' || /^-?[A-Za-z]*x[A-Za-z]*$/.test(arg))) {
        const directoryIndex = args.findIndex((arg) => arg === '-C' || arg === '--directory');
        const target = args.find((arg) => arg.startsWith('--directory='))?.slice(12)
          ?? (directoryIndex >= 0 ? args[directoryIndex + 1] : '.');
        if (shared(target, cwd)) blocked = true;
      }
    }
    if (args[0] === 'mv' || args[0] === 'cp') {
      const files = args.slice(1).filter((arg) => !arg.startsWith('-'));
      if (files.length >= 2 && files.slice(0, -1).some((arg) => staleFiles.has(resolve(arg, cwd)))) {
        if (shared(files.at(-1), cwd)) blocked = true;
        staleFiles.add(resolve(files.at(-1), cwd));
      }
    }
  };
  for (const token of [...tokens, ';']) {
    if ([';', '&&', '||', '\n', '|', '&'].includes(token)) {
      processClause();
      if (token !== '|') staleOutput = false;
    } else words.push(unquote(token));
  }
  return blocked ? refusal : '';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(evaluateStaleWriteGuard(readFileSync(0, 'utf8')));
}
