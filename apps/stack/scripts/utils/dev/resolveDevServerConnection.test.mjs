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
  publicServerUrl: 'http://localhost:3005',
  defaultPublicUrl: 'http://localhost:3005',
};

test('uses local server defaults when no remote flags are set', () => {
  const { flags, kv } = makeArgs();
  const out = resolveDevServerConnection({ flags, kv, env: {}, resolvedLocalUrls: localUrls });
  assert.equal(out.startServer, true);
  assert.equal(out.internalServerUrl, localUrls.internalServerUrl);
  assert.equal(out.publicServerUrl, localUrls.publicServerUrl);
  assert.equal(out.uiApiUrl, localUrls.defaultPublicUrl);
  assert.equal(out.source, 'local');
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
