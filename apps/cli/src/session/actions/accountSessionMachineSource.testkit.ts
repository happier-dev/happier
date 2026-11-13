import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import { defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';

const inputSchema = defineProtocolObject({ sessionId: defineProtocolString() }, { policy: 'closed' });
const entryInputSchema = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const resultSchema = defineProtocolObject({ value: defineProtocolString() }, { policy: 'closed' });
const protocol = defineContributionProtocol({ id: 'session-source', version: 1, operations: {
    read: { required: true, input: { kind: 'protocolDefined', schema: inputSchema },
        resultSchema,
        action: { surfaces: ['plugin', 'cli'], dangerLevel: 'safe' } },
} });
const plugin = definePlugin({
    id: 'acme.account-session-source', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
    contributionPoints: { sources: protocol.point() },
    actions: {
        'account-scope': { title: 'Read Account Home scope', surfaces: ['plugin', 'cli'], dangerLevel: 'safe',
            inputSchema: defineProtocolObject({}, { policy: 'closed' }),
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (_input, context) => ({ scope: context.accountScope ?? null }) },
        'account-only': { title: 'Read Account data for Session', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async () => ({ value: 'account-only' }) },
        source: { title: 'Read Session source', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context) => context.services.actions.execute({ pluginId: 'acme.account-session-source', localId: 'read' }, input) },
        'attached-entry': { title: 'Read attached entry', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema: entryInputSchema,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context) => context.services.actions.execute({ pluginId: 'acme.account-session-source', localId: 'read-entry' }, input) },
        'read-entry': { title: 'Read entry on attached Session Machine', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema: entryInputSchema,
            run: async () => ({ value: 'local-handler-must-not-run' }) },
        'attached-targeted': { title: 'Read targeted source in attached Session', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context): Promise<{ value: string }> => {
                const observation = context.services.targetedContributions.observeForSelf(plugin.contributionPoints.sources, { onInvalidated() {} });
                try {
                    const source = (await observation.readCurrent()).contributions.find(entry => entry.contributor.pluginId === 'acme.session-source-provider');
                    if (!source) throw new Error('Missing attached Session source');
                    return await context.services.actions.executeAdmittedTargetedOperation(source.operations.read, input);
                } finally { observation.dispose(); }
            } },
        targeted: { title: 'Read targeted Session source', surfaces: ['plugin', 'cli', 'agent', 'mcp'], dangerLevel: 'safe', inputSchema,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context): Promise<{ value: string }> => {
                const observation = context.services.targetedContributions.observeForSelf(plugin.contributionPoints.sources, { onInvalidated() {} });
                try {
                    const snapshot = await observation.readCurrent();
                    const source = snapshot.contributions.find(entry => entry.contributor.pluginId === 'acme.session-source-provider');
                    if (!source) throw new Error('Missing Session source');
                    return await context.services.actions.executeAdmittedTargetedOperation(source.operations.read, input);
                } finally { observation.dispose(); }
            } },
        'targeted-account': { title: 'Read targeted Account source', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async (input, context): Promise<{ value: string }> => {
                const observation = context.services.targetedContributions.observeForSelf(plugin.contributionPoints.sources, { onInvalidated() {} });
                try {
                    const source = (await observation.readCurrent()).contributions.find(entry => entry.contributor.pluginId === plugin.manifest.id);
                    if (!source) throw new Error('Missing Account source');
                    return await context.services.actions.executeAdmittedTargetedOperation(source.operations.read, input);
                } finally { observation.dispose(); }
            } },
        'read-account-source': { title: 'Read Account source', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema, resultSchema,
            execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
            run: async () => ({ value: 'account-source' }) },
        read: { title: 'Read Session on its Machine', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema,
            sessionTarget: { field: 'sessionId', cardinality: 'one' },
            run: async () => ({ value: 'local-handler-must-not-run' }) },
    },
    contributesTo: { 'acme.account-session-source': { sources: {
        'account-source': protocol.contribute({ operations: { read: protocol.operations.read.bind('read-account-source') } }),
    } } },
});

export const manifest = plugin.manifest;
export const activateAccount = plugin.activateAccount;

export const sourceManifest = definePlugin({ id: 'acme.session-source-provider', version: '1.0.0',
    actions: { read: { title: 'Read selected Session source', surfaces: ['plugin', 'cli'], dangerLevel: 'safe', inputSchema, resultSchema,
        sessionTarget: { field: 'sessionId', cardinality: 'one' }, run: async () => ({ value: 'local-handler-must-not-run' }) } },
    contributesTo: { 'acme.account-session-source': { sources: {
        source: protocol.contribute({ operations: { read: protocol.operations.read.bind('read') } }),
    } } },
}).manifest;
