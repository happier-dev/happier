/**
 * The single deterministic ordering rule for projected plugin UI contributions
 * (§8.1 "one UI contribution catalog": qualified identity, one normalization and
 * one deterministic collision policy).
 *
 * Four sites previously carried their own copy and two of them disagreed about
 * what a MISSING `order` means: the surface-placement projection and its
 * selector sorted an undeclared contribution LAST
 * (`Number.MAX_SAFE_INTEGER`), while the session-header and browser-action
 * families sorted it as `0` — ahead of every positively-ordered peer and tied
 * with an explicit `order: 0`. Two answers for one question is a split-brain,
 * and it is user-visible: the same manifest produced a different position
 * depending on which family read it.
 *
 * The retained answer is the placement owner's: `order` is an opt-in position,
 * so a contribution that does not declare one follows every contribution that
 * does, and ties break on the qualified contribution id so the result is stable
 * across projection rebuilds.
 */
export type PluginContributionOrderEntry = Readonly<{
    id: string;
    order?: unknown;
}>;

/** Undeclared `order` follows every declared one. */
function readDeclaredOrder(entry: PluginContributionOrderEntry): number {
    return typeof entry.order === 'number' && Number.isFinite(entry.order)
        ? entry.order
        : Number.MAX_SAFE_INTEGER;
}

export function comparePluginContributionOrder(
    left: PluginContributionOrderEntry,
    right: PluginContributionOrderEntry,
): number {
    const leftOrder = readDeclaredOrder(left);
    const rightOrder = readDeclaredOrder(right);
    return leftOrder !== rightOrder
        ? leftOrder - rightOrder
        : left.id.localeCompare(right.id);
}
