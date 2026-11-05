import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMachineResourcesPolicyRuntime } from '@/daemon/resources/machineResourcesPolicy';
import type { StorageOperationActor } from '@/storage/storageService';
import { storagePathFromBytes } from '@/storage/storagePath';

describe('storage protected-folder policy owner', () => {
  it.skipIf(process.platform === 'win32')('keeps native byte folder identity distinct from its display replacement twin in metadata CAS', async () => {
    const { createStorageProtectedFolders } = await import('./storageProtectedFolders');
    const home = await realpath(await mkdtemp(join(tmpdir(), 'happier-protected-bytes-')));
    const bytes = Buffer.concat([Buffer.from(`${home}/folder-`), Buffer.from([0xff])]);
    const path = storagePathFromBytes(bytes); const twin = bytes.toString('utf8');
    await mkdir(bytes); await mkdir(twin);
    let metadata: Record<string, unknown> = {}; let version = 1;
    const policy = createMachineResourcesPolicyRuntime({ port: {
      read: async () => ({ status: 'ready', metadata, metadataVersion: version }),
      compareAndSwap: async input => {
        if (input.expectedMetadataVersion !== version) return { status: 'conflict', metadata, metadataVersion: version };
        metadata = input.metadata; version++; return { status: 'applied', metadata, metadataVersion: version };
      },
    } });
    const actor: StorageOperationActor = { accountId: 'owner', custodianAccountId: 'owner', kind: 'person', assertCurrent: async () => {}, assertCurrentAuthority: async () => {} };
    const owner = createStorageProtectedFolders({ resourcesPolicy: policy, readProtectionFacts: () => ({ homeDir: home }) });
    try {
      await policy.reload();
      expect(await owner.add({ path }, { actor })).toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [{ path }] } } });
      expect(await owner.add({ path: twin }, { actor })).toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [{ path }, { path: twin }] } } });
      expect(await owner.remove({ path }, { actor })).toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [{ path: twin }] } } });
    } finally { policy.stop(); await rm(home, { recursive: true, force: true }); }
  });
  it('writes physical list deltas through real metadata CAS, retaining neighboring policy and refusing stale custody', async () => {
    const { createStorageProtectedFolders } = await import('./storageProtectedFolders');
    const root = await realpath(await mkdtemp(join(tmpdir(), 'happier-protected-policy-')));
    let metadata: Record<string, unknown> = { neighbor: 'retained' }; let version = 1;
    let onRead: (() => void) | undefined; let authorized = true;
    const runtime = createMachineResourcesPolicyRuntime({ port: {
      read: async () => { onRead?.(); return { status: 'ready', metadata, metadataVersion: version }; },
      compareAndSwap: async input => {
        if (input.expectedMetadataVersion !== version) return { status: 'conflict', metadata, metadataVersion: version };
        metadata = input.metadata; version++; return { status: 'applied', metadata, metadataVersion: version };
      },
    } });
    try {
      const home = join(root, 'home'); const folder = join(home, 'personal'); await mkdir(folder, { recursive: true });
      const alias = join(home, 'alias'); await symlink(folder, alias, 'junction');
      await runtime.reload();
      const actor: StorageOperationActor = { accountId: 'owner', custodianAccountId: 'owner', kind: 'person', assertCurrent: async () => {}, assertCurrentAuthority: async () => {
        if (!authorized) throw Object.assign(new Error('revoked'), { code: 'unauthorized' });
      } };
      const owner = createStorageProtectedFolders({ resourcesPolicy: runtime, readProtectionFacts: () => ({ homeDir: home }) });
      const added = await owner.add({ path: '~\\alias' }, { actor });
      expect(added.status === 'unavailable' ? added.reason : added.status).toBe('applied');
      expect(added).toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [{ path: folder, addedAt: expect.any(Number) }] } } });
      expect(await owner.add({ path: folder }, { actor })).toMatchObject({ status: 'unchanged' });
      expect(metadata.neighbor).toBe('retained');
      expect(await owner.remove({ path: join(home, 'Documents') }, { actor })).toEqual({ status: 'unsupported', reason: 'built_in_protection' });
      onRead = () => { authorized = false; };
      // The policy writer projects a denied CAS as unavailable. The RPC owner
      // separately verifies authority before disclosing this service result.
      expect(await owner.remove({ path: folder }, { actor })).toMatchObject({ status: 'unavailable' });
      onRead = undefined; authorized = true;
      expect(runtime.read()).toMatchObject({ policy: { storage: { protectedFolders: [{ path: folder }], logRetentionDays: 30 } } });
      expect(await owner.remove({ path: alias }, { actor })).toMatchObject({ status: 'applied', policy: { storage: { protectedFolders: [] } } });
      expect(await owner.add({ path: folder }, { actor: { ...actor, accountId: 'manager' } })).toMatchObject({ status: 'applied' });
      await expect(owner.add({ path: folder }, { actor: { ...actor, accountId: 'recipient', sessionIds: new Set() } })).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { runtime.stop(); await rm(root, { recursive: true, force: true }); }
  });
});
