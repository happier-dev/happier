import { describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonContributionRegistryProjectionDescribeResponseSchema, DaemonPluginUiTargetedContributionsReadResponseSchema, shareDaemonPluginUiTargetedContributionsReadResponse } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolObject } from '@happier-dev/plugin-sdk/protocol';
import { parseDaemonPluginUiTargetedContributionsReadResponse } from '../../../../ui/sources/sync/api/daemon/daemonContributionRegistryProjectionProtocol';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import {
    invalidateDaemonContributionRegistryProjectionCache,
    registerDaemonContributionRegistryProjectionHandler,
} from './daemonContributionRegistryProjection';

describe('targeted detail execution origins through admitted runtime publication', () => {
    it('sends each demanded Surface input contract and contributor snapshot once through the real UI reader', async () => {
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: {
            resolveCurrentMachineId: () => 'machine-targeted-cost',
        } });
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => { throw new Error('Exact target read must not describe the inventory'); },
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_targeted_cost', machineId: 'machine-targeted-cost' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
            if (!handler) throw new Error('Expected real targeted-contributions RPC');
            const raw = await handler({ machineId: 'machine-targeted-cost', pluginId: 'happier.triage' });
            const response = parseDaemonPluginUiTargetedContributionsReadResponse(raw);
            if (response?.status !== 'current') throw new Error('Expected current real bundled target');
            const serialized = JSON.stringify(raw);
            const schemas = new Map(response.targetedSurfaceMounts.map(mount => [JSON.stringify(mount.inputSchema), mount.inputSchema]));
            expect(response.targetedSurfaceMounts.length).toBeGreaterThan(1);
            expect(schemas.size).toBe(1);
            const schemaBody = JSON.stringify([...schemas.values()][0]);
            // Cost is unique demanded bodies, independent of the mounted contributor count.
            expect(serialized.split(schemaBody).length - 1).toBe(1);
            const ownSnapshot = JSON.stringify(response.targetedContributions);
            expect(serialized.split(ownSnapshot).length - 1).toBe(1);
            expect(serialized).not.toContain('happier.voice.local');
            const inline = { ...response, targetedSurfaceMounts: response.targetedSurfaceMounts };
            expect(parseDaemonPluginUiTargetedContributionsReadResponse(inline)).toEqual(response);
            const shared = shareDaemonPluginUiTargetedContributionsReadResponse(response);
            expect(raw).toEqual(shared);
            for (const malformed of [
                { ...shared, targetedSurfaceMountBodies: { ...shared.targetedSurfaceMountBodies, inputContracts: [] } },
                { ...shared, targetedSurfaceMountBodies: { ...shared.targetedSurfaceMountBodies,
                    inputContracts: [...shared.targetedSurfaceMountBodies.inputContracts, ...shared.targetedSurfaceMountBodies.inputContracts] } },
                { ...shared, targetedSurfaceMounts: shared.targetedSurfaceMounts.map((mount, index) => index === 0
                    ? { ...mount, contributor: { ...mount.contributor, occurrenceId: 'unadmitted-source' } } : mount) },
            ]) expect(parseDaemonPluginUiTargetedContributionsReadResponse(malformed)).toBeNull();
            // Match mountedTargetedContributions' complete caller/operation union,
            // including Actions declared by child callers rather than only the target.
            const snapshots = [response.targetedContributions,
                ...response.targetedSurfaceMounts.map(mount => mount.contributorTargetedContributions)];
            const callers = [...new Map(snapshots.map(snapshot => [snapshot.target.pluginId, snapshot.target])).values()];
            const callerPluginIds = new Set(callers.map(caller => caller.pluginId));
            const actions = [...new Map([
                ...fixture.registry.contributes.actions.filter(action => callerPluginIds.has(action.pluginId)).map(action => action.identity),
                ...snapshots.flatMap(snapshot => snapshot.points.flatMap(point => point.protocols.flatMap(protocol =>
                    protocol.contributions.flatMap(contribution => contribution.operations.map(operation => operation.action))))),
            ].map(action => [buildQualifiedPluginContributionKey(action), action])).values()];
            const describe = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            if (!describe) throw new Error('Expected real mounted Action RPC');
            const mountedReply = await describe({ machineId: 'machine-targeted-cost', selection: 'mountedActions', callers, actions, locale: 'en' });
            const mounted = DaemonContributionRegistryProjectionDescribeResponseSchema.parse(mountedReply).projection;
            expect(Object.keys(mounted.actionsById).sort()).toEqual(actions.map(buildQualifiedPluginContributionKey).sort());
            expect(Object.keys(mounted.familiesById)).toEqual(['pluginUi']);
            expect(JSON.stringify(mountedReply)).not.toContain('happier.voice.local');
            const actionFields: Record<string, number> = {};
            for (const action of Object.values(mounted.actionsById)) {
                for (const [field, value] of Object.entries(action)) {
                    if (value !== undefined) actionFields[field] = (actionFields[field] ?? 0) + Buffer.byteLength(JSON.stringify(value));
                }
                expect(action).not.toHaveProperty('inputSchema');
                expect(action).not.toHaveProperty('resultSchema');
            }
            console.info('targeted payload bytes', JSON.stringify({
                wire: Buffer.byteLength(serialized), inline: Buffer.byteLength(JSON.stringify(inline)),
                mounts: response.targetedSurfaceMounts.length, schema: Buffer.byteLength(schemaBody),
                snapshot: Buffer.byteLength(ownSnapshot),
                mountedActions: { bytes: Buffer.byteLength(JSON.stringify(mountedReply)), callers: callers.length, actions: actions.length, actionFields,
                    fields: Object.fromEntries(Object.entries(mounted).map(([key, value]) => [key, Buffer.byteLength(JSON.stringify(value))])) },
            }));
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await fixture.dispose();
        }
    }, 120_000);

    it('publishes complete external Resource declarations with targeted handles and follows source replacement and withdrawal', async () => {
        const targetId = 'acme.resource-host';
        const contributorId = 'acme.resource-source';
        const unrelatedId = 'acme.unrelated-scm';
        const protocol = { id: 'detail', version: 1 } as const;
        const target = definePlugin({
            id: targetId, version: '1.0.0',
            contributionPoints: { details: defineContributionProtocol({ ...protocol, operations: {},
                surfaces: { detail: { required: true, presentation: 'content',
                    inputSchema: defineProtocolObject({}, { policy: 'closed' }) } },
            }).point() },
        });
        const contributor = (version: string, contentType?: string) => ({
            manifest: createPluginManifestV2Fixture({ id: contributorId, version, contributes: {
                resources: contentType ? [{ id: 'rows', source: 'dynamic', kind: 'config', scope: 'global', contentType }] : [],
                ui: { renderers: [{ id: 'detail', kind: 'declarative', root: { kind: 'text', text: 'Resource detail' } }] },
                targetedPluginContributions: [{ id: 'source', target: { pluginId: targetId, pointId: 'details' },
                    protocol, operations: {}, surfaces: { detail: { renderer: 'detail' } } }],
            } }),
            files: { 'daemon.mjs': 'export function activate() { throw new Error("Discovery must stay cold"); }' },
        });
        const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [
            { manifest: target.manifest, files: {} }, contributor('1.0.0', 'text/plain'),
            { manifest: createPluginManifestV2Fixture({ id: unrelatedId, contributes: {
                resources: [{ id: 'private', source: 'dynamic', kind: 'config', scope: 'global', contentType: 'application/json' }],
                scmBackends: [{ id: 'vcs', title: 'Unrelated SCM', kind: 'acme', capabilities: ['detect'] }],
            } }), files: { 'daemon.mjs': 'export function activate() { throw new Error("Unrelated SCM must stay cold"); }' } },
        ] });
        const replacements: Awaited<ReturnType<typeof createAuthoredAdmittedPluginRuntimeFixture>>[] = [];
        let currentRuntime = fixture.registry;
        try {
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
                resolveRuntimeRegistry: async () => currentRuntime,
                // The filesystem catalog is a genuine boundary; targeted reads must not need full describe.
                resolveInstalledPackages: async () => { throw new Error('Targeted Resource census requested full describe'); },
                resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_resources', machineId: 'machine-resources' }),
            });
            const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
            if (!handler) throw new Error('Expected real targeted-contributions RPC');
            const read = async (pluginId = targetId) => DaemonPluginUiTargetedContributionsReadResponseSchema.parse(
                await handler({ machineId: 'machine-resources', pluginId }));
            const first = await read();
            expect(first).toMatchObject({ status: 'current', resourceDeclarationsByPluginId: {
                [targetId]: {}, [contributorId]: { [`${contributorId}/rows`]: {
                    pluginId: contributorId, id: 'rows', resourceKind: 'config', scope: 'global', contentType: 'text/plain',
                    occurrenceId: currentRuntime.readPluginOccurrenceId?.(contributorId),
                } },
            } });
            expect(first).not.toHaveProperty('projection');
            expect(first).not.toHaveProperty(['resourceDeclarationsByPluginId', unrelatedId]);
            if (first.status !== 'current') throw new Error('Expected current external Resource declarations');
            expect(first.targetedSurfaceMounts).toHaveLength(1);
            // A target with no points/renderers still receives its complete Resource set.
            expect(await read(contributorId)).toMatchObject({ status: 'current', targetedSurfaceMounts: [],
                resourceDeclarationsByPluginId: { [contributorId]: { [`${contributorId}/rows`]: { contentType: 'text/plain' } } } });
            for (const [version, contentType] of [['2.0.0', 'application/json'], ['3.0.0', undefined]] as const) {
                const replacement = await createAuthoredAdmittedPluginRuntimeFixture({
                    happyHomeDir: fixture.happyHomeDir, controller: fixture.controller, coldStart: true,
                    plugins: [{ ...contributor(version, contentType), replaceExisting: true }],
                });
                replacements.push(replacement);
                currentRuntime = replacement.registry;
                const next = await read();
                expect(next).toMatchObject({ status: 'current', resourceDeclarationsByPluginId: {
                    [targetId]: {}, [contributorId]: contentType ? { [`${contributorId}/rows`]: {
                        contentType, occurrenceId: currentRuntime.readPluginOccurrenceId?.(contributorId),
                    } } : {},
                } });
                if (!contentType) expect(next).not.toHaveProperty(['resourceDeclarationsByPluginId', contributorId, `${contributorId}/rows`]);
                expect(currentRuntime.activatedPluginIds.size).toBe(0);
                expect(currentRuntime.scmBackendsById?.size).toBe(0);
            }
        } finally {
            for (const replacement of replacements.reverse()) await replacement.dispose();
            await fixture.dispose();
        }
    });

    it('mounts a real source-backed GitHub detail and diagnoses a dropped runtime materialization reader', async () => {
        const pluginId = 'happier.scm.forge.github';
        const fixture = await createAdmittedPluginRuntimeFixture({
            runtimeOptions: {
                pluginIds: ['happier.triage', pluginId],
                resolveCurrentMachineId: () => 'machine-detail',
            },
        });
        try {
            // Real source admission and Availability produce this observation;
            // no copied execution-origin or targeted-snapshot fixture is used.
            expect(fixture.registry.contributes.materializationIdsByPluginId?.[pluginId]).toBeUndefined();
            const materialization = fixture.registry.readReleaseLessMaterializations?.()
                .find((entry) => entry.pluginId === pluginId);
            expect(materialization).toBeDefined();
            expect(materialization).toMatchObject({ enabled: true, trustState: 'trusted' });
            expect(fixture.registry.readPluginOccurrenceId?.(pluginId)).toBeTruthy();
            if (!materialization) throw new Error('Expected source-backed Availability materialization');
            const expectedOrigin = PluginMachineExecutionOriginV1Schema.parse({
                serverIdentityId: 'srv_detail',
                sourceRef: {
                    machineId: 'machine-detail', pluginId: materialization.pluginId,
                    sourceCustody: fixture.registry.readPluginSourceCustody?.(pluginId),
                },
            });

            const read = async (runtime: ResolvedExecutablePluginRuntimeRegistry, contextAvailable = true) => {
                invalidateDaemonContributionRegistryProjectionCache();
                const handlers = new Map<string, RpcHandler>();
                const registrar: RpcHandlerRegistrar = {
                    registerHandler(method, handler) { handlers.set(method, handler); },
                };
                registerDaemonContributionRegistryProjectionHandler(registrar, {
                    resolveRuntimeRegistry: async () => runtime,
                    resolveInstalledPackages: async () => [],
                    resolvePluginProjectionExecutionOriginContext: () => contextAvailable
                        ? { serverIdentityId: expectedOrigin.serverIdentityId, machineId: 'machine-detail' }
                        : null,
                });
                const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
                if (!handler) throw new Error('Expected real targeted-contributions RPC registration');
                return DaemonPluginUiTargetedContributionsReadResponseSchema.parse(await handler({
                    machineId: 'machine-detail', pluginId: 'happier.triage',
                }));
            };

            const response = await read(fixture.registry);
            if (response.status !== 'current') throw new Error(`Detail projection refused: ${response.status === 'unavailable' ? response.code : response.status}; target diagnostics: ${JSON.stringify(fixture.registry.pluginDiagnosticsByPluginId['happier.triage'] ?? [])}`);
            const mount = response.targetedSurfaceMounts.find((entry) => entry.contributor.pluginId === pluginId);
            expect(mount).toMatchObject({
                role: 'detail',
                executionOrigin: expectedOrigin,
                selectedRenderer: {
                    renderer: { kind: 'reactNative' },
                    artifactProjection: { pluginId },
                },
            });
            expect(response.targetedSurfaceMounts.length).toBeGreaterThan(0);

            // The real describe is cold and held at its filesystem catalog
            // boundary. Reading this admitted target must not join that work.
            invalidateDaemonContributionRegistryProjectionCache();
            let releaseCatalog!: () => void;
            let catalogEntered!: () => void;
            const pendingCatalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
            const enteredCatalog = new Promise<void>((resolve) => { catalogEntered = resolve; });
            const handlers = new Map<string, RpcHandler>();
            registerDaemonContributionRegistryProjectionHandler({
                registerHandler(method, handler) { handlers.set(method, handler); },
            }, {
                resolveRuntimeRegistry: async () => fixture.registry,
                resolveInstalledPackages: async () => {
                    catalogEntered();
                    await pendingCatalog;
                    return [];
                },
                resolvePluginProjectionExecutionOriginContext: () => ({
                    serverIdentityId: expectedOrigin.serverIdentityId, machineId: 'machine-detail',
                }),
            });
            const describeHandler = handlers.get(RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE);
            const targetHandler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
            if (!describeHandler || !targetHandler) throw new Error('Expected registered projection handlers');
            const pendingDescribe = describeHandler({ machineId: 'machine-detail' });
            await enteredCatalog;
            let independentTarget: unknown;
            const pendingTarget = Promise.resolve(targetHandler({
                machineId: 'machine-detail', pluginId: 'happier.triage',
            })).then((result) => { independentTarget = result; });
            try {
                await vi.waitFor(() => {
                    expect(parseDaemonPluginUiTargetedContributionsReadResponse(independentTarget)).toEqual(response);
                });
            } finally {
                releaseCatalog();
                await Promise.all([pendingDescribe, pendingTarget]);
            }

            // The loaded pre-migration daemon copied flat stamps into this
            // artifact. Current strict consumers reject that producer shape;
            // the materialization arm itself remains a valid origin.
            const artifact = mount?.selectedRenderer.artifactProjection;
            if (!artifact) throw new Error('Expected real selected renderer artifact');
            const { executionOrigin: _origin, ...artifactDeclaration } = artifact;
            expect(DaemonPluginUiTargetedContributionsReadResponseSchema.safeParse({
                ...response,
                targetedSurfaceMounts: response.targetedSurfaceMounts.map(entry => entry === mount ? {
                    ...entry, selectedRenderer: { ...entry.selectedRenderer, artifactProjection: {
                        ...artifactDeclaration, serverIdentityId: expectedOrigin.serverIdentityId,
                        materializationRef: { machineId: 'machine-detail', pluginId,
                            materializationId: materialization.materializationId },
                    } },
                } : entry),
            }).success).toBe(false);

            // Deliberate wiring mutation: dropping the real producer's reader
            // must refuse observably rather than publish handles with no mounts.
            expect(await read({ ...fixture.registry, readReleaseLessMaterializations: undefined })).toEqual({
                status: 'unavailable', code: 'plugin_targeted_surface_mount_unavailable',
            });
            expect(await read({ ...fixture.registry, readPluginSourceCustody: undefined })).toEqual({
                status: 'unavailable', code: 'plugin_targeted_contributions_unavailable',
            });
            expect(await read(fixture.registry, false)).toEqual({
                status: 'unavailable', code: 'plugin_targeted_surface_mount_unavailable',
            });
        } finally {
            invalidateDaemonContributionRegistryProjectionCache();
            await fixture.dispose();
        }
    }, 120_000);
});
