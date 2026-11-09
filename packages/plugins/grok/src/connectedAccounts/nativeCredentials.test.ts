import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseGrokAuthStore, readGrokNativeCredential, serializeGrokSelectedAuth } from './nativeCredentials.js';
import { readXaiCredential } from './credential.js';

const issuer = 'https://auth.x.ai';
const clientId = 'b1a00492-073a-47ea-816f-4c329264a828';
const scope = `${issuer}::${clientId}`;
const native = { key: 'fake-selected-token', auth_mode: 'oidc', create_time: '2026-11-09T00:00:00Z',
  user_id: 'fake-user-b', email: 'b@example.test', refresh_token: 'fake-refresh',
  expires_at: '2026-11-10T00:00:00Z', oidc_issuer: issuer, oidc_client_id: clientId,
  principal_type: 'Team', principal_id: 'fake-team', team_id: 'fake-team',
  coding_data_retention_opt_out: false };

describe('Grok native credential codec', () => {
  it('rejects malformed native JSON without propagating credential bytes in parser diagnostics', () => {
    expect(() => parseGrokAuthStore('fake-secret-native-access malformed json'))
      .toThrow('Unsupported Grok native auth store');
    expect(() => readXaiCredential('fake-secret-sealed-access malformed json'))
      .toThrow('xAI credential unavailable');
  });

  it('reads exactly the explicitly configured native auth file without changing it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'happier-grok-import-'));
    const authPath = join(directory, 'selected-auth.json');
    try {
      await writeFile(authPath, JSON.stringify({ [scope]: native }));
      expect(await readGrokNativeCredential({ environment: { GROK_HOME: '/does-not-exist', GROK_AUTH_PATH: authPath }, scope }))
        .toMatchObject({ accessToken: native.key, mode: 'subscription' });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('imports the selected first-party scope with its real expiry, identity and native facts', () => {
    const credential = parseGrokAuthStore(JSON.stringify({ [scope]: native, 'https://idp.example.test::other': { key: 'unrelated' } }), { scope });
    expect(credential).toMatchObject({ mode: 'subscription', accessToken: 'fake-selected-token', refreshToken: 'fake-refresh',
      expiresAtMs: Date.parse(native.expires_at), subject: 'fake-user-b', email: 'b@example.test', issuer, clientId,
      native: { create_time: native.create_time, principal_type: 'Team', coding_data_retention_opt_out: false } });
    expect(credential.native).toMatchObject({ decoderGeneration: 'scoped-grok-auth-v1' });
    const selected = JSON.parse(serializeGrokSelectedAuth(credential));
    expect(Object.keys(selected)).toEqual([scope]);
    const { refresh_token: _refreshToken, ...accessOnlyNative } = native;
    expect(selected[scope]).toMatchObject({ ...accessOnlyNative, expires_at: new Date(native.expires_at).toISOString() });
    expect(Object.hasOwn(selected[scope], 'refresh_token')).toBe(false);
  });

  it('keeps API keys separate and does not invent an expiry', () => {
    const credential = parseGrokAuthStore({ 'xai::api_key': { ...native, key: 'fake-api-key', auth_mode: 'api_key',
      refresh_token: undefined, expires_at: undefined, oidc_issuer: undefined, oidc_client_id: undefined } });
    expect(credential).toMatchObject({ mode: 'api-key', accessToken: 'fake-api-key' });
    expect(credential.expiresAtMs).toBeUndefined();
    expect(JSON.parse(serializeGrokSelectedAuth(credential))['xai::api_key']).toMatchObject({ key: 'fake-api-key', auth_mode: 'api_key' });
  });

  it('refuses ambiguous stores, unsupported legacy/external/enterprise credentials and malformed dates', () => {
    expect(() => parseGrokAuthStore({ [scope]: native, 'xai::api_key': { ...native, auth_mode: 'api_key' } })).toThrow();
    for (const record of [{ ...native, auth_mode: 'external' }, { ...native, auth_mode: 'web_login' },
      { ...native, oidc_issuer: 'https://idp.example.test' }, { ...native, expires_at: 'not-a-date' },
      { ...native, expires_at: '2026-02-30T00:00:00Z' }, { ...native, expires_at: '2026-11-10T00:00:00' }]) {
      expect(() => parseGrokAuthStore({ [scope]: record }, { scope })).toThrow();
    }
  });

  it('creates an access-only first-party record using the snapshot time without fabricating expiry', () => {
    const nowMs = Date.parse('2026-11-09T12:00:00Z');
    const record = JSON.parse(serializeGrokSelectedAuth({ mode: 'subscription', accessToken: 'fake-access',
      refreshToken: 'must-not-reach-child', subject: 'fake-user', issuer, clientId }, { nowMs }))[scope];
    expect(record).toMatchObject({ auth_mode: 'oidc', key: 'fake-access', user_id: 'fake-user', create_time: new Date(nowMs).toISOString() });
    expect(record).not.toHaveProperty('refresh_token');
    expect(record).not.toHaveProperty('expires_at');
  });
});
