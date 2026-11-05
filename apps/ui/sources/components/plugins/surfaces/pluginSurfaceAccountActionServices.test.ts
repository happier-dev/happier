import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { definePlugin, type JsonValue } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString, type ProtocolComposableSchema } from '@happier-dev/plugin-sdk/protocol';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { buildQualifiedPluginContributionKey, PluginJsonValueV2Schema } from '@happier-dev/protocol';
import { DaemonPluginStructuredMessageActionExecuteRequestSchema } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { createDeferred, flushHookEffects, renderHook } from '@/dev/testkit';
import { serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { readPluginAccountAvailability, replacePluginAccountAvailabilityProjection } from '@/sync/domains/plugins/availability/projection';
import { machinePluginStructuredMessageActionExecute, resetMachineProjectionReadsForTests } from '@/sync/ops/machineContributionRegistryProjection';
import { createPluginSurfaceAccountActionServices } from './pluginSurfaceAccountActionServices';
import { createBoundPluginSurfaceController } from './boundPluginSurfaceController';
import type { PluginAccountAvailabilityIntentReadResponseV1 } from '@happier-dev/protocol/plugins/availability';
import { readMountedAccountTargetedContributions } from './mountedAccountTargetedContributions';
import { resolveManifestTargetedContributions, type TargetedContributionManifestDeclaration } from '@happier-dev/plugin-sdk/host/registration';
import { projectPluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui/targetedContributions';
import { projectPluginPortableUiDeclarationsV1 } from '@happier-dev/protocol/plugins/contributions/ui';
import {
    DaemonPluginTargetedSourceDeclarationV1Schema,
    DaemonPluginUiTargetedContributionsReadRequestSchema,
    DaemonPluginUiTargetedSurfaceMountV1Schema,
} from '@happier-dev/protocol/daemon/contributionRegistryProjection';

// The Machine RPC is the physical boundary. Manifest parsing, declaration
// merging, targeted admission, observation and handle currentness stay real.
const machineRpc = vi.hoisted(() => vi.fn());
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: machineRpc,
}));

const inputSchema = defineProtocolObject({ id: defineProtocolString() }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ accepted: defineProtocolLiteral(true) }, { policy: 'closed' });
it.each([false, true])('admits the current GitHub source in the Account Triage Session relation view (Machine pending=%s)', async machinePending => {
    const { PLUGIN_MANIFEST, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } = await import('@happier-dev/plugins-triage/manifest');
    const { GITHUB_PLUGIN } = await import('../../../../../../packages/plugins/scm-github/src/manifest');
    const { indexTriageAdmittedSourcesV1 } = await import('../../../../../../packages/plugins/triage/src/actions/listEntries');
    const manifests = [PLUGIN_MANIFEST, GITHUB_PLUGIN.manifest].map(value => {
        const parsed = ingestPluginManifestV2(value);
        if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
        return parsed.manifest;
    });
    const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://triage-source-view.test', accountId: 'alice' }], route: () => undefined });
    let owner: ReturnType<typeof createPluginSurfaceAccountActionServices> | undefined;
    try {
        const lifetime = captureActiveServerAccountScopeLifetime();
        if (!lifetime) throw new Error('Expected Account lifetime');
        replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
            availabilityCursor: 1, materializations: [], snapshots: [], intentReads: manifests.filter(manifest => machinePending || manifest.id === PLUGIN_MANIFEST.id).map(manifest => ({ pluginId: manifest.id, response: {
                availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                intent: { pluginId: manifest.id, desiredVersion: manifest.version, enabled: true, offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                release: { ref: { pluginId: manifest.id, version: manifest.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
                    normalizedManifest: manifest, collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
            } })),
        } });
        machineRpc.mockImplementation(async request => {
            if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) throw new Error('Unexpected Machine RPC');
            return { status: 'sourceDeclarations', pluginId: PLUGIN_MANIFEST.id, sourceDeclarations: manifests.map(manifest => ({
                occurrenceId: `${manifest.id}:machine`, sourceCustody: { kind: 'development', registeredRootId: `/plugins/${manifest.id}` },
                manifest: { id: manifest.id, contributes: { actions: manifest.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: manifest.contributes.targetedPluginContributions,
                    ui: { renderers: manifest.contributes.ui.renderers } } },
            })) };
        });
        owner = createPluginSurfaceAccountActionServices({ pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'account-triage',
            accountLifetime: lifetime, signal: new AbortController().signal, isCurrent: () => true,
            isMachineAvailable: () => !machinePending,
            machine: { machineId: 'session-machine', serverId: lifetime.scope.serverId }, execute: async () => null });
        const observation = owner.services.targetedContributions.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated() {} });
        try {
            const snapshot = await observation.readCurrent();
            expect(snapshot.contributions.map(row => row.contributor.pluginId)).toContain(GITHUB_PLUGIN.manifest.id);
            expect([...indexTriageAdmittedSourcesV1(snapshot.contributions).values()].map(row => row.contributor.pluginId)).toContain(GITHUB_PLUGIN.manifest.id);
            if (machinePending) expect(machineRpc).not.toHaveBeenCalled();
        } finally { observation.dispose(); }
    } finally { await owner?.dispose(); machineRpc.mockReset(); resetMachineProjectionReadsForTests(); await home.dispose(); }
});
const protocol = defineContributionProtocol({ id: 'external-source', version: 1, operations: {
    inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
} });
const target = definePlugin({ id: 'example.account-target', version: '1.0.0',
    contributionPoints: { sources: protocol.point() } });
