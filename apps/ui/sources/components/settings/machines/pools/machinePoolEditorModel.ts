import type { MachinePoolMemberInputV1 } from '@happier-dev/protocol/machines/pools/v1';

export type MachinePoolHomeStatus = 'idle' | 'loading' | 'signedOut' | 'error';

/**
 * A Home the client cannot currently write to. A failed request is deliberately not part of this:
 * a refresh that failed is a truthful "could not refresh", not evidence that the Home is offline,
 * and it must not silently take administration away.
 */
export function isMachinePoolHomeOffline(status: MachinePoolHomeStatus): boolean {
    return status === 'signedOut';
}

/** The Home's last read failed. Rows stay readable; the user gets an explicit Retry. */
export function isMachinePoolRefreshFailed(status: MachinePoolHomeStatus): boolean {
    return status === 'error';
}

/**
 * Empty visual tiers are editor state only. The aggregate wire definition keeps occupied tiers
 * contiguous while preserving member order inside each unordered tier.
 */
export function normalizeMachinePoolEditorMembers(
    members: readonly MachinePoolMemberInputV1[],
): MachinePoolMemberInputV1[] {
    const tiers = Array.from(new Set(members.map((member) => member.priorityTier))).sort((a, b) => a - b);
    const normalizedTierByTier = new Map(tiers.map((tier, index) => [tier, index]));
    return members.map((member) => ({
        ...member,
        priorityTier: normalizedTierByTier.get(member.priorityTier) ?? 0,
    }));
}

export type MachinePoolEditorTierState = Readonly<{
    members: MachinePoolMemberInputV1[];
    tierCount: number;
}>;

/**
 * Keeps the visible form in the shape the aggregate will be saved in.
 *
 * Emptying an intermediate fallback tier renumbers the remaining tiers immediately, so Save is never
 * the first moment the user sees a different tier structure. A trailing tier the user deliberately
 * added with "Add fallback" is preserved, because it is a place they are still filling in.
 */
export function normalizeMachinePoolEditorTierState(
    members: readonly MachinePoolMemberInputV1[],
    tierCount: number,
): MachinePoolEditorTierState {
    const occupied = Array.from(new Set(members.map((member) => member.priorityTier))).sort((a, b) => a - b);
    const normalized = normalizeMachinePoolEditorMembers(members);
    const occupiedTierCount = occupied.length;
    const lastOccupiedTier = occupied[occupiedTierCount - 1];
    const trailingEmptyTierCount = Math.max(
        0,
        tierCount - (lastOccupiedTier === undefined ? 0 : lastOccupiedTier + 1),
    );
    return {
        members: normalized,
        tierCount: Math.max(1, occupiedTierCount + trailingEmptyTierCount),
    };
}

export function createMachinePoolEditorTierState(
    members: readonly MachinePoolMemberInputV1[],
): MachinePoolEditorTierState {
    const normalized = normalizeMachinePoolEditorMembers(members);
    const tierCount = normalized.reduce((count, member) => Math.max(count, member.priorityTier + 1), 1);
    return { members: normalized, tierCount };
}

export function moveMachinePoolEditorTier(
    members: readonly MachinePoolMemberInputV1[],
    fromTier: number,
    toTier: number,
): MachinePoolMemberInputV1[] {
    if (fromTier === toTier) return [...members];
    return members.map((member) => {
        if (member.priorityTier === fromTier) return { ...member, priorityTier: toTier };
        if (member.priorityTier === toTier) return { ...member, priorityTier: fromTier };
        return member;
    });
}
