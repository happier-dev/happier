import type {
    RightSidebarMobileSurface,
    RightSidebarScope,
    RightSidebarTabDefinition,
    RightSidebarTabOwner,
} from './rightSidebarBuiltinTabs';

export type RightSidebarMobileProjectionEntry = Readonly<{
    tabId: string;
    surface: RightSidebarMobileSurface;
    owner: RightSidebarTabOwner;
    tab: RightSidebarTabDefinition;
}>;

export function resolveRightSidebarMobileSurface(
    tab: RightSidebarTabDefinition,
    scope: RightSidebarScope,
): RightSidebarMobileSurface | null {
    return tab.mobileSurfaces?.[scope] ?? null;
}

export function resolveRightSidebarMobileProjection(input: Readonly<{
    scope: RightSidebarScope;
    tabs: readonly RightSidebarTabDefinition[];
}>): readonly RightSidebarMobileProjectionEntry[] {
    return Object.freeze(input.tabs.flatMap((tab): readonly RightSidebarMobileProjectionEntry[] => {
        if (tab.disabledReason || tab.hiddenInLauncher) {
            return [];
        }
        const surface = resolveRightSidebarMobileSurface(tab, input.scope);
        if (!surface) {
            return [];
        }
        return [Object.freeze({
            tabId: tab.id,
            surface,
            owner: tab.owner,
            tab,
        })];
    }));
}

export function resolveRightSidebarTabIdForMobileSurface(input: Readonly<{
    scope: RightSidebarScope;
    surface: RightSidebarMobileSurface;
    tabs: readonly RightSidebarTabDefinition[];
}>): string | null {
    // Route/selection resolution consumes the complete catalog, including a
    // companion whose launcher is temporarily hidden by the active full page.
    return input.tabs.find((tab) => !tab.disabledReason
        && resolveRightSidebarMobileSurface(tab, input.scope) === input.surface)?.id ?? null;
}
