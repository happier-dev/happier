import type { ConnectedAccountDaemonControlCommand } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import { sameQualifiedConnectedAccountRef } from '@happier-dev/protocol/connect/qualifiedConnectedAccountPersistence';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { getStorage } from '@/sync/domains/state/storageStore';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { createMachineRpcReadAdmission, type MachineRpcReadAdmission } from '@/sync/runtime/orchestration/serverScopedRpc/machineRpcReadAdmission';

/** Each caller retains Action admission; only the same versioned native read is shared. */
export function createUiConnectedAccountNativeConfigurationReadAdmission(
    account: Pick<LazyActionAccountContext, 'accountLifetime'>,
    machineId: string | undefined,
    command: ConnectedAccountDaemonControlCommand,
): MachineRpcReadAdmission | undefined {
    if (command.operation !== 'readConfiguration' || command.target.kind !== 'account') return undefined;
    const requested = command.target.account;
    const state = getStorage().getState();
    const grant = areServerAccountScopesEqual(account.accountLifetime.scope, state.profileScope)
        ? state.profile.connectedAccountsV4?.find(candidate => sameQualifiedConnectedAccountRef(candidate.ref, requested)) : null;
    if (grant?.revisionSemantics !== 'revisioned' || grant.credentialRevision === null) return undefined;
    return createMachineRpcReadAdmission(['connectedServices.configuration.get', machineId,
        command.target, grant.credentialRevision, grant.configurationRevision]);
}
