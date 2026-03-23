import type { MachineLoginKey } from '@/agents/catalog/catalog';

type MachineLoginSelectableTarget = Readonly<{
    targetKey: string;
    machineLoginKey: MachineLoginKey;
}>;

export function resolveMachineLoginRequirementForProfileTargets(params: Readonly<{
    compatibleTargets: readonly MachineLoginSelectableTarget[];
}>): Readonly<{
    selectableTargetKey: string | null;
    machineLoginKey: MachineLoginKey | null;
}> {
    if (params.compatibleTargets.length !== 1) {
        return {
            selectableTargetKey: null,
            machineLoginKey: null,
        };
    }

    const onlyTarget = params.compatibleTargets[0]!;
    return {
        selectableTargetKey: onlyTarget.targetKey,
        machineLoginKey: onlyTarget.machineLoginKey,
    };
}
