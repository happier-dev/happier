import {
    buildWorkBoardItemKeyV1,
    readWorkBoardItemKeyV1,
    WORK_BOARD_SECTIONS_V1,
    type BoardItemRefV1,
    type WorkBoardMembershipV1,
    type WorkBoardSectionV1,
    type WorkBoardV1,
} from '@happier-dev/protocol';

/** One item on a board, once, whatever brought it in. */
export type BoardMember = Readonly<{
    key: string;
    ref: BoardItemRefV1;
    /** Added by hand (it can be removed); otherwise a section or the filter keeps it on the board. */
    picked: boolean;
    /** A section or the filter holds it (it may also be picked): it stays on the board without the pick. */
    sourced: boolean;
    /** False when its Home or source cannot serve it here: shown as unavailable, never deleted. */
    available: boolean;
}>;

export type BoardMembership = Readonly<{
    members: readonly BoardMember[];
    /** Every chosen section and the filter have answered; until then nothing may be pruned. */
    complete: boolean;
}>;

/**
 * The live inputs of a board's source, each from its existing owner: Needs you from the Inbox model,
 * Running now from FIN's active run window, My machines from the machine list, and the inline filter
 * from the Sessions list query. `null` is "not answered yet"; a source the board does not use is
 * simply absent.
 */
export type BoardMembershipSources = Readonly<{
    isHomeMounted: (serverId: string) => boolean;
    sections: Readonly<Partial<Record<WorkBoardSectionV1, readonly BoardItemRefV1[] | null>>>;
    /** An answered page is still incomplete while its canonical source has more pages or has failed. */
    sectionComplete?: Readonly<Partial<Record<WorkBoardSectionV1, boolean>>>;
    /** Mounting a Home does not imply that an Account-scoped source serves it. */
    isSourceAvailable?: (ref: BoardItemRefV1) => boolean;
    filtered: readonly BoardItemRefV1[] | null | undefined;
    /** False while some Home has not answered the filter yet; the answered Homes' Sessions still show. */
    filterComplete?: boolean;
}>;

/** What is on a board now: sections in their fixed order, then the filter, then what was added by hand. */
export function projectBoardMembership(board: WorkBoardV1, sources: BoardMembershipSources): BoardMembership {
    const pickedKeys = new Set(board.source.picked.map(buildWorkBoardItemKeyV1));
    const chosenSections = new Set(board.source.sections ?? []);
    const byKey = new Map<string, BoardMember>();
    let complete = true;
    const available = (ref: BoardItemRefV1) => sources.isHomeMounted(ref.qualifiedId.serverId)
        && sources.isSourceAvailable?.(ref) !== false;
    const add = (ref: BoardItemRefV1, sourced: boolean) => {
        const key = buildWorkBoardItemKeyV1(ref);
        if (byKey.has(key)) return;
        byKey.set(key, {
            key,
            ref,
            picked: pickedKeys.has(key),
            sourced,
            available: available(ref),
        });
    };
    for (const section of WORK_BOARD_SECTIONS_V1) {
        if (!chosenSections.has(section)) continue;
        const refs = sources.sections[section];
        if (sources.sectionComplete?.[section] === false) complete = false;
        if (!refs) {
            complete = false;
            continue;
        }
        refs.forEach((ref) => add(ref, true));
    }
    if (board.source.filter) {
        if (!sources.filtered || sources.filterComplete === false) complete = false;
        sources.filtered?.forEach((ref) => add(ref, true));
    }
    board.source.picked.forEach((ref) => add(ref, false));
    // A placed card whose Home or source is unavailable cannot be answered by its section or filter here; its
    // qualified position key still names it, so it stays on the board as unavailable rather than vanishing.
    for (const key of Object.keys(board.positionsByItemRef)) {
        const ref = readWorkBoardItemKeyV1(key);
        if (ref && !available(ref)) add(ref, true);
    }
    return { members: [...byKey.values()], complete };
}

/**
 * The membership a save prunes positions against (`pruneWorkBoardPositionsV1`). While a source has
 * not answered, every saved position is treated as live, so a slow section never costs a card its place.
 */
export function resolveBoardPruneMembership(
    board: WorkBoardV1,
    membership: BoardMembership,
    isHomeMounted: (serverId: string) => boolean,
): WorkBoardMembershipV1 {
    const positionKeys = Object.keys(board.positionsByItemRef);
    const liveItemKeys = membership.complete
        ? membership.members.filter((member) => member.sourced).map((member) => member.key)
        : [...new Set([...membership.members.map((member) => member.key), ...positionKeys])];
    const unavailableServerIds = new Set<string>();
    for (const key of [...positionKeys, ...board.source.picked.map(buildWorkBoardItemKeyV1)]) {
        const serverId = readWorkBoardItemKeyV1(key)?.qualifiedId.serverId;
        if (serverId && !isHomeMounted(serverId)) unavailableServerIds.add(serverId);
    }
    return { liveItemKeys, unavailableServerIds: [...unavailableServerIds] };
}
