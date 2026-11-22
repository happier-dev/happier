import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseEnv } from 'node:util';

// Real loopback HTTP is the external Dokploy boundary. Never use real credentials.
async function scenario(t, { sourceType = 'docker', failure = '', images, overrides = {},
  env = 'DATABASE_URL=must-not-be-logged\nREDIS_URL=redis://retained\nRUN_MIGRATIONS=0' } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://localhost');
    calls.push({ route: url.pathname, body: body ? JSON.parse(body) : null });
    assert.equal(req.headers['x-api-key'], 'fixture-secret');
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith(failure) && failure) {
      res.writeHead(500).end(JSON.stringify({ secret: 'must-not-be-logged' }));
    } else if (url.pathname.endsWith('application.one')) {
      res.end(JSON.stringify({ sourceType, password: 'must-not-be-logged', env }));
    } else if (url.pathname.endsWith('application.deploy')) res.end();
    else res.end('true');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const child = spawn(process.execPath, [
    'scripts/pipeline/deploy/deploy-hosted-images.mjs', '--images', JSON.stringify(images ?? {
      api: 'ghcr.io/happier-dev/relay-server:0.2.0-preview-abc',
      worker: 'ghcr.io/happier-dev/relay-server:0.2.0-preview-abc',
    }),
  ], { env: { ...process.env, DOKPLOY_API_URL: `http://127.0.0.1:${server.address().port}`,
    DOKPLOY_API_KEY: 'fixture-secret', DOKPLOY_API_APPLICATION_ID: 'api-id',
    DOKPLOY_WORKER_APPLICATION_ID: 'worker-id', DOKPLOY_UI_APPLICATION_ID: 'ui-id',
    DOKPLOY_UI_SERVER_URL: 'https://api.example.test', ...overrides }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.doesNotMatch(output, /fixture-secret|must-not-be-logged/);
  return { calls, code, output };
}

test('deploys API and worker exact images while retaining Dokploy registry credentials', async (t) => {
  const { calls, code, output } = await scenario(t);
  assert.equal(code, 0, output);
  const updates = calls.filter((call) => call.route.endsWith('application.update')).map((call) => call.body);
  assert.equal(updates.length, 2);
  for (const [index, role] of ['api', 'worker'].entries()) {
    assert.equal(updates[index].dockerImage, 'ghcr.io/happier-dev/relay-server:0.2.0-preview-abc');
    assert.match(updates[index].env, /DATABASE_URL=must-not-be-logged/);
    assert.match(updates[index].env, /RUN_MIGRATIONS=0/);
    const env = parseEnv(updates[index].env);
    assert.equal(env.HAPPIER_SERVER_FLAVOR, 'full');
    assert.equal(env.HAPPIER_DB_PROVIDER, 'postgres');
    assert.equal(env.HAPPIER_SERVER_UI_REQUIRED, '0');
    assert.equal(env.SERVER_ROLE, role);
  }
  assert.deepEqual(calls.filter((call) => call.route.endsWith('application.deploy')).map((call) => call.body.applicationId), ['api-id', 'worker-id']);
});

test('an unmigrated Git source refuses deployment before any write', async (t) => {
  const { calls, code } = await scenario(t, { sourceType: 'github' });
  assert.notEqual(code, 0);
  assert.ok(calls.length > 0);
  assert.ok(calls.every((call) => call.body === null));
});

test('redeployment preserves env added after a previous runtime override block', async (t) => {
  const env = 'DATABASE_URL=must-not-be-logged\n# Happier image runtime configuration\nSERVER_ROLE=old\n# End Happier image runtime configuration\nADDED_LATER=retained\n';
  const result = await scenario(t, { env });
  assert.equal(result.code, 0, result.output);
  for (const call of result.calls.filter((call) => call.route.endsWith('application.update'))) {
    assert.equal(parseEnv(call.body.env).ADDED_LATER, 'retained');
    assert.equal(call.body.env.split('# Happier image runtime configuration').length, 2);
  }
});

test('UI uses the public generic webapp image and runtime server URL', async (t) => {
  const result = await scenario(t, { images: { ui: 'ghcr.io/happier-dev/webapp:0.2.0-preview-abc' } });
  assert.equal(result.code, 0, result.output);
  const update = result.calls.find((call) => call.route.endsWith('application.update')).body;
  assert.equal(update.applicationId, 'ui-id');
  assert.equal(parseEnv(update.env).HAPPIER_WEBAPP_SERVER_URL, 'https://api.example.test');
  assert.equal(parseEnv(update.env).DATABASE_URL, 'must-not-be-logged');
});

test('an image update failure stops before triggering deployment and redacts response bodies', async (t) => {
  const { calls, code, output } = await scenario(t, { failure: 'application.update' });
  assert.notEqual(code, 0);
  assert.match(output, /500/);
  assert.ok(!calls.some((call) => call.route.endsWith('application.deploy')));
});

test('manual rollback deploys API before worker regardless of JSON key order', async (t) => {
  const result = await scenario(t, { images: {
    worker: 'ghcr.io/happier-dev/relay-server:0.2.0-preview-abc',
    api: 'ghcr.io/happier-dev/relay-server:0.2.0-preview-abc',
  } });
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.calls.filter((call) => call.route.endsWith('application.deploy')).map((call) => call.body.applicationId), ['api-id', 'worker-id']);
});

test('missing operator credentials fails visibly before any request', async (t) => {
  const result = await scenario(t, { overrides: { DOKPLOY_API_KEY: '' } });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /DOKPLOY_API_KEY/);
  assert.deepEqual(result.calls, []);
});

test('missing target UI URL fails before writing application configuration', async (t) => {
  const result = await scenario(t, { images: { ui: 'ghcr.io/happier-dev/webapp:0.2.0-preview-abc' },
    overrides: { DOKPLOY_UI_SERVER_URL: '' } });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /DOKPLOY_UI_SERVER_URL/);
  assert.ok(result.calls.every((call) => call.body === null));
});

const unconfigured = { DOKPLOY_API_URL: '', DOKPLOY_API_KEY: '', DOKPLOY_API_APPLICATION_ID: '', DOKPLOY_WORKER_APPLICATION_ID: '', DOKPLOY_UI_APPLICATION_ID: '' };

test('a non-production environment without hosted applications skips deployment like the webhook path', async (t) => {
  const { calls, code, output } = await scenario(t, { overrides: { ...unconfigured, DEPLOY_ENVIRONMENT: 'preview' } });
  assert.equal(code, 0, output);
  assert.equal(calls.length, 0);
  assert.match(output, /::notice::/);
});

test('production without hosted applications still fails instead of silently skipping', async (t) => {
  for (const environment of ['production', undefined]) {
    const overrides = { ...unconfigured, ...(environment ? { DEPLOY_ENVIRONMENT: environment } : {}) };
    const { calls, code } = await scenario(t, { overrides });
    assert.equal(code, 1);
    assert.equal(calls.length, 0);
  }
});
