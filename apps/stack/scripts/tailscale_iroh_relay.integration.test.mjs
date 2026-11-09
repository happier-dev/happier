import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { withPatchedProcessEnv } from './testkit/core/env_scope.mjs';
import { tailscaleServeEnable, tailscaleServeReset } from './tailscale.mjs';

async function fixture(t) {
  const temp = await createTempFixture(t, { prefix: 'iroh-relay-serve-' });
  const configPath = temp.path('serve.json');
  const initial = {
    '443': { '/': 'http://127.0.0.1:3005', '/other': 'http://127.0.0.1:3999' },
    '5432': { tcp: 'tcp://127.0.0.1:5432' },
    '6432': { tcp: 'tcp://127.0.0.1:6432' },
  };
  await writeFile(configPath, JSON.stringify(initial));
  const { binPath } = writeFakeBin({ root: temp.root, name: 'tailscale', content: `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = process.env.RELAY_TEST_SERVE_CONFIG;
let config = JSON.parse(fs.readFileSync(path, 'utf8'));
if (args[0] !== 'serve') process.exit(1);
if (args[1] === 'status') {
  for (const [port, routes] of Object.entries(config)) {
    console.log('https://relay-test.example.ts.net' + (port === '443' ? '' : ':' + port));
    for (const [route, upstream] of Object.entries(routes)) console.log('|-- ' + route + ' proxy ' + upstream);
  }
  process.exit(0);
}
if (args[1] === 'reset') config = {};
else {
  const port = args.find(a => a.startsWith('--https='))?.split('=')[1] || '443';
  const route = args.find(a => a.startsWith('--set-path='))?.split('=')[1] || '/';
  if (args.at(-1) === 'off') {
    if (args.some(a => a.startsWith('--set-path='))) delete config[port]?.[route];
    else delete config[port];
  } else (config[port] ||= {})[route] = args.at(-1);
}
fs.writeFileSync(path, JSON.stringify(config));
` });
  return { initial, configPath, env: { HAPPIER_TAILSCALE_BIN: binPath,
    RELAY_TEST_SERVE_CONFIG: configPath, HAPPIER_STACK_SANDBOX_ALLOW_GLOBAL: '1',
    HAPPIER_STACK_TAILSCALE_UPSTREAM: undefined, HAPPIER_STACK_TAILSCALE_SERVE_PATH: undefined } };
}

test('relay HTTPS add advertises its dedicated TLS URL and preserves Home, database and foreign routes', async t => {
  const { initial, configPath, env } = await fixture(t);
  withPatchedProcessEnv(t, env);
    const served = await tailscaleServeEnable({ internalServerUrl: 'http://127.0.0.1:35550', httpsPort: 8443 });
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    for (const [port, routes] of Object.entries(initial)) assert.deepEqual(config[port], routes);
    assert.equal(served.httpsUrl, 'https://relay-test.example.ts.net:8443');
    assert.equal(config['8443']['/'], 'http://127.0.0.1:35550');
});

test('stack disable removes only its owned route and preserves the relay and database routes', async t => {
  const { initial, configPath, env } = await fixture(t);
  const config = { ...initial, '8443': { '/': 'http://127.0.0.1:35550' } };
  await writeFile(configPath, JSON.stringify(config));
  withPatchedProcessEnv(t, env);
    await tailscaleServeReset({ internalServerUrl: 'http://127.0.0.1:3005' });
    const after = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(after['443']?.['/'], undefined);
    assert.equal(after['443']?.['/other'], initial['443']['/other']);
    for (const port of ['5432', '6432', '8443']) assert.deepEqual(after[port], config[port]);
});

test('relay removal cannot disable a listener whose mapping was replaced by another owner', async t => {
  const { initial, configPath, env } = await fixture(t);
  const config = { ...initial, '8443': { '/': 'http://127.0.0.1:3998' } };
  await writeFile(configPath, JSON.stringify(config));
  withPatchedProcessEnv(t, env);
    await tailscaleServeReset({ internalServerUrl: 'http://127.0.0.1:35550', httpsPort: 8443 });
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')), config);
});
