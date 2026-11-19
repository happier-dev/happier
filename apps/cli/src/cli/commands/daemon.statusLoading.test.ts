import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('reads daemon status from a cold CLI without loading the daemon startup runtime', async () => {
  const repo = resolve(import.meta.dirname, '../../../../..');
  const entry = resolve(repo, 'apps/cli/src/index.ts');
  const privateHome = await mkdtemp(join(tmpdir(), 'happier-daemon-status-loading-'));
  try {
    const script = `
      import { writeSync } from 'node:fs';
      import { registerHooks } from 'node:module';
      let daemonStartupLoads = 0;
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/daemon/startDaemon.ts')) daemonStartupLoads++;
        return next(url, context);
      }});
      process.on('exit', () => writeSync(2, 'daemonStartupLoads=' + daemonStartupLoads + '\\n'));
      process.argv = [process.execPath, ${JSON.stringify(entry)}, 'daemon', 'status', '--json'];
      await import(${JSON.stringify(pathToFileURL(entry).href)});
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HAPPIER_') && key !== 'NODE_OPTIONS' && key !== 'DEBUG',
    ));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'),
      '--input-type=module', '-e', script,
    ], { cwd: repo, env: { ...env, HAPPIER_HOME_DIR: privateHome, HAPPIER_CLI_RUNTIME_DISABLE: '1',
      HAPPIER_CLI_UPDATE_CHECK: '0', TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    expect(JSON.parse(stdout)).toMatchObject({ daemon: { running: false, healthy: false } });
    expect(stderr).toContain('daemonStartupLoads=0\n');
  } finally {
    await rm(privateHome, { recursive: true, force: true });
  }
}, 120_000);
