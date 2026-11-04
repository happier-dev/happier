import * as React from 'react';
import type { MachineAgentIsolationPreviewResultV1, MachineAgentIsolationSetInputV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import { presentMachineAuthorityV1 } from '@happier-dev/protocol/machines/machineAuthorityV1';
import { useMachineField } from '@/sync/store/hooks';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { FrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

/** Grant disclosure reads desired placement, never claims native readiness.
 * Mount only with the share surface. Setup remains the existing reviewed Action,
 * metadata CAS, operation progress and elevated-effect owner. */
export function useMachineGuestExecution(input: Readonly<{
    machineId: string;
    scope: ServerAccountScope;
    canManage: boolean;
    execute: FrontDoorActionExecute;
}>) {
    const { machineId, scope, execute } = input;
    const options = { serverId: scope.serverId };
    const platform = useMachineField(machineId, 'metadata', 'platform', options);
    const storedPolicy = useMachineField(machineId, 'metadata', 'agentIsolation', options);
    const isolation = useMachineField(machineId, 'daemonState', 'agentIsolation', options);
    const { separateUsers } = presentMachineAuthorityV1({ platform, isolationPolicy: storedPolicy, isolation });
    const { placement } = separateUsers;
    const previewSeparateUsers = React.useCallback((signal?: AbortSignal) => execute('machines.agentIsolation.preview', {
        serverId: scope.serverId, machineId, enabled: true, memberProvisioning: 'linuxUsersV1',
    }, { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId, signal }),
    [execute, scope.serverId, scope.accountId, machineId]);
    // The UI must show the preview's effects before calling this on person intent.
    // Return the typed Action result intact, including approval, conflict and refusal.
    const applySeparateUsers = React.useCallback((review: Extract<MachineAgentIsolationPreviewResultV1, { kind: 'ready' }>, signal?: AbortSignal) =>
        execute('machines.agentIsolation.set', {
            serverId: scope.serverId, machineId, enabled: true, memberProvisioning: 'linuxUsersV1',
            expectedPolicy: review.policy, expectedMetadataVersion: review.metadataVersion, expectedPlanDigest: review.plan.planDigest,
        } satisfies MachineAgentIsolationSetInputV1,
        { surface: 'ui', authority: 'present_user', serverId: scope.serverId, expectedAccountId: scope.accountId, signal }),
    [execute, scope.serverId, scope.accountId, machineId]);
    return { placement, showOwnerUserDisclosure: placement !== null && placement !== 'member', canEnableSeparateUsers: input.canManage && separateUsers.canEnable,
        previewSeparateUsers, applySeparateUsers };
}
