import { expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { DaemonPluginActionSchemasReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createPluginActionInvocation } from '@happier-dev/protocol/plugins/actions/invocation';
import type { RpcHandler } from '@/api/rpc/types';
import { createAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { testkitEntryRef, testkitLocator } from '../../../../../packages/plugins/triage/src/corpus/testkit/observations.test-support';

it('serves published Triage Session Action schemas through the daemon RPC and UI parser', async () => {
    const fixture = await createAdmittedPluginRuntimeFixture({ runtimeOptions: { pluginIds: ['happier.triage'] } });
    try {
        const handlers = new Map<string, RpcHandler>();
        registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
            resolveRuntimeRegistry: async () => fixture.registry,
            resolveGeneration: async () => fixture.registry.generation,
            resolveInstalledPackages: async () => [],
        });
        const read = handlers.get(RPC_METHODS.DAEMON_PLUGIN_ACTION_SCHEMAS_READ);
        if (!read) throw new Error('Action schema RPC missing');
        const pluginId = 'happier.triage';
        const occurrenceId = fixture.registry.readPluginOccurrenceId!(pluginId);
        expect(occurrenceId).toBeTypeOf('string');
        for (const localId of ['sessions/link-entry-v1', 'sessions/read-source-links-v1']) {
            const response = DaemonPluginActionSchemasReadResponseSchema.parse(await read({
                machineId: 'triage-schema-machine', expectedOccurrenceId: occurrenceId,
                qualifiedActionId: `${pluginId}/${localId}`,
            }));
            expect(response, JSON.stringify({ response, localId, occurrenceId,
                declared: fixture.registry.contributes.actionsById?.has(`${pluginId}/${localId}`),
                actionCount: fixture.registry.contributes.actions.length })).toMatchObject({ ok: true });
            if (!response.ok) throw new Error(response.code);
            expect(response.inputSchema).toBeDefined();
            expect(response.outputSchema).toBeDefined();
            expect(structuredClone(response)).toEqual(response);
            const invocation = createPluginActionInvocation({ pluginId, localId, inputSchema: response.inputSchema,
                occurrenceSignal: new AbortController().signal, isCurrent: () => true });
            expect(invocation.prepare({ v: 1, sessionId: 42 }).kind).toBe('settled');
            const input = { v: 1, sessionId: 'c111111111111111111111111',
                ...(localId === 'sessions/link-entry-v1' ? { entryRef: testkitEntryRef(),
                    display: { locator: testkitLocator(), scopeLabel: 'example/repository' } } : {}) };
            expect(invocation.prepare(input).kind).toBe('ready');
        }
    } finally { await fixture.dispose(); }
});
