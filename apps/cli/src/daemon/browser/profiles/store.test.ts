import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore } from './store';

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function createExtensionObservationFixture() {
  const root = await mkdtemp(join(tmpdir(), 'happier-browser-extension-observation-'));
  const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
    partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
  const profileId = 'personal';
  const profiles = createStore();
  await profiles.registerPersistentProfile({ profileId, storageMode: 'user', owner: { kind: 'user', id: profileId } });
  const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1.0', enabled: true,
    source: { kind: 'unpacked' as const, directory: '/original/fixture' }, directory: '/owned/1', permissions: [], hostPermissions: [] };
  await profiles.setExtension(profileId, extension);
  const checker = createStore();
  await checker.loadPersistentProfile(profileId);
  const snapshot = await checker.listExtensions(profileId);
  if (!snapshot.ok) throw new Error(snapshot.reason);
  const upstream = { state: 'update_available' as const, latest: { kind: 'version' as const, version: '3.0' } };
  let resumeCheck: () => void = () => {};
  const paused = new Promise<void>(resolve => { resumeCheck = resolve; });
  // A registry observation can finish after another store has applied a user mutation.
  const observation = paused.then(() => checker.recordExtensionUpstream(profileId, extension.id, snapshot.extensions[0].version, upstream));
  return { root, createStore, profileId, profiles, checker, extension, upstream, resumeCheck, observation };
}

