// @ts-check

import { execFileSync } from 'node:child_process';

/**
 * Runs the `tauri:prepare:*` yarn script through a platform shell.
 *
 * We intentionally avoid `corepack yarn ...` here because Corepack's internal checks can attempt to
 * `spawn('yarn')` on Windows, which fails when Yarn is only available as `yarn.cmd`.
 *
 * @param {{
 *   mode: 'dev' | 'build';
 *   platform?: NodeJS.Platform;
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   execFileSync?: typeof execFileSync;
 * }} opts
 */
export function runTauriBeforeCommand(opts) {
  const platform = opts.platform ?? process.platform;
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const execImpl = opts.execFileSync ?? execFileSync;

  const mode = opts.mode;
  if (mode !== 'dev' && mode !== 'build') {
    throw new Error(`mode must be 'dev' or 'build' (got: ${String(mode)})`);
  }

  const yarnCmd = `yarn -s tauri:prepare:${mode}`;

  if (platform === 'win32') {
    execImpl('cmd', ['/D', '/S', '/C', yarnCmd], { cwd, env, stdio: 'inherit' });
    return;
  }

  execImpl('bash', ['-lc', yarnCmd], { cwd, env, stdio: 'inherit' });
}

function main() {
  const mode = String(process.argv[2] ?? '').trim();
  if (mode !== 'dev' && mode !== 'build') {
    console.error('Usage: node ./scripts/runTauriBeforeCommand.mjs <dev|build>');
    process.exit(1);
  }

  runTauriBeforeCommand({ mode });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

