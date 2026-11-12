import { ManagedAcquireInputV1Schema, type ManagedAcquireInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import type { ManagedMachinePresetV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetV1';
import type { ManagedControllerAccessV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import type { ManagedConfigurationFactsV1 } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { MachinePoolErrorV1Schema, MachinePoolResolveResultV1Schema, type MachinePoolResolveInputV1 } from '@happier-dev/protocol/machines/pools';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

export type ManagedPresetAcquireOriginV1 = Readonly<{
    kind: 'bound'; input: ManagedAcquireInputV1; controllerAccess?: ManagedControllerAccessV1;
}> | Readonly<{ kind: 'refused'; code: string }>;

/** Fresh origins select once; admission and later execution consume this exact input. */
export async function bindManagedPresetAcquireOriginV1(params: Readonly<{
    input: ManagedAcquireInputV1; preset: ManagedMachinePresetV1; requestKey: string;
    resolvePool: (input: MachinePoolResolveInputV1) => Promise<unknown>;
}>): Promise<ManagedPresetAcquireOriginV1> {
    const { input, preset } = params;
    const refused = (code: string): ManagedPresetAcquireOriginV1 => ({ kind: 'refused', code });
    if (!('retention' in input) || input.selection.kind !== 'preset') return refused('invalid_parameters');
    if (input.selection.id !== preset.id || input.selection.homeId !== preset.homeId) return refused('managed_response_invalid');
    if (input.selection.revision !== preset.revision) return refused('request_conflict');
    const selectedName = input.selection.name;
    // Public facts already own the provider default; only bind this Machine's requested name.
    const withSelectedName = (facts: ManagedConfigurationFactsV1) => selectedName === undefined ? facts
        : { ...facts, launch: { ...facts.launch, name: selectedName } };
    const delegated = preset.delegatedAcquire;
    if (delegated?.kind === 'unavailable') return refused(delegated.code);
    if (delegated?.kind === 'ready' && (!sameStrictJsonValue(input.retention, delegated.reviewedFacts.retention)
        || input.wakeOnAcceptedMessage !== delegated.reviewedFacts.wakeOnAcceptedMessage)) return refused('permission_denied');
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
        if (!sameStrictJsonValue(input.retention, bound.reviewedFacts.retention)
            || input.wakeOnAcceptedMessage !== bound.reviewedFacts.wakeOnAcceptedMessage) return refused('request_conflict');
        return { kind: 'bound', controllerAccess: bound.controllerAccess,
            input: ManagedAcquireInputV1Schema.parse({ ...input, controller: bound.controller, reviewedFacts: withSelectedName(bound.reviewedFacts) }) };
    }
    if (input.controller && !sameStrictJsonValue(preset.controller, input.controller)) return refused('controller_retired');
    return { kind: 'bound',
        input: ManagedAcquireInputV1Schema.parse({ ...input,
            ...(preset.controller ? { controller: preset.controller } : {}),
            ...(input.reviewedFacts === undefined && delegated?.kind === 'ready' ? { reviewedFacts: withSelectedName(delegated.reviewedFacts) } : {}) }),
        ...(delegated?.kind === 'ready' ? { controllerAccess: delegated.controller } : {}) };
}
