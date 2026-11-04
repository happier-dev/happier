import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserExtensionService } from './service';
import { createBrowserExtensionRegistryUpdateTracker } from './registryUpdateTracker';
import { createRegistryUpdateCheck } from '../../../registries/updates/registryUpdateTracker';
import { createCliRegistryUpdateCheck } from '../../../registries/updates/createCliRegistryUpdateCheck';
import { createConfiguredBrowserProfileStore } from '../profiles/configuredStore';
import { reloadConfiguration } from '@/configuration';
import type { RegistryHttpV1 } from '@happier-dev/protocol/registries';

describe('browser extension updates through the registry tracker', () => {
  it('records a profile-qualified version observation without applying an update', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-tracker-'));
    const source = join(root, 'source');
    await mkdir(source);
    const manifest = { manifest_version: 3, name: 'Tracker fixture', version: '1.0', permissions: ['storage'] };
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    const store = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const service = createBrowserExtensionService({ profileStore: store });
    const provenance = { sourceId: 'extensions', format: 'happier-catalog' as const,
      sourceUrl: 'https://example.test/extensions.json', itemId: 'fixture', importedAt: 1,
      ref: { kind: 'content' as const, digest: 'sha256:' + 'a'.repeat(64) } };
    const unused = async (): Promise<never> => { throw new Error('Unpacked extension checks do not make HTTP requests'); };
    const http: RegistryHttpV1 = { getJson: unused, getText: unused, getBytes: unused };
    try {
      const result = await service.execute('browser.extensions.install', { machineId: 'machine', profileId: 'personal',
        source: { kind: 'unpacked', directory: source }, provenance,
        reviewedPermissions: { version: '1.0', permissions: ['storage'], hostPermissions: [] } });
      expect(result).toMatchObject({ status: 'updated' });
      const installed = await store.listExtensions('personal');
      if (!installed.ok) throw new Error('Expected installed extension');
      const extension = installed.extensions[0];
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0', permissions: ['storage', 'tabs'] }));
      const check = createRegistryUpdateCheck({ trackers: [createBrowserExtensionRegistryUpdateTracker({ profileStore: store })],
        ctx: { http }, readSources: async () => [] });
      expect(await check.checkNow({ kind: 'browserExtension' })).toMatchObject({ results: [{ kind: 'browserExtension',
        key: JSON.stringify(['personal', extension.id]), upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }] });
      expect(await store.listExtensions('personal')).toMatchObject({ ok: true, extensions: [{ id: extension.id, version: '1.0',
        upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }] });
      // Discovery leaves neither a staged package nor an unreviewed permission grant behind.
      expect(await readdir(join(store.resolveProfileDirectory('personal'), 'extensions', 'packages'))).toHaveLength(1);
      expect(await service.execute('browser.extensions.update', { machineId: 'machine', profileId: 'personal',
        extensionId: extension.id, expectedVersion: '2.0' })).toMatchObject({ status: 'needs_review',
          review: { version: '2.0', permissions: ['storage', 'tabs'], hostPermissions: [] } });
      expect(await store.listExtensions('personal')).toMatchObject({ ok: true, extensions: [{ version: '1.0' }] });
      expect(await service.execute('browser.extensions.update', { machineId: 'machine', profileId: 'personal',
        extensionId: extension.id, expectedVersion: '2.0',
        reviewedPermissions: { version: '2.0', permissions: ['storage', 'tabs'], hostPermissions: [] } }))
        .toMatchObject({ status: 'updated', entry: { extension: { version: '2.0' } } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('checks verified Store packages only for the selected profile and retains the last good observation after an outage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-store-tracker-'));
    const extensionId = 'eimadpbcbfnmbkopoojfekhnkhdbieeh';
    const bytes = await readFile(new URL('./fixtures/darkreader.crx', import.meta.url));
    let online = true;
    let downloads = 0;
    vi.stubGlobal('fetch', async () => {
      downloads += 1;
      return online ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 503 });
    });
    const store = createBrowserProfileStore({ storageRootDirectory: root,
      partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const service = createBrowserExtensionService({ profileStore: store });
    const forbidden = async (): Promise<never> => { throw new Error('A native check does not require Account registry sources'); };
    const http: RegistryHttpV1 = { getJson: forbidden, getText: forbidden, getBytes: forbidden };
    try {
      for (const profileId of ['personal', 'work']) {
        const request = { machineId: 'machine', profileId, source: { kind: 'webStore' as const, extensionId } };
        const review = await service.execute('browser.extensions.install', request);
        if (review.status !== 'needs_review') throw new Error('Expected actual Store manifest permission review');
        expect(await service.execute('browser.extensions.install', { ...request, reviewedPermissions: review.review }))
          .toMatchObject({ status: 'updated' });
      }
      downloads = 0;
      const check = createRegistryUpdateCheck({ trackers: [createBrowserExtensionRegistryUpdateTracker({ profileStore: store })],
        ctx: { http }, readSources: forbidden });
      const key = JSON.stringify(['work', extensionId]);
      expect(await check.checkNow({ kind: 'browserExtension', keys: [key] }))
        .toMatchObject({ results: [{ kind: 'browserExtension', key, upstream: { state: 'current' } }] });
      expect(downloads).toBe(1);
      const current = await store.listExtensions('work');
      expect(current).toMatchObject({ ok: true, extensions: [{ upstream: { state: 'current' } }] });
      const personal = await store.listExtensions('personal');
      if (!personal.ok) throw new Error('Expected other profile');
      expect(personal.extensions[0].upstream).toBeUndefined();
      online = false;
      expect(await check.checkNow({ kind: 'browserExtension', keys: [key] }))
        .toMatchObject({ results: [{ upstream: { state: 'unchecked', reason: { state: 'unreachable' } } }] });
      expect(await store.listExtensions('work')).toEqual(current);
      expect(await readdir(join(store.resolveProfileDirectory('work'), 'extensions', 'packages'))).toHaveLength(1);
      expect(await check.checkNow({ kind: 'browserExtension', keys: ['unknown'] })).toMatchObject({ results: [] });
      expect(downloads).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('registers native profile checks in the production CLI composition without fetching Account catalogs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-extension-composition-'));
    vi.stubEnv('HAPPIER_HOME_DIR', root);
    reloadConfiguration();
    vi.stubGlobal('fetch', async () => { throw new Error('Unpacked profile update checks must stay on the execution Machine'); });
    try {
      const source = join(root, 'source');
      await mkdir(source);
      const manifest = { manifest_version: 3, name: 'Composition fixture', version: '1.0' };
      await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
      const store = createConfiguredBrowserProfileStore();
      const service = createBrowserExtensionService({ profileStore: store });
      expect(await service.execute('browser.extensions.install', { machineId: 'machine', profileId: 'personal',
        source: { kind: 'unpacked', directory: source },
        reviewedPermissions: { version: '1.0', permissions: [], hostPermissions: [] } }))
        .toMatchObject({ status: 'updated' });
      await writeFile(join(source, 'manifest.json'), JSON.stringify({ ...manifest, version: '2.0' }));
      const checker = createCliRegistryUpdateCheck({ credentials: { token: 'fixture-account', encryption: null },
        serverHttpBaseUrl: 'https://home.example.test' });
      expect(await checker.checkNow({ kind: 'browserExtension' })).toMatchObject({ results: [{ kind: 'browserExtension',
        upstream: { state: 'update_available', latest: { kind: 'version', version: '2.0' } } }] });
      const reopened = createConfiguredBrowserProfileStore();
      await reopened.loadPersistentProfile('personal');
      expect(await reopened.listExtensions('personal'))
        .toMatchObject({ ok: true, extensions: [{ version: '1.0', upstream: { state: 'update_available' } }] });
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      reloadConfiguration();
      await rm(root, { recursive: true, force: true });
    }
  });
});
