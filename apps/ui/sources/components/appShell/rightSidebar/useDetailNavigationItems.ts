import * as React from 'react';
import { resolveDetailNavigationItems, type DetailNavigationItem } from './detailNavigationItems';
import type { ResolveRightSidebarTabsInput } from './rightSidebarTabRegistry';
import { retainKeyedRows } from '@/sync/domains/state/structuralSharing';

/** Scope facts change the admitted list; placement, body updates and layout width do not. */
export const DetailNavigationItemsContext = React.createContext<Readonly<{
    scopeId: string;
    items: readonly DetailNavigationItem[];
    /** The inputs behind `items`, read only when Customize resolves another device's list through the same owner. */
    input?: ResolveRightSidebarTabsInput;
}> | null>(null);

/**
 * Reuses the enclosing Session's list when it was resolved for the same presentation; a desktop body
 * inside the phone navigator resolves its own, since arrangement and device decide pages and tools.
 */
export function useDetailNavigationItems(input: ResolveRightSidebarTabsInput, enclosing?: Readonly<{ items: readonly DetailNavigationItem[]; input?: ResolveRightSidebarTabsInput }>) {
    const previous = React.useRef<readonly DetailNavigationItem[] | undefined>(undefined);
    const presentation = input.presentation ?? 'desktop';
    // Arrangement only shapes desktop items (Editor first), so a phone body reuses the phone list as is.
    const inheritedItems = enclosing && (enclosing.input?.presentation ?? 'desktop') === presentation
        && (presentation === 'mobile' || enclosing.input?.arrangement === input.arrangement) ? enclosing.items : undefined;
    return React.useMemo(() => {
        const items = inheritedItems ?? retainKeyedRows(previous.current, resolveDetailNavigationItems(input), item => item.id);
        previous.current = items;
        return items;
    }, [
        inheritedItems,
        input.scope, input.arrangement, input.presentation, input.activePage,
        input.terminalTabAvailable, input.computerAvailable, input.computerDisabledReason,
        input.boardFeatureEnabled, input.browserFeatureEnabled, input.sessionSharingAvailable, input.sourceControlTabAvailable,
        input.sessionProjectCheckoutAvailable, input.codeIntelligenceAvailable,
        input.pluginPlacements, input.policyContext, input.runtimeAdmission, input.localize,
        input.appPluginPlacements, input.appLocalize,
    ]);
}
