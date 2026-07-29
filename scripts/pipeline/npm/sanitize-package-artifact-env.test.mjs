import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizePackageArtifactEnv } from './sanitize-package-artifact-env.mjs';

test('package artifact children reject OpenSSL provider injection while preserving transport inputs', () => {
  const sanitized = sanitizePackageArtifactEnv({
    OPENSSL_CONF: '/attacker/openssl.cnf',
    openssl_modules: '/attacker/providers',
    NODE_EXTRA_CA_CERTS: '/etc/ssl/private-ca.pem',
    HTTPS_PROXY: 'https://proxy.example',
  });

  assert.deepEqual(sanitized, {
    NODE_EXTRA_CA_CERTS: '/etc/ssl/private-ca.pem',
    HTTPS_PROXY: 'https://proxy.example',
  });
});

test('package artifact children preserve non-authoritative package-manager bookkeeping', () => {
  const sanitized = sanitizePackageArtifactEnv({
    npm_lifecycle_event: 'pack',
    COREPACK_ENABLE_STRICT: '0',
    YARN_WRAP_OUTPUT: 'false',
  });

  assert.deepEqual(sanitized, {
    npm_lifecycle_event: 'pack',
    COREPACK_ENABLE_STRICT: '0',
    YARN_WRAP_OUTPUT: 'false',
  });
});

test('package artifact children do not inherit package-manager credentials', () => {
  const sanitized = sanitizePackageArtifactEnv({
    corepack_npm_token: 'corepack-token',
    COREPACK_NPM_USERNAME: 'corepack-user',
    COREPACK_NPM_PASSWORD: 'corepack-password',
    YARN_NPM_AUTH_TOKEN: 'yarn-token',
    yarn_npm_auth_ident: 'yarn-user:yarn-password',
    AUTH_TOKEN: 'runtime-test-token',
  });

  assert.deepEqual(sanitized, {
    AUTH_TOKEN: 'runtime-test-token',
  });
});
