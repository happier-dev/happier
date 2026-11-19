import { expect, it, onTestFinished } from 'vitest';
import { createPurposeTargetResolver } from '@happier-dev/cli-common/connectedAccounts';
import { PluginConnectedAccountAuthenticationV2Schema } from '@happier-dev/protocol';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createStablePluginConnectedAccountsHost } from './connectedAccounts';
import type { PluginConnectedAccountBindingScope, PluginInvocationServicesSeed } from './types';

const scope: PluginConnectedAccountBindingScope = {
    purpose: 'claude-subscription',
    serviceRefs: [{ pluginId: 'acme.accounts', localId: 'claude' }],
    operations: ['use'], materializationKinds: ['environment'],
};

function createSeed(): { seed: PluginInvocationServicesSeed } {
    return { seed: {
        plugin: { id: 'acme.consumer', version: '1.0.0' },
        contribution: { id: 'reviewer', qualifiedId: 'acme.consumer/agents/reviewer' },
        occurrenceId: 'selection-occurrence', correlationId: 'selection-correlation', surface: 'cli',
        signal: new AbortController().signal, retirementSignal: new AbortController().signal,
        isOccurrenceCurrent: () => true,
    } };
}

    it('projects the exact admitted native selection and refuses unavailable selected accounts', async () => {
        const { seed } = createSeed();
        const purpose = { consumer: { pluginId: seed.plugin.id, localId: seed.contribution.id }, purpose: scope.purpose };
        const account = { service: scope.serviceRefs[0]!, accountId: 'selected' };
        const unexpected = async (): Promise<never> => { throw new Error('Selection must not acquire credentials'); };
        const owner = createConnectedAccountPurposeBindingOwner({
            store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
            resolveTarget: createPurposeTargetResolver({ available: true,
                resolveService: async () => ({ service: account.service,
                    authentication: PluginConnectedAccountAuthenticationV2Schema.parse({ defaultModeId: 'token', modes: [{
                        id: 'token', kind: 'manual', outcomeReconciliation: 'none',
                        fields: [{ id: 'token', title: 'Token', secret: true, schema: { type: 'string' } }],
                    }] }) }), listAccounts: async () => [] }),
            selectTarget: unexpected, materializeAccount: unexpected,
            projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
        });
        const lease = owner.activatePurposeBindings({
            subject: { kind: 'execution_run', runId: 'selected-native', runnerPid: 123, agentId: 'reviewer', isCurrent: () => true },
            purposes: [purpose], bindings: [],
        });
        const host = createStablePluginConnectedAccountsHost(owner);
        onTestFinished(() => { lease.dispose(); host.retire(); });
        const service = host.bind(seed, [scope], { exactPurposeBindingSubjectId: lease.subjectId });
        await expect(service.getBinding(scope.purpose)).resolves.toBeNull();
        await expect(service.resolveSelection!(scope.purpose)).resolves.toEqual({ credentialSource: 'machineLogin' });
        lease.dispose();
        await expect(service.resolveSelection!(scope.purpose)).rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable' });
        const selected = owner.activatePurposeBindings({
            subject: { kind: 'execution_run', runId: 'unavailable-account', runnerPid: 123, agentId: 'reviewer', isCurrent: () => true },
            purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account } }],
        });
        onTestFinished(() => selected.dispose());
        await expect(host.bind(seed, [scope], { exactPurposeBindingSubjectId: selected.subjectId }).resolveSelection!(scope.purpose))
            .rejects.toMatchObject({ code: 'plugin_connected_account_binding_unavailable', details: { reasonCode: 'target_unavailable' } });
    });
