import fastify from 'fastify';
import { expect, it } from 'vitest';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolLiteral, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAccountHomeHttp } from './widgetApproval.testkit';
import { createCliActionExecutor } from './createCliActionExecutor';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createCommittedContributedActionDefinitionLister, createCommittedContributedActionInvoker, createRegistryInputTypeDeps } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

it('places the reload-18 flower options request on the same admitted Machine runtime as invocation', async () => {
    const pluginId = 'qa.qar90s-r8';
    const machineId = 'ffd72b3e-40ca-4644-9bd2-46753a01d8cb';
    const serverId = 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN';
    const accountId = '5e3a0581-6f3d-4e73-bf40-383db0be6c3e';
    const flowerValueSchema = defineProtocolUnion([defineProtocolLiteral('marigold'), defineProtocolLiteral('rose')]);
    const flowerSchema = defineProtocolObject({ flower: flowerValueSchema }, { policy: 'closed' });
    const plugin = definePlugin({ id: pluginId, version: '0.1.2', entrypoints: { daemon: './daemon.mjs' },
        actions: { change: { title: 'QAR90S change flower', scopes: ['global', 'machine'], surfaces: ['ui', 'agent', 'cli'],
            execution: { target: 'daemon' }, dangerLevel: 'safe',
            inputSchema: flowerSchema,
            inputHints: { fields: [{ path: 'flower', title: 'Flower', widget: 'select', required: true,
                inputType: { pluginId, localId: 'flower' } }] },
            resultSchema: flowerSchema,
            async run(input) { return { flower: input.flower }; },
        } },
        inputTypes: { flower: { title: 'Flower', semantic: 'qa-qar90s-flower', valueSchema: flowerValueSchema.jsonSchema, picker: 'flower-picker-renderer' } },
        ui: { surfaces: [{ id: 'flower-picker', placement: 'rendererOnly', renderer: { kind: 'reactNative' } }] },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({ coldStart: true, plugins: [{ manifest: plugin.manifest,
        files: { 'daemon.mjs': 'export function activate() {}' }, instantiateCommittedModule: () => ({ activate: plugin.activate }) }] });
    const app = fastify();
    const endpoint = 'http://reload-18-machine-options.test';
    registerAccountHomeHttp(app, { accountId, serverId });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
        PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: true, maxArtifactBytes: 16 * 1024 * 1024, maxAccountBytes: 256 * 1024 * 1024 },
            intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin: endpoint });
    try {
        const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
        const executor = createCliActionExecutor({ token, credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
            sessionId: 'session', mode: 'plain', ctx: null, serverId, serverIdentityId: serverId, serverHttpBaseUrl: endpoint,
            // Like the daemon external-Action receiver, consume its admitted
            // runtime rather than constructing another registry from a home path.
            pluginActionExecutionOwner: 'current_process',
            listContributedActionDefinitions: createCommittedContributedActionDefinitionLister({
                tryAcquireRuntimeRegistryLease: () => tryAcquireAuthoritativePluginRuntimeRegistryLease({ controller: fixture.controller }) }),
            inputTypeDeps: createRegistryInputTypeDeps(fixture.registry),
            invokeContributedAction: createCommittedContributedActionInvoker({
                acquireRuntimeRegistryLease: async () => {
                    const lease = fixture.controller.tryAcquireRuntimeRegistry();
                    if (!lease) throw new Error('Fixture runtime retired');
                    return lease;
                } }),
        });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, serverIdentityId: serverId,
            runtimeAccountId: accountId, externalActionTarget: { kind: 'machine' as const, machineId } };
        expect(await executor.execute('action.invoke', { action: { pluginId, localId: 'change' }, input: { flower: 'marigold' } }, context))
            .toMatchObject({ ok: true, result: { flower: 'marigold' } });
        const options = await executor.execute('action.options.resolve', {
            actionId: 'qa.qar90s-r8/actions/change', fieldPath: 'flower', draftInput: { machineId },
        }, context);
        expect(options, options.ok ? undefined : options.errorCode).toMatchObject({ ok: true, result: { actionId: 'qa.qar90s-r8/actions/change', fieldPath: 'flower',
            optionsSourceId: null, options: [] } });
    } finally {
        restore();
        await app.close();
        await fixture.dispose();
    }
});
