import { afterEach, describe, expect, it, vi } from 'vitest';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';

// Boundary: a temporary HAPPIER_HOME_DIR holds real stored credentials and only
// the Home HTTP answer is injected; persistence and both mode owners are real.
const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_API_TOKEN', 'HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE']);
const token = (nonce: string) => `e30.${Buffer.from(JSON.stringify({ sub: 'alice', nonce })).toString('base64url')}.sig`;
const DOWNGRADE = { code: 'account_mode_downgrade_unverified', canTryAgain: false };
const plainCurrentness = { mode: 'plain', version: 2, settingsVersion: 2, updatedAt: 2, signingKeyFingerprint: null, contentKeyFingerprint: null };
afterEach(() => { env.restore(); vi.resetModules(); });

async function withHome<T>(run: (modules: Awaited<ReturnType<typeof load>>) => Promise<T>): Promise<T> {
  return await withTempDir('mode-admission-', async home => {
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined, HAPPIER_SESSION_REQUESTER_CREDENTIAL_FILE: undefined });
    vi.resetModules();
    return await run(await load());
  });
}
async function load() {
  return {
    persistence: await import('@/persistence'),
    mode: await import('./accountEncryptionMode'),
    currentness: await import('./accountEncryptionCurrentness'),
  };
}
const reads = (bearer: string, m: Awaited<ReturnType<typeof load>>) => ({
  mode: () => m.mode.readAccountEncryptionModeOnce({
    credentials: { token: bearer },
    request: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 2 } }),
    scope: { token: bearer, serverBaseUrl: 'https://home.test' },
  }),
  currentness: () => m.currentness.fetchAccountEncryptionCurrentnessFromServer({
    token: bearer, serverBaseUrl: 'https://home.test', request: async () => ({ status: 200, data: plainCurrentness }),
  }),
});

describe('CLI Account mode downgrade pin', () => {
  it('refuses a Home-reported plain while this computer holds active Account E2EE keys', async () => {
    await withHome(async m => {
      const bearer = token('active');
      await m.persistence.writeCredentialsLegacy({ token: bearer, secret: new Uint8Array(32).fill(8) });
      await expect(reads(bearer, m).mode()).rejects.toMatchObject(DOWNGRADE);
      await expect(reads(bearer, m).currentness()).rejects.toMatchObject(DOWNGRADE);
    });
  });

  it('reads custody from the in-hand credential, not from a stored file or the selected profile', async () => {
    await withHome(async m => {
      // The selected profile is keyless; the caller holds active keys only in memory.
      await m.persistence.writeCredentialsTokenOnly({ token: token('profile') });
      const bearer = token('in-memory');
      const credentials = { token: bearer, encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(8) } };
      await expect(m.mode.readAccountEncryptionModeOnce({ credentials,
        request: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 2 } }) })).rejects.toMatchObject(DOWNGRADE);
      await expect(m.currentness.fetchAccountEncryptionCurrentnessFromServer({ token: bearer, credentials, serverBaseUrl: 'https://home.test',
        request: async () => ({ status: 200, data: plainCurrentness }) })).rejects.toMatchObject(DOWNGRADE);
    });
  });

  it('admits plain for a genuinely keyless computer', async () => {
    await withHome(async m => {
      const bearer = token('keyless');
      await m.persistence.writeCredentialsTokenOnly({ token: bearer });
      await expect(reads(bearer, m).mode()).resolves.toEqual({ kind: 'resolved', mode: 'plain' });
      await expect(reads(bearer, m).currentness()).resolves.toMatchObject({ mode: 'plain' });
    });
  });

  it('keyless re-auth keeps retained keys as history and admits plain', async () => {
    await withHome(async m => {
      const secret = new Uint8Array(32).fill(8);
      await m.persistence.writeCredentialsLegacy({ token: token('old'), secret });
      const bearer = token('reauth');
      await m.persistence.writeCredentialsTokenOnly({ token: bearer });
      const { configuration } = await import('@/configuration');
      expect(await m.persistence.readStoredCredentialsForServerId(configuration.activeServerId))
        .toMatchObject({ token: bearer, encryption: { type: 'legacy', secret }, accountE2eeCustody: 'historical' });
      await expect(reads(bearer, m).mode()).resolves.toEqual({ kind: 'resolved', mode: 'plain' });
    });
  });

  it('admits plain once this computer reclassifies the same keys as history', async () => {
    await withHome(async m => {
      const secret = new Uint8Array(32).fill(8);
      const bearer = token('reclassify');
      await m.persistence.writeCredentialsLegacy({ token: bearer, secret });
      const { configuration } = await import('@/configuration');
      await expect(m.persistence.writeAccountE2eeCustodyForServerId(configuration.activeServerId, bearer, 'historical')).resolves.toBe(true);
      expect(await m.persistence.readStoredCredentialsForServerId(configuration.activeServerId))
        .toMatchObject({ encryption: { type: 'legacy', secret }, accountE2eeCustody: 'historical' });
      await expect(reads(bearer, m).currentness()).resolves.toMatchObject({ mode: 'plain' });
    });
  });
});
