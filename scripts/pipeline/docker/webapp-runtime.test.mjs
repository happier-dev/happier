import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';

test('webapp runtime URL is serialized safely for the existing browser config consumer', () => {
  const url = 'https://api.example.test/"\\\n</script>';
  const source = execFileSync('sh', ['docker/webapp-runtime.sh'], {
    encoding: 'utf8', env: { ...process.env, HAPPIER_WEBAPP_SERVER_URL: url },
  });
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.equal(context.window.__HAPPIER_WEB_RUNTIME_CONFIG__.serverUrl, url);
});

test('webapp runtime leaves URL selection to existing defaults when unset', () => {
  const source = execFileSync('sh', ['docker/webapp-runtime.sh'], {
    encoding: 'utf8', env: { ...process.env, HAPPIER_WEBAPP_SERVER_URL: '' },
  });
  const context = { window: {} };
  vm.runInNewContext(source, context);
  assert.equal(context.window.__HAPPIER_WEB_RUNTIME_CONFIG__.serverUrl, '');
});
