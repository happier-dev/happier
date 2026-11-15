import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserExtensionService } from './service';

describe('persistent profile extension application', () => {
  it('opens and mutates a selected extension without reading unrelated records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-selected-'));
    const store = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    try {
      await store.registerPersistentProfile({ profileId: 'personal', storageMode: 'user', owner: { kind: 'user', id: 'person' } });
      const extension = { id: 'a'.repeat(32), name: 'Selected', version: '1.0', enabled: true,
        source: { kind: 'unpacked' as const, directory: join(root, 'selected') }, directory: join(root, 'installed'),
        permissions: [], hostPermissions: [], actionPopup: 'popup.html' };
      await store.setExtension('personal', extension);
      // The filesystem boundary exposes an unreadable unrelated record. Exact operations must
      // still work; only an actual collection listing needs this other manifest.
      await writeFile(join(store.resolveProfileDirectory('personal'), 'extensions', 'records', `${'b'.repeat(32)}.json`), 'invalid json');
      const service = createBrowserExtensionService({ profileStore: store, runtime: {
        openView: async command => ({ v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }),
      } });
      const selected = { machineId: 'machine', profileId: 'personal', extensionId: extension.id };
      expect(await service.execute('browser.extensions.openActionPopup', { ...selected, commandId: 'popup', browserSessionId: 'session', viewId: 'view' }))
        .toMatchObject({ status: 'dispatched' });
      expect(await service.execute('browser.extensions.disable', selected)).toMatchObject({ status: 'updated', entry: { extension: { enabled: false } } });
      expect(await service.execute('browser.extensions.enable', selected)).toMatchObject({ status: 'updated', entry: { extension: { enabled: true } } });
      expect(await service.execute('browser.extensions.remove', selected)).toMatchObject({ status: 'removed', extensionId: extension.id });
      expect(await store.listExtensions('personal', [extension.id])).toEqual({ ok: true, extensions: [] });
      await expect(store.listExtensions('personal')).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('lists saved profiles before extensions exist, including after the store is recreated', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-profile-inventory-'));
    const createStore = () => createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    try {
      const first = createStore();
      await first.registerPersistentProfile({ profileId: 'personal', storageMode: 'user',
        owner: { kind: 'user', id: 'person' }, displayName: 'Personal' });
      await first.registerPersistentProfile({ profileId: 'work', storageMode: 'plugin',
        owner: { kind: 'plugin', id: 'work-plugin' } });
      const restarted = createStore();
      restarted.register({ profileId: 'temporary', storageMode: 'ephemeral',
        owner: { kind: 'session', id: 'session' } });
      const service = createBrowserExtensionService({ profileStore: restarted });
      const listed = await service.execute('browser.extensions.list', { machineId: 'machine' });
      expect(listed).toMatchObject({ status: 'ready', entries: [], profiles: expect.arrayContaining([
        { profileId: 'personal', displayName: 'Personal' }, { profileId: 'work' },
      ]) });
      expect(listed).toHaveProperty('profiles.length', 2);
      expect(await service.execute('browser.extensions.list', { machineId: 'machine', profileId: 'personal' }))
        .toEqual({ status: 'ready', entries: [], profiles: [{ profileId: 'personal', displayName: 'Personal' }] });
      expect(await service.execute('browser.extensions.list', { machineId: 'machine', profileId: 'absent' }))
        .toEqual({ status: 'unavailable', code: 'profile_not_found' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reviews grants before installing, keeps identity on explicit update, and isolates profiles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-service-'));
    const source = join(root, 'source');
    await mkdir(source);
    const manifest = { manifest_version: 3, name: 'Local content fixture', version: '1.0',
      permissions: ['storage'], host_permissions: ['https://example.test/*'],
      action: { default_popup: 'popup.html' }, options_page: 'options.html' };
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'popup.html'), '<p>Popup</p>');
    await writeFile(join(source, 'options.html'), '<p>Options</p>');
    const store = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    let active = false;
    const restartProfile = vi.fn(async () => { active = false; });
    const service = createBrowserExtensionService({ profileStore: store, runtime: {
      getProfileRuntime: () => ({ active, extensionDirectories: [] }), restartProfile,
      openView: async command => ({ v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] }),
    } });
    const install = { machineId: 'machine', profileId: 'personal', source: { kind: 'unpacked', directory: source } };
    try {
      expect(await service.execute('browser.extensions.install', install)).toMatchObject({ status: 'needs_review',
        review: { version: '1.0', permissions: ['storage'], hostPermissions: ['https://example.test/*'] } });
      const installed = await service.execute('browser.extensions.install', { ...install, reviewedPermissions: {
        version: '1.0', permissions: ['storage'], hostPermissions: ['https://example.test/*'] } });
      expect(installed).toMatchObject({ status: 'updated', entry: { profileId: 'personal',
        extension: { version: '1.0', enabled: true } } });
      const initial = await store.listExtensions('personal');
      expect(initial.ok).toBe(true);
      if (!initial.ok) return;
      const extension = initial.extensions[0];
      expect(JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))).not.toHaveProperty('key');
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0', permissions: ['storage', 'tabs'] }));
      const update = { machineId: 'machine', profileId: 'personal', extensionId: extension.id, expectedVersion: '2.0' };
      active = true;
      expect(await service.execute('browser.extensions.update', update)).toMatchObject({ status: 'needs_review',
        restartRequired: true,
        review: { version: '2.0', permissions: ['storage', 'tabs'] } });
      expect(await store.listExtensions('personal')).toEqual(initial);
      expect(await service.execute('browser.extensions.update', { ...update, reviewedPermissions: {
        version: '2.0', permissions: ['tabs', 'storage'], hostPermissions: ['https://example.test/*'] } }))
        .toMatchObject({ status: 'updated', entry: { extension: { id: extension.id, version: '2.0' } } });
      expect(restartProfile).toHaveBeenCalledTimes(1);
      expect(await service.execute('browser.extensions.list', { machineId: 'machine', profileId: 'other' }))
        .toMatchObject({ status: 'unavailable', code: 'profile_not_found' });
      await service.execute('browser.extensions.disable', { machineId: 'machine', profileId: 'personal', extensionId: extension.id });
      expect(await store.listExtensions('personal')).toMatchObject({ ok: true, extensions: [{ enabled: false }] });
      await service.execute('browser.extensions.remove', { machineId: 'machine', profileId: 'personal', extensionId: extension.id });
      expect(await store.listExtensions('personal')).toEqual({ ok: true, extensions: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('refuses ephemeral profiles without acquiring a package or creating profile files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-service-'));
    const store = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    store.register({ profileId: 'ephemeral', storageMode: 'ephemeral', owner: { kind: 'session', id: 'session' } });
    try {
      expect(await createBrowserExtensionService({ profileStore: store }).execute('browser.extensions.install', {
        machineId: 'machine', profileId: 'ephemeral', source: { kind: 'unpacked', directory: '/does-not-exist' },
      })).toEqual({ status: 'unavailable', code: 'persistent_profile_required' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('requires review when an update adds content script injection hosts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-injection-review-'));
    try {
      const directory = join(root, 'source');
      await mkdir(directory);
      const manifest = { manifest_version: 3, name: 'Injection fixture', version: '1.0' };
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      const store = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      const service = createBrowserExtensionService({ profileStore: store });
      expect(await service.execute('browser.extensions.install', {
        machineId: 'machine', profileId: 'personal', source: { kind: 'unpacked', directory },
        reviewedPermissions: { version: '1.0', permissions: [], hostPermissions: [] },
      })).toMatchObject({ status: 'updated' });
      const initial = await store.listExtensions('personal');
      if (!initial.ok) throw new Error(initial.reason);
      const extensionId = initial.extensions[0].id;
      await writeFile(join(directory, 'content.js'), 'document.body.dataset.fixture = "injected";');
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0',
        content_scripts: [{ matches: ['https://private.example/*'], js: ['content.js'] }] }));
      const update = { machineId: 'machine', profileId: 'personal', extensionId, expectedVersion: '2.0' };
      expect(await service.execute('browser.extensions.update', update)).toEqual({ status: 'needs_review',
        review: { version: '2.0', permissions: [], hostPermissions: ['https://private.example/*'] } });
      expect(await store.listExtensions('personal')).toEqual(initial);
      expect(await service.execute('browser.extensions.update', { ...update, reviewedPermissions: {
        version: '2.0', permissions: [], hostPermissions: ['https://private.example/*'] },
      })).toMatchObject({ status: 'updated', entry: { extension: { version: '2.0',
        hostPermissions: ['https://private.example/*'] } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    { manifest: { manifest_version: 2, name: 'Legacy', version: '1.0' }, code: 'unsupported_manifest' },
    { manifest: { manifest_version: 3, version: '1.0' }, code: 'invalid_manifest' },
  ])('keeps a repairable $code result without creating a profile', async ({ manifest, code }) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-refusal-'));
    try {
      const directory = join(root, 'source');
      await mkdir(directory);
      await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
      const store = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      expect(await createBrowserExtensionService({ profileStore: store }).execute('browser.extensions.install', {
        machineId: 'machine', profileId: 'personal', source: { kind: 'unpacked', directory },
      })).toEqual({ status: 'unavailable', code });
      expect(await store.loadPersistentProfile('personal')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('settles canceled admission without acquiring or registering a profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-canceled-'));
    try {
      const store = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      const cancellation = new AbortController();
      cancellation.abort();
      expect(await createBrowserExtensionService({ profileStore: store }).execute('browser.extensions.install', {
        machineId: 'machine', profileId: 'personal', source: { kind: 'unpacked', directory: '/missing' },
      }, { signal: cancellation.signal })).toEqual({ status: 'unavailable', code: 'canceled' });
      expect(await store.loadPersistentProfile('personal')).toBeNull();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('preserves cancellation when Web Store acquisition is interrupted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-canceled-download-'));
    const cancellation = new AbortController();
    // The third-party network boundary pauses while the real acquisition owner runs.
    const download = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      cancellation.abort();
      cancellation.signal.throwIfAborted();
      throw new Error('Expected cancellation');
    });
    try {
      const store = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
      expect(await createBrowserExtensionService({ profileStore: store }).execute('browser.extensions.install', {
        machineId: 'machine', profileId: 'personal', source: { kind: 'webStore', extensionId: 'a'.repeat(32) },
      }, { signal: cancellation.signal })).toEqual({ status: 'unavailable', code: 'canceled' });
      expect(await store.loadPersistentProfile('personal')).toBeNull();
    } finally { download.mockRestore(); await rm(root, { recursive: true, force: true }); }
  });
});
