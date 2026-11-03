import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createPackageAssetArchiveV1, openPackageAssetArchiveV1, PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { encodeBase64 } from '@/encryption/base64';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginSurfaceResourceReadTransport } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '../ui/projection';
import { createPluginUiTranslationResourceByteReader } from './translationResourceBytes';
import { createPluginUiTranslationRuntime } from '../ui/i18n';
import { createPluginAccountAvailabilityReaderStore } from './reader';

const expo = vi.hoisted(() => ({ fromModule: vi.fn() }));
vi.mock('expo-asset', () => ({ Asset: { fromModule: expo.fromModule } }));
// The transport imports the host locale/device environment. Translation policy
// is not part of this adapter; its Resource and Package Asset owners stay real.
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

const pluginId = 'com.acme.locale';
const bytes = new TextEncoder().encode('{"label":"Hello"}');
const digest = computePluginUiArtifactSha256DigestV1(bytes);
const scope = { serverId: 'server-a', accountId: 'account-a' };

function lifetime() {
    let current = true;
    const listeners = new Set<() => void>();
    const accountLifetime: ActiveServerAccountScopeLifetime = {
        scope, isCurrent: () => current,
        onRetire: listener => { listeners.add(listener); return { dispose: () => { listeners.delete(listener); } }; },
    };
    return { accountLifetime, retire: () => { current = false; for (const listener of listeners) listener(); } };
}

function projection(bundled = false): PluginUiProjectionModel {
    return {
        ...EMPTY_PLUGIN_UI_PROJECTION,
        installedPackagesById: { [pluginId]: { id: pluginId, displayName: 'Locale', version: '1.2.3', enabled: true,
            occurrenceId: 'occurrence-1', source: bundled ? { kind: 'bundled', locator: '@acme/locale' } : { kind: 'localPath', locator: '/plugins/locale' } } },
        resourcesById: { [`${pluginId}/locale-en`]: { id: 'locale-en', pluginId, occurrenceId: 'occurrence-1',
            resourceKind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json', digest,
            ...(bundled ? { hostAccountOrigin: { ...scope, custodyId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName: '@acme/locale' } } } }
                : { hostOrigin: { machineId: 'machine-a', serverId: scope.serverId, interactionEnabled: true, phase: 'current', executionOrigin: null } }),
        } },
    };
}

function machineResult(): Awaited<ReturnType<PluginSurfaceResourceReadTransport>> {
    return { supported: true, result: {
        ok: true, resource: { pluginId, localId: 'locale-en' }, kind: 'asset',
        contentType: 'application/json', digest, bytesBase64: encodeBase64(bytes, 'base64'),
    } };
}

function machineRead() {
    return vi.fn<PluginSurfaceResourceReadTransport>(async () => machineResult());
}

