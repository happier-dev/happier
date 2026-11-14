import type { ManagedMachinePresetAcquireRoutingInputV1, ManagedMachinePresetAcquireRoutingResultV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { TeamOperationAuthenticationContext } from '@/app/teams/actorContext';
import { inReadSnapshot } from '@/storage/inTx';
import { ManagedMachineError, sameManagedInput } from './managedRows';
import { resolveMachinePresetForAcquireInTx } from './machinePresetService';

/** Reuse acquire admission's scoped custody before clients encrypt to an exact controller. */
export async function resolveMachinePresetAcquireRouting(params: Readonly<{
    accountId: string; authentication?: Partial<TeamOperationAuthenticationContext>;
    input: ManagedMachinePresetAcquireRoutingInputV1;
}>): Promise<ManagedMachinePresetAcquireRoutingResultV1> {
    try {
        const selected = await inReadSnapshot(tx => resolveMachinePresetForAcquireInTx(tx, {
            accountId: params.accountId, authentication: params.authentication,
            ...params.input, boundController: params.input.controller, checkCapacity: false,
        }));
        if (selected.kind === 'conflict') return { kind: 'refused', code: 'request_conflict' };
        if (selected.kind === 'refused') return selected;
        if (!sameManagedInput(selected.preset.controller, params.input.controller)) return { kind: 'refused', code: 'controller_retired' };
        if (!selected.preset.controller || !selected.controllerAccess) return { kind: 'refused', code: 'controller_unavailable' };
        return { kind: 'resolved', controller: selected.preset.controller, controllerAccess: selected.controllerAccess };
    } catch (error) {
        if (!(error instanceof ManagedMachineError)) throw error;
        return { kind: 'refused', code: error.code };
    }
}
