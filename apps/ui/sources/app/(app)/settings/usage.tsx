import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { UsageWidgetPage } from '@/components/settings/usage/UsageWidgetPage';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from '@/components/settings/usage/usageRouteParams';
import { resolveFloatingTabBarBottomPadding } from '@/components/ui/navigation/floatingTabBarBottomInset';

// Clears the floating bottom nav (its pill height above its own bottom padding)
// so the usage footer is never overlapped on the full-page route (D-R2-10).
const FLOATING_TAB_BAR_PILL_CLEARANCE = 64;

export function UsageSettingsScreen() {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const contentBottomInset = resolveFloatingTabBarBottomPadding(insets.bottom, Platform.OS === 'ios')
        + FLOATING_TAB_BAR_PILL_CLEARANCE;
    const initialFilters = React.useMemo(() => resolveUsagePageInitialFilters(params), [
        params.period,
        params.metric,
        params.costMode,
        params.focusDimension,
        params.focusKey,
        params.focusLabel,
        params.scope,
        params.layoutId,
    ]);
    // Each writer sets only the params it owns: filters never clear the selected view, and back.
    const handleFiltersChange = React.useCallback((filters: Parameters<typeof buildUsageRouteParams>[0]) => {
        const { layoutId: _layoutId, ...owned } = buildUsageRouteParams(filters);
        router.setParams(owned);
    }, [router]);
    const handleLayoutChange = React.useCallback((layoutId: string) => {
        router.setParams({ layoutId });
    }, [router]);

    return (
        <UsageWidgetPage
            initialFilters={initialFilters}
            onFiltersChange={handleFiltersChange}
            onLayoutChange={handleLayoutChange}
            contentBottomInset={contentBottomInset}
        />
    );
}
import { WorkspaceRouteEntry } from '@/components/appShell/workspace/createWorkspaceRouteEntry';
export { UsageSettingsScreen as WorkspaceRouteBody };
export default function RouteEntry() { return <WorkspaceRouteEntry Body={UsageSettingsScreen} />; }
