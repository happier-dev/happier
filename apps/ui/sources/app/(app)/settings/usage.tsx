import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { buildUsageRouteParams, resolveUsagePanelInitialFilters } from '@/components/settings/usage/usageRouteParams';

export default function UsageSettingsScreen() {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const router = useRouter();
    const initialFilters = React.useMemo(() => resolveUsagePanelInitialFilters(params), [
        params.period,
        params.metric,
        params.costMode,
        params.focusDimension,
        params.focusKey,
        params.focusLabel,
    ]);
    const handleFiltersChange = React.useCallback((filters: Parameters<typeof buildUsageRouteParams>[0]) => {
        router.setParams(buildUsageRouteParams(filters));
    }, [router]);

    return (
        <UsagePanel
            initialFilters={initialFilters}
            onFiltersChange={handleFiltersChange}
        />
    );
}
