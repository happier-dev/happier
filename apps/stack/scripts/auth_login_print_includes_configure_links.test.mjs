import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthStackFixture, getStackRootFromMeta, hstackBinPath, runNodeCapture } from './auth.testHelper.mjs';

const BASE_ENV_LINES = [
  'HAPPIER_STACK_STACK=main',
  'HAPPIER_STACK_SERVER_PORT=4102',
  'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0',
  'HAPPIER_STACK_TAILSCALE_SERVE=0',
];

async function runAuthLoginPrintJson({ rootDir, prefix, stackEnvLines, extraEnv = {}, args = [] }) {
  const fixture = await createAuthStackFixture({
    prefix,
    stackEnvLines,
  });
  try {
    const res = await runNodeCapture(
      [hstackBinPath(rootDir), 'auth', 'login', '--print', '--no-open', '--json', ...args],
      { cwd: rootDir, env: fixture.buildEnv(extraEnv) }
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);
    return JSON.parse(res.stdout.trim());
  } finally {
    await fixture.cleanup();
  }
}

test('hstack auth login --print --json includes configure-server links and public server URL env export', async () => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const parsed = await runAuthLoginPrintJson({
    rootDir,
    prefix: 'hstack-auth-links-',
    stackEnvLines: BASE_ENV_LINES,
  });

  assert.equal(parsed.internalServerUrl, 'http://127.0.0.1:4102');
  assert.equal(parsed.publicServerUrl, 'http://localhost:4102');
  assert.equal(parsed.webappUrl, 'http://localhost:4102');
  assert.match(parsed.cmd, /HAPPIER_PUBLIC_SERVER_URL="http:\/\/localhost:4102"/);

  assert.ok(parsed.configureServer, 'expected configureServer field');
  assert.equal(
    parsed.configureServer.webUrl,
    `http://localhost:4102/?server=${encodeURIComponent('http://localhost:4102')}`
  );
  assert.equal(
    parsed.configureServer.mobileUrl,
    `happier://server?url=${encodeURIComponent('http://localhost:4102')}`
  );
});

test('hstack auth login --print --json webapp precedence variants', async (t) => {
  const rootDir = getStackRootFromMeta(import.meta.url);
  const matrix = [
    {
      name: '--webapp-url overrides computed webappUrl',
      prefix: 'hstack-auth-webapp-url-',
      stackEnvLines: BASE_ENV_LINES,
      args: ['--webapp-url=http://example.test:1234'],
      assertParsed(parsed) {
        assert.equal(parsed.webappUrl, 'http://example.test:1234');
        assert.match(parsed.cmd, /HAPPIER_WEBAPP_URL="http:\/\/example\.test:1234"/);
      },
    },
    {
      name: '--webapp=public overrides stack-env hosted webapp',
      prefix: 'hstack-auth-webapp-public-',
      stackEnvLines: [...BASE_ENV_LINES, 'HAPPIER_WEBAPP_URL=https://app.happier.dev'],
      args: ['--webapp=public'],
      assertParsed(parsed) {
        assert.equal(parsed.webappUrl, 'http://localhost:4102');
      },
    },
    {
      name: 'main stack ignores global HAPPIER_WEBAPP_URL when stack env does not define it',
      prefix: 'hstack-auth-main-webapp-',
      stackEnvLines: ['HAPPIER_STACK_STACK=main', 'HAPPIER_STACK_TAILSCALE_PREFER_PUBLIC_URL=0', 'HAPPIER_STACK_TAILSCALE_SERVE=0'],
      extraEnv: { HAPPIER_WEBAPP_URL: 'https://app.happier.dev' },
      assertParsed(parsed) {
        assert.ok(parsed.webappUrl, 'expected webappUrl in output');
        assert.notEqual(parsed.webappUrl, 'https://app.happier.dev');
      },
    },
  ];

  for (const scenario of matrix) {
    await t.test(scenario.name, async () => {
      const parsed = await runAuthLoginPrintJson({
        rootDir,
        prefix: scenario.prefix,
        stackEnvLines: scenario.stackEnvLines,
        extraEnv: scenario.extraEnv,
        args: scenario.args,
      });
      scenario.assertParsed(parsed);
    });
  }
});
