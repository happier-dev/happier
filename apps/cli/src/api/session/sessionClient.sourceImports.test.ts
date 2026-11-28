import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('loads the Session RPC registrar before loading request-only implementations', async () => {
  const root = resolve(import.meta.dirname, '../../../../..');
  const cli = resolve(root, 'apps/cli');
  const script = `
    import { resolve } from 'node:path';
    import { registerHooks } from 'node:module';
    import { pathToFileURL } from 'node:url';

    const loadCli = (path) => import(pathToFileURL(resolve(process.cwd(), 'apps/cli/src', path)).href);
    const loaded = new Set();
    registerHooks({ load(url, context, next) {
      loaded.add(url);
      return next(url, context);
    }});

    const { preloadSessionRunner } = await loadCli('agent/runtime/lifecycle/sessionRunnerPreload.ts');
    await preloadSessionRunner();
    await loadCli('agent/runtime/session/loop/runHostSessionRuntime.ts');
    await loadCli('api/session/sessionClient.ts');

    const saw = name => [...loaded].some(url => url.endsWith('/' + name + '.ts'));
    console.log(JSON.stringify({
      rpcRegistrar: saw('registerSessionClientRuntimeHandlers'),
      executionRunHandlers: saw('registerExecutionRunRpcHandlers'),
      executionRunSnapshot: saw('runnerExecutionRunSnapshot'),
      pluginProjection: saw('plugins/projection/registry/projection/v2'),
      liveSystemTasks: saw('liveSystemTasksRunner'),
      pluginScaffold: saw('plugins/scaffold/scaffold'),
    }));
    process.exit(0);
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--conditions=happier-source',
    '--import', resolve(root, 'packages/cli-common/registerSourceRuntime.mjs'),
    '--input-type=module', '--eval', script,
  ], { cwd: root, env: { ...process.env, TSX_TSCONFIG_PATH: resolve(cli, 'tsconfig.json') } });

  expect(JSON.parse(stdout.trim())).toEqual({
    rpcRegistrar: true,
    executionRunHandlers: true,
    executionRunSnapshot: false,
    pluginProjection: false,
    liveSystemTasks: false,
    pluginScaffold: false,
  });
}, 120_000);
