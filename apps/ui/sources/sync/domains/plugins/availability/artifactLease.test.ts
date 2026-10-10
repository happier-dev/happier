import { describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';
import { PluginAccountAvailabilityIntentReadResponseV1Schema } from '@happier-dev/protocol/plugins/availability';
import { encodeBase64 } from '@/encryption/base64';
import { createPluginArtifactDaemonSource } from './artifactDaemonSource';

import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    acquirePluginSelectedArtifactLease,
    createPluginArtifactPersistentSource,
    persistVerifiedPluginArtifactLease,
} from './artifactLease';
import * as platformDigest from '@/platform/digest';
import type { PluginArtifactByteRequest, PluginArtifactLeasePersistentScope } from './artifactLease';
import type {
    PluginUiPersistentArtifactRecord,
} from '@/sync/domains/plugins/ui/artifactByteCache';

const scope = { serverId: 'srv-local-a', accountId: 'account-a' } as const;
const createLifetime = () => Object.freeze({
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});
const slot = {
    pluginId: 'com.acme.fixture',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
};

function fixture(
    current: boolean,
    availabilityCursor = 42,
    accountArtifactId: string | null = '00000000-0000-4000-8000-000000000001',
    /** Declares an artifact digest that is not the declared file set's digest. */
    artifactDigestOverride?: `sha256:${string}`,
    pluginId = slot.pluginId,
    entryContent = '<!doctype html><script src="/app.js"></script>',
) {
    const entryPath = 'hosted-web/hosted/index.html';
    const appPath = 'hosted-web/hosted/app.js';
    const entryBytes = new TextEncoder().encode(entryContent);
    const appBytes = new TextEncoder().encode('export const rendered = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: appPath,
            digest: computePluginUiArtifactSha256DigestV1(appBytes),
            byteSize: appBytes.byteLength,
        },
    ];
    const digest = artifactDigestOverride ?? computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: appPath, bytes: appBytes },
    ]);
    const intentRead = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor,
        packageAssets: [],
        hostingCapability: {
            enabled: true,
            maxArtifactBytes: 1024,
            maxAccountBytes: 2048,
        },
        intent: {
            pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: {
            ref: { pluginId, version: '1.2.3' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: pluginId,
                version: '1.2.3',
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                contributionId: slot.contributionId,
                artifactId: 'hosted',
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                hostUiApiRange: '^1.0.0',
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        },
        uiArtifacts: accountArtifactId ? [{
            release: { pluginId, version: '1.2.3' },
            contributionId: slot.contributionId,
            artifactId: 'hosted',
            tier: slot.tier,
            platform: slot.platform,
            accountArtifactId,
            artifactDigest: digest,
            hostUiApiRange: '^1.0.0',
        }] : [],
    });
    return {
        snapshot: {
            availabilityCursor,
            intentReads: current ? [{ pluginId, response: intentRead }] : [],
            materializations: [],
            snapshots: [],
        } satisfies PluginAccountAvailabilitySnapshot,
        artifact: {
            artifactId: 'hosted',
            digest,
            releaseVersion: '1.2.3',
        },
        graph: {
            artifactId: 'hosted',
            tier: slot.tier,
            entry: entryPath,
            files,
            digest,
            builtWith: { staging: 'staticDirectory' as const },
            hostUiApiRange: '^1.0.0',
        },
        bytesByPath: new Map([
            [entryPath, entryBytes],
            [appPath, appBytes],
        ]),
    };
}

/**
 * The real persistent byte custody seam: one retained verified record plus the
 * Artifact custody owner's exact-entry deletion. Tests assert against this adapter rather
 * than a hand-rolled source so a deletion decision cannot hide behind a fake.
 */
function persistentCustody(record: ReturnType<typeof fixture>) {
    const removePersistentArtifact = vi.fn(async () => {});
    const read = vi.fn(async (): Promise<PluginUiPersistentArtifactRecord | null> => Object.freeze({
        persistentIdentity: Object.freeze({
            accountScope: scope,
            artifactDigest: record.artifact.digest,
        }),
        bytes: record.bytesByPath.get(record.graph.entry)!,
        entryRelativePath: record.graph.entry,
        files: Object.freeze(record.graph.files.map((file) => Object.freeze({
            relativePath: file.relativePath,
            digest: file.digest,
            byteSize: file.byteSize,
            bytes: record.bytesByPath.get(file.relativePath)!,
        }))),
    }));
    const persistent: PluginArtifactLeasePersistentScope = Object.freeze({
        scope,
        store: Object.freeze({
            read,
            write: async () => 'persisted' as const,
            remove: removePersistentArtifact,
            removeAccount: async () => {},
        }),
        isCurrent: () => true,
        removePersistentArtifact,
    });
    const source = createPluginArtifactPersistentSource({ scope: persistent });
    return { persistent, source, read, removePersistentArtifact };
}

