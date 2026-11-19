import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import current02Credentials from './persistence.current02Credentials.fixture.json';

const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_API_TOKEN']);
const token = (sub: string, nonce: string) => `e30.${Buffer.from(JSON.stringify({ sub, nonce })).toString('base64url')}.sig`;
afterEach(() => { env.restore(); vi.resetModules(); });

describe('same-Account historical credential refresh', () => {
  it.each([
    { shape: 'plain', vector: current02Credentials.plain, encryption: null },
    { shape: 'legacy', vector: current02Credentials.legacy, encryption: { type: 'legacy', secret: new Uint8Array(Buffer.from(current02Credentials.legacy.secret, 'base64')) } },
    { shape: 'dataKey', vector: current02Credentials.dataKey, encryption: { type: 'dataKey', publicKey: new Uint8Array(Buffer.from(current02Credentials.dataKey.encryption.publicKey, 'base64')), machineKey: new Uint8Array(Buffer.from(current02Credentials.dataKey.encryption.machineKey, 'base64')) } },
  ])('reads the actual current0.2 $shape persisted credential producer vector', async ({ vector, encryption }) => {
    await withTempDir('predecessor-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      await writeFile(configuration.privateKeyFile, JSON.stringify(vector));
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ token: vector.token, encryption });
    });
  });

  it.each([false, true])('retains genuine legacy material on %s explicit-profile refresh', async (explicit) => {
    await withTempDir('historical-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      const secret = new Uint8Array(32).fill(8);
      await persistence.writeCredentialsLegacy({ token: token('alice', 'old'), secret });
      const next = token('alice', 'new');
      if (explicit) await persistence.writeCredentialsTokenOnlyForServerId(configuration.activeServerId, { token: next });
      else await persistence.writeCredentialsTokenOnly({ token: next });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ token: next, encryption: { type: 'legacy', secret } });
      await persistence.writeStoredCredentialsForServerId(configuration.activeServerId, { token: next, encryption: null });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ encryption: null });
    });
  });

  it('recovers tokenless predecessor material only through its established Account scope', async () => {
    await withTempDir('historical-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      const secret = new Uint8Array(32).fill(8);
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      await writeFile(configuration.privateKeyFile, JSON.stringify({ secret: Buffer.from(secret).toString('base64') }));
      await persistence.updateSettings(settings => ({ ...settings, lastTokenSubByServerId: { [configuration.activeServerId]: 'alice' } }));
      await persistence.writeCredentialsTokenOnly({ token: token('alice', 'new') });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ encryption: { type: 'legacy', secret } });
    });
  });

  it('uses the predecessor scope captured before Machine registration rewrites last Account', async () => {
    await withTempDir('historical-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      await mkdir(dirname(configuration.privateKeyFile), { recursive: true });
      await writeFile(configuration.privateKeyFile, JSON.stringify({ secret: Buffer.from(new Uint8Array(32).fill(8)).toString('base64') }));
      await persistence.updateSettings(settings => ({ ...settings, lastTokenSubByServerId: { [configuration.activeServerId]: 'bob' } }));
      await persistence.writeCredentialsTokenOnly({ token: token('bob', 'new') }, { previousAccountId: 'alice' });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ encryption: null });
    });
  });

  it('refuses an unknown Account identity without discarding genuine historical material', async () => {
    await withTempDir('historical-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      const previous = { token: token('alice', 'old'), secret: new Uint8Array(32).fill(8) };
      await persistence.writeCredentialsLegacy(previous);
      await expect(persistence.writeCredentialsTokenOnly({ token: 'unknown' })).rejects.toMatchObject({ code: 'HISTORICAL_ENCRYPTION_IDENTITY_UNAVAILABLE' });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ token: previous.token, encryption: { type: 'legacy', secret: previous.secret } });
    });
  });

  it('does not adopt historical material for another Account', async () => {
    await withTempDir('historical-credentials-', async home => {
      env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_API_TOKEN: undefined });
      vi.resetModules();
      const persistence = await import('@/persistence');
      const { configuration } = await import('@/configuration');
      await persistence.writeCredentialsLegacy({ token: token('alice', 'old'), secret: new Uint8Array(32).fill(8) });
      await persistence.writeCredentialsTokenOnly({ token: token('bob', 'new') });
      expect(await persistence.readStoredCredentialCustodyForServerId(configuration.activeServerId)).toMatchObject({ encryption: null });
    });
  });
});