describe('translation packaged Resource byte sources', () => {
    beforeEach(() => { vi.restoreAllMocks(); expo.fromModule.mockReset(); });

    it('recovers translation copy on explicit demand after transport recovery without replacing the admitted source', async () => {
        const current: PluginUiProjectionModel = { ...projection(), translationsByPluginId: {
            [pluginId]: { id: 'translations', pluginId, contributionKind: 'translations', locales: ['en'],
                resourceIdsByLocale: { en: 'locale-en' } },
        } };
        let available = false;
        const read = vi.fn<PluginSurfaceResourceReadTransport>(async () => {
            if (!available) throw new Error('Machine temporarily unreachable');
            return machineResult();
        });
        const runtime = createPluginUiTranslationRuntime({ projection: current,
            readResourceBytes: createPluginUiTranslationResourceByteReader({ ...lifetime(),
                readCurrentProjection: () => current, resourceRead: read }),
        });
        try {
            await Promise.all([runtime.demand(pluginId, 'en'), runtime.demand(pluginId, 'en')]);
            expect(runtime.getText(pluginId, 'label', 'en')).toBeNull();
            expect(read).toHaveBeenCalledTimes(1);
            available = true;
            runtime.setProjection({ ...current });
            expect(read).toHaveBeenCalledTimes(1);
            await runtime.demand(pluginId, 'en');
            expect(runtime.getText(pluginId, 'label', 'en')).toBe('Hello');
            await runtime.demand(pluginId, 'en');
            expect(read).toHaveBeenCalledTimes(2);
        } finally { runtime.dispose(); }
    });

    it('reads exactly the requested same-plugin packaged Resource through the real contextual RPC adapter', async () => {
        const current = projection();
        const read = machineRead();
        const readBytes = createPluginUiTranslationResourceByteReader({ ...lifetime(), readCurrentProjection: () => current, resourceRead: read });
        expect(read).not.toHaveBeenCalled();
        await expect(readBytes(current, pluginId, 'locale-en')).resolves.toEqual(bytes);
        expect(read).toHaveBeenCalledTimes(1);
        expect(read).toHaveBeenCalledWith('machine-a', expect.objectContaining({
            expectedCallerOccurrenceId: 'occurrence-1', callerPluginId: pluginId,
            resource: { pluginId, localId: 'locale-en' }, serverId: scope.serverId,
        }));
    });

    it('refuses invalid declaration, cross-plugin identity, disabled occurrence and wrong Home before IO', async () => {
        const base = projection();
        const resource = base.resourcesById[`${pluginId}/locale-en`]!;
        const installed = base.installedPackagesById[pluginId]!;
        const read = machineRead();
        for (const bad of [
            { ...base, resourcesById: { [`${pluginId}/locale-en`]: { ...resource, pluginId: 'com.other.plugin' } } },
            { ...base, resourcesById: { [`${pluginId}/locale-en`]: { ...resource, contentType: 'text/plain' } } },
            { ...base, resourcesById: { [`${pluginId}/locale-en`]: { ...resource, path: undefined, scope: 'global' as const } } },
            { ...base, resourcesById: { [`${pluginId}/locale-en`]: { ...resource, occurrenceId: 'other' } } },
            { ...base, installedPackagesById: { [pluginId]: { ...installed, enabled: false } } },
            { ...base, resourcesById: { [`${pluginId}/locale-en`]: { ...resource, hostOrigin: { machineId: 'machine-a', serverId: 'other', phase: 'current', interactionEnabled: true } } } },
        ]) {
            const readBytes = createPluginUiTranslationResourceByteReader({ ...lifetime(), readCurrentProjection: () => bad, resourceRead: read });
            await expect(readBytes(bad, pluginId, 'locale-en')).resolves.toBeNull();
        }
        expect(read).not.toHaveBeenCalled();
    });

    it('cancels on Account retirement and rejects bytes delivered by a retired occurrence', async () => {
        let current = projection();
        const captured = current;
        const account = lifetime();
        let deliver!: (value: Awaited<ReturnType<PluginSurfaceResourceReadTransport>>) => void;
        let signal: AbortSignal | undefined;
        const read: PluginSurfaceResourceReadTransport = async (_machine, options) => {
            signal = options.signal;
            return new Promise(resolve => { deliver = resolve; });
        };
        const readBytes = createPluginUiTranslationResourceByteReader({ ...account, readCurrentProjection: () => current, resourceRead: read });
        const pending = readBytes(captured, pluginId, 'locale-en');
        account.retire();
        expect(signal?.aborted).toBe(true);
        current = EMPTY_PLUGIN_UI_PROJECTION;
        deliver(machineResult());
        await expect(pending).resolves.toBeNull();
    });

    it('rejects late Machine bytes when the occurrence is replaced while the Account remains current', async () => {
        let current = projection();
        const captured = current;
        let deliver!: (value: Awaited<ReturnType<PluginSurfaceResourceReadTransport>>) => void;
        const read: PluginSurfaceResourceReadTransport = async () => new Promise(resolve => { deliver = resolve; });
        const readBytes = createPluginUiTranslationResourceByteReader({ ...lifetime(), readCurrentProjection: () => current, resourceRead: read });
        const pending = readBytes(captured, pluginId, 'locale-en');
        current = EMPTY_PLUGIN_UI_PROJECTION;
        deliver(machineResult());
        await expect(pending).resolves.toBeNull();
    });

    it('reads a portable Resource through the real archive and selected lease owners', async () => {
        const manifest = { schemaVersion: 2, id: pluginId, version: '1.2.3', displayName: 'Locale',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: { resources: [{ id: 'locale-en', kind: 'asset', path: 'assets/i18n/en.json', contentType: 'application/json' }] } };
        const archive = createPackageAssetArchiveV1({ manifest, files: [{ path: 'assets/i18n/en.json', bytes }] });
        if (!archive) throw new Error('Missing archive fixture');
        const opened = openPackageAssetArchiveV1({ expectedDescriptor: archive.descriptor, header: archive.header, body: archive.body });
        if (!opened) throw new Error('Missing opened archive fixture');
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ availabilityCursor: 1,
            intent: { pluginId, desiredVersion: '1.2.3', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
            release: { ref: { pluginId, version: '1.2.3' }, archiveDigestSha256: digest,
                normalizedManifest: manifest, collectionContracts: [], uiSlots: [], packageAssetArchive: archive.descriptor },
            packageAssets: [], uiArtifacts: [], hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 } });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [{ pluginId, response }], materializations: [], snapshots: [] } });
        const reader = store.bind(scope);
        const account = lifetime();
        // The protected Account byte source is an external transport boundary;
        // the real archive opener and selected lease validate its returned bytes.
        const request = vi.fn(async () => opened);
        const source = { readArchive: request };
        const readBytes = createPluginUiTranslationResourceByteReader({ ...account,
            readCurrentProjection: reader.readAccountUiProjection, packageAssets: { reader, source } });
        const current = reader.readAccountUiProjection();
        if (!current) throw new Error('Missing portable Resource projection');
        await expect(readBytes(current, pluginId, 'locale-en')).resolves.toEqual(bytes);
        expect(request).toHaveBeenCalledTimes(1);
        store.retire([pluginId]);
        await expect(readBytes(current, pluginId, 'locale-en')).resolves.toBeNull();
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('verifies bundled plugin/version/resource/digest identity and bytes through Expo without evaluating JSON', async () => {
        const current = projection(true);
        const asset = 7;
        expo.fromModule.mockImplementation(() => ({ downloadAsync: async () => undefined, uri: 'https://assets.example/locale.bundle' }));
        const fetch = vi.fn(async () => new Response(bytes));
        vi.stubGlobal('fetch', fetch);
        try {
            const descriptor = { pluginId, releaseVersion: '1.2.3', resourceId: 'locale-en', digest, asset };
            const readBytes = createPluginUiTranslationResourceByteReader({ ...lifetime(), readCurrentProjection: () => current,
                bundledResources: [descriptor] });
            await expect(readBytes(current, pluginId, 'locale-en')).resolves.toEqual(bytes);
            expect(fetch).toHaveBeenCalledTimes(1);
            for (const wrong of [{ ...descriptor, pluginId: 'other' }, { ...descriptor, releaseVersion: '2.0.0' },
                { ...descriptor, resourceId: 'locale-fr' }, { ...descriptor, digest: `sha256:${'f'.repeat(64)}` as const }]) {
                const readWrong = createPluginUiTranslationResourceByteReader({ ...lifetime(), readCurrentProjection: () => current, bundledResources: [wrong] });
                await expect(readWrong(current, pluginId, 'locale-en')).resolves.toBeNull();
            }
            expect(fetch).toHaveBeenCalledTimes(1);
            fetch.mockResolvedValueOnce(new Response(new Uint8Array([0])));
            await expect(readBytes(current, pluginId, 'locale-en')).resolves.toBeNull();
            expect(fetch).toHaveBeenCalledTimes(2);
        } finally { vi.unstubAllGlobals(); }
    });
});
