import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

const INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'pwsh',
  'powershell',
  'bun',
  'deno',
  'tsx',
]);
// After these flags an interpreter runs inline code or a module name, not a script file operand.
const INLINE_CODE_FLAGS = new Set([
  '-c',
  '-e',
  '-m',
  '-p',
  '-r',
  '--eval',
  '--print',
  '-command',
  '-encodedcommand',
]);
const TOKEN = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

/**
 * Checkout-relative files a literal command line runs directly: each command segment's
 * path-like program and an interpreter's script operand (`bash scripts/setup.sh`,
 * `./setup.sh`, `sh ./x.sh`). This is a lexical scan, not a shell parser: files a
 * script sources or reads are declared through `workspace.setupInputs`. Paths outside
 * the checkout are omitted; the command text already names them.
 */
export function listLiteralCommandExecutedFiles(
  root: string,
  cwd: string,
  command: string,
): string[] {
  const files = new Set<string>();
  const add = (token: string) => {
    const local = relative(root, resolve(cwd, token));
    if (
      local !== '' &&
      local !== '..' &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local)
    )
      files.add(local.replaceAll('\\', '/'));
  };
  for (const segment of command.split(/&&|\|\||[;&|\n]/)) {
    const tokens = [...segment.matchAll(TOKEN)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? '',
    );
    let index = 0;
    while (
      index < tokens.length &&
      /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]!)
    )
      index += 1;
    const program = tokens[index];
    if (program === undefined) continue;
    if (/[\\/]/.test(program)) add(program);
    if (
      !INTERPRETERS.has(
        basename(program.replaceAll('\\', '/'))
          .toLowerCase()
          .replace(/\.exe$/, ''),
      )
    )
      continue;
    for (const operand of tokens.slice(index + 1)) {
      if (INLINE_CODE_FLAGS.has(operand.toLowerCase())) break;
      if (operand.startsWith('-')) continue;
      add(operand);
      break;
    }
  }
  return [...files];
}
