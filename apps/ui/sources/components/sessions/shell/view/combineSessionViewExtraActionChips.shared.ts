import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';

const combinedChipsCache = new WeakMap<ReadonlyArray<AgentInputExtraActionChip>, WeakMap<ReadonlyArray<AgentInputExtraActionChip>, ReadonlyArray<AgentInputExtraActionChip>>>();

function getCachedCombinedChips(
    left: ReadonlyArray<AgentInputExtraActionChip>,
    right: ReadonlyArray<AgentInputExtraActionChip>,
): ReadonlyArray<AgentInputExtraActionChip> | null {
    const leftCache = combinedChipsCache.get(left);
    return leftCache?.get(right) ?? null;
}

function setCachedCombinedChips(
    left: ReadonlyArray<AgentInputExtraActionChip>,
    right: ReadonlyArray<AgentInputExtraActionChip>,
    combined: ReadonlyArray<AgentInputExtraActionChip>,
): ReadonlyArray<AgentInputExtraActionChip> {
    let leftCache = combinedChipsCache.get(left);
    if (!leftCache) {
        leftCache = new WeakMap<ReadonlyArray<AgentInputExtraActionChip>, ReadonlyArray<AgentInputExtraActionChip>>();
        combinedChipsCache.set(left, leftCache);
    }
    leftCache.set(right, combined);
    return combined;
}

export function combineSessionViewExtraActionChips(
    left: ReadonlyArray<AgentInputExtraActionChip> | undefined,
    right: ReadonlyArray<AgentInputExtraActionChip> | undefined,
): ReadonlyArray<AgentInputExtraActionChip> | undefined {
    if (left == null || left.length === 0) return right?.length ? right : undefined;
    if (right == null || right.length === 0) return left;

    const cached = getCachedCombinedChips(left, right);
    if (cached) {
        return cached;
    }

    const chips = [...left, ...right];
    return setCachedCombinedChips(left, right, chips);
}
