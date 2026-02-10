import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonStatusSummary } from './daemon.mjs';

test('daemonStatusSummary uses stack-scoped env for status resolution', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-daemon-status-scope-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliHomeDir = join(root, 'cli-home');
  await mkdir(cliHomeDir, { recursive: true });

  const cliBin = join(root, 'happier.mjs');
  await writeFile(
    cliBin,
    [
      "const args = process.argv.slice(2);",
      "if (args[0] === 'daemon' && args[1] === 'status') {",
      "  const scope = process.env.HAPPIER_ACTIVE_SERVER_ID || '';",
      "  console.log(scope === 'stack_dev__id_default' ? 'daemon: running' : 'daemon: stopped');",
      '  process.exit(0);',
      '}',
      'process.exit(0);',
      '',
    ].join('\n'),
    'utf-8'
  );

  const status = await daemonStatusSummary({
    cliBin,
    cliHomeDir,
    internalServerUrl: 'http://127.0.0.1:3010',
    publicServerUrl: 'http://happier-dev.localhost:8082',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
    },
    stackName: 'dev',
    cliIdentity: 'default',
  });

  assert.ok(
    status.includes('daemon: running'),
    `expected daemon status summary to include stack-scoped running status\n${status}`
  );
});
