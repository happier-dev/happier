import { listQualifiedConnectedAccountGroupsV4 } from '@/api/client/qualifiedConnectedAccountApi';
import type { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import type { ConnectedServiceAuthGroupGenerationConsumer } from '../accountGroups/generation/ConnectedServiceAuthGroupGenerationConsumer';
import { applyHealthSwitchGeneration } from '../accountGroups/generation/applyHealthSwitchGeneration';
import { rotateReauthPools, type ConnectedAccountReauthEvent } from '../accountGroups/switching/reauthPools';
import { createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator } from './createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator';

type CoordinatorInput = Parameters<typeof createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator>[0];

/** Account-bound composition shared by the daemon and requester refresh runtimes. */
export function createCredentialHealthPoolRotation(input: Pick<CoordinatorInput,
    'token' | 'accountScope' | 'isCurrent' | 'leases' | 'nowMs' | 'prepareCandidateForSwitch' | 'api'> & Readonly<{
    runtimeRegistry: ConnectedServiceRuntimeRegistry;
    consumeCommittedGeneration?: ConnectedServiceAuthGroupGenerationConsumer['consume'];
    listGroups?: typeof listQualifiedConnectedAccountGroupsV4;
}>): (event: ConnectedAccountReauthEvent) => Promise<void> {
    const assertCurrent = async () => {
        if (input.isCurrent && !await input.isCurrent()) throw new Error('connected_account_runtime_not_current');
    };
    const coordinator = createDaemonQualifiedConnectedAccountAuthGroupSwitchCoordinator({
        ...input,
        applyGeneration: generation => applyHealthSwitchGeneration(generation, {
            runtimeRegistry: input.runtimeRegistry,
            consume: async request => {
                if (!input.consumeCommittedGeneration) throw new Error('connected_service_generation_consumer_unavailable');
                return await input.consumeCommittedGeneration(request);
            },
        }),
    });
    return async event => {
        await assertCurrent();
        await rotateReauthPools(event, {
            listGroups: async service => {
                const result = await (input.listGroups ?? listQualifiedConnectedAccountGroupsV4)({ token: input.token, service });
                await assertCurrent();
                return result.groups;
            },
            switchAfterCredentialHealth: async event => {
                await assertCurrent();
                return await coordinator.switchAfterCredentialHealth({ serviceId: event.account.service,
                    groupId: event.groupId, profileId: event.account.accountId, credentialRevision: event.credentialRevision });
            },
        });
    };
}
