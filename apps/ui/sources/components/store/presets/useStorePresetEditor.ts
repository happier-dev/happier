import * as React from 'react';
import type { OpenedManagedMachinePresetV1 } from '@/sync/ops/machines/machinePresetCollectionClient';
import { createMachinePresetCollectionClient, type MachinePresetCollectionOptions } from '@/components/settings/machines/managed/machinePresetCollectionClient';
import { useMachinePresetQuery } from '@/components/settings/machines/managed/useMachinePresets';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import type { ActionApprovalRegistration } from '@/components/approvals/actionApprovalContinuation';

/** Exact preset content, without the managed-machine history requested by the Settings detail page. */
export function useStorePresetEditor(input: Readonly<{ serverId: string; presetId?: string;
    onApprovalPending?: (approval: ActionApprovalRegistration) => void }>) {
    const { serverId, presetId } = input;
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const homeId = getServerProfileById(serverId)?.serverIdentityId ?? null;
    const client = React.useMemo(() => binding && homeId
        ? createMachinePresetCollectionClient(binding.scope, homeId) : null, [binding, homeId]);
    const read = React.useMemo(() => client && homeId && presetId
        ? async (options: MachinePresetCollectionOptions<OpenedManagedMachinePresetV1>) => {
            const result = await client.read('machines.presets.get', { homeId, id: presetId }, {
                signal: options.signal, onApprovalPending: options.onApprovalPending, onApprovalSettled: options.onApprovalSettled,
            });
            if (result.kind === 'failed') return result;
            return result.value.kind === 'found' ? { kind: 'succeeded' as const, value: result.value.preset }
                : { kind: 'failed' as const, code: result.value.code };
        } : null, [client, homeId, presetId]);
    const query = useMachinePresetQuery({ serverId, homeId, presetId, binding, resolution, read,
        onApprovalPending: input.onApprovalPending });
    const state = !homeId ? { value: null, loading: false, error: 'server_identity_unavailable' }
        : !presetId ? { value: null, loading: false, error: null } : query.state;
    return { state, client, homeId, refresh: query.refresh };
}
