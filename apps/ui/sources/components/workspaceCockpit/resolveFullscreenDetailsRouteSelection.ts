type DetailsTabLike = Readonly<{ key?: string | null }> | null | undefined;

type DetailsGroupLike<TTab extends DetailsTabLike> = Readonly<{
    activeTabKey?: string | null;
    tabs?: readonly TTab[] | null;
    isFocused?: boolean;
}> | null | undefined;

export type FullscreenDetailsRouteSelection<TTab extends DetailsTabLike = DetailsTabLike> = Readonly<{
    hasAnyDetails: boolean;
    tabs: readonly TTab[];
    activeKey: string | null;
}>;

function normalizeTabs<TTab extends DetailsTabLike>(tabs: readonly TTab[] | null | undefined): readonly TTab[] {
    return Array.isArray(tabs) ? tabs : [];
}

function readTabKey(tab: DetailsTabLike): string | null {
    const key = typeof tab?.key === 'string' ? tab.key : null;
    return key && key.length > 0 ? key : null;
}

function resolveActiveKeyFromTabs<TTab extends DetailsTabLike>(
    tabs: readonly TTab[],
    activeKey: string | null | undefined,
): string | null {
    if (typeof activeKey === 'string' && activeKey.length > 0 && tabs.some((tab) => readTabKey(tab) === activeKey)) {
        return activeKey;
    }
    return readTabKey(tabs.at(-1)) ?? null;
}

export function resolveFullscreenDetailsRouteSelection<TTab extends DetailsTabLike>(input: Readonly<{
    detailsTabs?: readonly TTab[] | null;
    activeDetailsKey?: string | null;
    detailsGroups?: readonly DetailsGroupLike<TTab>[] | null;
}>): FullscreenDetailsRouteSelection<TTab> {
    const directTabs = normalizeTabs(input.detailsTabs);
    const groups = (input.detailsGroups ?? [])
        .map((group) => {
            const tabs = normalizeTabs(group?.tabs);
            return {
                isFocused: group?.isFocused === true,
                activeTabKey: typeof group?.activeTabKey === 'string' ? group.activeTabKey : null,
                tabs,
            };
        })
        .filter((group) => group.tabs.length > 0);

    const selectedGroup = groups.find((group) => group.isFocused) ?? groups[0] ?? null;
    const tabs = selectedGroup?.tabs ?? directTabs;
    const activeKey = resolveActiveKeyFromTabs(
        tabs,
        selectedGroup?.activeTabKey ?? input.activeDetailsKey,
    );

    return {
        hasAnyDetails: tabs.length > 0 || groups.length > 0,
        tabs,
        activeKey,
    };
}
