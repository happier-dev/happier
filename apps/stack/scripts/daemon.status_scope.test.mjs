import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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

test('daemonStatusSummary falls back to stack state without invoking a source CLI wrapper when its dist is missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-daemon-status-source-dist-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cliHomeDir = join(root, 'cli-home');
  const repoDir = join(root, 'repo');
  const cliBin = join(repoDir, 'apps', 'cli', 'bin', 'happier.mjs');
  const wrapperMarkerPath = join(root, 'source-cli-wrapper-invoked');
  await Promise.all([
    mkdir(cliHomeDir, { recursive: true }),
    ...['ui', 'cli', 'server'].map(async (component) => {
      const componentDir = join(repoDir, 'apps', component);
      await mkdir(componentDir, { recursive: true });
      await writeFile(join(componentDir, 'package.json'), '{}\n', 'utf-8');
    }),
  ]);
  await mkdir(join(repoDir, 'apps', 'cli', 'bin'), { recursive: true });
  await writeFile(
    cliBin,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(wrapperMarkerPath)}, 'invoked\\n', 'utf-8');`,
      "console.log('unexpected source CLI wrapper invocation');",
      '',
    ].join('\n'),
    'utf-8',
  );

  const status = await daemonStatusSummary({
    cliBin,
    cliHomeDir,
    internalServerUrl: 'http://127.0.0.1:3010',
    publicServerUrl: 'http://happier-dev.localhost:8082',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      HAPPIER_STACK_REPO_DIR: repoDir,
    },
    stackName: 'qa',
    cliIdentity: 'default',
  });

  assert.match(status, /Fallback status used because CLI dist entrypoint is missing/);
  assert.equal(existsSync(wrapperMarkerPath), false, 'status must not invoke a source CLI wrapper that can trigger a build');
});