const source = definePlugin({ id: 'example.machine-source', version: '1.0.0', actions: {
    inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
        inputSchema, resultSchema, run: async () => ({ accepted: true as const }) },
}, contributesTo: { 'example.account-target': { sources: {
    personal: protocol.contribute({ operations: { inspect: protocol.operations.inspect.bind('inspect') } }),
} } } });

describe('Account Action targeted-contribution services', () => {
    it('projects the current mounted Account target without a Machine', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://mounted-account-target.test', accountId: 'alice' }], route: () => undefined });
        let unmount: (() => Promise<void>) | undefined;
        try {
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Expected current Account lifetime');
            const intentReads = [target, source].map(plugin => {
                const parsed = ingestPluginManifestV2(plugin.manifest);
                if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
                return { pluginId: parsed.manifest.id, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false as const }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: parsed.manifest.id, desiredVersion: parsed.manifest.version, enabled: true,
                        offlineUiHosting: 'disabled' as const, writableCollections: [], revision: 'one' },
                    release: { ref: { pluginId: parsed.manifest.id, version: parsed.manifest.version },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: parsed.manifest,
                        collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                } satisfies PluginAccountAvailabilityIntentReadResponseV1 };
            });
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads,
            } });
            const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(target.manifest.id);
            if (selected.kind !== 'available' || (selected.sourceCustody.kind !== 'account_release'
                && selected.sourceCustody.kind !== 'bundled_first_party')) throw new Error('Expected current Account target');
            const accountOrigin = { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody };
            const { useMountedTargetedContributions } = await import('./mountedTargetedContributions');
            const mounted = await renderHook(() => useMountedTargetedContributions({
                accountLifetime: lifetime,
                machineId: null, serverId: lifetime.scope.serverId, pluginId: target.manifest.id,
                mountedOccurrenceId: selected.custodyId, enabled: true,
                accountExecutionOrigin: accountOrigin,
            }));
            unmount = mounted.unmount;
            await flushHookEffects({ cycles: 3, turns: 2 });
            expect(mounted.getCurrent()).toMatchObject({ phase: 'ready', targetedContributions: {
                target: { pluginId: target.manifest.id, occurrenceId: selected.custodyId, sourceCustody: selected.sourceCustody },
                points: [{ pointId: 'sources', protocols: [{ contributions: [{ contributor: { pluginId: source.manifest.id } }] }] }],
            } });
            expect(machineRpc).not.toHaveBeenCalled();
            await act(async () => replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 2, materializations: [], snapshots: [],
                intentReads: intentReads.map(row => row.pluginId !== source.manifest.id ? row : ({
                    ...row, response: { ...row.response, availabilityCursor: 2,
                        intent: { ...row.response.intent, enabled: false, revision: 'disabled' } },
                })),
            } }));
            await flushHookEffects({ cycles: 3, turns: 2 });
            expect(mounted.getCurrent()).toMatchObject({ phase: 'ready', targetedContributions: {
                points: [{ pointId: 'sources', protocols: [{ contributions: [] }] }],
            } });
            expect(machineRpc).not.toHaveBeenCalled();
        } finally {
            await unmount?.();
            machineRpc.mockReset();
            await home.dispose();
        }
    });

    it('retains an exact selected Machine child under the Account target and omits unavailable physical mounts', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://account-machine-child.test', accountId: 'alice' }], route: () => undefined });
        try {
            resetMachineProjectionReadsForTests();
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('Expected current Account lifetime');
            const makeProtocol = <TInput extends JsonValue>(surfaceInput: ProtocolComposableSchema<TInput>) => defineContributionProtocol({ id: 'machine-detail', version: 1,
                operations: { inspect: { required: true, input: { kind: 'protocolDefined', schema: inputSchema }, resultSchema,
                    action: { surfaces: ['plugin'], dangerLevel: 'safe' } } },
                surfaces: { detail: { required: true, presentation: 'content', inputSchema: surfaceInput } },
            });
            const detailProtocol = makeProtocol(inputSchema);
            const accountParent = definePlugin({ id: 'example.detail-target', version: '1.0.0', contributionPoints: { sources: detailProtocol.point() } });
            const oldMachineInput = defineProtocolObject({ legacy: defineProtocolString() }, { policy: 'closed' });
            const machineParent = definePlugin({ id: accountParent.manifest.id, version: '0.9.0',
                contributionPoints: { sources: makeProtocol(oldMachineInput).point() } });
            const childPoint = defineContributionProtocol({ id: 'child-context', version: 1, operations: {},
                descriptor: defineProtocolObject({ label: defineProtocolString() }, { policy: 'closed' }),
            });
            const machineChild = definePlugin({ id: 'example.detail-source', version: '1.0.0',
                contributionPoints: { own: childPoint.point() },
                actions: { inspect: { title: 'Inspect', surfaces: ['plugin'], dangerLevel: 'safe', execution: { target: 'daemon' },
                    inputSchema, resultSchema, run: async () => ({ accepted: true as const }) } },
                ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Machine source detail' } }] },
                contributesTo: { [accountParent.manifest.id]: { sources: { provider: detailProtocol.contribute({
                    operations: { inspect: detailProtocol.operations.inspect.bind('inspect') }, surfaces: { detail: { renderer: 'detail' } },
                }) } } },
            });
            const parseManifest = (plugin: Readonly<{ manifest: unknown }>) => {
                const parsed = ingestPluginManifestV2(plugin.manifest);
                if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
                return parsed.manifest;
            };
            const parentManifest = parseManifest(accountParent);
            const childManifest = parseManifest(machineChild);
            const oldParentManifest = parseManifest(machineParent);
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: parentManifest.id, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: parentManifest.id, desiredVersion: parentManifest.version, enabled: true,
                        offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                    release: { ref: { pluginId: parentManifest.id, version: parentManifest.version },
                        archiveDigestSha256: `sha256:${'c'.repeat(64)}`, normalizedManifest: parentManifest,
                        collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'d'.repeat(64)}`, resources: [] } },
                } }],
            } });
            const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(parentManifest.id);
            if (selected.kind !== 'available' || selected.sourceCustody.kind !== 'account_release') throw new Error('Expected selected Account release');
            const accountOrigin = { ...lifetime.scope, custodyId: selected.custodyId, sourceCustody: selected.sourceCustody };
            const declarations = [oldParentManifest, childManifest].map((manifest, index) => DaemonPluginTargetedSourceDeclarationV1Schema.parse({
                occurrenceId: index === 0 ? 'machine-parent-current' : 'machine-child-current',
                sourceCustody: { kind: 'development', registeredRootId: `${manifest.id}-root` },
                manifest: { id: manifest.id, contributes: { actions: manifest.contributes.actions,
                    pluginContributionPoints: manifest.contributes.pluginContributionPoints,
                    targetedPluginContributions: manifest.contributes.targetedPluginContributions,
                    ui: { renderers: manifest.contributes.ui.renderers } } },
            }));
            const admitted = resolveManifestTargetedContributions(declarations);
            const project = (declaration: TargetedContributionManifestDeclaration) => projectPluginUiTargetedContributionsV1({
                target: { pluginId: declaration.manifest.id, occurrenceId: declaration.occurrenceId },
                snapshots: declaration.manifest.contributes.pluginContributionPoints.flatMap(point => point.protocols.map(protocol => {
                    const snapshot = admitted.read({ targetPluginId: declaration.manifest.id, pointId: point.id, protocol });
                    if (!snapshot) throw new Error('Expected genuine Machine admission');
                    return { point: { pointId: point.id, protocol: { id: protocol.id, version: protocol.version } }, snapshot };
                })),
                readSourceCustody: (pluginId, occurrenceId) => declarations.find(row => row.manifest.id === pluginId && row.occurrenceId === occurrenceId)?.sourceCustody,
            });
            const machineTarget = project(declarations[0]!);
            const childSnapshot = project(declarations[1]!);
            const publicSurface = machineTarget.points[0]!.protocols[0]!.contributions[0]!.surfaces[0]!;
            const rendererEntry = projectPluginPortableUiDeclarationsV1(childManifest)[`uiRenderer:${childManifest.id}:detail`];
            if (!rendererEntry) throw new Error('Expected canonical renderer facts');
            const executionOrigin = { serverIdentityId: 'srv_machine_child', materializationRef: {
                materializationId: 'machine-child-materialization', machineId: 'machine-1', pluginId: childManifest.id,
            } };
            const actualMount = DaemonPluginUiTargetedSurfaceMountV1Schema.parse({
                kind: 'targetedSurface', target: machineTarget.target, ...publicSurface,
                inputSchema: oldMachineInput.jsonSchema, rendererChain: [{ pluginId: childManifest.id, localId: 'detail' }],
                selectedRenderer: { identity: { pluginId: childManifest.id, localId: 'detail' },
                    renderer: rendererEntry.renderer, availability: rendererEntry.availability },
                executionOrigin, resourceCapability: { readable: true, dynamic: false }, contributorTargetedContributions: childSnapshot,
            });
            let includeMount = true;
            machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload: unknown }>) => {
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) throw new Error('Unexpected Machine RPC');
                const payload = DaemonPluginUiTargetedContributionsReadRequestSchema.parse(request.payload);
                expect(payload.machineId).toBe('machine-1');
                expect(payload.pluginId).toBe(parentManifest.id);
                return payload.readMode === 'sourceDeclarations'
                    ? { status: 'sourceDeclarations', pluginId: parentManifest.id, sourceDeclarations: [declarations[1]] }
                    : { status: 'current', targetedContributions: machineTarget, targetedSurfaceMounts: includeMount ? [actualMount] : [] };
            });
            const read = () => readMountedAccountTargetedContributions({ pluginId: parentManifest.id,
                origin: accountOrigin,
                accountLifetime: lifetime, signal: new AbortController().signal, isCurrent: () => true,
                machine: { machineId: 'machine-1', serverId: lifetime.scope.serverId },
            });
            const result = await read();
            expect(result.targetedSurfaceMounts).toHaveLength(1);
            expect(result.targetedSurfaceMounts[0]).toEqual({ ...actualMount,
                target: { pluginId: parentManifest.id, occurrenceId: selected.custodyId, sourceCustody: selected.sourceCustody },
                inputSchema: inputSchema.jsonSchema,
            });
            expect(result.targetedSurfaceMounts[0]).not.toHaveProperty('accountExecutionOrigin');
            expect(result.targetedSurfaceMounts[0]?.contributorTargetedContributions).toEqual(childSnapshot);
            expect(childSnapshot.target).not.toEqual(result.targetedContributions.target);
            includeMount = false;
            resetMachineProjectionReadsForTests();
            const unavailable = await read();
            expect(unavailable.targetedContributions.points[0]?.protocols[0]?.contributions).toHaveLength(1);
            expect(unavailable.targetedSurfaceMounts).toEqual([]);
        } finally {
            machineRpc.mockReset(); resetMachineProjectionReadsForTests(); await home.dispose();
        }
    });

    it('does not retire a current Machine operation when a separate declaration read is canceled', async () => {
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://account-targeted-cancellation.test', accountId: 'alice' }],
            route: () => undefined });
        const executionStarted = createDeferred<void>();
        const releaseExecution = createDeferred<void>();
        const rpcStarted = createDeferred<void>();
        const releaseRpc = createDeferred<void>();
        const cancellation = new AbortController();
        let owner: ReturnType<typeof createPluginSurfaceAccountActionServices> | undefined;
        let observation: ReturnType<ReturnType<typeof createPluginSurfaceAccountActionServices>['services']['targetedContributions']['observeForSelf']> | undefined;
        try {
            resetMachineProjectionReadsForTests();
            const lifetime = captureActiveServerAccountScopeLifetime();
            if (!lifetime) throw new Error('The served Home must establish its Account lifetime');
            const parsedTarget = ingestPluginManifestV2(target.manifest);
            if (!parsedTarget.ok) throw new Error(JSON.stringify(parsedTarget.diagnostics));
            replacePluginAccountAvailabilityProjection({ scope: lifetime.scope, snapshot: {
                availabilityCursor: 1, materializations: [], snapshots: [], intentReads: [{ pluginId: target.manifest.id, response: {
                    availabilityCursor: 1, hostingCapability: { enabled: false }, packageAssets: [], uiArtifacts: [],
                    intent: { pluginId: target.manifest.id, desiredVersion: target.manifest.version, enabled: true,
                        offlineUiHosting: 'disabled', writableCollections: [], revision: 'one' },
                    release: { ref: { pluginId: target.manifest.id, version: target.manifest.version },
                        archiveDigestSha256: `sha256:${'a'.repeat(64)}`, normalizedManifest: parsedTarget.manifest,
                        collectionContracts: [], uiSlots: [], packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
                } }],
            } });
            const selected = readPluginAccountAvailability(lifetime.scope).readCurrentAccountExecution(target.manifest.id);
            if (selected.kind !== 'available') throw new Error('The current Account target must be selected');
            const parsed = ingestPluginManifestV2(source.manifest);
            if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
            const response = { status: 'sourceDeclarations', pluginId: target.manifest.id, sourceDeclarations: [{
                occurrenceId: 'machine-source-current', sourceCustody: { kind: 'development', registeredRootId: 'machine-source-root' },
                manifest: { id: parsed.manifest.id, contributes: { actions: parsed.manifest.contributes.actions,
                    pluginContributionPoints: [], targetedPluginContributions: parsed.manifest.contributes.targetedPluginContributions,
                    ui: { renderers: parsed.manifest.contributes.ui.renderers } } },
            }] };
            let holdRpc = false;
            let executedRequest: ReturnType<typeof DaemonPluginStructuredMessageActionExecuteRequestSchema.parse> | undefined;
            machineRpc.mockImplementation(async (request: Readonly<{ method: string; payload: unknown; onIssued?: () => void }>) => {
                if (request.method === RPC_METHODS.DAEMON_PLUGIN_STRUCTURED_MESSAGE_ACTION_EXECUTE) {
                    // The real transport's final-currentness fence runs at
                    // physical issuance, before this boundary accepts an effect.
                    request.onIssued?.();
                    executedRequest = DaemonPluginStructuredMessageActionExecuteRequestSchema.parse(request.payload);
                    return { ok: true, result: { accepted: true } };
                }
                if (request.method !== RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ) throw new Error('Unexpected Machine RPC');
                if (holdRpc) { rpcStarted.resolve(); await releaseRpc.promise; }
                return response;
            });
            owner = createPluginSurfaceAccountActionServices({ pluginId: target.manifest.id,
                occurrenceId: selected.custodyId, sourceCustody: selected.sourceCustody, accountLifetime: lifetime,
                signal: new AbortController().signal, isCurrent: () => true,
                machine: { machineId: 'machine-1', serverId: lifetime.scope.serverId },
                // Hold the physical Action transport until the independent
                // observation has canceled, retaining its real issuance fence.
                execute: async (action, value, options) => {
                    executionStarted.resolve();
                    await releaseExecution.promise;
                    if (typeof action === 'string' || !options.expectedContributorOccurrenceId) throw new Error('Expected an admitted source Action');
                    const result = await machinePluginStructuredMessageActionExecute('machine-1', {
                        serverId: lifetime.scope.serverId, accountLifetime: lifetime,
                        qualifiedActionId: buildQualifiedPluginContributionKey(action), input: PluginJsonValueV2Schema.parse(value),
                        expectedContributorOccurrenceId: options.expectedContributorOccurrenceId,
                        executionSurface: 'ui', signal: options.signal, isCurrent: options.isCurrent,
                    });
                    if (!result.supported || !result.result.ok) throw new Error('Machine Action transport refused');
                    return result.result.result;
                },
            });
            const currentObservation = owner.services.targetedContributions.observeForSelf(target.contributionPoints.sources, { onInvalidated() {} });
            observation = currentObservation;
            const snapshot = await currentObservation.readCurrent();
            expect(snapshot.contributions).toHaveLength(1);
            const operation = snapshot.contributions[0]!.operations.inspect;
            expect(operation.identity.contributor.occurrenceId).toBe('machine-source-current');
            const executing = owner.services.actions.executeAdmittedTargetedOperation(operation, { id: 'personal' });
            // Attach rejection handling before driving the competing read.
            const completed = expect(executing).resolves.toEqual({ accepted: true });
            await executionStarted.promise;
            holdRpc = true;
            const canceledRead = currentObservation.readCurrent({ signal: cancellation.signal });
            const canceled = expect(canceledRead).rejects.toMatchObject({ code: 'plugin_targeted_contributions_aborted' });
            await rpcStarted.promise;
            cancellation.abort();
            await canceled;
            releaseRpc.resolve();
            await releaseRpc.promise;
            releaseExecution.resolve();
            await completed;
            expect(executedRequest).toMatchObject({ qualifiedActionId: buildQualifiedPluginContributionKey({ pluginId: source.manifest.id, localId: 'inspect' }),
                expectedContributorOccurrenceId: 'machine-source-current', input: { id: 'personal' } });
        } finally {
            cancellation.abort(); releaseRpc.resolve(); releaseExecution.resolve();
            observation?.dispose(); owner?.dispose(); machineRpc.mockReset();
            resetMachineProjectionReadsForTests();
            await home.dispose();
        }
    });
});
