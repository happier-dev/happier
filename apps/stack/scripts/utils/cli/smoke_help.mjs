import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { gethstackRegistry } from './cli_registry.mjs';

function cliRootDir() {
  // scripts/utils/cli/* -> scripts/utils -> scripts -> repo root
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

function runOrThrow(label, args) {
  const root = cliRootDir();
  const bin = join(root, 'bin', 'hstack.mjs');
  const res = spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit', cwd: root, env: process.env });
  if (res.status !== 0) {
    throw new Error(`[smoke_help] failed (${label}): node bin/hstack.mjs ${args.join(' ')}`);
  }
}

function visibleCommands() {
  const { commands } = gethstackRegistry();
  return commands.filter((c) => !c.hidden).map((c) => c.name);
}

async function main() {
  const cmds = visibleCommands();
  for (const c of cmds) {
    runOrThrow(`${c} --help`, [c, '--help']);
  }

  // Also validate delegation path for a few key groups.
  for (const c of ['wt', 'stack', 'srv', 'service', 'tailscale', 'self', 'menubar', 'completion', 'where', 'init', 'uninstall']) {
    runOrThrow(`help ${c}`, ['help', c]);
  }

  process.stdout.write('[smoke_help] ok\n');
}

main().catch((err) => {
  process.stderr.write(String(err?.message ?? err) + '\n');
  process.exit(1);
});
