import test from 'node:test';
import assert from 'node:assert/strict';

import { buildServiceAuthGuidance, isLocalishUrl } from './auth_guidance.mjs';

test('isLocalishUrl treats empty as localish (fail-closed)', () => {
  assert.equal(isLocalishUrl(''), true);
  assert.equal(isLocalishUrl('   '), true);
});

test('isLocalishUrl detects localhost and *.localhost', () => {
  assert.equal(isLocalishUrl('http://localhost:3005'), true);
  assert.equal(isLocalishUrl('http://127.0.0.1:3005'), true);
  assert.equal(isLocalishUrl('http://happy-exp1.localhost:3009'), true);
});

test('isLocalishUrl treats non-local hosts as non-localish', () => {
  assert.equal(isLocalishUrl('https://example.com'), false);
  assert.equal(isLocalishUrl('https://happy-1.tailnet.ts.net'), false);
});

test('buildServiceAuthGuidance emits stack-scoped commands', () => {
  const g = buildServiceAuthGuidance({
    stackName: 'exp1',
    publicServerUrl: 'https://example.com',
    tailscaleServeEnabled: false,
  });
  assert.match(g.headlessCmd, /^hstack stack auth exp1 login\b/);
  assert.match(g.headlessCmd, /--method=mobile/);
  assert.match(g.headlessCmd, /--no-open/);
  assert.match(g.laptopCmd, /^hstack stack auth exp1 login\b/);
  assert.match(g.laptopCmd, /--method=web/);
  assert.match(g.laptopCmd, /--webapp=hosted/);
});

test('buildServiceAuthGuidance warns when public URL is loopback and Tailscale is not enabled', () => {
  const g = buildServiceAuthGuidance({
    stackName: 'main',
    publicServerUrl: 'http://localhost:3005',
    tailscaleServeEnabled: false,
    publicServerUrlSource: 'default',
  });
  assert.equal(g.warnings.length, 1);
  assert.match(g.warnings[0], /Mobile authentication will not work yet/i);
  assert.match(g.warnings[0], /HAPPIER_STACK_SERVER_URL/i);
});

test('buildServiceAuthGuidance does not warn when public URL is non-local', () => {
  const g = buildServiceAuthGuidance({
    stackName: 'main',
    publicServerUrl: 'https://example.com',
    tailscaleServeEnabled: false,
  });
  assert.equal(g.warnings.length, 0);
});

test('buildServiceAuthGuidance does not warn when Tailscale appears to provide public HTTPS', () => {
  const g = buildServiceAuthGuidance({
    stackName: 'main',
    publicServerUrl: 'https://happy-1.tailnet.ts.net',
    tailscaleServeEnabled: true,
    publicServerUrlSource: 'tailscale-serve',
  });
  assert.equal(g.warnings.length, 0);
});