function daemonResponse(record: ReturnType<typeof fixture>) {
    return {
        ok: true as const,
        artifactFamily: 'hostedWeb' as const,
        cacheIdentity: { artifactDigest: record.graph.digest },
        artifact: {
            artifactKind: 'hostedWebAsset' as const,
            digest: record.graph.digest,
            byteSize: record.bytesByPath.get(record.graph.entry)!.byteLength,
        },
        files: record.graph.files.map((file) => ({
            ...file,
            bytesBase64: encodeBase64(record.bytesByPath.get(file.relativePath)!, 'base64'),
        })),
    };
}

describe('Artifact selected handle lease', () => {
    it('awaits platform integrity work and refuses an Account retired while hashing', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        let lifetimeCurrent = true;
        let retireAccount!: () => void;
        let releaseDigest!: () => void;
        const waiting = new Promise<void>((resolve) => { releaseDigest = resolve; });
        const realDigest = platformDigest.digest;
        const hashing = vi.spyOn(platformDigest, 'digest').mockImplementation(async (algorithm, bytes) => {
            await waiting;
            return realDigest(algorithm, bytes);
        });
        try {
            const acquired = acquirePluginSelectedArtifactLease({
                reader: store.bind(scope),
                accountLifetime: {
                    isCurrent: () => lifetimeCurrent,
                    onRetire: (listener) => {
                        retireAccount = listener;
                        return { dispose: () => {} };
                    },
                },
                slot,
                artifactGraph: current.graph,
                sources: [{ kind: 'appExact', fetch: async () => current.bytesByPath }],
            });
            // Flush the acquisition's ordinary async source boundary. Hashing
            // itself remains pending at the genuine platform boundary.
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            expect(hashing).toHaveBeenCalled();
            lifetimeCurrent = false;
            retireAccount();
            releaseDigest();
            await expect(acquired).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        } finally {
            releaseDigest();
            hashing.mockRestore();
        }
    });

    function daemonProjectionSelection(
        current: ReturnType<typeof fixture>,
        isCurrent = () => true,
    ) {
        return Object.freeze({
            occurrenceId: 'com.acme.fixture-occurrence-a',
            artifact: Object.freeze({
                pluginId: slot.pluginId,
                contributionId: slot.contributionId,
                artifactId: current.graph.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                digest: current.graph.digest,
                hostUiApiRange: current.graph.hostUiApiRange,
                releaseVersion: '1.2.3',
            }),
            isCurrent,
        });
    }

    it('uses a bundled daemon projection to select exact app bytes without an Account release', async () => {
        const current = fixture(false);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const appRead = vi.fn(async () => current.bytesByPath);

        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            daemonProjectionSelection: daemonProjectionSelection(current),
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', fetch: appRead }],
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                artifact: expect.objectContaining({ digest: current.graph.digest }),
                sourceKind: 'appExact',
            },
        });
        expect(appRead).toHaveBeenCalledTimes(1);
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('uses a trusted development daemon projection to select daemon bytes without an Account release', async () => {
        const current = fixture(false);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const daemonRead = vi.fn(async () => current.bytesByPath);

        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            daemonProjectionSelection: daemonProjectionSelection(current),
            artifactGraph: current.graph,
            sources: [{ kind: 'daemon', fetch: daemonRead }],
        });

        expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(daemonRead).toHaveBeenCalledTimes(1);
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('retires daemon-projection selection when its exact occurrence is no longer current', async () => {
        const current = fixture(false);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        let occurrenceCurrent = true;
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            daemonProjectionSelection: daemonProjectionSelection(current, () => occurrenceCurrent),
            artifactGraph: current.graph,
            sources: [{
                kind: 'appExact',
                fetch: async () => current.bytesByPath,
            }],
        });
        if (acquired.kind !== 'available') throw new Error('expected daemon-projection lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        occurrenceCurrent = false;

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledTimes(1);
    });

    it('revokes the lease itself when its Account lifetime retires', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        let lifetimeCurrent = true;
        const retireListeners = new Set<() => void>();
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            accountLifetime: {
                isCurrent: () => lifetimeCurrent,
                onRetire: (listener) => {
                    retireListeners.add(listener);
                    return { dispose: () => retireListeners.delete(listener) };
                },
            },
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', fetch: async () => current.bytesByPath }],
        });
        if (acquired.kind !== 'available') throw new Error('expected Account-release lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        lifetimeCurrent = false;
        for (const listener of retireListeners) listener();

        expect(revoked).toHaveBeenCalledTimes(1);
        expect(acquired.lease.isCurrent()).toBe(false);
        expect(retireListeners.size).toBe(0);
    });

    it('does not fall back to Account release selection for a stale daemon-owned occurrence', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const appRead = vi.fn(async () => current.bytesByPath);

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            daemonProjectionSelection: daemonProjectionSelection(current, () => false),
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', fetch: appRead }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(appRead).not.toHaveBeenCalled();
    });

    it('does not let exact app bytes select themselves without Account or daemon-projection admission', async () => {
        const current = fixture(false);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const appRead = vi.fn(async () => current.bytesByPath);

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', fetch: appRead }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(appRead).not.toHaveBeenCalled();
    });

    it('continues to select portable installed UI from the Account release', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{
                kind: 'appExact',
                fetch: async () => current.bytesByPath,
            }],
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: { artifact: expect.objectContaining({ releaseVersion: '1.2.3' }) },
        });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('shares one in-flight verified acquisition for concurrent mounts of the same selected digest', async () => {
        const sharedLifetime = createLifetime();
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const reader = store.bind(scope);
        let releaseFirstRead!: () => void;
        const firstReadStarted = new Promise<void>((resolve) => {
            releaseFirstRead = resolve;
        });
        let firstRead = true;
        const readFile = vi.fn(async () => {
            if (firstRead) {
                firstRead = false;
                await firstReadStarted;
            }
            return current.bytesByPath;
        });
        const acquire = () => acquirePluginSelectedArtifactLease({
            reader,
            accountLifetime: sharedLifetime,
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact' as const, fetch: readFile }],
        });

        const first = acquire();
        const second = acquire();
        releaseFirstRead();
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.kind).toBe('available');
        expect(secondResult.kind).toBe('available');
        expect(readFile).toHaveBeenCalledTimes(1);
        if (firstResult.kind === 'available') firstResult.lease.dispose();
        if (secondResult.kind === 'available') secondResult.lease.dispose();
    });

    it('does not retain settled daemon bytes when persistent storage is unavailable', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const accountLifetime = createLifetime();
        const daemonRead = vi.fn(async () => daemonResponse(current));
        const daemonSource = () => createPluginArtifactDaemonSource({
            transport: { machineId: 'machine-a', serverId: scope.serverId },
            family: 'hostedWeb', fetchArtifactBytes: daemonRead,
        });
        const acquire = (graph = current.graph) => acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            accountLifetime,
            slot,
            artifactGraph: graph,
            sources: [daemonSource()],
        });
        const readAndClose = async () => {
            const acquired = await acquire();
            expect(acquired.kind).toBe('available');
            if (acquired.kind !== 'available') return;
            const read = await acquired.lease.readFile(current.graph.entry);
            expect(read).toMatchObject({ kind: 'available', bytes: current.bytesByPath.get(current.graph.entry) });
            acquired.lease.dispose();
        };
        expect(daemonRead).not.toHaveBeenCalled();
        for (let mount = 0; mount < 3; mount += 1) {
            await readAndClose();
        }
        expect(daemonRead).toHaveBeenCalledTimes(3);

        await expect(acquire({
            ...current.graph,
            files: current.graph.files.map((file) => ({ ...file, byteSize: file.byteSize + 1 })),
        })).resolves.toMatchObject({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        await expect(acquire({
            ...current.graph,
            files: [current.graph.files[0]!, current.graph.files[0]!],
        })).resolves.toMatchObject({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
    });

    it('continues a shared digest acquisition through a surviving occurrence source', async () => {
        const sharedLifetime = createLifetime();
        const current = fixture(false);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const reader = store.bind(scope);
        let firstCurrent = true;
        const firstReadBlocked = new Promise<void>(() => {});
        const firstLifetime = new AbortController();
        let firstReadStarted!: () => void;
        const firstReadDidStart = new Promise<void>((resolve) => {
            firstReadStarted = resolve;
        });
        const firstRead = vi.fn(async () => {
            firstReadStarted();
            await firstReadBlocked;
            if (!firstCurrent) return null;
            return current.bytesByPath;
        });
        const secondRead = vi.fn(async () => current.bytesByPath);
        const firstSelection = daemonProjectionSelection(current, () => firstCurrent);
        const secondSelection = Object.freeze({
            ...daemonProjectionSelection(current),
            occurrenceId: 'com.acme.fixture-occurrence-b',
        });

        const first = acquirePluginSelectedArtifactLease({
            reader,
            accountLifetime: sharedLifetime,
            signal: firstLifetime.signal,
            slot,
            daemonProjectionSelection: firstSelection,
            artifactGraph: current.graph,
            sources: [{ kind: 'daemon', fetch: firstRead }],
        });
        await firstReadDidStart;
        const second = acquirePluginSelectedArtifactLease({
            reader,
            accountLifetime: sharedLifetime,
            slot,
            daemonProjectionSelection: secondSelection,
            artifactGraph: current.graph,
            sources: [{ kind: 'daemon', fetch: secondRead }],
        });
        firstCurrent = false;
        firstLifetime.abort();
        await vi.waitFor(() => expect(secondRead).toHaveBeenCalledTimes(1));

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(secondResult).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
        expect(secondRead).toHaveBeenCalledTimes(1);
        expect(firstResult).toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        if (secondResult.kind === 'available') secondResult.lease.dispose();
    });

    it('uses the surviving plugin and Account-hosted link when distinct plugins share identical bytes', async () => {
        const current = fixture(true);
        const otherSlot = { ...slot, pluginId: 'com.acme.other' };
        const otherLink = '00000000-0000-4000-8000-000000000002';
        const other = fixture(true, 42, otherLink, undefined, otherSlot.pluginId);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({
            scope,
            snapshot: {
                ...current.snapshot,
                intentReads: [...current.snapshot.intentReads, ...other.snapshot.intentReads],
            },
        });
        const accountLifetime = createLifetime();
        const retired = new AbortController();
        let started!: () => void;
        const sourceStarted = new Promise<void>((resolve) => { started = resolve; });
        // Byte transport boundaries qualify their plugin/link independently;
        // the real acquisition owner still shares and verifies the same digest.
        const firstRead = async () => {
            started();
            return await new Promise<null>(() => {});
        };
        const secondRead = async (request: PluginArtifactByteRequest) => (
            request.artifact.pluginId === otherSlot.pluginId && request.accountHostedArtifactId === otherLink
                ? other.bytesByPath : null
        );
        const first = acquirePluginSelectedArtifactLease({
            reader: store.bind(scope), accountLifetime, slot, signal: retired.signal,
            artifactGraph: current.graph, sources: [{ kind: 'accountHosted', fetch: firstRead }],
        });
        await sourceStarted;
        const second = acquirePluginSelectedArtifactLease({
            reader: store.bind(scope), accountLifetime, slot: otherSlot,
            artifactGraph: other.graph, sources: [{ kind: 'accountHosted', fetch: secondRead }],
        });
        retired.abort();
        await expect(first).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        const acquired = await second;
        expect(acquired).toMatchObject({ kind: 'available', lease: { artifact: { pluginId: otherSlot.pluginId } } });
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('settles a retired joined reader without cancelling the current source reader', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const accountLifetime = createLifetime();
        const retired = new AbortController();
        let release!: () => void;
        const pending = new Promise<void>((resolve) => { release = resolve; });
        let sourceSignal: AbortSignal | undefined;
        const read = vi.fn(async (request: { signal?: AbortSignal }) => {
            sourceSignal = request.signal;
            await pending;
            return current.bytesByPath;
        });
        const acquire = (signal?: AbortSignal) => acquirePluginSelectedArtifactLease({
            reader: store.bind(scope), accountLifetime, slot, signal,
            artifactGraph: current.graph, sources: [{ kind: 'daemon', fetch: read }],
        });
        const first = acquire();
        const second = acquire(retired.signal);
        retired.abort();
        let retiredResult: Awaited<typeof second> | undefined;
        void second.then((result) => { retiredResult = result; });
        try {
            await vi.waitFor(() => expect(retiredResult).toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' }));
            expect(sourceSignal?.aborted).toBe(false);
        } finally {
            release();
        }
        const acquired = await first;
        expect(acquired.kind).toBe('available');
        expect(read).toHaveBeenCalledTimes(1);
        if (acquired.kind === 'available') acquired.lease.dispose();
    });

    it('uses persistent custody for remounts and reacquires bytes after that owner evicts them', async () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const accountLifetime = createLifetime();
        const builds = [0, 1, 2].map((build) => {
            const current = fixture(true, 42 + build, null, undefined, slot.pluginId, `<p>Build ${build}</p>`);
            const custody = persistentCustody(current);
            const daemonRead = vi.fn(async () => current.bytesByPath);
            const acquire = () => acquirePluginSelectedArtifactLease({
                reader: store.bind(scope), accountLifetime, slot,
                artifactGraph: current.graph,
                sources: [custody.source, { kind: 'daemon', fetch: daemonRead }],
            });
            return { current, custody, daemonRead, acquire };
        });
        for (const build of builds) {
            store.replace({ scope, snapshot: build.current.snapshot });
            for (let mount = 0; mount < 2; mount += 1) {
                const acquired = await build.acquire();
                expect(acquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'persistentCache' } });
                if (acquired.kind === 'available') acquired.lease.dispose();
            }
            expect(build.daemonRead).not.toHaveBeenCalled();
            store.clear();
            build.custody.read.mockResolvedValue(null);
        }
        // All mounted leases and their persistent records are gone. Each
        // historical digest must go back through the byte custody/source owner.
        for (const build of builds) {
            store.replace({ scope, snapshot: build.current.snapshot });
            const afterEviction = await build.acquire();
            expect(afterEviction).toMatchObject({ kind: 'available', lease: { sourceKind: 'daemon' } });
            expect(build.daemonRead).toHaveBeenCalledTimes(1);
            if (afterEviction.kind === 'available') afterEviction.lease.dispose();
        }
    });

    it('retries unavailable bytes and retires current leases with the Account', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        let active = true;
        const listeners = new Set<() => void>();
        const accountLifetime = {
            isCurrent: () => active,
            onRetire: (listener: () => void) => {
                listeners.add(listener);
                return { dispose: () => { listeners.delete(listener); } };
            },
        };
        const daemonRead = vi.fn(async () => daemonResponse(current));
        daemonRead.mockImplementationOnce(async () => { throw new Error('transport unavailable'); });
        const daemonSource = () => createPluginArtifactDaemonSource({
            transport: { machineId: 'machine-a', serverId: scope.serverId },
            family: 'hostedWeb', fetchArtifactBytes: daemonRead,
        });
        const acquire = () => acquirePluginSelectedArtifactLease({
            reader: store.bind(scope), accountLifetime, slot, artifactGraph: current.graph,
            sources: [daemonSource()],
        });
        await expect(acquire()).resolves.toMatchObject({ kind: 'unavailable', code: 'artifact_source_unavailable' });
        const first = await acquire();
        expect(first.kind).toBe('available');
        if (first.kind === 'available') first.lease.dispose();
        const reused = await acquire();
        expect(reused.kind).toBe('available');
        expect(daemonRead).toHaveBeenCalledTimes(3);
        active = false;
        for (const listener of listeners) listener();
        if (reused.kind === 'available') {
            await expect(reused.lease.readFile(current.graph.entry)).resolves.toMatchObject({ kind: 'unavailable' });
        }
        await expect(acquire()).resolves.toMatchObject({ kind: 'unavailable' });
        expect(daemonRead).toHaveBeenCalledTimes(3);
        expect(listeners.size).toBe(0);
    });

    it('retires a named plugin lease immediately without revoking an unrelated plugin lease', async () => {
        const first = fixture(true);
        const secondSlot = { ...slot, pluginId: 'com.acme.other' };
        const second = fixture(true, 42, null, undefined, secondSlot.pluginId);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({
            scope,
            snapshot: {
                ...first.snapshot,
                intentReads: [...first.snapshot.intentReads, ...second.snapshot.intentReads],
            },
        });
        const reader = store.bind(scope);
        const acquire = (selectedSlot: typeof slot, current: ReturnType<typeof fixture>) => (
            acquirePluginSelectedArtifactLease({
                reader,
                slot: selectedSlot,
                artifactGraph: current.graph,
                sources: [{
                    kind: 'appExact',
                    fetch: async () => current.bytesByPath,
                }],
            })
        );
        const firstLease = await acquire(slot, first);
        const secondLease = await acquire(secondSlot, second);
        if (firstLease.kind !== 'available' || secondLease.kind !== 'available') {
            throw new Error('Expected both current Artifact leases');
        }
        let firstRevoked = false;
        let secondRevoked = false;
        firstLease.lease.onRevoke(() => { firstRevoked = true; });
        secondLease.lease.onRevoke(() => { secondRevoked = true; });

        store.retire([slot.pluginId]);

        expect(firstRevoked).toBe(true);
        expect(secondRevoked).toBe(false);
        expect(firstLease.lease.isCurrent()).toBe(false);
        expect(secondLease.lease.isCurrent()).toBe(true);
        await expect(secondLease.lease.readFile(second.graph.entry)).resolves.toMatchObject({ kind: 'available' });
        secondLease.lease.dispose();
    });

    it('does not let persistent bytes select themselves without a current Availability Artifact fact', async () => {
        const current = fixture(false);
        const persistentRead = vi.fn(async () => current.bytesByPath);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'persistentCache', fetch: persistentRead }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(persistentRead).not.toHaveBeenCalled();
    });

    it('materializes one verified exact Artifact source in source order and revokes it on explicit withdrawal', async () => {
        const current = fixture(true);
        const appRead = vi.fn(async () => current.bytesByPath);
        const persistentRead = vi.fn(async () => current.bytesByPath);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [
                { kind: 'persistentCache', fetch: persistentRead },
                { kind: 'appExact', fetch: appRead },
            ],
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            lease: {
                artifact: expect.objectContaining(current.artifact),
            },
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        expect(acquired.lease.artifact).not.toHaveProperty('accountArtifactId');
        expect(persistentRead).toHaveBeenCalledTimes(1);
        expect(appRead).not.toHaveBeenCalled();
        await expect(acquired.lease.readFile('hosted-web/hosted/app.js')).resolves.toMatchObject({
            kind: 'available',
            bytes: current.bytesByPath.get('hosted-web/hosted/app.js'),
        });

        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);
        store.retire([slot.pluginId]);

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledTimes(1);
        await expect(acquired.lease.readFile('hosted-web/hosted/app.js')).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_lease_revoked',
        });
    });

    it('refuses a source whose files each verify but whose complete declared set does not', async () => {
        // Every per-file digest is canonical; only the artifact's whole-graph
        // digest disagrees with the bytes the source hands over.
        const current = fixture(true, 42, null, `sha256:${'e'.repeat(64)}`);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const readFile = vi.fn(async () => current.bytesByPath);

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{ kind: 'appExact', fetch: readFile }],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        expect(readFile).toHaveBeenCalledTimes(1);
    });

    it('keeps an exact Artifact lease current across an unrelated Availability cursor advance', async () => {
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{
                kind: 'appExact',
                fetch: async () => current.bytesByPath,
            }],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        store.replace({ scope, snapshot: fixture(true, 43).snapshot });

        expect(acquired.lease.isCurrent()).toBe(true);
        expect(revoked).not.toHaveBeenCalled();
    });

    it('retires a persistent Artifact lease on an ordinary Availability withdrawal without deleting its verified bytes', async () => {
        // Bootstrap, resume, and every level-triggered AccountChange withdraw the
        // active projection before one coalesced refresh re-supplies it. That is
        // currentness loss, not revocation of the retained bytes: deleting them
        // here costs the same Account a full re-download seconds later.
        const current = fixture(true);
        const custody = persistentCustody(current);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [custody.source],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
        const revoked = vi.fn();
        acquired.lease.onRevoke(revoked);

        store.clear();

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(revoked).toHaveBeenCalledTimes(1);
        expect(custody.removePersistentArtifact).not.toHaveBeenCalled();

        // The same Account's next verified snapshot re-admits the identical
        // Artifact and the retained bytes still satisfy it with no re-acquisition.
        store.replace({ scope, snapshot: fixture(true, 43).snapshot });
        const reacquireCustody = persistentCustody(current);
        const daemonRead = vi.fn(async () => null);
        const reacquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [reacquireCustody.source, { kind: 'daemon', fetch: daemonRead }],
        });
        expect(reacquired).toMatchObject({ kind: 'available', lease: { sourceKind: 'persistentCache' } });
        expect(daemonRead).not.toHaveBeenCalled();
        expect(reacquireCustody.removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('leaves a superseded digest to the one owner that holds both verified snapshots', async () => {
        const current = fixture(true);
        const superseded = fixture(true, 43, null, `sha256:${'b'.repeat(64)}`);
        const custody = persistentCustody(current);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [custody.source],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');

        store.replace({ scope, snapshot: superseded.snapshot });

        expect(acquired.lease.isCurrent()).toBe(false);
        expect(custody.removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('still deletes the exact retained entry whose declared file graph no longer verifies', async () => {
        // Corruption is the lease-local deletion trigger the retirement rule
        // deliberately keeps: these bytes can never satisfy the current digest.
        const current = fixture(true);
        const custody = persistentCustody(current);
        const corrupted = Object.freeze({
            ...custody.source,
            fetch: async (request: Parameters<typeof custody.source.fetch>[0]) => {
                await custody.source.fetch(request);
                return new Map([...current.bytesByPath].map(
                    ([relativePath, bytes]) => [relativePath, new Uint8Array(bytes.byteLength)] as const,
                ));
            },
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });

        await expect(acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [corrupted],
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_source_integrity_invalid' });
        expect(custody.removePersistentArtifact).toHaveBeenCalledTimes(1);
    });

    it('keeps freshly persisted verified bytes when the projection withdraws during the write', async () => {
        // The acquisition that just paid for these bytes must not undo itself
        // because a level-triggered AccountChange withdrew the projection while
        // the write was in flight; the Account is unchanged and the very next
        // refresh re-admits the same Artifact.
        const current = fixture(true);
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: current.snapshot });
        const acquired = await acquirePluginSelectedArtifactLease({
            reader: store.bind(scope),
            slot,
            artifactGraph: current.graph,
            sources: [{
                kind: 'daemon',
                fetch: async () => current.bytesByPath,
            }],
        });
        if (acquired.kind !== 'available') throw new Error('expected Artifact lease');

        const removePersistentArtifact = vi.fn(async () => {});
        const written: unknown[] = [];
        const persistent: PluginArtifactLeasePersistentScope = Object.freeze({
            scope,
            store: Object.freeze({
                read: async () => null,
                write: async (record: PluginUiPersistentArtifactRecord) => {
                    written.push(record);
                    store.clear();
                    return 'persisted' as const;
                },
                remove: removePersistentArtifact,
                removeAccount: async () => {},
            }),
            isCurrent: () => true,
            removePersistentArtifact,
        });

        await persistVerifiedPluginArtifactLease({ lease: acquired.lease, persistent });

        expect(written).toHaveLength(1);
        expect(acquired.lease.isCurrent()).toBe(false);
        expect(removePersistentArtifact).not.toHaveBeenCalled();
    });

    it('keeps persistent and app-exact Artifact leases current when Account-hosted link provenance changes', async () => {
        const initial = fixture(true, 42, '00000000-0000-4000-8000-000000000001');
        const withoutLink = fixture(true, 43, null);
        const addedLink = fixture(true, 44, '00000000-0000-4000-8000-000000000002');
        const replacementLink = fixture(true, 45, '00000000-0000-4000-8000-000000000003');
        for (const sourceKind of ['persistentCache', 'appExact'] as const) {
            const store = createPluginAccountAvailabilityReaderStore();
            const custody = persistentCustody(initial);
            const source = sourceKind === 'persistentCache'
                ? custody.source
                : {
                    kind: 'appExact' as const,
                    fetch: async () => initial.bytesByPath,
                };
            store.replace({ scope, snapshot: initial.snapshot });
            const acquired = await acquirePluginSelectedArtifactLease({
                reader: store.bind(scope),
                slot,
                artifactGraph: initial.graph,
                sources: [source],
            });
            if (acquired.kind !== 'available') throw new Error('expected Artifact lease');
            const revoked = vi.fn();
            acquired.lease.onRevoke(revoked);

            for (const next of [withoutLink, addedLink, replacementLink]) {
                store.replace({ scope, snapshot: next.snapshot });
                expect(acquired.lease.isCurrent()).toBe(true);
            }

            expect(revoked).not.toHaveBeenCalled();
            expect(custody.removePersistentArtifact).not.toHaveBeenCalled();
        }
    });
});
