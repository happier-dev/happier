import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityIntentReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { createPluginAccountAvailabilityReaderStore } from '@/sync/domains/plugins/availability/reader';
import {
    applyPluginAccountAvailabilityProjectionRefresh,
    clearPluginAccountAvailabilityProjection,
    readPluginAccountAvailability,
} from '@/sync/domains/plugins/availability/projection';
import { InvalidateSync } from '@/utils/sessions/sync';
import { refreshPluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/refreshProjection';
import { activateStorageAccountScope } from '@/dev/testkit/runtime/storageRuntime';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { ServerFetchAbortedForServerSwitchError, ServerFetchReadSupersededError } from '@/sync/http/client';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import { createPluginEventAutomationSetupResultV1JsonSchema } from '@happier-dev/protocol/automations/event-setup-result';

import { createActivePluginAccountAvailabilityProjectionHydrator } from './pluginAvailabilityProjection';

const scope = { serverId: 'srv-manifest-compat', accountId: 'account-manifest-compat' } as const;
const pluginId = 'com.acme.manifest-compat';
const materializationsPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.materializations.read'];
const intentsPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'];

function intentRead() {
    return PluginAvailabilityIntentReadActionOutputV1Schema.parse({
        availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: { pluginId, desiredVersion: '1.0.0', enabled: true,
            offlineUiHosting: 'disabled', writableCollections: [], revision: '1' },
        release: {
            ref: { pluginId, version: '1.0.0' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Stored plugin',
                engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
                contributes: { actions: [{ id: 'healthy', title: 'Healthy Action', scopes: ['global'],
                    surfaces: ['ui'], placementBindings: ['commandPalette'],
                    execution: { target: 'daemon' }, dangerLevel: 'safe' }] },
            },
            collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        },
        packageAssets: [], uiArtifacts: [],
    });
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function availabilityChange() {
    return { cursor: 2, kind: 'pluginDomain', entityId: `pluginDomain/${pluginId}/availability`,
        changedAt: 2, hint: { pluginDomain: 'availability', pluginId } };
}

afterEach(() => {
    clearPluginAccountAvailabilityProjection();
    vi.useRealTimers();
});

describe('stored manifest Account Availability read', () => {
    it.each([
        { inventoryComplete: true, canMerge: true },
        { inventoryComplete: false, canMerge: false },
        { inventoryComplete: false, canMerge: true },
    ])('acquires guided Event Machine bodies after the page census ($inventoryComplete / merge $canMerge)', async ({ inventoryComplete, canMerge }) => {
        const base = intentRead();
        const sourceConfigSchema = { type: 'object', properties: {}, additionalProperties: false } as const;
        const manifest = { ...base.release!.normalizedManifest, contributes: {
            actions: [{ id: 'setup', title: 'Configure source', scopes: ['global'], surfaces: ['plugin'],
                dangerLevel: 'safe', execution: { target: 'daemon' }, inputSchema: sourceConfigSchema,
                resultSchema: createPluginEventAutomationSetupResultV1JsonSchema(1, sourceConfigSchema) }],
            events: [{ kind: 'event', id: 'changed', title: 'Changed', payloadSchema: sourceConfigSchema,
                automation: { v: 1, eligible: true, source: { sourceContractVersion: 1,
                    supportedObservationTransports: ['checkpointedPull'], sourceConfigSchema,
                    setupActionRef: { pluginId, localId: 'setup' } } } }],
        } };
        const declaration = { manifest, declarationDigestSha256: `sha256:${'c'.repeat(64)}` };
        const exact = { ...base, intent: { ...base.intent!, desiredVersion: null }, release: null,
            currentDeclaration: declaration, machineDeclarations: [{ machineId: 'machine-a',
                machineInstallationId: 'installed-a', declaration }] };
        let listCount = 0;
        let exactCount = 0;
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => {
                if (path === materializationsPath) return jsonResponse({ availabilityCursor: 1, snapshots: [], inventoryComplete });
                if (path === intentsPath) {
                    listCount += 1;
                    return jsonResponse({ availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                        intentReads: [{ pluginId, response: { ...exact, machineDeclarations: [{ machineId: 'machine-a',
                            machineInstallationId: 'installed-a', declaration: { declarationDigestSha256: declaration.declarationDigestSha256 } }] } }] });
                }
                expect(path).toBe(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']);
                exactCount += 1;
                return jsonResponse(exact);
            } }),
        });
        const store = createPluginAccountAvailabilityReaderStore({ loadMachineDeclarations: async (_scope, id) => {
            hydrator.requestPlugins([id]);
            const refreshed = await hydrator.refresh({ canMergePlugins: () => canMerge });
            if (refreshed) store.replace(refreshed);
        } });
        const first = await hydrator.refresh();
        if (!first) throw new Error('Availability did not publish');
        store.replace(first);
        const reader = store.bind(scope);
        const event = { pluginId, machineId: 'machine-a', machineInstallationId: 'installed-a',
            version: '1.0.0', eventLocalId: 'changed', sourceContractVersion: 1 };
        expect(reader.readCurrentAutomationEventContribution(event)).toBeNull();
        // A missing or replaced Machine has no declaration to acquire.
        await reader.ensureAutomationEventDeclarations({ pluginId, machineId: 'absent-machine' });
        expect(exactCount).toBe(0);
        await reader.ensureAutomationEventDeclarations({ pluginId, machineId: 'machine-a' });
        expect(reader.readCurrentAutomationEventContribution(event)).toMatchObject({ id: 'changed' });
        expect(reader.readCurrentAutomationEventContribution({ ...event, machineInstallationId: 'replaced' })).toBeNull();
        await reader.ensureAutomationEventDeclarations({ pluginId, machineId: 'machine-a' });
        expect({ listCount, exactCount }).toEqual({ listCount: inventoryComplete ? 1 : 2, exactCount: 1 });
    });

    it('admits only consumed manifests on a 91-intent first load, then admits an exact Machine declaration on demand', async () => {
        const base = intentRead().release!.normalizedManifest;
        // #97 census: 91 intents, 32 current declarations, 28 rows with two
        // Machine declarations each. The guided Automation editor is their
        // only body consumer; Changes/AppShell do not consume those 56 bodies.
        const intentReads = Array.from({ length: 91 }, (_, index) => {
            const id = `com.acme.list-${String(index).padStart(2, '0')}`;
            const declaration = { manifest: { ...base, id }, declarationDigestSha256: `sha256:${'c'.repeat(64)}` };
            return { pluginId: id, response: { availabilityCursor: 1, hostingCapability: { enabled: false },
                intent: { pluginId: id, desiredVersion: null, enabled: true, offlineUiHosting: 'disabled',
                    writableCollections: [], revision: '1' }, release: null, uiArtifacts: [], packageAssets: [],
                currentDeclaration: index < 32 ? declaration : null,
                ...(index < 28 ? { machineDeclarations: ['machine-a', 'machine-b'].map(machineId => ({
                    machineId, machineInstallationId: `${machineId}-installation`,
                    declaration: { ...declaration, manifest: { ...declaration.manifest } },
                })) } : {}),
            } };
        });
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => jsonResponse(path === materializationsPath
                ? { availabilityCursor: 1, snapshots: [], releases: [] }
                : { availabilityCursor: 1, pluginIds: intentReads.map(row => row.pluginId), failedPluginIds: [], intentReads }) }),
        });
        const fullParses = vi.spyOn(PluginManifestV2Schema, 'safeParse');
        try {
            const first = await hydrator.refresh();
            if (!first) throw new Error('Availability did not publish');
            const store = createPluginAccountAvailabilityReaderStore();
            store.replace(first);
            const reader = store.bind(scope);
            reader.readInstalledPlugins();
            reader.readUiProjectionInputs();
            reader.readCurrentAccountExecutionDeclarations();
            expect(fullParses).toHaveBeenCalledTimes(32);
            const selected = { pluginId: intentReads[0]!.pluginId, version: base.version,
                machineId: 'machine-a', machineInstallationId: 'machine-a-installation',
                eventLocalId: 'absent', sourceContractVersion: 1 };
            expect(reader.readCurrentAutomationEventContribution({ ...selected, machineId: 'missing' })).toBeNull();
            expect(fullParses).toHaveBeenCalledTimes(32);
            expect(reader.readCurrentAutomationEventContribution(selected)).toBeNull();
            expect(fullParses).toHaveBeenCalledTimes(33);
            // Unconsumed malformed bodies do not refuse unrelated list rows;
            // selecting that exact body still fails at full manifest admission.
            intentReads[0]!.response.machineDeclarations![0]!.declaration.manifest.version = 'invalid-semver';
            const changed = await hydrator.refresh();
            if (!changed) throw new Error('Changed availability did not publish');
            store.replace(changed);
            expect(reader.readCurrentAutomationEventContribution(selected)).toBeNull();
            expect(fullParses).toHaveBeenCalledTimes(66);
        } finally { fullParses.mockRestore(); }
    });

    it('admits a manifest revision once at ingress and zero times across availability publications and view reads', async () => {
        const response = intentRead();
        if (!response.release) throw new Error('Missing fixture release');
        let manifest = response.release.normalizedManifest;
        let revision = 1;
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => jsonResponse(path === materializationsPath
                ? { availabilityCursor: revision, snapshots: [{ serverIdentityId: 'srv_identity', machineId: 'machine-a',
                    materializations: [{ serverIdentityId: 'srv_identity', machineId: 'machine-a',
                        materializationId: 'installed-a', pluginId, version: '1.0.0', sourceClass: 'registryPackage',
                        portableRelease: true, enabled: true, trustState: 'trusted', observedAt: revision,
                        uiArtifacts: [], declaredManifest: manifest }] }] }
                : { availabilityCursor: revision, pluginIds: [], failedPluginIds: [], intentReads: [] }) }),
        });
        const store = createPluginAccountAvailabilityReaderStore();
        const fullParses = vi.spyOn(PluginManifestV2Schema, 'safeParse');
        try {
            const first = await hydrator.refresh();
            if (!first) throw new Error('Availability did not publish');
            expect(fullParses).toHaveBeenCalledTimes(1);
            // New observation/cursor carriers exercise real publications while the
            // admitted manifest revision stays unchanged. Rebinding/reading is the
            // consumer path used when a retained view becomes presented again.
            for (let publication = 0; publication < 12; publication += 1) {
                store.replace({ scope, snapshot: { ...first.snapshot, availabilityCursor: publication + 1,
                    materializations: first.snapshot.materializations.map(row => ({ ...row, observedAt: publication + 1 })),
                    snapshots: first.snapshot.snapshots.map(snapshot => ({ ...snapshot,
                        materializations: snapshot.materializations.map(row => ({ ...row, observedAt: publication + 1 })),
                    })),
                } });
                const reader = store.bind(scope);
                expect(reader.readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [{ pluginId,
                    installations: [{ declaration: { displayName: 'Stored plugin' } }],
                }] });
                reader.readUiProjectionInputs();
                reader.readAccountUiProjection();
                reader.readCurrentAccountExecutionDeclarations();
                expect(fullParses).toHaveBeenCalledTimes(1);
            }
            // A real new declaration reaches the same ingress and the consumer;
            // avoiding admission must never swallow changed plugin facts.
            manifest = { ...manifest, displayName: 'Updated plugin' };
            revision += 1;
            const changed = await hydrator.refresh();
            if (!changed) throw new Error('Changed availability did not publish');
            expect(fullParses).toHaveBeenCalledTimes(2);
            store.replace(changed);
            expect(store.bind(scope).readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [{ pluginId,
                installations: [{ declaration: { displayName: 'Updated plugin' } }],
            }] });
            expect(fullParses).toHaveBeenCalledTimes(2);
            manifest = { ...manifest, version: 'invalid-semver' };
            revision += 1;
            await expect(hydrator.refresh()).rejects.toMatchObject({ code: 'plugin_availability_invalid_response' });
            expect(fullParses).toHaveBeenCalledTimes(3);
        } finally { fullParses.mockRestore(); }
    });

    it('validates each consumed wire manifest once and carries admitted declarations through publication without another full parse', async () => {
        const response = intentRead();
        if (!response.release) throw new Error('Missing fixture release');
        const declaration = { manifest: response.release.normalizedManifest,
            declarationDigestSha256: `sha256:${'c'.repeat(64)}` };
        const materialization = { serverIdentityId: 'srv_identity', machineId: 'machine-a',
            materializationId: 'installed-a', pluginId, version: '1.0.0', sourceClass: 'registryPackage',
            portableRelease: true, enabled: true, trustState: 'trusted', observedAt: 1,
            uiArtifacts: [], archiveDigestSha256: response.release.archiveDigestSha256,
            declaredManifest: declaration.manifest };
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => jsonResponse(path === materializationsPath
                ? { availabilityCursor: 1, releases: [response.release], snapshots: [{
                    serverIdentityId: 'srv_identity', machineId: 'machine-a', materializations: [materialization],
                }] }
                : { availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                    intentReads: [{ pluginId, response: { ...response, currentDeclaration: declaration,
                        machineDeclarations: [{ machineId: 'machine-a', machineInstallationId: 'installed-a', declaration }] } }] }) }),
        });
        // Observe the real schema, including nested load admission, without replacing its logic.
        const fullParses = vi.spyOn(PluginManifestV2Schema, 'safeParse');
        try {
            const refreshed = await hydrator.refresh();
            if (!refreshed) throw new Error('Availability did not publish');
            expect(fullParses).toHaveBeenCalledTimes(4);
            const store = createPluginAccountAvailabilityReaderStore();
            store.replace(refreshed);
            expect(fullParses).toHaveBeenCalledTimes(4);
            expect(store.bind(scope).readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [{
                pluginId, installations: [{ declaration: { displayName: 'Stored plugin' } }],
            }] });
            Reflect.set(refreshed.snapshot.materializations[0]!.declaredManifest!, 'displayName', 'Changed upstream');
            expect(store.bind(scope).readInstalledPlugins()).toMatchObject({ kind: 'available', plugins: [{
                pluginId, installations: [{ declaration: { displayName: 'Stored plugin' } }],
            }] });
            expect(fullParses).toHaveBeenCalledTimes(4);
        } finally { fullParses.mockRestore(); }
    });

    it('publishes a stored release with empty retired families and retains its healthy Action', async () => {
        const response = intentRead();
        if (!response.release) throw new Error('Missing fixture release');
        const storedRelease = { ...response.release, normalizedManifest: {
            ...response.release.normalizedManifest,
            contributes: { ...response.release.normalizedManifest.contributes, tools: [], commands: [] },
        } };
        const materialization = { serverIdentityId: 'srv_identity', machineId: 'machine-a',
            materializationId: 'installed-a', pluginId, version: '1.0.0', sourceClass: 'registryPackage',
            portableRelease: true, enabled: true, trustState: 'trusted', observedAt: 1,
            uiArtifacts: [], archiveDigestSha256: storedRelease.archiveDigestSha256,
            declaredManifest: storedRelease.normalizedManifest };
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => jsonResponse(path === materializationsPath
                ? { availabilityCursor: 1, releases: [storedRelease], snapshots: [{
                    serverIdentityId: 'srv_identity', machineId: 'machine-a', materializations: [materialization],
                }] }
                : { availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                    intentReads: [{ pluginId, response: { ...response, release: storedRelease } }] }) }),
        });
        const store = createPluginAccountAvailabilityReaderStore();
        const reader = store.bind(scope);
        const refreshed = await hydrator.refresh();
        expect(refreshed).not.toBeNull();
        if (!refreshed) throw new Error('Availability did not publish');
        applyPluginAccountAvailabilityProjectionRefresh(refreshed);
        store.replace(refreshed);
        expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
        const installed = reader.readInstalledPlugins();
        expect(installed).toMatchObject({ kind: 'available', plugins: [{ pluginId, installations: [{
            declaration: { contributes: { actions: [{ id: 'healthy' }] } },
        }] }] });
        if (installed.kind !== 'available') throw new Error('Installation was not admitted');
        const declaration = installed.plugins[0]?.installations[0]?.declaration;
        expect(declaration?.contributes).not.toHaveProperty('tools');
        expect(declaration?.contributes).not.toHaveProperty('commands');
    });

    it.each(['materializations', 'intent_census'] as const)(
        'settles a deterministic %s parse failure without automatic reads and recovers on a real change',
        async phase => {
            vi.useFakeTimers();
            let malformed = true;
            const response = intentRead();
            const request = vi.fn(async (path: string) => {
                if (path === materializationsPath) return jsonResponse(malformed && phase === 'materializations'
                    ? { availabilityCursor: 'invalid', snapshots: [] }
                    : { availabilityCursor: 2, snapshots: [] });
                if (path === intentsPath) return jsonResponse(malformed && phase === 'intent_census'
                    ? { availabilityCursor: 1, pluginIds: [pluginId], intentReads: 'invalid', failedPluginIds: [] }
                    : { availabilityCursor: 2, pluginIds: [pluginId], failedPluginIds: [],
                        intentReads: [{ pluginId, response }] });
                if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) return jsonResponse(response);
                throw new Error('Unexpected Availability request');
            });
            const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
                captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
                getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
                captureRequestAuthority: async () => ({ request }),
            });
            const reader = readPluginAccountAvailability(scope);
            const failures: unknown[] = [];
            const queue = new InvalidateSync(() => refreshPluginAccountAvailabilityProjection(hydrator),
                { onError: error => failures.push(error) });
            try {
                queue.invalidate();
                await vi.advanceTimersByTimeAsync(0);
                const readsAfterFailure = request.mock.calls.length;
                expect(readsAfterFailure).toBe(phase === 'materializations' ? 1 : 2);
                await vi.advanceTimersByTimeAsync(60_000);
                expect(request).toHaveBeenCalledTimes(readsAfterFailure);
                expect(failures).toEqual([expect.objectContaining({
                    code: 'plugin_availability_invalid_response', phase, retryable: false, scope,
                })]);
                expect(vi.getTimerCount()).toBe(0);

                malformed = false;
                expect(hydrator.invalidate([availabilityChange()])).toEqual([pluginId]);
                await queue.invalidateAndAwait();
                expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
                expect(request).toHaveBeenCalledTimes(readsAfterFailure + 3);
            } finally {
                queue.stop();
            }
        },
    );

    it('publishes successful census pages before settling a later deterministic page failure', async () => {
        const response = intentRead();
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async (path, init) => {
                if (path === materializationsPath) return jsonResponse({ availabilityCursor: 1, snapshots: [] });
                const body = JSON.parse(String(init?.body)) as { cursor?: string };
                return jsonResponse(body.cursor
                    ? { availabilityCursor: 1, intentReads: 'invalid' }
                    : { availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [], nextCursor: pluginId,
                        intentReads: [{ pluginId, response }] });
            } }),
        });
        const refreshed = await hydrator.refresh();
        if (!refreshed) throw new Error('Missing partial refresh');
        expect(() => applyPluginAccountAvailabilityProjectionRefresh(refreshed)).toThrowError(
            expect.objectContaining({ code: 'plugin_availability_invalid_response', phase: 'intent_census', scope }),
        );
        expect(readPluginAccountAvailability(scope).readCurrentAccountExecution(pluginId))
            .toMatchObject({ kind: 'available' });
    });

    it.each(['pending', 'manual_retry', 'server_switch', 'retirement', 'invalidation'] as const)(
        'does not publish an outage for an initial read under %s control, and permits its successor', async control => {
            vi.useFakeTimers();
            const activeScope = await activateStorageAccountScope(scope);
            const heldResponse = createDeferred<Response>();
            const response = intentRead();
            let current = true;
            let retire = () => {};
            let reads = 0;
            const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
                captureLifetime: () => ({ scope, isCurrent: () => current,
                    onRetire: callback => { retire = callback; return { dispose: () => {} }; } }),
                getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
                captureRequestAuthority: async () => ({ request: async path => {
                    reads += 1;
                    if (reads === 1) return heldResponse.promise;
                    if (path === PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read']) return jsonResponse(response);
                    return jsonResponse(path === materializationsPath
                        ? { availabilityCursor: 1, snapshots: [] }
                        : { availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                            intentReads: [{ pluginId, response }] });
                } }),
            });
            const reader = readPluginAccountAvailability(scope);
            const initial = reader.readCurrentAccountExecution(pluginId);
            const observations: unknown[] = [];
            const unsubscribe = reader.subscribe(() => observations.push(reader.readCurrentAccountExecution(pluginId)));
            let settled = false;
            const pending = refreshPluginAccountAvailabilityProjection(hydrator)
                .catch((error: unknown) => error).finally(() => { settled = true; });
            try {
                await vi.advanceTimersByTimeAsync(60_000);
                expect(settled).toBe(false);
                expect(reads).toBe(1);
                expect(reader.readCurrentAccountExecution(pluginId)).toEqual(initial);
                if (control === 'pending') {
                    heldResponse.resolve(jsonResponse({ availabilityCursor: 1, snapshots: [] }));
                } else if (control === 'manual_retry' || control === 'server_switch') {
                    const error = control === 'manual_retry' ? new ServerFetchReadSupersededError()
                        : new ServerFetchAbortedForServerSwitchError();
                    heldResponse.reject(error);
                    expect(await pending).toBe(error);
                } else {
                    if (control === 'retirement') { current = false; retire(); }
                    else hydrator.invalidate([availabilityChange()]);
                    heldResponse.reject(new TypeError('Network request failed'));
                    expect(await pending).toBeUndefined();
                }
                await pending;
                expect(observations).not.toContainEqual({ kind: 'unavailable', code: 'plugin_availability_unavailable' });
                if (control !== 'pending') {
                    expect(reader.readCurrentAccountExecution(pluginId)).toEqual(initial);
                    current = true;
                    await refreshPluginAccountAvailabilityProjection(hydrator);
                }
                expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
                expect(reads).toBe(control === 'pending' ? 2 : control === 'invalidation' ? 4 : 3);
                expect(vi.getTimerCount()).toBe(0);
            } finally {
                heldResponse.resolve(jsonResponse({ availabilityCursor: 1, snapshots: [] }));
                await pending;
                unsubscribe();
                activeScope.dispose();
            }
        },
    );

    it.each([
        ['materializations', 'http'], ['intent_census', 'http'],
        ['materializations', 'transport'], ['intent_census', 'transport'],
        ['materializations', 'body'], ['intent_census', 'body'],
    ] as const)(
        'publishes transient %s %s failure to subscribed readers, keeps automatic retry and clears failure on recovery', async (phase, failure) => {
        vi.useFakeTimers();
        const activeScope = await activateStorageAccountScope(scope);
        let failedPhaseReads = 0;
        const response = intentRead();
        const hydrator = createActivePluginAccountAvailabilityProjectionHydrator({
            captureLifetime: () => ({ scope, isCurrent: () => true, onRetire: () => ({ dispose: () => {} }) }),
            getServerSnapshot: () => ({ serverId: scope.serverId, generation: 1 }),
            captureRequestAuthority: async () => ({ request: async path => {
                if (path === (phase === 'materializations' ? materializationsPath : intentsPath)) {
                    failedPhaseReads += 1;
                    if (failedPhaseReads === 1) {
                        if (failure === 'transport') throw new TypeError('Network request failed');
                        if (failure === 'body') return new Response(new ReadableStream({
                            start(controller) { controller.error(new TypeError('Network request failed')); },
                        }));
                        return new Response(null, { status: 503 });
                    }
                }
                if (path === materializationsPath) return jsonResponse({ availabilityCursor: 1, snapshots: [] });
                return jsonResponse({ availabilityCursor: 1, pluginIds: [pluginId], failedPluginIds: [],
                    intentReads: [{ pluginId, response }] });
            } }),
        });
        const reader = readPluginAccountAvailability(scope);
        const observations: unknown[] = [];
        const unsubscribe = reader.subscribe(() => observations.push(reader.readCurrentAccountExecution(pluginId)));
        const failures: unknown[] = [];
        const queue = new InvalidateSync(() => refreshPluginAccountAvailabilityProjection(hydrator),
            { onRetryFailure: error => failures.push(error) });
        try {
            queue.invalidate();
            await vi.advanceTimersByTimeAsync(0);
            expect(failedPhaseReads).toBe(1);
            expect(reader.readCurrentAccountExecution(pluginId)).toEqual({
                kind: 'unavailable', code: 'plugin_availability_unavailable',
            });
            expect(observations).toContainEqual({ kind: 'unavailable', code: 'plugin_availability_unavailable' });
            expect(failures).toEqual([expect.objectContaining({
                code: 'plugin_availability_unavailable', phase, scope, retryable: true,
                ...(failure === 'http' ? { status: 503 } : {}),
            })]);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(failedPhaseReads).toBe(2);
            expect(reader.readCurrentAccountExecution(pluginId)).toMatchObject({ kind: 'available' });
            expect(observations.at(-1)).toMatchObject({ kind: 'available' });
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            queue.stop();
            unsubscribe();
            activeScope.dispose();
        }
    });
});
