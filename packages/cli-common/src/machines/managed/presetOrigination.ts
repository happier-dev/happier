import { ManagedAcquireInputV1Schema, isManagedPresetAcquireInputV1, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachinePresetAcquireRoutingResultV1Schema, type ManagedMachinePresetAcquireRoutingInputV1, type ManagedMachinePresetAcquireOriginV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachinePoolErrorV1Schema, MachinePoolResolveResultV1Schema, type MachinePoolResolveInputV1 } from '@happier-dev/protocol/machines/pools';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type ManagedPresetAcquireOriginV1 = Readonly<{
    kind: 'bound'; input: ManagedAcquireInputV1; controllerAccess?: ManagedControllerAccessV1;
}> | Readonly<{ kind: 'refused'; code: string }>;

/** Fresh origins select once; admission and later execution consume this exact input. */
export async function bindManagedPresetAcquireOriginV1(params: Readonly<{
    input: ManagedAcquireInputV1; preset: ManagedMachinePresetAcquireOriginV1; requestKey: string;
    resolvePool: (input: MachinePoolResolveInputV1) => Promise<unknown>;
    resolveExact: (input: ManagedMachinePresetAcquireRoutingInputV1) => Promise<unknown>;
}>): Promise<ManagedPresetAcquireOriginV1> {
    const { input, preset } = params;
    const refused = (code: string): ManagedPresetAcquireOriginV1 => ({ kind: 'refused', code });
    if (!isManagedPresetAcquireInputV1(input)) return refused('invalid_parameters');
    if (input.selection.id !== preset.id || input.selection.homeId !== preset.homeId) return refused('managed_response_invalid');
    if (input.selection.revision !== preset.revision) return refused('request_conflict');
    // Retention and wake are the only public preset acquisition choices. The
    // launch, setup, provider review, and Team authorization stay respectively
    // in the private content, the installed custodian, and Home admission.
    if (preset.retention !== undefined && input.retention !== undefined && !sameStrictJsonValue(input.retention, preset.retention)
        || preset.wakeOnAcceptedMessage !== undefined && input.wakeOnAcceptedMessage !== undefined && input.wakeOnAcceptedMessage !== preset.wakeOnAcceptedMessage) return refused('permission_denied');
    if (preset.controllerPoolId) {
        // An already-bound invocation must retain its original carrier, never select again.
        if (input.controller) return refused('controller_unavailable');
        const payload = await params.resolvePool({
            poolId: preset.controllerPoolId, requestKey: params.requestKey, purpose: 'managed-preset',
            preset: { homeId: preset.homeId, id: preset.id, revision: preset.revision },
        });
        const poolError = MachinePoolErrorV1Schema.safeParse(payload);
        if (poolError.success) return refused(poolError.data.code);
        const projected = MachinePoolResolveResultV1Schema.safeParse(payload);
        if (!projected.success || projected.data.poolId !== preset.controllerPoolId) return refused('managed_response_invalid');
        const placement = projected.data;
        if (placement.kind === 'unavailable') return refused(placement.code ?? placement.reason);
        const bound = placement.managedPreset;
        if (!bound || bound.controller.machineId !== placement.machineId) return refused('managed_response_invalid');
        return { kind: 'bound', controllerAccess: bound.controllerAccess,
            input: ManagedAcquireInputV1Schema.parse({ ...input, controller: bound.controller }) };
    }
    if (input.controller && !sameStrictJsonValue(preset.controller, input.controller)) return refused('controller_retired');
    if (!preset.controller) return { kind: 'bound', input };
    const payload = await params.resolveExact({ homeId: preset.homeId, id: preset.id,
        revision: preset.revision, controller: preset.controller });
    const resolved = ManagedMachinePresetAcquireRoutingResultV1Schema.safeParse(payload);
    if (!resolved.success) return refused('managed_response_invalid');
    if (resolved.data.kind === 'refused') return refused(resolved.data.code);
    if (!sameStrictJsonValue(resolved.data.controller, preset.controller)) return refused('controller_retired');
    return { kind: 'bound', input: ManagedAcquireInputV1Schema.parse({ ...input, controller: resolved.data.controller }),
        controllerAccess: resolved.data.controllerAccess };
}
