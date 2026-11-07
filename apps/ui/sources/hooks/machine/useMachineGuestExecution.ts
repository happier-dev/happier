import * as React from 'react';
import type { MachineAgentIsolationPreviewResultV1, MachineAgentIsolationSetInputV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { useMachineField } from '@/sync/store/hooks';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

type ReadyPreview = Extract<MachineAgentIsolationPreviewResultV1, { kind: 'ready' }>;
/** How agents run on the Machine, one per-Machine policy: as Happier's own user, one shared agent user, or a user per person. */
export type MachineAgentRunAs = 'daemon' | 'sharedAgent' | 'member';
const policyInput = (target: MachineAgentRunAs) => ({ enabled: target !== 'daemon',
    ...(target === 'member' ? { memberProvisioning: 'linuxUsersV1' as const } : {}) });
/** No current Account binding: nothing is asked of the Machine. */
const UNBOUND = { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' } as const;

/** Grant disclosure reads desired placement, never claims native readiness.
 * Mount only with the share or Security surface. Setup remains the existing reviewed Action,
 * metadata CAS, operation progress and elevated-effect owner. `scope` is null while the Account
 * binding is not current; the Actions then refuse without asking the Machine. */
export function useMachineGuestExecution(input: Readonly<{
    machineId: string;
    scope: ServerAccountScope | null;
    canManage: boolean;
    execute: FrontDoorActionExecute;
}>) {
    const { machineId, scope, execute } = input;
    const serverId = scope?.serverId ?? null;
    const accountId = scope?.accountId ?? null;
    const options = { serverId };
    const platform = useMachineField(machineId, 'metadata', 'platform', options);
    const storedPolicy = useMachineField(machineId, 'metadata', 'agentIsolation', options);
    // The Machine's own readiness report, the same fact Security reads, so Sharing never says "on" while it is not running.
    const isolation = useMachineField(machineId, 'daemonState', 'agentIsolation', options);
    const { separateUsers, isolation: readiness } = presentMachineAuthorityV1({ platform, isolationPolicy: storedPolicy, isolation });
    const { placement } = separateUsers;
    // The reviewed target: a user per person (separate users), the shared agent user, or Happier's own user.
    const previewSeparateUsers = React.useCallback((signal?: AbortSignal, target: MachineAgentRunAs = 'member') => serverId && accountId
        ? execute('machines.agentIsolation.preview', {
            serverId, machineId, ...policyInput(target),
        }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId, signal })
        : Promise.resolve(UNBOUND),
    [execute, serverId, accountId, machineId]);
    // The UI must show the preview's effects before calling this on person intent; the direction is the reviewed one.
    // Return the typed Action result intact, including approval, conflict and refusal.
    const applySeparateUsers = React.useCallback((review: ReadyPreview, signal?: AbortSignal, target: MachineAgentRunAs = 'member') => serverId && accountId
        ? execute('machines.agentIsolation.set', {
            serverId, machineId, ...policyInput(target),
            expectedPolicy: review.policy, expectedMetadataVersion: review.metadataVersion, expectedPlanDigest: review.plan.planDigest,
        } satisfies MachineAgentIsolationSetInputV1,
        { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId, signal })
        : Promise.resolve(UNBOUND),
    [execute, serverId, accountId, machineId]);
    const bound = scope !== null && input.canManage;
    return { placement, availability: separateUsers.availability, isolation: readiness,
        canEnableSeparateUsers: bound && separateUsers.availability.kind === 'can_turn_on',
        /** The Machine's current policy, readable on a supported Machine; the owner changes it through the review. */
        runAs: separateUsers.availability.kind === 'unavailable' ? null : placement,
        canChooseRunAs: bound && separateUsers.availability.kind !== 'unavailable',
        previewSeparateUsers, applySeparateUsers };
}
