import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDevServerConnection } from './resolveDevServerConnection.mjs';

function makeArgs({ flags = [], kv = {} } = {}) {
  return {
    flags: new Set(flags),
    kv: new Map(Object.entries(kv)),
  };
}

const localUrls = {
  internalServerUrl: 'http://127.0.0.1:3005',
  publicServerUrl: 'http://qa-agent-x.localhost:3005',
  defaultPublicUrl: 'http://localhost:3005',
};

test('uses local server defaults when no remote flags are set', () => {
  const { flags, kv } = makeArgs();
  const out = resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls });
  assert.equal(out.startServer, true);
  assert.equal(out.internalServerUrl, localUrls.internalServerUrl);
  assert.equal(out.publicServerUrl, localUrls.publicServerUrl);
  assert.equal(out.uiApiUrl, localUrls.publicServerUrl);
  assert.equal(out.source, 'local');
  assert.equal(out.publicServerUrlIsExplicit, false);
});

test('uses one LAN-reachable canonical audience for a local mobile stack server and its clients', () => {
  const { flags, kv } = makeArgs();
  const out = resolveDevServerConnection({
    flags,
    kv,
    env: { HAPPIER_STACK_LAN_IP: '192.168.0.50' },
    resolvedLocalUrls: localUrls,
    requireMobileReachability: true,
  });
  assert.equal(out.startServer, true);
  assert.equal(out.internalServerUrl, localUrls.internalServerUrl);
  assert.equal(out.publicServerUrl, 'http://192.168.0.50:3005');
  assert.equal(out.uiApiUrl, 'http://192.168.0.50:3005');
});

test('uses explicit --server-url and disables local server', () => {
  const { flags, kv } = makeArgs({ kv: { '--server-url': 'https://api.example.com/' } });
  const out = resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls });
  assert.equal(out.startServer, false);
  assert.equal(out.internalServerUrl, 'https://api.example.com');
  assert.equal(out.publicServerUrl, 'https://api.example.com');
  assert.equal(out.uiApiUrl, 'https://api.example.com');
  assert.equal(out.source, 'cli-arg');
});

test('keeps the internal tunnel URL separate from the public URL advertised to Expo clients', () => {
  const { flags, kv } = makeArgs({
    kv: {
      '--server-url': 'http://127.0.0.1:43105',
      '--server-public-url': 'https://dev-mac.example.test/',
    },
  });
  const out = resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls });
  assert.equal(out.internalServerUrl, 'http://127.0.0.1:43105');
  assert.equal(out.publicServerUrl, 'https://dev-mac.example.test');
  assert.equal(out.uiApiUrl, 'https://dev-mac.example.test');
  assert.equal(out.publicServerUrlIsExplicit, true);
});

test('accepts HAPPIER_PUBLIC_SERVER_URL as the advertised URL for an external server', () => {
  const { flags, kv } = makeArgs({ flags: ['--no-server'] });
  const out = resolveDevServerConnection({
    flags,
    kv,
    env: {
      HAPPIER_SERVER_URL: 'http://127.0.0.1:43105',
      HAPPIER_PUBLIC_SERVER_URL: 'https://phone.example.test',
    },
    resolvedLocalUrls: localUrls,
  });
  assert.equal(out.internalServerUrl, 'http://127.0.0.1:43105');
  assert.equal(out.publicServerUrl, 'https://phone.example.test');
  assert.equal(out.uiApiUrl, 'https://phone.example.test');
  assert.equal(out.publicServerUrlIsExplicit, true);
});

test('uses HAPPIER_SERVER_URL when --no-server is set', () => {
  const { flags, kv } = makeArgs({ flags: ['--no-server'] });
  const out = resolveDevServerConnection({
    flags,
    kv,
    env: { HAPPIER_SERVER_URL: 'http://remote.example.com:4000/' },
    resolvedLocalUrls: localUrls,
  });
  assert.equal(out.startServer, false);
  assert.equal(out.internalServerUrl, 'http://remote.example.com:4000');
  assert.equal(out.source, 'env');
});

test('throws when --no-server is set without remote URL', () => {
  const { flags, kv } = makeArgs({ flags: ['--no-server'] });
  assert.throws(
    () => resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls }),
    /--no-server requires an external server URL/
  );
});

test('throws on invalid --server-url protocol', () => {
  const { flags, kv } = makeArgs({ kv: { '--server-url': 'ftp://example.com' } });
  assert.throws(
    () => resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls }),
    /invalid --server-url/
  );
});

test('throws when --server-url is combined with --server', () => {
  const { flags, kv } = makeArgs({ kv: { '--server-url': 'https://api.example.com', '--server': 'happier-server' } });
  assert.throws(
    () => resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls }),
    /cannot be combined/
  );
});
