import React from 'react';
import { useLocalSearchParams, useRouter } from '@/components/appShell/workspace/destinationRoute';
import { UsageWidgetPage } from '@/components/settings/usage/UsageWidgetPage';
import { buildUsageRouteParams, resolveUsagePageInitialFilters } from '@/components/settings/usage/usageRouteParams';
import { useSessionCockpitPageBottomClearance } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

export function UsageSettingsScreen() {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const router = useRouter();
    const contentBottomInset = useSessionCockpitPageBottomClearance();
    const initialFilters = React.useMemo(() => resolveUsagePageInitialFilters(params), [
        params.period,
        params.metric,
        params.costMode,
        params.focusDimension,
        params.focusKey,
        params.focusLabel,
        params.scope,
        params.layoutId,
        params.queryOverrides,
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
