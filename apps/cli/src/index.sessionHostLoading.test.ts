import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

it.skipIf(process.platform === 'win32')('publishes session-host READY before loading the runner command registry', async () => {
  const repo = resolve(import.meta.dirname, '../../..');
  const entrypoint = resolve(repo, 'apps/cli/src/index.ts');
  await withTempDir('happier-session-host-loading-', async (home) => {
    const script = `
      import { writeSync } from 'node:fs';
      import { registerHooks } from 'node:module';
      let dispatchLoaded = false;
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/cli/dispatch.ts')) dispatchLoaded = true;
        return next(url, context);
      }});
      const write = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk, ...args) => {
        if (String(chunk).startsWith('happier-session-host-ready ')) {
          writeSync(2, 'dispatchLoadedAtReady=' + dispatchLoaded + '\\n');
          setImmediate(() => process.kill(process.pid, 'SIGTERM'));
        }
        return write(chunk, ...args);
      };
      process.argv = [process.execPath, ${JSON.stringify(entrypoint)}, 'session-host'];
      await import(${JSON.stringify(pathToFileURL(entrypoint).href)});
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HAPPIER_') && key !== 'NODE_OPTIONS' && key !== 'DEBUG',
    ));
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'),
      '--input-type=module', '-e', script,
    ], { cwd: repo, env: { ...env, HAPPIER_HOME_DIR: home, HAPPIER_SERVER_URL: 'https://session-host.test.invalid',
      HAPPIER_CLI_RUNTIME_DISABLE: '1',
      HAPPIER_CLI_UPDATE_CHECK: '0', TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    expect(stdout).toMatch(/^happier-session-host-ready \d+$/m);
    expect(stderr).toContain('dispatchLoadedAtReady=false\n');
  });
}, 120_000);
