import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTerminalConnectLinks, buildConfigureServerLinks } from '../dist/links/index.js';

test('buildTerminalConnectLinks adds server param to web + mobile links', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'https://stack.example.test';
  const publicKeyB64Url = 'abcDEF_123-zzz';

  const out = buildTerminalConnectLinks({ webappUrl, serverUrl, publicKeyB64Url });
  assert.equal(
    out.webUrl,
    'https://app.happier.dev/terminal/connect#key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
  );
  assert.equal(
    out.mobileUrl,
    'happier://terminal?key=abcDEF_123-zzz&server=https%3A%2F%2Fstack.example.test',
  );
});

test('buildTerminalConnectLinks carries authenticated pairing context in both links', () => {
  const out = buildTerminalConnectLinks({
    webappUrl: 'https://app.happier.dev',
    serverUrl: 'https://api.happier.dev',
    publicKeyB64Url: 'terminal-key',
    pairing: {
      secretB64Url: 'pairing-secret',
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
    },
  });

  for (const value of [out.webUrl, out.mobileUrl]) {
    assert.match(value, /pairingSecret=pairing-secret/);
    assert.match(value, /createdAt=1000/);
    assert.match(value, /expiresAt=61000/);
  }
});

test('buildTerminalConnectLinks advertises token-only reader support only with authenticated pairing context', () => {
  const paired = buildTerminalConnectLinks({
    webappUrl: 'https://app.happier.dev',
    serverUrl: 'https://api.happier.dev',
    publicKeyB64Url: 'terminal-key',
    pairing: {
      secretB64Url: 'pairing-secret',
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
    },
    supportsTokenOnly: true,
  });
  assert.match(paired.webUrl, /supportsTokenOnly=1/);
  assert.match(paired.mobileUrl, /supportsTokenOnly=1/);

  const unauthenticated = buildTerminalConnectLinks({
    webappUrl: 'https://app.happier.dev',
    serverUrl: 'https://api.happier.dev',
    publicKeyB64Url: 'terminal-key',
    supportsTokenOnly: true,
  });
  assert.doesNotMatch(unauthenticated.webUrl, /supportsTokenOnly/);
  assert.doesNotMatch(unauthenticated.mobileUrl, /supportsTokenOnly/);
});

test('buildConfigureServerLinks encodes server URL', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'https://stack.example.test';

  const out = buildConfigureServerLinks({ webappUrl, serverUrl });
  assert.equal(
    out.webUrl,
    'https://app.happier.dev/?server=https%3A%2F%2Fstack.example.test',
  );
  assert.equal(
    out.mobileUrl,
    'happier://server?url=https%3A%2F%2Fstack.example.test',
  );
});

test('buildTerminalConnectLinks omits loopback server URL from shareable links', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'http://localhost:3010';
  const publicKeyB64Url = 'abcDEF_123-zzz';

  const out = buildTerminalConnectLinks({ webappUrl, serverUrl, publicKeyB64Url });
  assert.equal(
    out.webUrl,
    'https://app.happier.dev/terminal/connect#key=abcDEF_123-zzz',
  );
  assert.equal(
    out.mobileUrl,
    'happier://terminal?key=abcDEF_123-zzz',
  );
});

test('buildTerminalConnectLinks keeps loopback server URL for local web auth links only', () => {
  const webappUrl = 'http://happier-dev-auth.localhost:8082';
  const serverUrl = 'http://localhost:3010';
  const publicKeyB64Url = 'abcDEF_123-zzz';

  const out = buildTerminalConnectLinks({ webappUrl, serverUrl, publicKeyB64Url });
  assert.equal(
    out.webUrl,
    'http://happier-dev-auth.localhost:8082/terminal/connect#key=abcDEF_123-zzz&server=http%3A%2F%2Flocalhost%3A3010',
  );
  assert.equal(
    out.mobileUrl,
    'happier://terminal?key=abcDEF_123-zzz',
  );
});

test('buildTerminalConnectLinks keeps loopback server URL for IPv6 loopback web auth links', () => {
  const webappUrl = 'http://[::1]:8082';
  const serverUrl = 'http://127.0.0.1:3010';
  const publicKeyB64Url = 'abcDEF_123-zzz';

  const out = buildTerminalConnectLinks({ webappUrl, serverUrl, publicKeyB64Url });
  assert.equal(
    out.webUrl,
    'http://[::1]:8082/terminal/connect#key=abcDEF_123-zzz&server=http%3A%2F%2F127.0.0.1%3A3010',
  );
  assert.equal(
    out.mobileUrl,
    'happier://terminal?key=abcDEF_123-zzz',
  );
});

test('buildConfigureServerLinks omits loopback server URL from shareable links', () => {
  const webappUrl = 'https://app.happier.dev';
  const serverUrl = 'http://127.0.0.1:3010';

  const out = buildConfigureServerLinks({ webappUrl, serverUrl });
  assert.equal(out.webUrl, 'https://app.happier.dev');
  assert.equal(out.mobileUrl, 'happier://server');
});

test('buildConfigureServerLinks keeps loopback server URL for local webapp links only', () => {
  const webappUrl = 'http://127.0.0.1:8082';
  const serverUrl = 'http://127.0.0.1:3010';

  const out = buildConfigureServerLinks({ webappUrl, serverUrl });
  assert.equal(out.webUrl, 'http://127.0.0.1:8082/?server=http%3A%2F%2F127.0.0.1%3A3010');
  assert.equal(out.mobileUrl, 'happier://server');
});
