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

const ANALYTICS_ENV_KEYS = [
  'HAPPIER_WEBAPP_POSTHOG_KEY',
  'HAPPIER_WEBAPP_POSTHOG_HOST',
  'HAPPIER_WEBAPP_SENTRY_DSN',
  'HAPPIER_WEBAPP_SENTRY_ENVIRONMENT',
];

function runRuntimeScript(extraEnv) {
  const env = { ...process.env, HAPPIER_WEBAPP_SERVER_URL: '' };
  for (const key of ANALYTICS_ENV_KEYS) delete env[key];
  const source = execFileSync('sh', ['docker/webapp-runtime.sh'], {
    encoding: 'utf8', env: { ...env, ...extraEnv },
  });
  const context = { window: {} };
  vm.runInNewContext(source, context);
  return context.window.__HAPPIER_WEB_RUNTIME_CONFIG__;
}

test('webapp runtime publishes operator analytics and Sentry settings when set', () => {
  const config = runRuntimeScript({
    HAPPIER_WEBAPP_POSTHOG_KEY: 'phc_"key"</script>',
    HAPPIER_WEBAPP_POSTHOG_HOST: 'https://eu.i.posthog.com',
    HAPPIER_WEBAPP_SENTRY_DSN: 'https://public@o0.ingest.sentry.io/1',
    HAPPIER_WEBAPP_SENTRY_ENVIRONMENT: 'production',
  });
  assert.equal(config.posthogKey, 'phc_"key"</script>');
  assert.equal(config.posthogHost, 'https://eu.i.posthog.com');
  assert.equal(config.sentryDsn, 'https://public@o0.ingest.sentry.io/1');
  assert.equal(config.sentryEnvironment, 'production');
});

test('webapp runtime sends no analytics or Sentry settings by default', () => {
  const config = runRuntimeScript({ HAPPIER_WEBAPP_SENTRY_DSN: '' });
  assert.deepEqual(Object.keys(config).sort(), ['serverUrl']);
});
