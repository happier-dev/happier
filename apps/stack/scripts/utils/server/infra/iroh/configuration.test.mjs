import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readRelayProfile, renderRelayConfiguration, resolveRelayRequest, projectRelayEnvironment } from './configuration.mjs';

const repoDir = fileURLToPath(new URL('../../../../../../../', import.meta.url));

test('derives the relay version and forwarding/QAD profile from the deployment owner', async () => {
  const { template, version } = await readRelayProfile(repoDir);
  assert.equal(version, '1.1.0');
  const rendered = renderRelayConfiguration({ template, httpPort: 35501, httpsPort: 35502,
    metricsPort: 35503, certDir: '/tmp/relay certs', tailnetIp: '100.64.0.5' });
  assert.match(rendered, /^enable_relay = true$/mu);
  assert.match(rendered, /^enable_quic_addr_discovery = true$/mu);
  assert.match(rendered, /^access = "everyone"$/mu);
  assert.match(rendered, /^quic_bind_addr = "100.64.0.5:7842"$/mu);
  assert.match(rendered, /^cert_mode = "Manual"$/mu);
  assert.match(rendered, /^https_bind_addr = "127.0.0.1:35502"$/mu);
  assert.doesNotMatch(rendered, /__HAPPIER_|\[limits/u);
});

test('the served TLS URL reaches every runtime environment; opt-out withdraws it', () => {
  const env = { HAPPIER_CANONICAL_SERVER_URL: 'http://home.localhost:3005', UNRELATED: 'keep' };
  const ready = projectRelayEnvironment(env, { status: 'ready', httpsUrl: 'https://host.example.ts.net:8443' });
  assert.equal(ready.HAPPIER_IROH_RELAY_URLS, 'https://host.example.ts.net:8443');
  assert.equal(ready.HAPPIER_IROH_RELAY_POLICY, 'automatic');
  assert.equal(ready.HAPPIER_CANONICAL_SERVER_URL, env.HAPPIER_CANONICAL_SERVER_URL);
  const disabled = projectRelayEnvironment(ready, { status: 'disabled' });
  assert.equal(disabled.HAPPIER_IROH_RELAY_POLICY, 'disabled');
  assert.equal(disabled.HAPPIER_IROH_RELAY_URLS, undefined);
  assert.equal(disabled.UNRELATED, 'keep');
  assert.equal(resolveRelayRequest({ HAPPIER_STACK_IROH_RELAY: '0' }), 'disabled');
  assert.equal(resolveRelayRequest({}), 'managed');
  assert.equal(resolveRelayRequest({ HAPPIER_IROH_RELAY_URLS: 'https://operator-relay.example' }), 'external');
});

