import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { resolveWindowsCommandInvocation } from '../../../packages/cli-common/dist/process/index.js';

import { syncPackageDist } from './syncPackageDist.mjs';

function main() {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { values } = parseArgs({
    options: {
      'dest-dir': { type: 'string' },
    },
    allowPositionals: false,
  });

  const destDir = String(values['dest-dir'] ?? '').trim();
  if (!destDir) {
    throw new Error('--dest-dir is required');
  }

  if (!fs.existsSync(path.join(packageDir, 'dist'))) {
    throw new Error('apps/cli/dist is missing. Run the CLI build before packing.');
  }
  if (!fs.existsSync(path.join(packageDir, 'package-dist'))) {
    syncPackageDist();
  }

  fs.mkdirSync(destDir, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-cli-pack-stage-'));
  const stagePackageDir = path.join(stageDir, 'package');
  fs.cpSync(packageDir, stagePackageDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git${path.sep}`),
  });

  const env = { ...process.env };
  const invocation = resolveWindowsCommandInvocation({
    command: 'npm',
    args: ['pack', '--ignore-scripts', '--json', '--pack-destination', destDir],
    env,
    resolveCommandOnPath: true,
  });
  const raw = execFileSync(invocation.command, invocation.args, {
    cwd: stagePackageDir,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    timeout: 10 * 60_000,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  }).trim();

  process.stdout.write(raw);
  if (!raw.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

main();
