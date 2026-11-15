import { useCallback } from 'react';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import type { ManagedMachineReadSnapshotV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { buildManagedInstallationRetryInput, resolveManagedInstallationRecovery, type ManagedInstallationRecoveryKind }
    from '@/components/settings/machines/managed/managedCreationPresentation';

export type MachineRecoveryRefusal = 'notManaged' | 'recoveryUnavailable';
export type MachineRecovery = Readonly<{ kind: 'unavailable'; reason: MachineRecoveryRefusal }>
    | Readonly<{ kind: ManagedInstallationRecoveryKind; actionId: typeof MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1;
        run: () => Promise<ActionExecuteResult> }>;
export type MachineRecoveryOptions = Readonly<{
    managed: ManagedMachineReadSnapshotV1 | null;
    online: boolean | null;
    /** From the Home payload comparison owner, never a public release version. */
    guestPayloadStale?: boolean;
    operation?: ActionOperationProjection | null;
    providerAvailable?: boolean;
    /** Supply the page's mounted Action executor, including approval continuation and Account binding. */
    execute: (actionId: ActionId, input: unknown) => Promise<ActionExecuteResult>;
}>;

/** No reads, timers or store: consume the page's existing admitted row and presence. */
export function useMachineRecovery(options: MachineRecoveryOptions): MachineRecovery {
    const { managed, online, execute } = options;
    const kind = managed ? resolveManagedInstallationRecovery(managed, options.operation, {
        guestOnline: online, guestPayloadStale: online === true && options.guestPayloadStale, providerAvailable: options.providerAvailable,
    }) : null;
    const run = useCallback(() => execute(MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1,
        managed ? buildManagedInstallationRetryInput(managed) : {}), [execute, managed]);
    if (!managed) return { kind: 'unavailable', reason: 'notManaged' };
    if (kind) return { kind, actionId: MANAGED_BOOTSTRAP_RETRY_ACTION_ID_V1, run };
    return { kind: 'unavailable', reason: 'recoveryUnavailable' };
}
