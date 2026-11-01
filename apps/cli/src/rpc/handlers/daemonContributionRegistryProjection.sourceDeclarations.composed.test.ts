import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginUiTargetedContributionsReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { ingestPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { createManifestTargetedContributionsService, requireAdmittedTargetedOperationExecutionBinding } from '@happier-dev/plugin-sdk/host/registration';
import { PLUGIN_MANIFEST as TRIAGE_MANIFEST, TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1 } from '@happier-dev/plugins-triage/manifest';
import type { RpcHandler } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { registerDaemonContributionRegistryProjectionHandler } from './daemonContributionRegistryProjection';

describe('current Machine source declarations for an Account target', () => {
    it('reads the actual source without a Machine target and re-admits it through the Account target owner', async () => {
        const sourceId = 'happier.scm.forge.github';
        const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: [sourceId] } });
        try {
            expect(fixture.registry.readPluginOccurrenceId?.('happier.triage')).toBeNull();
            let schemaReads = 0;
            // Observe real schema traversal without changing admitted values or
            // replacing a parser. Only copied declaration containers hold proxies.
            function observeSchemaReads<T extends object>(value: T): T {
                return new Proxy(value, {
                    get(target, key, receiver) {
                        if (typeof key === 'string') schemaReads += 1;
                        const next: unknown = Reflect.get(target, key, receiver);
                        return next !== null && typeof next === 'object' ? observeSchemaReads(next) : next;
                    },
                });
            }
            const observedRuntime = {
                ...fixture.registry,
                contributes: {
                    ...fixture.registry.contributes,
                    pluginDeclarations: fixture.registry.contributes.pluginDeclarations?.map((declaration) => declaration.pluginId !== sourceId
                        ? declaration
                        : { ...declaration, manifest: { ...declaration.manifest, contributes: {
                            ...declaration.manifest.contributes,
                            actions: declaration.manifest.contributes.actions.map((action) => ({
                                ...action,
                                ...(action.inputSchema === undefined ? {} : { inputSchema: observeSchemaReads(action.inputSchema) }),
                                ...(action.resultSchema === undefined ? {} : { resultSchema: observeSchemaReads(action.resultSchema) }),
                            })),
                        } } }),
                },
            } satisfies ResolvedExecutablePluginRuntimeRegistry;
            const readRaw = async (runtime: ResolvedExecutablePluginRuntimeRegistry) => {
                const handlers = new Map<string, RpcHandler>();
                registerDaemonContributionRegistryProjectionHandler({
                    registerHandler(method, handler) { handlers.set(method, handler); },
                }, { resolveRuntimeRegistry: async () => runtime });
                const handler = handlers.get(RPC_METHODS.DAEMON_PLUGIN_UI_TARGETED_CONTRIBUTIONS_READ);
                if (!handler) throw new Error('Target read RPC was not registered');
                let response: unknown;
                try {
                    response = await handler({ machineId: 'machine-source', pluginId: 'happier.triage', readMode: 'sourceDeclarations' });
                } catch (error) { throw new Error('Machine source-declaration producer failed before response parsing', { cause: error }); }
                return response;
            };
            const decode = (response: unknown) => {
                try { return DaemonPluginUiTargetedContributionsReadResponseSchema.parse(JSON.parse(JSON.stringify(response))); }
                catch (error) { throw new Error('Machine source-declaration response parsing failed', { cause: error }); }
            };
            const firstRaw = await readRaw(observedRuntime);
            const secondRaw = await readRaw(observedRuntime);
            expect({ reads: 2, producerSchemaReads: schemaReads }).toEqual({ reads: 2, producerSchemaReads: 0 });
            const response = decode(firstRaw);
            expect(schemaReads).toBeGreaterThan(0);
            expect(decode(secondRaw)).toEqual(response);
            expect(response.status).toBe('sourceDeclarations');
            if (response.status !== 'sourceDeclarations') throw new Error(`Source read refused: ${response.status}`);
            expect(response.pluginId).toBe('happier.triage');
            expect(response.sourceDeclarations).toMatchObject([{
                manifest: { id: sourceId },
                occurrenceId: fixture.registry.readPluginOccurrenceId?.(sourceId),
                sourceCustody: fixture.registry.readPluginSourceCustody?.(sourceId),
            }]);
            expect(response.sourceDeclarations[0]?.manifest.contributes.targetedPluginContributions
                .every((entry) => entry.target.pluginId === 'happier.triage')).toBe(true);
            const parsedTarget = (() => {
                try { return ingestPluginManifestV2(TRIAGE_MANIFEST); }
                catch (error) { throw new Error('Account Triage target manifest ingestion failed', { cause: error }); }
            })();
            if (!parsedTarget.ok) throw new Error('Expected the current Triage declaration');
            const declarations = [{ manifest: parsedTarget.manifest, occurrenceId: 'account-target', sourceCustody: {
                kind: 'account_release' as const, pluginId: 'happier.triage', version: parsedTarget.manifest.version,
                archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            } }, ...response.sourceDeclarations];
            const service = createManifestTargetedContributionsService({
                readCurrentDeclarations: () => declarations,
                subscribeToCatalogChanges: () => () => {},
            }).bind({ pluginId: 'happier.triage', signal: new AbortController().signal, isCurrent: () => true });
            const observation = service.observeForSelf(TRIAGE_SOURCES_CONTRIBUTION_POINT_REF_V1, { onInvalidated() {} });
            try {
                const snapshot = await observation.readCurrent().catch((error) => {
                    throw new Error('Account Triage target snapshot admission failed', { cause: error });
                });
                const github = snapshot.contributions.find((entry) => entry.contributor.pluginId === sourceId);
                expect(github).toBeDefined();
                if (!github) throw new Error('Expected the actual Machine GitHub source');
                const binding = requireAdmittedTargetedOperationExecutionBinding(github.operations.scan, {
                    plugin: { id: 'happier.triage' }, occurrenceId: 'account-target',
                }, declarations);
                expect(binding.contributorOccurrenceId).toBe(fixture.registry.readPluginOccurrenceId?.(sourceId));
                expect(binding.operation.contributor.sourceCustody).toEqual(fixture.registry.readPluginSourceCustody?.(sourceId));
            } finally { observation.dispose(); }
            expect(decode(await readRaw({ ...fixture.registry, readPluginSourceCustody: undefined }))).toEqual({
                status: 'unavailable', code: 'plugin_targeted_contributions_unavailable',
            });
        } finally { await fixture.dispose(); }
    }, 120_000);
});
