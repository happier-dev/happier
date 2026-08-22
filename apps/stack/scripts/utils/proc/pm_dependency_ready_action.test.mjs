import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureDepsInstalled } from './pm.mjs';

async function writeYarnInstallStub(binDir) {
  await mkdir(binDir, { recursive: true });
  const yarnPath = join(binDir, 'yarn');
  await writeFile(
    yarnPath,
    [
      '#!/usr/bin/env node',
      "const { mkdirSync, writeFileSync } = require('node:fs');",
      "if (process.env.HAPPIER_SCOPE_LOG) require('node:fs').appendFileSync(process.env.HAPPIER_SCOPE_LOG, `${process.env.HAPPIER_INSTALL_SCOPE || ''}\\n`);",
      "if (process.argv[2] === '--version') {",
      "  process.stdout.write('1.22.22\\n');",
      '  process.exit(0);',
      '}',
      "if (process.argv[2] === 'install') {",
      "  mkdirSync('node_modules', { recursive: true });",
      "  writeFileSync('node_modules/.yarn-integrity', 'fixture\\n');",
      '}',
    ].join('\n') + '\n',
    'utf-8',
  );
  await chmod(yarnPath, 0o755);
}

test('ensureDepsInstalled serializes dependency-ready actions inside the existing refresh lock', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-dependency-ready-action-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const componentDir = join(root, 'apps', 'ui');
  const binDir = join(root, 'bin');
  const dependencyLockPath = join(root, '.project', 'tmp', 'dependency-install.lock');
  const cliLockPath = join(root, '.project', 'tmp', 'cli-dist-build.lock');
  await Promise.all([
    mkdir(componentDir, { recursive: true }),
    mkdir(join(root, 'apps', 'cli'), { recursive: true }),
    mkdir(join(root, 'apps', 'server'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'fixture',
      private: true,
      workspaces: ['apps/*'],
    }) + '\n', 'utf-8'),
    writeFile(join(root, 'yarn.lock'), '# fixture\n', 'utf-8'),
    writeFile(join(root, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/ui"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8'),
    writeFile(join(root, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8'),
  ]);
  await writeYarnInstallStub(binDir);

  const env = {
    ...process.env,
    PATH: [binDir, String(process.env.PATH ?? '')].filter(Boolean).join(delimiter),
    CI: '1',
    HAPPIER_STACK_ENV_FILE: '',
    HAPPIER_STACK_PM_CACHE_BASE_DIR: join(root, 'cache'),
    HAPPIER_SCOPE_LOG: join(root, 'scope.log'),
  };
  const events = [];
  let releaseFirstAction;
  const releaseFirstActionPromise = new Promise((resolve) => {
    releaseFirstAction = resolve;
  });
  let markFirstActionStarted;
  const firstActionStarted = new Promise((resolve) => {
    markFirstActionStarted = resolve;
  });

  const firstEnsure = ensureDepsInstalled(componentDir, 'fixture', {
    quiet: true,
    env,
    onDependenciesReady: async () => {
      assert.equal((await stat(dependencyLockPath)).isFile(), true);
      await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
      events.push('first:action:start');
      markFirstActionStarted();
      await releaseFirstActionPromise;
      events.push('first:action:end');
    },
  });
  await Promise.race([
    firstActionStarted,
    // Remote test lanes can spend more than 500ms scheduling the Yarn stub under
    // machine load. This deadline guards a real deadlock without racing setup.
    delay(5_000).then(() => {
      throw new Error('timed out waiting for the dependency-ready action');
    }),
  ]);

  const secondEnsure = ensureDepsInstalled(componentDir, 'fixture', {
    quiet: true,
    env,
    onDependenciesReady: async () => {
      assert.equal((await stat(dependencyLockPath)).isFile(), true);
      await assert.rejects(() => stat(cliLockPath), { code: 'ENOENT' });
      events.push('second:action');
    },
  });
  await delay(150);
  assert.deepEqual(events, ['first:action:start']);

  releaseFirstAction();
  await Promise.all([firstEnsure, secondEnsure]);
  assert.deepEqual(events, ['first:action:start', 'first:action:end', 'second:action']);
  assert.match(
    await (await import('node:fs/promises')).readFile(join(root, 'scope.log'), 'utf8'),
    /^ui,cli$/m,
    'Stack-managed dependency refresh must not run shared-package or server build postinstalls',
  );
});
