import { definePlugin } from '@happier-dev/plugin-sdk';
import { defineContributionPoint, defineContributionProtocol } from '@happier-dev/plugin-sdk/contributions';
import { defineProtocolLiteral, defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';

const input = defineProtocolObject({ key: defineProtocolString() }, { policy: 'closed' });
const result = defineProtocolObject({ key: defineProtocolString(), machine: defineProtocolLiteral(true) }, { policy: 'closed' });
const protocol = defineContributionProtocol({ id: 'account-machine-read', version: 1, operations: {
    read: { required: true, input: { kind: 'protocolDefined', schema: input }, resultSchema: result,
        action: { surfaces: ['plugin'], dangerLevel: 'safe' } },
} });
const plugin = definePlugin({ id: 'acme.account-admitted', version: '1.0.0',
    contributionPoints: { sources: defineContributionPoint([protocol]) },
    actions: { source: { title: 'Read admitted Machine source', surfaces: ['ui'], placementBindings: [],
        execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
        inputSchema: input, dangerLevel: 'safe', run: async (input, context): Promise<{ key: string; machine: true }> => {
            const observation = context.services.targetedContributions.observeForSelf(plugin.contributionPoints.sources,
                { onInvalidated: () => {} });
            try {
                const current = await observation.readCurrent({ signal: context.signal });
                const source = current.contributions[0];
                if (!source) throw new Error('Expected admitted Machine source');
                return await context.services.actions.executeAdmittedTargetedOperation(source.operations.read, input);
            } finally { observation.dispose(); }
        } },
    },
});
export const manifest = plugin.manifest;
export const activateAccount = plugin.activateAccount;
