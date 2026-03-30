import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveTauriSigningPrivateKeyPassword } from '../pipeline/tauri/resolve-signing-key-password.mjs';

test('resolveTauriSigningPrivateKeyPassword prefers the explicit Tauri password env', () => {
  const password = resolveTauriSigningPrivateKeyPassword({
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'tauri-password',
    MINISIGN_PASSPHRASE: 'minisign-passphrase',
  });

  assert.equal(password, 'tauri-password');
});

test('resolveTauriSigningPrivateKeyPassword falls back to MINISIGN_PASSPHRASE', () => {
  const password = resolveTauriSigningPrivateKeyPassword({
    MINISIGN_PASSPHRASE: 'minisign-passphrase',
  });

  assert.equal(password, 'minisign-passphrase');
});

test('resolveTauriSigningPrivateKeyPassword returns empty when neither env is set', () => {
  const password = resolveTauriSigningPrivateKeyPassword({});

  assert.equal(password, '');
});
