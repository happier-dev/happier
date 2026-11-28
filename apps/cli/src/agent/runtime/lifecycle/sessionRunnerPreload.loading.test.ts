import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

it('warms the Session runner and loads its attach owner without loading the turn lifecycle', async () => {
  const repo = resolve(import.meta.dirname, '../../../../../..');
  const source = resolve(repo, 'apps/cli/src/agent/runtime');
  const preload = pathToFileURL(resolve(source, 'lifecycle/sessionRunnerPreload.ts'));
  const runtime = pathToFileURL(resolve(source, 'session/loop/runHostSessionRuntime.ts'));
  await withTempDir('happier-session-runner-loading-', async (home) => {
    const script = [
      "import { registerHooks } from 'node:module';",
      'let turnLifecycleLoaded = false;',
      'registerHooks({ load(url, context, next) {',
      "  if (url.endsWith('/agent/runtime/session/loop/lifecycle.ts')) turnLifecycleLoaded = true;",
      '  return next(url, context);',
      '}});',
      'const { preloadSessionRunner } = await import(' + JSON.stringify(preload.href) + ');',
      'await preloadSessionRunner();',
      "console.log('hold: turnLifecycleLoaded=' + turnLifecycleLoaded);",
      'await import(' + JSON.stringify(runtime.href) + ');',
      "console.log('attach: turnLifecycleLoaded=' + turnLifecycleLoaded);",
    ].join('\n');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('HAPPIER_') && key !== 'NODE_OPTIONS' && key !== 'DEBUG',
    ));
    const { stdout } = await promisify(execFile)(process.execPath, [
      '--conditions=happier-source', '--import', resolve(repo, 'packages/cli-common/registerSourceRuntime.mjs'),
      '--input-type=module', '-e', script,
    ], { cwd: repo, env: { ...env, HAPPIER_HOME_DIR: home,
      HAPPIER_SERVER_URL: 'https://runner.test.invalid', TSX_TSCONFIG_PATH: resolve(repo, 'apps/cli/tsconfig.json') } });
    expect(stdout).toContain('hold: turnLifecycleLoaded=false\n');
    expect(stdout).toContain('attach: turnLifecycleLoaded=false\n');
  });
}, 120_000);
