// @happier-test-preparation source
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runNodeCapture as runNode } from '../../testkit/core/run_node_capture.mjs';

test('Stack metadata does not load authenticated readiness or database environment mutation', async () => {
  const result = await runNode(['--import', fileURLToPath(new URL('../../../../../packages/cli-common/registerSourceRuntime.mjs', import.meta.url)),
    '--input-type=module', '-e', `
    import { registerHooks } from 'node:module';
    const readinessLoads = [];
    registerHooks({ load(url, context, next) {
      if (url.endsWith('/home_descriptor_readiness.mjs') || url.endsWith('/apply_runtime_server_database_env.mjs')) readinessLoads.push(url);
      return next(url, context);
    } });
    const server = await import(${JSON.stringify(new URL('./server.mjs', import.meta.url).href)});
    const database = await import(${JSON.stringify(new URL('../../stack/stack_database_identity.mjs', import.meta.url).href)});
    const component = server.getServerComponentName({ env: {}, kv: new Map() });
    console.log(JSON.stringify({ component, provider: database.projectStackDatabaseIdentity({ provider: 'sqlite' }).provider, readinessLoads }));
  `]);
  assert.equal(result.code, 0, result.stderr);
  const observation = JSON.parse(result.stdout);
  assert.equal(observation.component, 'happier-server-light');
  assert.equal(observation.provider, 'sqlite');
  assert.deepEqual(observation.readinessLoads, [], 'metadata commands must not pay for readiness and database mutation schemas');
});