describe('browser profile store disk purge', () => {
  it('discards a late upstream observation for a superseded installed version', async () => {
    const fixture = await createExtensionObservationFixture();
    const { root, profiles, profileId, extension, resumeCheck, observation, createStore } = fixture;
    try {
      const replacement = { ...extension, enabled: false, version: '2.0', directory: '/owned/2' };
      await profiles.setExtension(profileId, replacement);
      resumeCheck();
      await observation;
      expect(await profiles.listExtensions(profileId)).toEqual({ ok: true, extensions: [replacement] });
      const restarted = createStore();
      await restarted.loadPersistentProfile(profileId);
      expect(await restarted.listExtensions(profileId)).toEqual({ ok: true, extensions: [replacement] });
    } finally { resumeCheck(); await observation; await rm(root, { recursive: true, force: true }); }
  });

  it('records an upstream observation while preserving a changed enablement choice', async () => {
    const { root, profiles, profileId, extension, upstream, resumeCheck, observation } = await createExtensionObservationFixture();
    try {
      await profiles.setExtension(profileId, { ...extension, enabled: false });
      resumeCheck();
      await observation;
      expect(await profiles.listExtensions(profileId)).toEqual({ ok: true,
        extensions: [{ ...extension, enabled: false, upstream }] });
    } finally { resumeCheck(); await observation; await rm(root, { recursive: true, force: true }); }
  });

  it('does not resurrect an extension removed while another store checks upstream', async () => {
    const { root, profiles, profileId, extension, resumeCheck, observation } = await createExtensionObservationFixture();
    try {
      await profiles.removeExtension(profileId, extension.id);
      resumeCheck();
      await observation;
      expect(await profiles.listExtensions(profileId)).toEqual({ ok: true, extensions: [] });
    } finally { resumeCheck(); await observation; await rm(root, { recursive: true, force: true }); }
  });

  it('loads a persistent registration without a startup scan and rejects paths outside profile storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-extensions-'));
    const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    try {
      const first = createStore();
      const profile = await first.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
        owner: { kind: 'user', id: 'person' }, displayName: 'Personal', createdAt: 10, cleanupOnSessionClose: false });
      const restarted = createStore();
      expect(restarted.listProfiles()).toEqual([]);
      const outside = join(root, 'outside');
      await mkdir(outside);
      await writeFile(join(outside, 'profile.json'), JSON.stringify({ ...profile, profileId: 'linked' }));
      await symlink(outside, join(root, 'profiles', 'linked'), 'junction');
      restarted.register({ profileId: 'temporary', storageMode: 'ephemeral', owner: { kind: 'session', id: 'session' } });
      expect(await restarted.listPersistentProfiles()).toEqual([profile]);
      expect(await restarted.loadPersistentProfile('personal')).toEqual(profile);
      expect(restarted.getProfile('personal')).toEqual(profile);
      expect(await restarted.loadPersistentProfile('absent')).toBeNull();
      expect(restarted.listProfiles().map(item => item.profileId)).toEqual(['temporary', 'personal']);
      for (const profileId of ['../escape', 'a/b', 'a\\b', '..', 'C:drive']) {
        await expect(restarted.loadPersistentProfile(profileId)).rejects.toThrow();
        await expect(restarted.registerPersistentProfile({ profileId, storageMode: 'user', owner: { kind: 'user', id: 'person' } })).rejects.toThrow();
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('retains independent persistent profile extensions across store recreation and purges them with the profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-extensions-'));
    const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const user = { profileId: 'personal', storageMode: 'user' as const, owner: { kind: 'user' as const, id: 'person' } };
    const plugin = { profileId: 'plugin', storageMode: 'plugin' as const, owner: { kind: 'plugin' as const, id: 'plugin' } };
    const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1.0', enabled: true,
      source: { kind: 'unpacked' as const, directory: '/original/fixture' },
      directory: '/owned/fixture', permissions: ['storage'], hostPermissions: ['https://example.test/*'],
      actionPopup: 'popup.html', optionsPage: 'options.html' };
    try {
      const first = createStore();
      first.register(user);
      first.register(plugin);
      await Promise.all([
        first.setExtension(user.profileId, extension),
        first.setExtension(user.profileId, { ...extension, id: 'b'.repeat(32), enabled: false }),
        first.setExtension(plugin.profileId, { ...extension, version: '2.0' }),
      ]);
      const restarted = createStore();
      expect((await restarted.listPersistentProfiles()).map(profile => profile.profileId).sort()).toEqual(['personal', 'plugin']);
      expect(await restarted.listExtensions(user.profileId)).toEqual({ ok: true,
        extensions: [extension, { ...extension, id: 'b'.repeat(32), enabled: false }] });
      expect(await restarted.listExtensions(plugin.profileId)).toEqual({ ok: true,
        extensions: [{ ...extension, version: '2.0' }] });
      await restarted.setExtension(user.profileId, { ...extension, enabled: false });
      await restarted.removeExtension(user.profileId, 'b'.repeat(32));
      expect(await restarted.listExtensions(user.profileId)).toEqual({ ok: true,
        extensions: [{ ...extension, enabled: false }] });
      expect(await restarted.purgeForLogout()).toEqual({ purgedProfileIds: [], failedProfileIds: [] });
      expect(await restarted.purgeForExplicitRequest({ profileIds: [user.profileId] }))
        .toEqual({ purgedProfileIds: [user.profileId], failedProfileIds: [] });
      const afterPurge = createStore();
      afterPurge.register(user);
      expect(await afterPurge.listExtensions(user.profileId)).toEqual({ ok: true, extensions: [] });
      expect(await restarted.listExtensions(plugin.profileId)).toEqual({ ok: true,
        extensions: [{ ...extension, version: '2.0' }] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('returns a typed unsupported result for session and ephemeral extension records without writing storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-extensions-'));
    try {
      const store = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      for (const storageMode of ['session', 'ephemeral'] as const) {
        store.register({ profileId: storageMode, storageMode, owner: { kind: 'session', id: 'session' } });
        expect(await store.listExtensions(storageMode)).toEqual({ ok: false, reason: 'persistent_profile_required' });
        expect(await store.setExtension(storageMode, { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
          source: { kind: 'unpacked', directory: '/original' }, directory: '/owned', permissions: [], hostPermissions: [] }))
          .toEqual({ ok: false, reason: 'persistent_profile_required' });
        expect(await store.removeExtension(storageMode, 'a'.repeat(32))).toEqual({ ok: false, reason: 'persistent_profile_required' });
        expect(await pathExists(store.resolveProfileDirectory(storageMode))).toBe(false);
      }
      expect(await store.listExtensions('missing')).toEqual({ ok: false, reason: 'profile_not_found' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('purges a session-owned ephemeral profile once after its process settles despite concurrent session deletion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      let settle: (() => void) | undefined;
      const processSettled = new Promise<void>((resolve) => { settle = resolve; });
      const removeDirectory = vi.fn(async (_directory: string) => {});
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }),
        removeDirectory,
      });
      store.register({
        profileId: 'ephemeral_session', storageMode: 'ephemeral',
        owner: { kind: 'session', id: 'session_1' }, cleanupOnSessionClose: true,
        beforePurge: () => processSettled,
      });
      store.register({
        profileId: 'ephemeral_other', storageMode: 'ephemeral',
        owner: { kind: 'session', id: 'session_2' }, cleanupOnSessionClose: true,
      });
      const purge = store.purgeForSessionDeleted({ sessionId: 'session_1' });
      const duplicatePurge = store.purgeForSessionDeleted({ sessionId: 'session_1' });
      await Promise.resolve();
      expect(removeDirectory).not.toHaveBeenCalled();
      settle?.();
      expect(await purge).toEqual({ purgedProfileIds: ['ephemeral_session'], failedProfileIds: [] });
      expect(await duplicatePurge).toEqual({ purgedProfileIds: [], failedProfileIds: [] });
      expect(removeDirectory.mock.calls).toEqual([[store.resolveProfileDirectory('ephemeral_session')]]);
      expect(store.getProfile('ephemeral_other')?.lifecycleState).toBe('active');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains storage and audits a failed process settlement', async () => {
    const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: '/unused' });
    const removeDirectory = vi.fn(async () => {});
    const auditRecords: unknown[] = [];
    const store = createBrowserProfileStore({ storageRootDirectory: '/unused', partitionOwner, removeDirectory,
      emitAudit: record => auditRecords.push(record) });
    store.register({
      profileId: 'running_profile', storageMode: 'ephemeral',
      owner: { kind: 'session', id: 'session' }, cleanupOnSessionClose: true,
      beforePurge: async () => { throw new Error('CDP ws://127.0.0.1/private_token failed'); },
    });
    expect(await store.purgeForSessionDeleted({ sessionId: 'session' }))
      .toEqual({ purgedProfileIds: [], failedProfileIds: ['running_profile'] });
    expect(removeDirectory).not.toHaveBeenCalled();
    expect(store.getProfile('running_profile')).toMatchObject({
      lifecycleState: 'unusable', purgeFailure: { reasonCode: 'profile_in_use' },
    });
    expect(JSON.stringify([store.getProfile('running_profile'), auditRecords])).not.toContain('private_token');
  });

  it('purges session-mode profiles and their bound partitions on session delete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const auditRecords: unknown[] = [];
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        emitAudit: (record) => auditRecords.push(record),
      });

      store.register({
        profileId: 'profile_session',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_1' },
      });
      const partition = partitionOwner.register({
        profileId: 'profile_session',
        originKey: 'https://example.com',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });
      const profileDir = store.resolveProfileDirectory('profile_session');
      const partitionDir = partitionOwner.resolvePartitionDirectory(partition.partitionId);
      await mkdir(profileDir, { recursive: true });
      await mkdir(partitionDir, { recursive: true });
      await writeFile(join(profileDir, 'state'), 'x');
      await writeFile(join(partitionDir, 'cookies.db'), 'y');

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_1' });

      expect(result.purgedProfileIds).toEqual(['profile_session']);
      expect(result.failedProfileIds).toEqual([]);
      expect(await pathExists(profileDir)).toBe(false);
      expect(await pathExists(partitionDir)).toBe(false);
      expect(store.getProfile('profile_session')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not purge session-mode profiles for a different session', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const store = createBrowserProfileStore({ storageRootDirectory: root, partitionOwner });
      store.register({
        profileId: 'profile_other',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_other' },
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_target' });

      expect(result.purgedProfileIds).toEqual([]);
      expect(store.getProfile('profile_other')?.lifecycleState).not.toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('purges ephemeral profiles and their partitions on logout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const store = createBrowserProfileStore({ storageRootDirectory: root, partitionOwner });
      store.register({
        profileId: 'profile_ephemeral',
        storageMode: 'ephemeral',
        owner: { kind: 'session', id: 'session_a' },
      });
      store.register({
        profileId: 'profile_user',
        storageMode: 'user',
        owner: { kind: 'user', id: 'user_1' },
      });
      const partition = partitionOwner.register({
        profileId: 'profile_ephemeral',
        originKey: 'https://eph.example',
        targetKind: 'localServicePreview',
        persistence: 'ephemeral',
        createdAt: 1,
        updatedAt: 1,
      });
      const partitionDir = partitionOwner.resolvePartitionDirectory(partition.partitionId);
      await mkdir(partitionDir, { recursive: true });
      await writeFile(join(partitionDir, 'idb'), 'z');

      const result = await store.purgeForLogout();

      expect(result.purgedProfileIds).toEqual(['profile_ephemeral']);
      expect(await pathExists(partitionDir)).toBe(false);
      expect(store.getProfile('profile_ephemeral')).toBeNull();
      // User profiles survive logout.
      expect(store.getProfile('profile_user')?.lifecycleState).not.toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when the profile directory cannot be removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({ storageRootDirectory: root });
      const auditRecords: Array<{ kind: string; profileId: string }> = [];
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        removeDirectory: async () => {
          throw new Error('EACCES');
        },
        emitAudit: (record) => auditRecords.push(record),
        now: () => 5_000,
      });
      store.register({
        profileId: 'profile_locked',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_locked' },
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_locked' });

      expect(result.purgedProfileIds).toEqual([]);
      expect(result.failedProfileIds).toEqual(['profile_locked']);
      const profile = store.getProfile('profile_locked');
      expect(profile?.lifecycleState).toBe('unusable');
      expect(profile?.purgeFailure?.reasonCode).toBe('disk_purge_failed');
      expect((profile?.disabledReasons?.length ?? 0)).toBeGreaterThan(0);
      // The profile is no longer usable for new partitions: a fail-closed audit was emitted.
      expect(auditRecords.some((r) => r.kind === 'browser_profile_purge_failed' && r.profileId === 'profile_locked')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('marks the profile unusable when a bound partition purge fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-browser-profiles-'));
    try {
      const partitionOwner = createBrowserStoragePartitionOwner({
        storageRootDirectory: root,
        removeDirectory: async () => {
          throw new Error('partition EACCES');
        },
      });
      const store = createBrowserProfileStore({
        storageRootDirectory: root,
        partitionOwner,
        removeDirectory: vi.fn(async () => {}),
      });
      store.register({
        profileId: 'profile_partition_fail',
        storageMode: 'session',
        owner: { kind: 'session', id: 'session_pf' },
      });
      partitionOwner.register({
        profileId: 'profile_partition_fail',
        originKey: 'https://pf.example',
        targetKind: 'localServicePreview',
        persistence: 'session',
        createdAt: 1,
        updatedAt: 1,
      });

      const result = await store.purgeForSessionDeleted({ sessionId: 'session_pf' });

      expect(result.failedProfileIds).toEqual(['profile_partition_fail']);
      expect(store.getProfile('profile_partition_fail')?.lifecycleState).toBe('unusable');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
