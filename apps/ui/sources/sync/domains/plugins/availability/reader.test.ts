import { describe, expect, it, onTestFinished, vi } from 'vitest';
import * as availability from '@happier-dev/protocol/plugins/availability';
import * as canonicalJson from '@happier-dev/protocol/crypto/canonicalJson';
import * as uiProjection from '@/sync/domains/plugins/ui/projection';

import {
    createPackageAssetArchiveV1,
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginMachineMaterializationV1Schema,
    PluginPortableReleaseManifestV1Schema,
} from '@happier-dev/protocol/plugins/availability';

import {
    createPluginAccountAvailabilityReader,
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import { normalizePluginUiDestinationBindingV1, PluginUiArtifactsManifestEntryV2Schema } from '@happier-dev/protocol/plugins/ui';
import { artifactHtmlBundleFromBodyV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { admitDeclarativeStaticModel } from '@/components/plugins/surfaces/declarativeStaticModel';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';

const scope = { serverId: 'srv-local-a', accountId: 'account-a' } as const;

const hostedSlot = {
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
};
const artifactDigest = `sha256:${'b'.repeat(64)}`;

function intentRead() {
    return PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
        availabilityCursor: 42,
        hostingCapability: {
            enabled: true,
            maxArtifactBytes: 1024,
            maxAccountBytes: 2048,
        },
        intent: {
            pluginId: 'com.acme.fixture',
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: {
            ref: { pluginId: 'com.acme.fixture', version: '1.2.3' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: 'com.acme.fixture',
                version: '1.2.3',
                displayName: 'Fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                ...hostedSlot,
                artifactId: 'hosted',
                artifactDigest,
                hostUiApiRange: '^1.0.0',
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'c'.repeat(64)}`,
                resources: [],
            },
        },
        packageAssets: [],
        uiArtifacts: [{
            release: { pluginId: 'com.acme.fixture', version: '1.2.3' },
            ...hostedSlot,
            artifactId: 'hosted',
            accountArtifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
    });
}

function snapshot(overrides: Partial<PluginAccountAvailabilitySnapshot> = {}): PluginAccountAvailabilitySnapshot {
    const materialization = PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: 'srv_fixture',
        machineId: 'machine-1',
        materializationId: 'install-1',
        pluginId: 'com.acme.fixture',
        version: '1.2.3',
        sourceClass: 'registryPackage',
        portableRelease: true,
        uiArtifacts: [{
            contributionId: 'hosted',
            artifactId: 'hosted',
            tier: 'hostedWeb',
            platform: 'web',
            artifactDigest: `sha256:${'a'.repeat(64)}`,
            hostUiApiRange: '^1.0.0',
        }],
        enabled: false,
        trustState: 'revoked',
        observedAt: 1_700_000_000_000,
    });
    return {
        availabilityCursor: 42,
        intentReads: [],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            materializations: [materialization],
        }],
        ...overrides,
    };
}

describe('Plugin Account Availability reader', () => {
    it('publishes stable semantic UI inputs while observations advance and real declaration/lifecycle changes remain visible', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        expect(reader.readUiProjectionInputs).toEqual(expect.any(Function));
        expect(reader.readUiProjectionInputs()).toBeNull();
        const base = snapshot();
        const materialization = PluginMachineMaterializationV1Schema.parse({
            ...base.materializations[0], portableRelease: false, sourceClass: 'localPath',
            enabled: true, trustState: 'trusted',
            declaredManifest: intentRead().release!.normalizedManifest, declaredUiEntries: {},
        });
        const value = snapshot({ materializations: [materialization],
            snapshots: [{ ...base.snapshots[0]!, materializations: [materialization] }],
        });
        store.replace({ scope, snapshot: value });
        const first = reader.readUiProjectionInputs();
        expect(first?.installedPlugins?.[0]?.installations[0]?.declaration?.id).toBe('com.acme.fixture');
        const notification = vi.fn();
        const unsubscribe = store.subscribe(notification);
        let observation = reader.getObservationSnapshot();
        for (let index = 1; index <= 20; index += 1) {
            const row = { ...materialization, observedAt: materialization.observedAt + index };
            store.replace({ scope, snapshot: { ...value, availabilityCursor: 42 + index,
                materializations: [row], snapshots: [{ ...value.snapshots[0]!, materializations: [row] }],
            } });
            expect(reader.readUiProjectionInputs()).toBe(first);
            expect(reader.getObservationSnapshot()).not.toBe(observation);
            observation = reader.getObservationSnapshot();
            expect(reader.readMaterializations()).toMatchObject({ availabilityCursor: 42 + index,
                materializations: [{ observedAt: materialization.observedAt + index }],
            });
        }
        expect(notification).toHaveBeenCalledTimes(20);
        const changed = { ...materialization, declaredManifest: { ...materialization.declaredManifest!, displayName: 'Changed external declaration' } };
        store.replace({ scope, snapshot: { ...value, materializations: [changed] } });
        const declared = reader.readUiProjectionInputs();
        expect(declared).not.toBe(first);
        expect(declared?.installedPlugins?.[0]?.installations[0]?.declaration?.displayName).toBe('Changed external declaration');
        store.replace({ scope, snapshot: { ...value, materializations: [{ ...changed, trustState: 'revoked' }] } });
        const revoked = reader.readUiProjectionInputs();
        expect(revoked).not.toBe(declared);
        expect(revoked?.materializations[0]?.trustState).toBe('revoked');
        store.retire([materialization.pluginId]);
        expect(reader.readUiProjectionInputs()).not.toBe(revoked);
        store.replace({ scope: { ...scope, accountId: 'account-b' }, snapshot: value });
        expect(reader.readUiProjectionInputs()).toBeNull();
        store.clear();
        expect(store.bind({ ...scope, accountId: 'account-b' }).readUiProjectionInputs()).toBeNull();
        unsubscribe();
    });

    it('keeps equal replacement publications quiet while publishing cursor, refresh-status and scope changes', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const createSnapshot = () => snapshot({ intentReads: [{ pluginId: 'com.acme.fixture', response: intentRead() }] });
        store.replace({ scope, snapshot: createSnapshot() });
        const reader = store.bind(scope);
        const previous = store.getSnapshot();
        const observation = reader.getObservationSnapshot();
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);

        store.replace({ scope: { ...scope }, snapshot: createSnapshot() });
        expect(notify).not.toHaveBeenCalled();
        expect(store.getSnapshot()).toBe(previous);
        expect(reader.getObservationSnapshot()).toBe(observation);

        store.replace({ scope, snapshot: createSnapshot(), failedPluginIds: ['com.acme.fixture'] });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()?.stalePluginIds).toEqual(['com.acme.fixture']);
        const failed = store.getSnapshot();
        store.replace({ scope, snapshot: createSnapshot(), failedPluginIds: ['com.acme.fixture'] });
        expect(notify).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()).toBe(failed);

        store.replace({ scope, snapshot: createSnapshot() });
        expect(notify).toHaveBeenCalledTimes(2);
        store.replace({ scope, snapshot: { ...createSnapshot(), availabilityCursor: 43 } });
        expect(notify).toHaveBeenCalledTimes(3);
        expect(reader.getObservationSnapshot()).not.toBe(observation);
        store.replace({ scope: { ...scope, accountId: 'account-b' }, snapshot: createSnapshot() });
        expect(notify).toHaveBeenCalledTimes(4);
        expect(reader.readMaterializations()).toEqual({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
        unsubscribe();
    });

    it('publishes empty inventory census transitions without manufacturing a loaded projection before admission', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        expect(reader.readUiProjectionInputs).toEqual(expect.any(Function));
        const empty = snapshot({ materializations: [], snapshots: [], inventoryComplete: false });
        store.replace({ scope, snapshot: empty });
        const incomplete = reader.readUiProjectionInputs();
        expect(incomplete).toMatchObject({ materializations: [], installedPlugins: [], accountUiProjection: null });
        store.replace({ scope, snapshot: { ...empty, inventoryComplete: true } });
        expect(reader.readUiProjectionInputs()).not.toBe(incomplete);
        const complete = reader.readUiProjectionInputs();
        store.replace({ scope, snapshot: { ...empty, inventoryComplete: true, availabilityCursor: 43 } });
        expect(reader.readUiProjectionInputs()).toBe(complete);
        let cursor = 43;
        for (const inventoryComplete of [undefined, true, undefined]) {
            store.replace({ scope, snapshot: snapshot({ materializations: [], snapshots: [],
                availabilityCursor: ++cursor,
                ...(inventoryComplete === undefined ? {} : { inventoryComplete }),
            }) });
            expect(reader.readUiProjectionInputs()).toBe(complete);
        }
        store.replace({ scope, snapshot: { ...empty, availabilityCursor: ++cursor } });
        const incompleteAgain = reader.readUiProjectionInputs();
        expect(incompleteAgain).not.toBe(complete);
        store.replace({ scope, snapshot: snapshot({ materializations: [], snapshots: [], availabilityCursor: ++cursor }) });
        expect(reader.readUiProjectionInputs()).not.toBe(incompleteAgain);
        store.clear();
        expect(reader.readUiProjectionInputs()).toBeNull();
    });

    it('publishes retirement and clearing once per real transition and restores retired authority on replacement', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const notify = vi.fn();
        const unsubscribe = store.subscribe(notify);
        store.clear();
        expect(notify).not.toHaveBeenCalled();
        const value = snapshot({ intentReads: [{ pluginId: 'com.acme.fixture', response: intentRead() }] });
        store.replace({ scope, snapshot: value });
        const reader = store.bind(scope);
        store.retire(['com.acme.fixture']);
        const retired = store.getSnapshot();
        expect(notify).toHaveBeenCalledTimes(2);
        expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' }).kind).toBe('unavailable');
        store.retire(['com.acme.fixture']);
        expect(notify).toHaveBeenCalledTimes(2);
        expect(store.getSnapshot()).toBe(retired);
        store.replace({ scope, snapshot: value });
        expect(notify).toHaveBeenCalledTimes(3);
        expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' }).kind).toBe('available');
        store.clear();
        expect(notify).toHaveBeenCalledTimes(4);
        expect(reader.getObservationSnapshot()).toBeNull();
        store.clear();
        expect(notify).toHaveBeenCalledTimes(4);
        unsubscribe();
    });

    it('acquires app-owned bundled declarations only on first publication and updates pre-bound readers', () => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse(intentRead().release!.normalizedManifest);
        const bundle = {
            pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
            packageName: '@happier-dev/plugins-fixture', normalizedManifest: manifest, entriesById: {}, artifactGraphs: [],
        };
        let acquisitions = 0;
        const input = {
            hostBundledUi: undefined,
            loadHostBundledUi: () => { acquisitions += 1; return [bundle]; },
        };
        const store = createPluginAccountAvailabilityReaderStore(input);
        const reader = store.bind(scope);
        expect(reader.readCurrentAccountExecutionDeclarations()).toEqual([]);
        expect(reader.readCurrentArtifact({ pluginId: manifest.id, ...hostedSlot, platform: 'web' }).kind).toBe('unavailable');
        store.clear();
        store.retire([manifest.id]);
        expect(acquisitions).toBe(0);

        const published: string[] = [];
        const unsubscribe = reader.subscribe(() => published.push(reader.readCurrentAccountExecution(manifest.id).kind));
        const empty = snapshot({ intentReads: [], materializations: [], snapshots: [] });
        store.replace({ scope, snapshot: empty });
        expect(reader.readCurrentAccountExecution(manifest.id)).toMatchObject({ kind: 'available', manifest });
        expect(reader.readCurrentAccountExecutionDeclarations()).toHaveLength(1);
        expect(published).toEqual(['available']);
        expect(acquisitions).toBe(1);

        store.clear();
        expect(reader.readCurrentAccountExecution(manifest.id).kind).toBe('unavailable');
        store.replace({ scope, snapshot: empty });
        expect(reader.readCurrentAccountExecution(manifest.id)).toMatchObject({ kind: 'available', manifest: { displayName: 'Fixture' } });
        expect(reader.readCurrentAccountExecutionDeclarations()[0]?.manifest.displayName).toBe('Fixture');
        expect(acquisitions).toBe(1);
        store.retire([manifest.id]);
        expect(reader.readCurrentAccountExecution(manifest.id).kind).toBe('unavailable');
        expect(store.bind({ ...scope, accountId: 'other' }).readCurrentAccountExecutionDeclarations()).toEqual([]);
        unsubscribe();
    });
    it('keeps deferred acquisition failures unpublished and permits the publisher to retry', () => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse(intentRead().release!.normalizedManifest);
        let ready = false;
        const input = {
            hostBundledUi: undefined,
            loadHostBundledUi: () => {
                if (!ready) throw new Error('Bundled inventory unavailable');
                return [{ pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
                    packageName: '@happier-dev/plugins-fixture', normalizedManifest: manifest, entriesById: {} }];
            },
        };
        const store = createPluginAccountAvailabilityReaderStore(input);
        const reader = store.bind(scope);
        const published: string[] = [];
        const unsubscribe = reader.subscribe(() => published.push(reader.readCurrentAccountExecution(manifest.id).kind));
        const empty = snapshot({ intentReads: [], materializations: [], snapshots: [] });
        expect(() => store.replace({ scope, snapshot: empty })).toThrow('Bundled inventory unavailable');
        expect(store.getSnapshot()).toBeNull();
        expect(reader.readCurrentAccountExecution(manifest.id).kind).toBe('unavailable');
        expect(published).toEqual([]);
        ready = true;
        store.replace({ scope, snapshot: empty });
        expect(reader.readCurrentAccountExecution(manifest.id).kind).toBe('available');
        expect(published).toEqual(['available']);
        unsubscribe();
    });
    it('selects trusted host declarations by package and version without using artifact bytes as authority', () => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse(intentRead().release!.normalizedManifest);
        const packageName = '@acme/fixture';
        const parseManifest = vi.spyOn(PluginPortableReleaseManifestV1Schema, 'safeParse');
        onTestFinished(() => parseManifest.mockRestore());
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: snapshot({ intentReads: [], materializations: [], snapshots: [] }),
            hostBundledUi: [{ pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
                packageName, normalizedManifest: manifest, entriesById: {}, artifactGraphs: [] }],
        });
        const selected = reader.readCurrentAccountExecution(manifest.id);
        expect(selected).toMatchObject({
            kind: 'available', manifest,
            custodyId: JSON.stringify([packageName, manifest.id, manifest.version]),
            sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'source_declaration', packageName } },
        });
        expect(selected.kind === 'available' ? selected.manifest : null).toBe(manifest);
        expect(parseManifest).not.toHaveBeenCalled();
    });
    it.each(['equal', 'different'] as const)('prepares %s bundled Account Action graphs once, without repeating graph traversal during currentness checks', (duplicate) => {
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'account-actions', tier: 'reactNative', entry: 'react-native/account-actions/entry.cjs.bundle',
            digest: artifactDigest,
            files: [{ relativePath: 'react-native/account-actions/entry.cjs.bundle', digest: artifactDigest, byteSize: 1 }],
            builtWith: { bundler: 'esbuild', version: '1.0.0' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0',
        });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({
            ...intentRead().release!.normalizedManifest,
            contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'],
                placementBindings: [], dangerLevel: 'safe', execution: {
                    target: 'account', account: { artifactId: graph.artifactId, exportName: 'activate' },
                }, inputSchema: { type: 'object' }, resultSchema: { type: 'object' } }] },
        });
        const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: [{
            pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture',
            packageName: '@happier-dev/plugins-fixture', normalizedManifest: manifest, entriesById: {},
            artifactGraphs: [graph, duplicate === 'equal' ? structuredClone(graph) : { ...graph, hostUiApiRange: '^2.0.0' }],
        }] });
        const empty = snapshot({ intentReads: [], materializations: [], snapshots: [] });
        store.replace({ scope, snapshot: empty });
        const reader = store.bind(scope);
        const slot = { pluginId: manifest.id, contributionId: 'read', tier: 'reactNative' as const, platform: 'web' as const };
        const expected = duplicate === 'equal' ? { kind: 'available', artifact: { digest: artifactDigest } }
            : { kind: 'unavailable', code: 'artifact_slot_ambiguous' };
        expect(reader.readCurrentArtifact(slot)).toMatchObject(expected);
        // Observe the real encoder, without replacing validation or admission.
        // The measured live regression walks multi-megabyte graphs on every predicate.
        const encode = vi.spyOn(canonicalJson, 'createCanonicalJsonSigningInput');
        onTestFinished(() => encode.mockRestore());
        for (let index = 0; index < 50; index += 1) {
            expect(reader.readCurrentArtifact(slot)).toMatchObject(expected);
        }
        expect(encode.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
            && 'artifactId' in value && 'files' in value)).toHaveLength(0);
        expect(store.bind({ ...scope, accountId: 'other' }).readCurrentArtifact(slot).kind).toBe('unavailable');
        const disabled = { ...intentRead(), intent: { ...intentRead().intent!, desiredVersion: null, enabled: false }, release: null, uiArtifacts: [] };
        store.replace({ scope, snapshot: { ...empty, intentReads: [{ pluginId: manifest.id, response: disabled }] } });
        expect(reader.readCurrentArtifact(slot).kind).toBe('unavailable');
        store.replace({ scope, snapshot: { ...empty, intentReads: [{ pluginId: manifest.id,
            response: { ...disabled, intent: { ...disabled.intent, enabled: true } } }] } });
        expect(reader.readCurrentArtifact(slot)).toMatchObject(expected);
        store.retire([manifest.id]);
        expect(reader.readCurrentArtifact(slot).kind).toBe('unavailable');
    });
    it('projects current portable Account Actions and exact graphs without a Machine, retiring disabled and replaced custody', () => {
        const artifactGraph = PluginUiArtifactsManifestEntryV2Schema.parse({
            artifactId: 'account-actions', tier: 'reactNative', entry: 'react-native/account-actions/entry.cjs.bundle',
            digest: artifactDigest,
            files: [{ relativePath: 'react-native/account-actions/entry.cjs.bundle', digest: artifactDigest, byteSize: 1 }],
            builtWith: { bundler: 'esbuild', version: '1.0.0' }, executable: { exports: ['activate', 'renderSurface'] }, hostUiApiRange: '^1.0.0',
        });
        const manifest = PluginPortableReleaseManifestV1Schema.parse({
            ...intentRead().release!.normalizedManifest,
            contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui', 'cli'],
                sessionTarget: { field: 'sessionId', cardinality: 'one' },
                placementBindings: [], dangerLevel: 'safe', execution: {
                    target: 'account', account: { artifactId: artifactGraph.artifactId, exportName: 'activate' },
                }, inputSchema: { type: 'object', properties: { sessionId: { type: 'string', minLength: 1 } },
                    required: ['sessionId'], additionalProperties: false }, resultSchema: { type: 'object' } }],
                ui: { renderers: [{ id: 'account-page-renderer', kind: 'reactNative', artifact: artifactGraph.artifactId,
                    requiredHostMethods: ['executeAction'] }], views: [{ id: 'account-page', container: 'appPage',
                    title: 'Account page', target: { kind: 'app' }, renderer: 'account-page-renderer' }] } },
        });
        const response = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...intentRead(), release: { ...intentRead().release!, normalizedManifest: manifest,
                uiSlots: [{ contributionId: 'read', artifactId: artifactGraph.artifactId, tier: artifactGraph.tier,
                    platform: 'web', artifactDigest, hostUiApiRange: artifactGraph.hostUiApiRange, artifactGraph }] },
            uiArtifacts: [],
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: manifest.id, response }], materializations: [], snapshots: [] }) });
        const reader = store.bind(scope);
        const first = reader.readAccountUiProjection();
        const action = first?.actionsById[`${manifest.id}/read`];
        const selected = reader.readCurrentAccountExecution(manifest.id);
        if (selected.kind !== 'available') throw new Error('Missing selected Account declaration');
        expect(action?.accountActionDeclaration).toBe(selected.manifest.contributes.actions![0]);
        expect(action).toMatchObject({ pluginId: manifest.id, id: 'read', execution: manifest.contributes.actions![0]!.execution,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            accountActionDeclaration: selected.manifest.contributes.actions![0], hostAccountOrigin: { ...scope, sourceCustody: { kind: 'account_release' } },
            authorization: { generation: { appliedGeneration: null } } });
        const custodyId = action?.occurrenceId;
        expect(custodyId).toBeTypeOf('string');
        expect(first?.surfacePlacementsById[`surfacePlacement:${manifest.id}:account-page`])
            .toMatchObject({ occurrenceId: custodyId, hostAccountOrigin: action?.hostAccountOrigin });
        expect(first?.reactNativeBundlesById[`reactNativeBundle:${manifest.id}:read`])
            .toMatchObject({ artifactGraph, generatedOwnerKind: 'clientContribution', contributionId: 'read',
                occurrenceId: custodyId, runtime: { decision: { state: 'load' }, loadPolicy: { source: 'installedArtifact' } } });
        expect(reader.readCurrentAccountExecution(manifest.id)).toMatchObject({ kind: 'available', manifest, custodyId });
        if (!action) throw new Error('Missing published Account Action');
        const slot = { pluginId: manifest.id, contributionId: 'read', tier: 'reactNative' as const, platform: 'web' as const };
        expect(reader.readCurrentArtifact(slot).kind).toBe('available');
        expect(Object.isFrozen(action.accountActionDeclaration)).toBe(true);
        expect(Object.isFrozen(action.accountActionDeclaration?.inputSchema)).toBe(true);
        // Count the real decoder after the canonical Account publication, not a
        // synthetic frozen input or a replacement for its validation logic.
        const decodeCustody = vi.spyOn(PluginSourceCustodyV1Schema, 'safeParse');
        onTestFinished(() => decodeCustody.mockRestore());
        const placement = first?.surfacePlacementsById[`surfacePlacement:${manifest.id}:account-page`];
        const origins = Array.from({ length: 100 }, () => readPluginUiAccountExecutableOrigin(placement));
        expect(decodeCustody).toHaveBeenCalledTimes(0);
        const ownedOrigin = origins[0];
        expect(ownedOrigin).not.toBeNull();
        expect(origins.every(origin => origin === ownedOrigin)).toBe(true);
        expect(Object.isFrozen(ownedOrigin)).toBe(true);
        expect(Object.isFrozen(ownedOrigin?.sourceCustody)).toBe(true);
        if (!ownedOrigin || ownedOrigin.sourceCustody.kind !== 'account_release') throw new Error('Missing Account release origin');
        const raw = { pluginId: manifest.id, hostAccountOrigin: { ...ownedOrigin,
            sourceCustody: { ...ownedOrigin.sourceCustody } } };
        // A frozen wrapper is not a decoder-owned immutable publication.
        Object.freeze(raw);
        Object.freeze(raw.hostAccountOrigin);
        const decodedRaw = readPluginUiAccountExecutableOrigin(raw);
        expect(decodedRaw).toEqual(ownedOrigin);
        expect(decodeCustody).toHaveBeenCalledTimes(1);
        expect(readPluginUiAccountExecutableOrigin(structuredClone(raw))).toEqual(ownedOrigin);
        expect(decodeCustody).toHaveBeenCalledTimes(2);
        raw.hostAccountOrigin.sourceCustody.version = '2.0.0';
        expect(readPluginUiAccountExecutableOrigin(raw)?.sourceCustody).toMatchObject({ version: '2.0.0' });
        expect(decodedRaw?.sourceCustody).toMatchObject({ version: manifest.version });
        expect(decodeCustody).toHaveBeenCalledTimes(3);
        raw.hostAccountOrigin.sourceCustody.archiveDigestSha256 = 'invalid';
        expect(readPluginUiAccountExecutableOrigin(raw)).toBeNull();
        expect(decodeCustody).toHaveBeenCalledTimes(4);
        const changed = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...response,
            intent: { ...response.intent!, desiredVersion: '2.0.0', revision: 'intent-2' },
            release: { ...response.release!, ref: { ...response.release!.ref, version: '2.0.0' },
                normalizedManifest: { ...manifest, version: '2.0.0' } },
        });
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: manifest.id, response: changed }], materializations: [], snapshots: [] }) });
        const changedAction = reader.readAccountUiProjection()?.actionsById[`${manifest.id}/read`];
        expect(changedAction?.occurrenceId).not.toBe(custodyId);
        if (!changedAction) throw new Error('Missing replaced Account Action');
        const changedDeclaration = changedAction.accountActionDeclaration;
        expect(changedDeclaration).not.toBe(action.accountActionDeclaration);
        expect(changedDeclaration?.inputSchema).toEqual(manifest.contributes.actions![0]!.inputSchema);
        expect(readPluginUiAccountExecutableOrigin(changedAction)?.sourceCustody).toMatchObject({ version: '2.0.0' });
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: manifest.id,
            response: { ...changed, intent: { ...changed.intent!, enabled: false } } }], materializations: [], snapshots: [] }) });
        expect(reader.readAccountUiProjection()).toBeNull();
        expect(reader.readCurrentAccountExecution(manifest.id)).toMatchObject({ kind: 'unavailable' });
    });
    it('admits a current daemon-selected source only after Account hydration and without portable intent', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        const response = intentRead();
        const slot = { pluginId: 'com.acme.fixture', ...hostedSlot };
        let sourceCurrent = true;
        const selected = {
            occurrenceId: 'development-a',
            artifact: { ...slot, artifactId: 'development', digest: `sha256:${'e'.repeat(64)}` as const,
                hostUiApiRange: '^1.0.0', releaseVersion: '1.0.0' },
            isCurrent: () => sourceCurrent,
        };
        expect(reader.readCurrentArtifact(slot, undefined, selected))
            .toEqual({ kind: 'unavailable', code: 'account_availability_not_loaded' });
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: slot.pluginId,
            response: { ...response, intent: { ...response.intent!, desiredVersion: null }, release: null, uiArtifacts: [] },
        }] }) });
        expect(reader.readCurrentArtifact(slot, undefined, selected))
            .toMatchObject({ kind: 'available', artifact: selected.artifact });
        sourceCurrent = false;
        expect(reader.readCurrentArtifact(slot, undefined, selected))
            .toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        sourceCurrent = true;
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: slot.pluginId,
            response: { ...response, intent: { ...response.intent!, desiredVersion: null, enabled: false }, release: null, uiArtifacts: [] },
        }] }) });
        expect(reader.readCurrentArtifact(slot, undefined, selected))
            .toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: slot.pluginId, response }] }) });
        expect(reader.readCurrentArtifact(slot, undefined, selected))
            .toMatchObject({ kind: 'available', artifact: { digest: artifactDigest, releaseVersion: '1.2.3' } });
    });

    it('classifies a fleet census with linear rather than quadratic read cost', () => {
        const absent = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...intentRead(), intent: null, release: null, uiArtifacts: [] });
        const measure = (count: number) => {
            const base = snapshot().materializations[0]!;
            const rows = Array.from({ length: count }, (_, index) => ({ ...base,
                machineId: `machine-${index}`, materializationId: `install-${index}`,
            }));
            const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
                intentReads: [{ pluginId: base.pluginId, response: absent }], materializations: rows, snapshots: [],
            }) });
            // Warm both the real classification and its immutable snapshot projection.
            reader.classifyRelease(rows[0]!);
            let unexpected = 0;
            const start = performance.now();
            for (let pass = 0; pass < 4; pass += 1) for (const row of rows) {
                if (reader.classifyRelease(row).releaseContent !== 'unknown') unexpected += 1;
            }
            const elapsed = performance.now() - start;
            expect(unexpected).toBe(0);
            return elapsed;
        };
        // The live QA Account has 1,889 installations. Compare scaling at that
        // order of magnitude instead of imposing a machine-specific time limit.
        const small = Math.min(...Array.from({ length: 3 }, () => measure(500)));
        const large = Math.min(...Array.from({ length: 3 }, () => measure(2_000)));
        expect(large / small).toBeLessThan(8);
    });

    it('admits an approved external archive only through its exact installed origin without selecting an Account release', () => {
        const release = intentRead().release!;
        const materialization = PluginMachineMaterializationV1Schema.parse({ ...snapshot().materializations[0]!,
            sourceClass: 'versionedArchive', enabled: true, trustState: 'trusted',
            archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: release.uiSlots,
        });
        const origin = { serverIdentityId: materialization.serverIdentityId, materializationRef: {
            machineId: materialization.machineId, materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        } };
        const absent = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...intentRead(), intent: null, release: null, uiArtifacts: [] });
        const installed = snapshot({ releases: [release], intentReads: [{ pluginId: materialization.pluginId, response: absent }],
            materializations: [materialization], snapshots: [{ serverIdentityId: materialization.serverIdentityId,
                machineId: materialization.machineId, materializations: [materialization] }],
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: installed });
        const reader = store.bind(scope);
        const slot = { pluginId: materialization.pluginId, ...hostedSlot };
        expect(reader.classifyRelease(materialization)).toMatchObject({ releaseContent: 'matched', validation: { kind: 'admitted' } });
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'available', artifact: {
            digest: artifactDigest, releaseVersion: release.ref.version,
        } });
        expect(reader.readCurrentArtifact(slot)).toMatchObject({ kind: 'unavailable' });
        expect(reader.readCurrentReleaseSelection({ pluginId: materialization.pluginId })).toMatchObject({ kind: 'unavailable' });
        expect(reader.readCurrentHostedPublicationTarget(slot)).toMatchObject({ kind: 'unavailable' });
        expect(reader.readCurrentArtifact(slot, { ...origin, materializationRef: { ...origin.materializationRef, materializationId: 'replaced' } }))
            .toMatchObject({ kind: 'unavailable' });
        expect(reader.readCurrentArtifact({ ...slot, platform: 'android' }, origin)).toMatchObject({ kind: 'unavailable' });
        store.replace({ scope, snapshot: { ...installed, materializations: [materialization, materialization] } });
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'unavailable' });
        // Same local installation id on another Home or Machine is a distinct
        // origin. It cannot make this exact origin ambiguous or grant its trust.
        store.replace({ scope, snapshot: { ...installed, materializations: [materialization,
            { ...materialization, serverIdentityId: 'another-home', enabled: false },
            { ...materialization, machineId: 'another-machine', enabled: false },
        ] } });
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'available' });
        for (const changed of [
            { ...materialization, enabled: false },
            { ...materialization, trustState: 'revoked' as const },
            { ...materialization, archiveDigestSha256: `sha256:${'e'.repeat(64)}` },
            { ...materialization, uiArtifacts: [{ ...materialization.uiArtifacts[0]!, artifactDigest: `sha256:${'e'.repeat(64)}` }] },
        ] satisfies PluginAccountAvailabilitySnapshot['materializations']) {
            store.replace({ scope, snapshot: { ...installed, materializations: [changed], snapshots: [{
                ...installed.snapshots[0]!, materializations: [changed],
            }] } });
            expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'unavailable' });
        }
        const disabled = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...absent,
            intent: { ...intentRead().intent!, enabled: false, desiredVersion: null },
        });
        store.replace({ scope, snapshot: { ...installed, intentReads: [{ pluginId: materialization.pluginId, response: disabled }] } });
        expect(reader.classifyRelease(materialization).validation).toMatchObject({ kind: 'rejected' });
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'unavailable' });
        store.replace({ scope, snapshot: installed });
        store.retire([materialization.pluginId]);
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'unavailable' });
        store.replace({ scope, snapshot: installed });
        store.replace({ scope: { ...scope, accountId: 'successor' }, snapshot: installed });
        expect(reader.readCurrentArtifact(slot, origin)).toMatchObject({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    });
    it('selects the host bundled Account renderer without a machine or claimed release, and respects Account disablement', () => {
        const manifest = PluginPortableReleaseManifestV1Schema.parse({
            schemaVersion: 2, id: 'happier.fixture', version: '1.0.0', displayName: 'Fixture',
            runtime: { apiVersion: 1 }, contributes: {
                actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                    dangerLevel: 'safe', execution: { target: 'daemon' } }], ui: { renderers: [{
                id: 'fixture', kind: 'reactNative', artifact: 'fixture', requiredHostMethods: [],
            }], views: [{ id: 'fixture-page', container: 'appPage', title: 'Fixture', target: { kind: 'app' },
                renderer: 'fixture' }] } },
        });
        const artifact = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: 'fixture', tier: 'reactNative',
            entry: 'react-native/fixture/entry.cjs.bundle', digest: artifactDigest,
            files: [{ relativePath: 'react-native/fixture/entry.cjs.bundle', digest: artifactDigest, byteSize: 1 }],
            builtWith: { bundler: 'esbuild' as const, version: '1.0.0' },
            executable: { exports: ['renderSurface'] }, hostUiApiRange: '^1.0.0' });
        const input = { scope, snapshot: snapshot({ intentReads: [], materializations: [], snapshots: [] }),
            hostBundledUi: [{ pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Fixture', packageName: '@happier-dev/plugins-fixture',
                entriesById: projectPluginPortableUiDeclarationsV1(manifest, [artifact]),
                declaredExecution: { daemonActions: true, contributionPoints: false } }] };
        const reader = createPluginAccountAvailabilityReader(input);
        const slot = { pluginId: manifest.id, contributionId: 'fixture', tier: 'reactNative' as const, platform: 'web' as const };
        expect(reader.readCurrentArtifact(slot)).toMatchObject({ kind: 'available', artifact: {
            pluginId: manifest.id, digest: artifactDigest, releaseVersion: manifest.version,
        } });
        const graphParses = vi.spyOn(PluginUiArtifactsManifestEntryV2Schema, 'safeParse');
        onTestFinished(() => graphParses.mockRestore());
        for (let index = 0; index < 100; index += 1) {
            expect(reader.readCurrentArtifact(slot).kind).toBe('available');
        }
        expect(graphParses).not.toHaveBeenCalled();
        graphParses.mockRestore();
        expect(reader.readAccountUiProjection()?.surfacePlacementsById['surfacePlacement:happier.fixture:fixture-page'])
            .toMatchObject({ availability: { state: 'available' }, renderer: { kind: 'reactNative' } });
        expect(reader.readAccountUiProjection()?.reactNativeBundlesById['reactNativeBundle:happier.fixture:fixture'])
            .toMatchObject({ artifactGraph: artifact, runtime: { decision: { state: 'load' } } });
        expect(reader.readAccountUiProjection()?.installedPackagesById[manifest.id]?.source)
            .toEqual({ kind: 'bundled', locator: '@happier-dev/plugins-fixture' });
        expect(reader.readAccountUiProjection()?.installedPackagesById[manifest.id]?.declaredExecution)
            .toEqual({ daemonActions: true, contributionPoints: false });
        const disabled = intentRead();
        disabled.intent = { ...disabled.intent!, pluginId: manifest.id, desiredVersion: null, enabled: false };
        disabled.release = null;
        const disabledInput = { ...input, snapshot: snapshot({ intentReads: [{ pluginId: manifest.id, response: disabled }],
            materializations: [], snapshots: [] }) };
        expect(createPluginAccountAvailabilityReader(disabledInput).readCurrentArtifact(slot))
            .toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(createPluginAccountAvailabilityReader(disabledInput).readAccountUiProjection()).toBeNull();
        const portableDigest = `sha256:${'c'.repeat(64)}`;
        const portable = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({ ...intentRead(),
            intent: { ...disabled.intent!, enabled: true, desiredVersion: '2.0.0' },
            release: { ...intentRead().release!, ref: { pluginId: manifest.id, version: '2.0.0' },
                normalizedManifest: { ...manifest, version: '2.0.0' }, uiSlots: [{ contributionId: slot.contributionId, tier: slot.tier, platform: slot.platform,
                    artifactId: 'fixture', artifactDigest: portableDigest, hostUiApiRange: '^1.0.0' }] },
            uiArtifacts: [],
        });
        const portableInput = { ...input, snapshot: snapshot({ intentReads: [{ pluginId: manifest.id, response: portable }],
            materializations: [], snapshots: [] }) };
        expect(createPluginAccountAvailabilityReader(portableInput).readCurrentArtifact(slot))
            .toMatchObject({ kind: 'available', artifact: { digest: portableDigest, releaseVersion: '2.0.0' } });
        const portableUi = createPluginAccountAvailabilityReader(portableInput).readAccountUiProjection();
        expect(portableUi?.surfacePlacementsById).toEqual({});
        expect(portableUi?.actionsById).toEqual({});
        expect(portableUi?.unknownEntriesById['uiRenderer:happier.fixture:fixture'])
            .toMatchObject({ contributionKind: 'uiRenderer', contributionId: 'fixture' });
        const store = createPluginAccountAvailabilityReaderStore({ hostBundledUi: input.hostBundledUi });
        store.replace({ scope, snapshot: input.snapshot });
        const bound = store.bind(scope);
        const accountUi = bound.readAccountUiProjection();
        const uiInputs = bound.readUiProjectionInputs();
        expect(uiInputs?.accountUiProjection).toBe(accountUi);
        store.replace({ scope, snapshot: { ...input.snapshot, availabilityCursor: 43 } });
        expect(store.bind(scope).readAccountUiProjection()).toBe(accountUi);
        expect(bound.readUiProjectionInputs()).toBe(uiInputs);
        store.retire([manifest.id]);
        expect(bound.readCurrentArtifact(slot)).toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(bound.readAccountUiProjection()).toBeNull();
        expect(bound.readUiProjectionInputs()?.accountUiProjection).toBeNull();
    });
    it('projects admitted registry and skill declarations on a cold Account and retires their installation census', () => {
        const base = snapshot();
        const declaration = PluginPortableReleaseManifestV1Schema.parse({ ...intentRead().release!.normalizedManifest,
            contributes: { actions: [{ id: 'read', title: 'Read', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
                dangerLevel: 'safe', execution: { target: 'daemon' } }],
                registrySources: [{ id: 'skills', title: 'Team skills', format: 'git', kinds: ['skill'], url: 'https://github.com/acme/skills' }],
                skills: [{ id: 'check', directory: './resources/skills/check' }] },
        });
        const materialization = { ...base.materializations[0]!, enabled: true, trustState: 'trusted' as const, declaredManifest: declaration };
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { ...base, materializations: [materialization], snapshots: [
            { serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId, materializations: [materialization] },
        ] } });
        const reader = store.bind(scope);
        const installed = reader.readInstalledPlugins();
        if (installed.kind !== 'available') throw new Error('Fixture must be admitted');
        const projection = installed.plugins[0]!.installations[0]!.uiModel;
        expect(projection.installedPackagesById[materialization.pluginId]?.declaredExecution)
            .toEqual({ daemonActions: true, contributionPoints: false });
        expect(projection.registrySourcesById['com.acme.fixture/skills']).toMatchObject({ pluginId: 'com.acme.fixture',
            pluginVersion: '1.2.3', definition: { id: 'skills', kinds: ['skill'] } });
        expect(projection.registrySourcesById['com.acme.fixture/skills']).not.toHaveProperty('occurrenceId');
        expect(projection.skillsById['com.acme.fixture/check']).toMatchObject({ pluginId: 'com.acme.fixture',
            pluginVersion: '1.2.3', definition: { id: 'check', directory: './resources/skills/check' } });
        expect(projection.skillsById['com.acme.fixture/check']).not.toHaveProperty('occurrenceId');
        store.replace({ scope, snapshot: { ...base, availabilityCursor: 43, materializations: [], snapshots: [
            { serverIdentityId: materialization.serverIdentityId, machineId: materialization.machineId, materializations: [] },
        ] } });
        expect(reader.readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [] });
        expect(store.bind({ ...scope, accountId: 'another-account' }).readInstalledPlugins()).toMatchObject({ kind: 'unavailable' });
    });
    it('retains one derived catalog per snapshot without retaining authority after clear', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        store.replace({ scope, snapshot: snapshot({ intentReads: [{ pluginId: 'com.acme.fixture', response: intentRead() }] }) });
        const observation = reader.getObservationSnapshot('com.acme.fixture');
        expect(store.bind({ ...scope })).toBe(reader);
        expect(store.bind({ ...scope }).classifyRelease).toBe(reader.classifyRelease);
        expect(store.bind({ ...scope }).getObservationSnapshot('com.acme.fixture')).toBe(observation);
        expect(observation).toEqual({});
        const normalizations = vi.spyOn(uiProjection, 'normalizePluginInstalledUiDeclarations');
        const releaseNormalizations = vi.spyOn(availability, 'normalizePluginReleaseFactsV1');
        const selections = vi.spyOn(availability, 'resolvePluginAccountExecutionSelectionV1');
        onTestFinished(() => { normalizations.mockRestore(); releaseNormalizations.mockRestore(); selections.mockRestore(); });
        const installed = reader.readInstalledPlugins();
        const materializations = reader.readMaterializations();
        const catalogs = new Set(Array.from({ length: 100 }, () => reader.readInstalledPlugins()));
        expect(catalogs.size).toBe(1);
        expect(reader.readInstalledPlugins()).toBe(installed);
        expect(reader.readMaterializations()).toBe(materializations);
        for (let index = 0; index < 100; index += 1) {
            expect(store.bind(scope).readCurrentAccountExecution('com.acme.fixture').kind).toBe('available');
            store.bind(scope).readAccountUiProjection();
        }
        expect(selections.mock.calls.length).toBeGreaterThanOrEqual(100);
        expect(normalizations).not.toHaveBeenCalled();
        expect(releaseNormalizations).not.toHaveBeenCalled();
        store.retire(['com.acme.fixture']);
        expect(reader.getObservationSnapshot('com.acme.fixture')).not.toBe(observation);
        expect(reader.readCurrentAccountExecution('com.acme.fixture').kind).toBe('unavailable');
        store.clear();
        expect(reader.getObservationSnapshot()).toBeNull();
        expect(reader.readInstalledPlugins()).toMatchObject({ kind: 'unavailable' });
        expect(reader.readMaterializations()).toMatchObject({ kind: 'unavailable' });
        store.replace({ scope, snapshot: snapshot({ availabilityCursor: 43 }) });
        expect(reader.readInstalledPlugins()).not.toBe(installed);
        expect(reader.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 43 });
    });
    it('retains identical all-plugin observations while publishing changed cursors, facts, and lifecycle', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        const pluginId = 'com.acme.fixture';
        const response = intentRead();
        const initial = snapshot({ intentReads: [{ pluginId, response }] });
        expect(reader.getObservationSnapshot()).toBeNull();
        store.replace({ scope, snapshot: initial });
        const all = reader.getObservationSnapshot();
        const plugin = reader.getObservationSnapshot(pluginId);
        expect(all).not.toBeNull();
        store.replace({ scope, snapshot: initial });
        expect(reader.getObservationSnapshot()).toBe(all);
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 43 } });
        expect(reader.getObservationSnapshot(pluginId)).toBe(plugin);
        const cursorOnly = reader.getObservationSnapshot();
        expect(cursorOnly).not.toBe(all);
        expect(reader.readMaterializations()).toMatchObject({ kind: 'available', availabilityCursor: 43 });
        expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 43 } });
        expect(reader.getObservationSnapshot()).toBe(cursorOnly);
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 44 } });
        const cursorChanged = reader.getObservationSnapshot();
        expect(cursorChanged).not.toBe(cursorOnly);
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 44, intentReads: [{ pluginId,
            response: { ...response, intent: { ...response.intent!, enabled: false } },
        }] } });
        const disabled = reader.getObservationSnapshot();
        expect(disabled).not.toBe(cursorChanged);
        expect(reader.getObservationSnapshot(pluginId)).not.toBe(plugin);
        expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'unavailable' });
        store.retire([pluginId]);
        expect(reader.getObservationSnapshot()).not.toBe(disabled);
        expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'unavailable' });
        store.clear();
        expect(reader.getObservationSnapshot()).toBeNull();
        store.replace({ scope, snapshot: initial });
        const restored = reader.getObservationSnapshot();
        expect(restored).not.toBe(all);
        const machineOnlyPluginId = 'com.acme.machine-only';
        store.replace({ scope, snapshot: { ...initial, materializations: [...initial.materializations,
            { ...initial.materializations[0]!, pluginId: machineOnlyPluginId },
        ] } });
        const added = reader.getObservationSnapshot();
        expect(added).not.toBe(restored);
        store.replace({ scope, snapshot: initial });
        expect(reader.getObservationSnapshot()).not.toBe(added);
        expect(reader.getObservationSnapshot(machineOnlyPluginId)).toBe(reader.getObservationSnapshot('com.acme.absent'));
        store.replace({ scope, snapshot: snapshot({ materializations: [], snapshots: [] }) });
        expect(reader.getObservationSnapshot()).not.toBe(restored);
        expect(reader.getObservationSnapshot(pluginId)).not.toBe(plugin);
        expect(reader.readMaterializations()).toMatchObject({ kind: 'available', materializations: [] });
        store.replace({ scope: { ...scope, accountId: 'another-account' }, snapshot: initial });
        expect(reader.getObservationSnapshot()).toBeNull();
    });
    it('retains unchanged installation models across fresh readers while publishing current admission facts', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const response = intentRead();
        const base = snapshot({ intentReads: [{ pluginId: 'com.acme.fixture', response }] });
        const materialization = { ...base.materializations[0]!,
            declaredManifest: response.release!.normalizedManifest, declaredUiEntries: {} };
        const materializations = Array.from({ length: 100 }, (_, index) => index === 0 ? materialization : {
            ...materialization, machineId: `machine-${index + 1}`, materializationId: `install-${index + 1}`,
        });
        const initial = { ...base, materializations, snapshots: materializations.map(row => ({
            ...base.snapshots[0]!, machineId: row.machineId, materializations: [row],
        })) };
        store.replace({ scope, snapshot: initial });
        const before = store.bind(scope).readInstalledPlugins();
        if (before.kind !== 'available') throw new Error('Fixture installation must be available');
        const normalizations = vi.spyOn(uiProjection, 'normalizePluginInstalledUiDeclarations');
        onTestFinished(() => normalizations.mockRestore());
        const retainedModels = new Set<unknown>(before.plugins[0]!.installations.map(row => row.uiModel));
        const entries = vi.spyOn(Object, 'entries');
        onTestFinished(() => entries.mockRestore());
        const retainedModelWalks = () => entries.mock.calls.filter(([value]) => retainedModels.has(value)).length;
        for (let index = 0; index < 20; index += 1) {
            store.replace({ scope, snapshot: { ...initial, availabilityCursor: 43 + index, intentReads: [{
                pluginId: 'com.acme.fixture', response: { ...response, availabilityCursor: 43 + index,
                    intent: { ...response.intent!, revision: 'intent-2' } },
            }] } });
        }
        const reader = store.bind(scope);
        const after = reader.readInstalledPlugins();
        if (after.kind !== 'available') throw new Error('Fixture installation must remain available');
        expect(after.availabilityCursor).toBe(62);
        expect(reader.readCurrentReleaseSelection({ pluginId: 'com.acme.fixture' }))
            .toMatchObject({ kind: 'available', availabilityCursor: 62, intent: { revision: 'intent-2' } });
        expect(after.plugins[0]!.installations[0]!.uiModel).toBe(before.plugins[0]!.installations[0]!.uiModel);
        expect(after.plugins[0]).toBe(before.plugins[0]);
        expect(normalizations).not.toHaveBeenCalled();
        const observed = { ...materialization, observedAt: materialization.observedAt + 1 };
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 63, materializations: [observed, ...materializations.slice(1)] } });
        const observation = reader.readInstalledPlugins();
        if (observation.kind !== 'available') throw new Error('Observed installation must remain available');
        expect(observation.plugins[0]!.installations[0]!.materialization.observedAt).toBe(observed.observedAt);
        expect(normalizations).not.toHaveBeenCalled();
        expect(observation.plugins[0]!.installations[0]!.uiModel).toBe(after.plugins[0]!.installations[0]!.uiModel);
        expect(retainedModelWalks()).toBe(0);
        entries.mockClear();
        const changed = { ...initial.materializations[0]!, enabled: true };
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 64, materializations: [changed, ...materializations.slice(1)], snapshots: [{
            ...initial.snapshots[0]!, materializations: [changed],
        }, ...initial.snapshots.slice(1)] } });
        const updated = store.bind(scope).readInstalledPlugins();
        if (updated.kind !== 'available') throw new Error('Updated installation must remain available');
        expect(updated.plugins[0]!.installations[0]!.uiModel).not.toBe(after.plugins[0]!.installations[0]!.uiModel);
        expect(updated.plugins[0]!.installations[0]!.uiModel.installedPackagesById['com.acme.fixture']?.enabled).toBe(true);
        for (let index = 1; index < materializations.length; index += 1) {
            expect(updated.plugins[0]!.installations[index]!.uiModel).toBe(after.plugins[0]!.installations[index]!.uiModel);
        }
        expect(retainedModelWalks()).toBe(0);
        expect(before.plugins[0]!.installations[0]!.uiModel.installedPackagesById['com.acme.fixture']?.enabled).toBe(false);
        expect(normalizations).toHaveBeenCalledTimes(1);
        entries.mockClear();
        normalizations.mockClear();
        const replacement = { ...changed, materializationId: 'install-replacement' };
        store.replace({ scope, snapshot: { ...initial, availabilityCursor: 65,
            materializations: [replacement, ...materializations.slice(1)],
            snapshots: [{ ...initial.snapshots[0]!, materializations: [replacement] }, ...initial.snapshots.slice(1)],
        } });
        const replaced = store.bind(scope).readInstalledPlugins();
        if (replaced.kind !== 'available') throw new Error('Replacement installation must be available');
        const replacedModel = replaced.plugins[0]!.installations[0]!.uiModel;
        expect(replacedModel).not.toBe(updated.plugins[0]!.installations[0]!.uiModel);
        expect(replacedModel.installedPackagesById['com.acme.fixture']?.source?.locator).toBe('install-replacement');
        expect(entries.mock.calls.filter(([value]) => value === replacedModel).length).toBe(1);
        expect(retainedModelWalks()).toBe(0);
        expect(normalizations).toHaveBeenCalledTimes(1);
    });
    it('projects cold portable app and settings destinations from the exact release without reported descriptors or execution authority', () => {
        const release = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...intentRead(),
            release: {
                ...intentRead().release!,
                normalizedManifest: {
                    ...intentRead().release!.normalizedManifest,
                    contributes: { settings: [{
                        id: 'preferences', title: 'Preferences', scope: 'account', target: { kind: 'plugin' },
                        fields: [{ id: 'enabled', title: 'Enabled', schema: { type: 'boolean' }, default: true }],
                    }], ui: {
                        renderers: [
                            { id: 'page', kind: 'declarative', root: { kind: 'stack', children: [
                                { kind: 'text', text: 'Portable page' },
                                { kind: 'field', label: 'Enabled', control: { kind: 'toggle', settingId: 'enabled' } },
                            ] } },
                            { id: 'inline', kind: 'hostedHtml', source: artifactHtmlBundleFromBodyV1('<p>Portable settings</p>') },
                        ],
                        views: [{ id: 'page', container: 'appPage', target: { kind: 'app' }, renderer: 'page', title: 'Page' }],
                        settingsPages: [{ id: 'settings', group: { kind: 'host', id: 'general' }, renderer: 'inline', title: 'Settings' }],
                    } },
                },
            },
        }).release!;
        const base = snapshot();
        // This is the descriptor-free shape reconstructed by Availability on the server.
        const materialization = PluginMachineMaterializationV1Schema.parse({
            ...base.materializations[0]!, archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: release.uiSlots,
        });
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
            releases: [release], materializations: [materialization],
            snapshots: [{ ...base.snapshots[0]!, materializations: [materialization] }],
        }) });
        const installed = reader.readInstalledPlugins();
        if (installed.kind !== 'available') throw new Error('Expected installed inventory');
        const installation = installed.plugins[0]!.installations[0]!;
        const page = installation.uiModel.surfacePlacementsById['surfacePlacement:com.acme.fixture:page'];
        const settings = installation.uiModel.settingsPagesById['settingsPage:com.acme.fixture:settings'];
        expect(installation.uiDeclarationState).toBe('known');
        expect(page).toMatchObject({ descriptorId: 'page', availability: { state: 'available' } });
        expect(settings).toMatchObject({ descriptorId: 'settings', renderer: { kind: 'hostedHtml' } });
        expect(admitDeclarativeStaticModel({ model: page?.renderer.kind === 'declarative' ? page.renderer.model : null,
            expectedPluginId: materialization.pluginId })?.root).toMatchObject({ kind: 'stack', children: [
                { kind: 'text', text: 'Portable page' },
                { kind: 'field', setting: { id: 'enabled', descriptor: { scope: 'account', default: true } } },
            ] });
        for (const destination of [page, settings]) {
            expect(destination).not.toHaveProperty('occurrenceId');
            expect(destination).not.toHaveProperty('materializationRef');
            expect(destination).not.toHaveProperty('hostOrigin');
        }
        expect(installation.uiModel.generation).toBeNull();
        expect(installation.execution.validation.kind).toBe('rejected');
    });
    it('uses installed immutable release facts descriptively without enabling Account execution', () => {
        const release = intentRead().release!;
        const base = snapshot();
        const materialization = { ...base.materializations[0]!, archiveDigestSha256: release.archiveDigestSha256, uiArtifacts: release.uiSlots };
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
            releases: [release], materializations: [materialization],
            snapshots: [{ ...base.snapshots[0]!, materializations: [materialization] }],
        }) });
        expect(reader.readInstalledPlugins()).toMatchObject({ plugins: [{ installations: [{ release, declaration: release.normalizedManifest }] }] });
        expect(reader.classifyRelease(materialization).validation.kind).toBe('rejected');
    });
    it('projects reported offline page declarations without inventing a process occurrence', () => {
        const base = snapshot();
        const id = 'surfacePlacement:com.acme.fixture:page';
        const materialization = PluginMachineMaterializationV1Schema.parse({ ...base.materializations[0],
            declaredManifest: intentRead().release!.normalizedManifest,
            declaredUiEntries: { [id]: {
                id, pluginId: 'com.acme.fixture', contributionKind: 'surfacePlacement', descriptorId: 'page',
                binding: normalizePluginUiDestinationBindingV1({ pluginId: 'com.acme.fixture', destinationId: 'page', rendererId: 'renderer', container: 'appPage', target: { kind: 'app' } }),
                target: { kind: 'app' }, renderer: { kind: 'declarative', contributionId: 'renderer' },
                display: { title: 'Page' }, availability: { state: 'available', reason: 'available', diagnostics: [] },
            } },
        });
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
            materializations: [materialization], snapshots: [{ ...base.snapshots[0]!, materializations: [materialization] }],
        }) });
        const installed = reader.readInstalledPlugins();
        expect(installed.kind).toBe('available');
        if (installed.kind !== 'available') throw new Error('Expected descriptive inventory');
        const page = installed.plugins[0]!.installations[0]!.uiModel.surfacePlacementsById[id];
        expect(page).toMatchObject({ descriptorId: 'page' });
        expect(page).not.toHaveProperty('occurrenceId');
        expect(page).not.toHaveProperty('materializationRef');
        expect(installed.plugins[0]!.installations[0]!.uiModel.generation).toBeNull();
        expect(installed.plugins[0]!.installations[0]!.uiModel.installedPackagesById[materialization.pluginId]).toMatchObject({
            id: materialization.pluginId, version: materialization.version, enabled: false,
        });
    });
    it('describes an installed release without an enabled Account intent and retains unknown declarations as preparing', () => {
        const base = snapshot();
        const declaration = intentRead().release!.normalizedManifest;
        const known = { ...base.materializations[0]!, declaredManifest: declaration };
        const unknown = { ...base.materializations[0]!, materializationId: 'install-2', machineId: 'machine-2' };
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
            materializations: [known, unknown],
            snapshots: [
                { serverIdentityId: known.serverIdentityId, machineId: known.machineId, materializations: [known] },
                { serverIdentityId: unknown.serverIdentityId, machineId: unknown.machineId, materializations: [unknown] },
            ],
        }) });
        expect(reader.readInstalledPlugins()).toMatchObject({
            kind: 'available', completeness: 'complete',
            plugins: [{ pluginId: known.pluginId, installations: [
                { declaration, declarationState: 'known', execution: { validation: { kind: 'rejected' } } },
                { declaration: null, declarationState: 'preparing' },
            ] }],
        });
        expect(reader.readCurrentArtifact({ pluginId: known.pluginId, ...hostedSlot }).kind).toBe('unavailable');
        expect(reader.readInstalledPlugins()).toMatchObject({ plugins: [{ installations: [
            { uiDeclarationState: 'preparing' }, { uiDeclarationState: 'preparing' },
        ] }] });
    });

    it('retains omitted installations on incomplete inventory and removes only a machine with an exact empty report', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const base = snapshot();
        const first = base.materializations[0]!;
        const second = { ...first, machineId: 'machine-2', materializationId: 'install-2' };
        store.replace({ scope, snapshot: snapshot({ materializations: [first, second], snapshots: [
            base.snapshots[0]!, { serverIdentityId: second.serverIdentityId, machineId: second.machineId, materializations: [second] },
        ] }) });
        store.replace({ scope, snapshot: snapshot({ materializations: [], snapshots: [{
            serverIdentityId: first.serverIdentityId, machineId: first.machineId, materializations: [],
        }], inventoryComplete: false }) });
        expect(store.bind(scope).readInstalledPlugins()).toMatchObject({
            completeness: 'incomplete', plugins: [{ installations: [{ materialization: second }] }],
        });
        store.replace({ scope, snapshot: snapshot({ materializations: [], snapshots: [], inventoryComplete: false }) });
        expect(store.bind(scope).readMaterializations()).toMatchObject({ materializations: [second] });
    });

    const machineBoundSlot = {
        pluginId: 'happier.fixture',
        contributionId: 'fixture-list-page-native',
        tier: 'reactNative' as const,
        platform: 'web' as const,
    };

    function machineBoundMaterialization(digest = `sha256:${'d'.repeat(64)}`) {
        return PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_fixture',
            machineId: 'machine-1',
            materializationId: 'bundled-fixture',
            pluginId: 'happier.fixture',
            version: '0.0.0',
            sourceClass: 'localPath',
            portableRelease: false,
            uiArtifacts: [{
                contributionId: 'fixture-list-page-native',
                artifactId: 'fixture-list-page-native',
                tier: 'reactNative',
                platform: 'web',
                artifactDigest: digest,
                hostUiApiRange: '^1.0.0',
            }],
            enabled: true,
            trustState: 'trusted',
            observedAt: 1_700_000_000_000,
        });
    }

    it('does not admit a slot from machine materialization alone without an Account release', () => {
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot() });

        expect(reader.readCurrentArtifact(machineBoundSlot)).toEqual({
            kind: 'unavailable',
            code: 'artifact_not_current',
        });
    });

    it('retires only named plugin authority without rewriting the separately owned machine snapshot', () => {
        const retiredPluginId = 'com.acme.retired';
        const retiredResponse = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...intentRead(),
            intent: { ...intentRead().intent!, pluginId: retiredPluginId },
            release: {
                ...intentRead().release!,
                ref: { pluginId: retiredPluginId, version: '1.2.3' },
                normalizedManifest: { ...intentRead().release!.normalizedManifest, id: retiredPluginId },
            },
            uiArtifacts: [],
        });
        const materializations = [machineBoundMaterialization()];
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({
            scope,
            snapshot: snapshot({
                intentReads: [
                    { pluginId: 'com.acme.fixture', response: intentRead() },
                    { pluginId: retiredPluginId, response: retiredResponse },
                ],
                materializations,
                snapshots: [{
                    serverIdentityId: materializations[0]!.serverIdentityId,
                    machineId: materializations[0]!.machineId,
                    materializations,
                }],
            }),
        });
        const reader = store.bind(scope);
        let notifications = 0;
        reader.subscribe(() => { notifications += 1; });

        store.retire([retiredPluginId]);

        expect(notifications).toBe(1);
        expect(reader.readCurrentSettingsDeclaration({ pluginId: retiredPluginId }))
            .toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(reader.readCurrentArtifact({ pluginId: 'com.acme.fixture', ...hostedSlot }))
            .toMatchObject({ kind: 'available' });
        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            intentReads: [{ pluginId: 'com.acme.fixture' }],
            materializations,
            snapshots: [{ materializations }],
        });
    });

    it('projects only Account currentness/materialization facts and never a byte-source or renderer URL selector', () => {
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot() });

        expect(reader).not.toHaveProperty('readHostedWebArtifact');
        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            availabilityCursor: 42,
            materializations: [expect.objectContaining({
                materializationId: 'install-1',
                enabled: false,
                trustState: 'revoked',
            })],
        });
    });

    it('derives the current Artifact coordinate from the canonical intent-read response without granting a byte source', () => {
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: intentRead(),
                }],
            },
        });

        expect(reader.readCurrentArtifact({
            pluginId: 'com.acme.fixture',
            ...hostedSlot,
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            artifact: expect.objectContaining({
                pluginId: 'com.acme.fixture',
                contributionId: 'hosted',
                tier: 'hostedWeb',
                platform: 'web',
                accountArtifactId: '00000000-0000-4000-8000-000000000001',
                artifactId: 'hosted',
                digest: artifactDigest,
                releaseVersion: '1.2.3',
            }),
        });
        expect(reader.readCurrentArtifact({
            pluginId: 'com.acme.fixture',
            ...hostedSlot,
        })).not.toHaveProperty('artifact.entryPath');
    });

    it('withholds Account-hosted provenance when hosting is unavailable or the intent opts out while preserving Artifact admission', () => {
        const response = intentRead();
        const intent = response.intent;
        if (!intent) throw new Error('Fixture requires a current intent.');
        for (const input of [
            { hostingCapability: { enabled: false as const }, offlineUiHosting: 'enabled' as const },
            { hostingCapability: response.hostingCapability, offlineUiHosting: 'disabled' as const },
        ]) {
            const reader = createPluginAccountAvailabilityReader({
                scope,
                snapshot: {
                    ...snapshot(),
                    intentReads: [{
                        pluginId: 'com.acme.fixture',
                        response: {
                            ...response,
                            hostingCapability: input.hostingCapability,
                            intent: { ...intent, offlineUiHosting: input.offlineUiHosting },
                        },
                    }],
                },
            });

            expect(reader.readCurrentArtifact({
                pluginId: 'com.acme.fixture',
                ...hostedSlot,
            })).toEqual({
                kind: 'available',
                availabilityCursor: 42,
                artifact: {
                    pluginId: 'com.acme.fixture',
                    contributionId: 'hosted',
                    artifactId: 'hosted',
                    tier: 'hostedWeb',
                    platform: 'web',
                    digest: artifactDigest,
                    hostUiApiRange: '^1.0.0',
                    releaseVersion: '1.2.3',
                },
            });
        }
    });

    it('admits only the current enabled release Package Asset descriptor without exposing its Artifact transport', () => {
        const response = intentRead();
        if (!response.release) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response,
                }],
            },
        });

        expect(reader.readCurrentPackageAsset({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            packageAsset: {
                pluginId: 'com.acme.fixture',
                releaseVersion: '1.2.3',
                descriptor: response.release.packageAssetArchive,
            },
        });
        expect(reader.readCurrentPackageAsset({ pluginId: 'com.acme.fixture' }))
            .not.toHaveProperty('packageAsset.artifactId');
    });

    it('projects the selected package archive into hosting administration without requiring a UI slot', () => {
        const response = intentRead();
        if (!response.release) throw new Error('Fixture requires a release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: snapshot({
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: { ...response, release: { ...response.release, uiSlots: [] }, uiArtifacts: [] },
                }],
            }),
        });
        expect(reader.readCurrentHostedArtifactAdministration({ pluginId: 'com.acme.fixture' }))
            .toMatchObject({
                kind: 'available',
                release: { packageAssetArchive: response.release.packageAssetArchive },
            });
    });

    it('admits package publication only for an enabled opted-in release with server hosting and no exact hosted archive', () => {
        const response = intentRead();
        if (!response.release || !response.intent) throw new Error('Fixture requires a selected release.');
        const manifest = {
            ...response.release.normalizedManifest,
            contributes: {
                resources: [{ id: 'mark', kind: 'asset', path: 'assets/mark.png', contentType: 'image/png' }],
            },
        };
        const archive = createPackageAssetArchiveV1({
            manifest,
            files: [{ path: 'assets/mark.png', bytes: new Uint8Array([1, 2, 3]) }],
        });
        if (!archive) throw new Error('Fixture requires a package archive.');
        const release = { ...response.release, normalizedManifest: manifest, packageAssetArchive: archive.descriptor, uiSlots: [] };
        const read = (overrides: Readonly<Record<string, unknown>> = {}) => createPluginAccountAvailabilityReader({
            scope,
            snapshot: snapshot({ intentReads: [{ pluginId: release.ref.pluginId, response:
                PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                    ...response, release, uiArtifacts: [], packageAssets: [], ...overrides,
                }),
            }] }),
        }).readCurrentHostedPackageAssetPublicationTarget({ pluginId: release.ref.pluginId });

        expect(read()).toMatchObject({ kind: 'available', target: { release: release.ref, descriptor: archive.descriptor } });
        expect(read({ hostingCapability: { enabled: false } })).toMatchObject({ kind: 'unavailable' });
        expect(read({ intent: { ...response.intent, offlineUiHosting: 'disabled' } })).toMatchObject({ kind: 'unavailable' });
        expect(read({ intent: { ...response.intent, enabled: false } })).toMatchObject({ kind: 'unavailable' });
        expect(read({ packageAssets: [{
            release: release.ref,
            descriptor: archive.descriptor,
            artifactId: '00000000-0000-4000-8000-000000000002',
        }] })).toMatchObject({ kind: 'unavailable', code: 'artifact_already_hosted' });
    });

    it('admits the current normalized declaration for Account Settings even when activation is disabled', () => {
        const response = intentRead();
        if (!response.intent || !response.release) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: { ...response.intent, enabled: false },
                    },
                }],
            },
        });

        expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            declaration: response.release.normalizedManifest,
        });
    });

    it('admits the current Account release selection with its CAS revision even while the release is disabled', () => {
        const response = intentRead();
        if (!response.intent || !response.release) throw new Error('Fixture requires a current release.');
        const disabledIntent = { ...response.intent, enabled: false };
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: disabledIntent,
                    },
                }],
            },
        });

        expect(reader.readCurrentReleaseSelection({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            intent: disabledIntent,
            release: {
                ref: response.release.ref,
                normalizedManifest: response.release.normalizedManifest,
            },
        });
        expect(reader.readCurrentAccountDataCapability({ pluginId: 'com.acme.fixture' })).toEqual({
            kind: 'unavailable',
            code: 'account_data_not_current',
        });
    });

    it('projects an exact Collection ref for server admission without deciding digest compatibility', () => {
        const ref = {
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
            schemaVersion: 2,
            contractDigest: 'A'.repeat(43),
        };
        const response = intentRead();
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        release: response.release
                            ? { ...response.release, collectionContracts: [ref] }
                            : null,
                    },
                }],
            },
        });

        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
            ref,
        });
        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).not.toHaveProperty('contract');
        const retained = { ...ref, contractDigest: `${'B'.repeat(42)}A` };
        expect(reader.readCurrentCollectionContract({
            pluginId: ref.pluginId, collectionId: ref.collectionId, ref: retained,
        })).toEqual({ kind: 'available', availabilityCursor: 42, ref: retained });
        expect(reader.readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'projects',
        })).toEqual({
            kind: 'unavailable',
            code: 'collection_not_current',
        });
    });

    it('admits the writer ref of a release-less daemon claim without selecting release UI', () => {
        const ref = {
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
            schemaVersion: 2,
            contractDigest: 'A'.repeat(43),
        };
        const response = intentRead();
        if (!response.intent) throw new Error('Fixture requires an intent.');
        const readerFor = (enabled: boolean) => createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: {
                            ...response.intent!,
                            desiredVersion: null,
                            enabled,
                            writableCollections: [ref],
                        },
                        release: null,
                        uiArtifacts: [],
                        packageAssets: [],
                    },
                }],
            },
        });

        expect(readerFor(true).readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).toEqual({ kind: 'available', availabilityCursor: 42, ref });
        const compiledRef = { ...ref, schemaVersion: 1, contractDigest: 'B'.repeat(43) };
        const bundledReader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: snapshot({ intentReads: [{ pluginId: ref.pluginId, response: {
                ...response, intent: { ...response.intent!, desiredVersion: null, writableCollections: [ref] }, release: null,
            } }] }),
            hostBundledUi: [{ pluginId: ref.pluginId, pluginVersion: '1.0.0', packageName: '@happier-dev/plugins-fixture',
                displayName: 'Fixture', entriesById: {}, collectionContracts: [compiledRef] }],
        });
        // The older app's compiled reader must reach Data unchanged. Availability
        // cannot silently replace it with the newer daemon's writer contract.
        expect(bundledReader.readCurrentCollectionContract({ pluginId: ref.pluginId, collectionId: ref.collectionId }))
            .toEqual({ kind: 'available', availabilityCursor: 42, ref: compiledRef });
        expect(readerFor(true).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({ kind: 'available', availabilityCursor: 42 });
        // The claim is the daemon-admitted plugin's Data authority, so its own
        // Account KV is admitted without a release declaration.
        expect(readerFor(true).readCurrentAccountKvCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({ kind: 'available', availabilityCursor: 42 });
        expect(readerFor(false).readCurrentAccountKvCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({ kind: 'unavailable', code: 'account_kv_not_current' });
        // A claim is Data authority only; release-selected UI stays unselected.
        expect(readerFor(true).readCurrentPackageAsset({
            pluginId: 'com.acme.fixture',
        })).toEqual({ kind: 'unavailable', code: 'artifact_not_current' });
        expect(readerFor(false).readCurrentCollectionContract({
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
        })).toEqual({ kind: 'unavailable', code: 'collection_not_current' });
    });

    it('admits Account Data rendering for either a Collection contract or declared Account KV', () => {
        const ref = {
            pluginId: 'com.acme.fixture',
            collectionId: 'tasks',
            schemaVersion: 2,
            contractDigest: 'A'.repeat(43),
        };
        const response = intentRead();
        const readerFor = (input: Readonly<{
            contracts: readonly typeof ref[];
            enabled?: boolean;
            accountStorage?: 'required' | 'optional';
        }>) => createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: {
                        ...response,
                        intent: response.intent
                            ? { ...response.intent, enabled: input.enabled ?? true }
                            : null,
                        release: response.release
                            ? {
                                ...response.release,
                                collectionContracts: input.contracts,
                                normalizedManifest: {
                                    ...response.release.normalizedManifest,
                                    hostAccess: {
                                        required: input.accountStorage === 'required'
                                            ? [{
                                                id: 'account-storage',
                                                capability: 'storage.account' as const,
                                                reason: 'Persist Account-scoped plugin state.',
                                                scope: { enabled: true as const },
                                            }]
                                            : [],
                                        optional: input.accountStorage === 'optional'
                                            ? [{
                                                id: 'optional-account-storage',
                                                capability: 'storage.account' as const,
                                                reason: 'Persist optional Account-scoped plugin state.',
                                                scope: { enabled: true as const },
                                            }]
                                            : [],
                                    },
                                },
                            }
                            : null,
                    },
                }],
            },
        });

        expect(readerFor({ contracts: [] }).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'account_data_not_current',
        });
        expect(readerFor({ contracts: [ref] }).readCurrentAccountKvCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'account_kv_not_current',
        });
        expect(readerFor({ contracts: [], accountStorage: 'required' }).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
        });
        expect(readerFor({ contracts: [], accountStorage: 'required' }).readCurrentAccountKvCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
        });
        expect(readerFor({ contracts: [], accountStorage: 'optional' }).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'account_data_not_current',
        });
        // Read capability is release-declared, not inferred from the mutable
        // intent list. CAS remains Data-owned and can require a writable grant.
        expect(readerFor({ contracts: [ref] }).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'available',
            availabilityCursor: 42,
        });
        expect(readerFor({ contracts: [ref], enabled: false }).readCurrentAccountDataCapability({
            pluginId: 'com.acme.fixture',
        })).toEqual({
            kind: 'unavailable',
            code: 'account_data_not_current',
        });
    });

    it('derives exact Account-release correspondence from a strict materialization without electing a machine', () => {
        const response = intentRead();
        const currentRelease = response.release;
        if (!currentRelease) throw new Error('Fixture requires a current release.');
        const reader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: {
                ...snapshot(),
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response,
                }],
            },
        });
        const classifyRelease = reader.classifyRelease;
        const exact = {
            ...snapshot().materializations[0]!,
            enabled: true,
            trustState: 'trusted' as const,
            archiveDigestSha256: currentRelease.archiveDigestSha256,
            uiArtifacts: currentRelease.uiSlots.map((slot) => ({
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: slot.artifactDigest,
                hostUiApiRange: slot.hostUiApiRange,
            })),
        };
        const identity = {
            serverIdentityId: exact.serverIdentityId,
            materializationRef: {
                machineId: exact.machineId,
                materializationId: exact.materializationId,
                pluginId: exact.pluginId,
            },
        };

        expect(classifyRelease(exact)).toEqual({
            ...identity,
            releaseContent: 'matched',
            validation: { kind: 'admitted' },
        });
        for (const correspondenceMismatch of [
            PluginMachineMaterializationV1Schema.parse({
                ...exact,
                version: '1.2.4',
            }),
            PluginMachineMaterializationV1Schema.parse({
                ...exact,
                uiArtifacts: [{
                    ...exact.uiArtifacts[0]!,
                    artifactDigest: `sha256:${'c'.repeat(64)}`,
                }],
            }),
        ]) {
            expect(classifyRelease(correspondenceMismatch)).toEqual({
                ...identity,
                releaseContent: 'conflict',
                validation: { kind: 'admitted' },
            });
        }
        expect(classifyRelease({ ...exact, portableRelease: false })).toEqual({
            ...identity,
            releaseContent: 'unknown',
            validation: { kind: 'rejected', reason: 'non_portable' },
        });
        const noRelease = createPluginAccountAvailabilityReader({ scope, snapshot: {
            ...snapshot(), intentReads: [{ pluginId: exact.pluginId, response: { ...response, intent: null, release: null } }],
        } });
        expect(noRelease.classifyRelease(exact).validation).toEqual({ kind: 'rejected', reason: 'release_unavailable' });
        expect(noRelease.classifyRelease({ ...exact, portableRelease: false }).validation)
            .toEqual({ kind: 'rejected', reason: 'non_portable' });
    });

    it('keeps a source-runtime bundled Channels census descriptive until its daemon source is admitted', () => {
        const materialization = PluginMachineMaterializationV1Schema.parse({
            ...machineBoundMaterialization(),
            pluginId: 'happier.channels',
            materializationId: 'daemon-selected:happier.channels',
            sourceClass: 'bundledFirstParty',
        });
        const reader = createPluginAccountAvailabilityReader({ scope, snapshot: snapshot({
            materializations: [materialization],
            snapshots: [{ serverIdentityId: materialization.serverIdentityId,
                machineId: materialization.machineId, materializations: [materialization] }],
        }) });

        expect(reader.readMaterializations()).toMatchObject({ kind: 'available', materializations: [materialization] });
        expect(reader.classifyRelease(materialization)).toEqual({
            serverIdentityId: materialization.serverIdentityId,
            materializationRef: { machineId: materialization.machineId,
                materializationId: materialization.materializationId, pluginId: materialization.pluginId },
            releaseContent: 'unknown',
            validation: { kind: 'rejected', reason: 'non_portable' },
        });
    });

    it('fails closed after the store moves to a different Account scope', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: snapshot() });
        const reader = store.bind({ serverId: 'srv-local-a', accountId: 'account-b' });

        expect(reader.readMaterializations())
            .toEqual({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    });

    it('reuses immutable materialization facts until replacement without leaking caller mutations or another Account', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const base = snapshot();
        const parsed = PluginMachineMaterializationV1Schema.parse({
            ...base.materializations[0],
            declaredManifest: intentRead().release!.normalizedManifest,
            declaredUiEntries: {},
        });
        const materialization = {
            ...parsed,
            uiArtifacts: parsed.uiArtifacts.map((artifact) => ({ ...artifact })),
            declaredUiEntries: { ...parsed.declaredUiEntries },
        };
        store.replace({ scope, snapshot: snapshot({
            materializations: [materialization],
            snapshots: [{ ...base.snapshots[0]!, materializations: [materialization] }],
        }) });
        const reader = store.bind(scope);
        const first = reader.readMaterializations();
        if (first.kind !== 'available') throw new Error('Expected materialization inventory');

        materialization.enabled = true;
        const declaredManifest = materialization.declaredManifest;
        if (!declaredManifest?.engines) throw new Error('Fixture requires declared manifest engines');
        declaredManifest.displayName = 'Mutated input';
        declaredManifest.engines.happier = '^9.0.0';
        materialization.uiArtifacts.splice(0, 1);
        Object.assign(materialization.declaredUiEntries!, { mutated: {} });

        const repeated = reader.readMaterializations();
        if (repeated.kind !== 'available') throw new Error('Expected materialization inventory');
        expect(repeated.materializations).toBe(first.materializations);
        expect(repeated.snapshots).toBe(first.snapshots);
        expect(repeated.materializations[0]).toMatchObject({
            enabled: false,
            declaredManifest: { displayName: 'Fixture', engines: { happier: '^1.0.0' } },
            declaredUiEntries: {},
            uiArtifacts: [{ contributionId: 'hosted' }],
        });
        const owned = repeated.materializations[0]!;
        expect(owned.declaredUiEntries).toEqual({});
        for (const value of [repeated.materializations, repeated.snapshots, owned,
            owned.declaredManifest, owned.declaredManifest!.engines, owned.declaredUiEntries,
            owned.uiArtifacts, owned.uiArtifacts[0], repeated.snapshots[0],
            repeated.snapshots[0]!.materializations]) {
            expect(Object.isFrozen(value)).toBe(true);
        }
        const installed = reader.readInstalledPlugins();
        if (installed.kind !== 'available') throw new Error('Expected descriptive inventory');
        expect(installed.plugins[0]!.installations[0]!.materialization).toBe(owned);
        expect(installed.plugins[0]!.installations[0]!.declaration).toBe(owned.declaredManifest);

        store.replace({ scope, snapshot: snapshot({
            availabilityCursor: 43,
            materializations: [],
            snapshots: [],
        }) });
        expect(reader.readMaterializations()).toMatchObject({
            availabilityCursor: 43, materializations: [], snapshots: [],
        });
        expect(first.materializations).toHaveLength(1);
        expect(reader.readInstalledPlugins()).toMatchObject({ availabilityCursor: 43, plugins: [] });

        store.replace({ scope: { ...scope, accountId: 'account-b' }, snapshot: snapshot() });
        expect(reader.readMaterializations()).toEqual({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
        expect(reader.readInstalledPlugins()).toEqual({ kind: 'unavailable', code: 'account_availability_scope_mismatch' });
    });

    it('replaces one complete materialization projection atomically', () => {
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: snapshot() });
        const reader = store.bind(scope);

        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            availabilityCursor: 42,
        });
        store.replace({ scope, snapshot: snapshot({
            availabilityCursor: 43,
            materializations: [],
            snapshots: [],
        }) });
        expect(reader.readMaterializations()).toEqual({
            kind: 'available',
            availabilityCursor: 43,
            intentReads: [],
            materializations: [],
            snapshots: [],
        });
    });

    it.each(['named failure', 'incomplete census'] as const)('replaces successful plugin reads while a %s keeps prior sibling content readable and flagged stale (AVD-07)', (failure) => {
        const failedPluginId = 'com.acme.failed';
        const failedResponse = PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
            ...intentRead(),
            intent: { ...intentRead().intent!, pluginId: failedPluginId },
            release: {
                ...intentRead().release!,
                ref: { pluginId: failedPluginId, version: '1.2.3' },
                normalizedManifest: { ...intentRead().release!.normalizedManifest, id: failedPluginId },
            },
            uiArtifacts: [],
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({
            scope,
            snapshot: snapshot({
                intentReads: [
                    { pluginId: 'com.acme.fixture', response: intentRead() },
                    { pluginId: failedPluginId, response: failedResponse },
                ],
            }),
        });
        const reader = store.bind(scope);
        const failedPluginObservation = reader.getObservationSnapshot(failedPluginId);

        store.replace({
            scope,
            snapshot: snapshot({
                availabilityCursor: 43,
                intentReads: [{
                    pluginId: 'com.acme.fixture',
                    response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                        ...intentRead(),
                        availabilityCursor: 43,
                    }),
                }],
            }),
            ...(failure === 'named failure' ? { failedPluginIds: [failedPluginId] } : { intentCensusIncomplete: true }),
        });

        expect(reader.readCurrentArtifact({ pluginId: 'com.acme.fixture', ...hostedSlot }))
            .toMatchObject({ kind: 'available', availabilityCursor: 43 });
        // A transport/timeout/parse failure is not a withdrawal: the prior
        // confirmed selection stays usable and mounted UI is not revoked.
        expect(reader.readCurrentSettingsDeclaration({ pluginId: failedPluginId }))
            .toMatchObject({ kind: 'available' });
        expect(reader.readMaterializations()).toMatchObject({
            kind: 'available',
            intentReads: [{ pluginId: failedPluginId }, { pluginId: 'com.acme.fixture' }],
        });
        expect(store.getSnapshot()).toMatchObject({
            stalePluginIds: [failedPluginId],
            snapshot: { intentReads: [{ pluginId: failedPluginId }, { pluginId: 'com.acme.fixture' }] },
        });
        // Refresh diagnostics do not change the failed plugin's last-confirmed
        // descriptive facts or the current admission read through this owner.
        expect(reader.getObservationSnapshot(failedPluginId)).toBe(failedPluginObservation);

        store.replace({
            scope,
            snapshot: snapshot({ availabilityCursor: 44, intentReads: [{ pluginId: failedPluginId, response: failedResponse }] }),
            failedPluginIds: [],
        });
        expect(reader.readCurrentSettingsDeclaration({ pluginId: failedPluginId }))
            .toMatchObject({ kind: 'available' });
        expect(store.getSnapshot()).toMatchObject({ stalePluginIds: [] });
        expect(reader.getObservationSnapshot(failedPluginId)).toBe(failedPluginObservation);
    });

    it('snapshots caller-owned nested release, intent, and materialization facts at reader ingestion', () => {
        const response = intentRead();
        const intent = response.intent;
        const release = response.release;
        if (!intent || !release) throw new Error('Fixture requires a current intent and release.');
        const mutableResponse = {
            ...response,
            intent: {
                ...intent,
                writableCollections: [...intent.writableCollections],
            },
            release: {
                ...release,
                normalizedManifest: {
                    ...release.normalizedManifest,
                    engines: { ...release.normalizedManifest.engines },
                },
                collectionContracts: [...release.collectionContracts],
                uiSlots: release.uiSlots.map((slot) => ({
                    ...slot,
                })),
                packageAssetArchive: {
                    ...release.packageAssetArchive,
                    resources: [...release.packageAssetArchive.resources],
                },
            },
            uiArtifacts: response.uiArtifacts.map((artifact) => ({
                ...artifact,
                release: { ...artifact.release },
            })),
        };
        const mutableMaterializations = snapshot().materializations.map((materialization) => ({
            ...materialization,
            uiArtifacts: materialization.uiArtifacts.map((artifact) => ({ ...artifact })),
        }));
        const mutableSnapshot = {
            availabilityCursor: 42,
            intentReads: [{
                pluginId: 'com.acme.fixture',
                response: mutableResponse,
            }],
            materializations: mutableMaterializations,
            snapshots: [{
                serverIdentityId: 'srv_fixture',
                machineId: 'machine-1',
                materializations: mutableMaterializations,
            }],
        };
        const directReader = createPluginAccountAvailabilityReader({
            scope,
            snapshot: mutableSnapshot,
        });
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: mutableSnapshot });
        const liveReader = store.bind(scope);

        // These mutations model the transport/projection owner reusing its
        // input graph after ingestion. Neither reader may silently adopt them
        // without a new Account Availability replacement/cursor notification.
        mutableResponse.intent.enabled = false;
        mutableResponse.intent.writableCollections.push({
            pluginId: 'com.acme.fixture',
            collectionId: 'mutated',
            schemaVersion: 1,
            contractDigest: 'm'.repeat(43),
        });
        mutableResponse.release.normalizedManifest.displayName = 'Mutated fixture';
        mutableResponse.release.uiSlots.splice(0, 1);
        mutableMaterializations[0]!.enabled = true;
        mutableMaterializations[0]!.uiArtifacts.splice(0, 1);

        for (const reader of [directReader, liveReader]) {
            expect(reader.readCurrentArtifact({
                pluginId: 'com.acme.fixture',
                ...hostedSlot,
            })).toMatchObject({
                kind: 'available',
                artifact: {
                    digest: artifactDigest,
                    releaseVersion: '1.2.3',
                },
            });
            expect(reader.readCurrentSettingsDeclaration({ pluginId: 'com.acme.fixture' }))
                .toMatchObject({
                    kind: 'available',
                    declaration: { displayName: 'Fixture' },
                });
            expect(reader.readMaterializations()).toMatchObject({
                kind: 'available',
                materializations: [{
                    enabled: false,
                    uiArtifacts: [{ contributionId: 'hosted' }],
                }],
                snapshots: [{
                    materializations: [{
                        enabled: false,
                        uiArtifacts: [{ contributionId: 'hosted' }],
                    }],
                }],
            });
        }
    });
});
