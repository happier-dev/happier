import { MANAGED_MACHINE_PRESET_PAGE_SIZE_V1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { homeDomainFailureFromActionFailure } from '@/sync/api/home/homeDomainActions';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { serverAccountScopedTeamResourceKey, type TeamAddress } from '@/sync/domains/teams/teamAddress';
import { homeAccountChangeAffectsMachinePresetList, isMachinePresetAccessLost } from '@/sync/engine/machines/machinePresetsResource';
import { createMachinePresetCollectionClient } from '@/sync/ops/machines/machinePresetCollectionClient';
import { teamSharedMachinePresetPages, type TeamSharedMachinePresetRow } from '@/sync/store/teams/teamsSnapshots';

import { useTeamObservedPagedList } from './useTeamObservedPagedList';

const presetKey = (preset: TeamSharedMachinePresetRow) => preset.id;

export function useTeamSharedMachinePresets(input: Readonly<{
    scope: ServerAccountScope;
    address: TeamAddress;
    onApprovalPending: (approval: ActionApprovalRegistration) => void;
}>) {
    const { scope, address, onApprovalPending } = input;
    const { serverId } = address;
    const homeId = getServerProfileById(serverId)?.serverIdentityId;
    const presented = useLayoutPresentationActive();
    return useTeamObservedPagedList<TeamSharedMachinePresetRow>({
        scope,
        key: serverAccountScopedTeamResourceKey(scope, address, homeId ?? ''),
        enabled: presented && scope.serverId === serverId,
        observations: teamSharedMachinePresetPages,
        getRowKey: presetKey,
        accountChange: { serverId, affects: event => event.source === 'connected' || homeAccountChangeAffectsMachinePresetList(event) },
        loadPage: async (cursor, signal) => {
            const result = homeId ? await createMachinePresetCollectionClient(scope, homeId).listPage({
                sharedWithTeamId: address.teamId, limit: MANAGED_MACHINE_PRESET_PAGE_SIZE_V1, cursor: cursor ?? undefined, signal, onApprovalPending,
            }) : { kind: 'failed' as const, code: 'server_identity_unavailable' };
            if (result.kind === 'succeeded' && result.value.kind === 'listed') {
                return { kind: 'succeeded', value: { items: result.value.presets.map(({ id, name }) => ({ id, name })), nextCursor: result.value.cursor ?? null } };
            }
            const code = result.kind === 'failed' ? result.code : 'invalid_action_output';
            const failure = homeDomainFailureFromActionFailure({ errorCode: code });
            return { kind: 'failed', failure: isMachinePresetAccessLost(code) ? { ...failure, kind: 'forbidden', retryable: false } : failure };
        },
    });
}
