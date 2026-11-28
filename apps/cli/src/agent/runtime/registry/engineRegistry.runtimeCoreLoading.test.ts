import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

it('warms the same engine runtime core used by Session adapter resolution without loading Project Run launch', async () => {
  const repo = resolve(import.meta.dirname, '../../../../../..');
  const resolution = pathToFileURL(resolve(repo, 'apps/cli/src/agent/runtime/registry/engineRegistry/resolution.ts'));
  await withTempDir('happier-engine-runtime-loading-', async (home) => {
    const script = `
      import { registerHooks } from 'node:module';
      let projectLaunchLoaded = false;
      registerHooks({ load(url, context, next) {
        if (url.endsWith('/daemon/agentRuntime/runnerAgentProjectLaunch.ts')) projectLaunchLoaded = true;
        return next(url, context);
      }});
      const { preloadEngineRuntimeCore } = await import(${JSON.stringify(resolution.href)});
      await preloadEngineRuntimeCore();
      console.log('projectLaunchLoaded=' + projectLaunchLoaded);
    `;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HAPPIER_') && key !== 'NODE_OPTIONS' && key !== 'DEBUG',
    ));
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'),
      '--input-type=module', '-e', script,
    ], { cwd: repo, env: { ...env, HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: 'https://adapter.test.invalid', TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    expect(stdout).toContain('projectLaunchLoaded=false\n');
  });
}, 120_000);
