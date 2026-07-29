import React from 'react';
import { Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { UsagePanel } from '@/components/settings/usage/UsagePanel';
import { buildUsageRouteParams, resolveUsagePanelInitialFilters } from '@/components/settings/usage/usageRouteParams';
import { resolveFloatingTabBarBottomPadding } from '@/components/ui/navigation/floatingTabBarBottomInset';

// Clears the floating bottom nav (its pill height above its own bottom padding)
// so the usage footer is never overlapped on the full-page route (D-R2-10).
const FLOATING_TAB_BAR_PILL_CLEARANCE = 64;

export default function UsageSettingsScreen() {
    const params = useLocalSearchParams() as Record<string, string | string[] | undefined>;
    const router = useRouter();
    const insets = useSafeAreaInsets();
    const contentBottomInset = resolveFloatingTabBarBottomPadding(insets.bottom, Platform.OS === 'ios')
        + FLOATING_TAB_BAR_PILL_CLEARANCE;
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
            contentBottomInset={contentBottomInset}
        />
    );
}
