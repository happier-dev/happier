import type { PluginContributionRef } from '@happier-dev/plugin-sdk';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol/connect/connected-account-purpose-bindings';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';

/** Bind the real host service against an empty persisted purpose catalog. */
export function unselectedConnectedAccount(input: {
    service: PluginContributionRef;
    purpose: string;
    version: string;
    action: string;
    signal?: AbortSignal;
    read?: () => Promise<QualifiedConnectedAccountPurposeBindingsV1>;
}) {
    const unexpected = async (): Promise<never> => { throw new Error('No account was selected'); };
    const owner = createConnectedAccountPurposeBindingOwner({
        store: {
            read: input.read ?? (async () => ({ v: 1, bindings: [] })),
            update: unexpected,
            subscribe: () => ({ dispose() {} }),
        },
        resolveTarget: unexpected,
        selectTarget: unexpected,
        materializeAccount: unexpected,
        projectTargetAccounts: unexpected,
        assertTargetAccountMaterializable: unexpected,
    });
    return createStablePluginConnectedAccountsHost(owner).bind({
        plugin: { id: input.service.pluginId, version: input.version },
        contribution: { id: input.action, qualifiedId: `${input.service.pluginId}/actions/${input.action}` },
        occurrenceId: 'test-occurrence',
        correlationId: 'test-invocation',
        signal: input.signal ?? new AbortController().signal,
        surface: 'plugin',
        isOccurrenceCurrent: () => true,
    }, [{ purpose: input.purpose, serviceRefs: [input.service], operations: ['use'], materializationKinds: ['environment'] }]);
}
