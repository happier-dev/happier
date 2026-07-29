import * as React from 'react';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import {
    buildUsageAnalyticsViewModel,
    type UsageAnalyticsViewModel,
    type UsageFilterState,
} from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';
import { useUsageAnalyticsQuery } from '@/sync/api/account/useUsageAnalyticsQuery';

type UseUsageBannerModelResult = Readonly<{
    viewModel: UsageAnalyticsViewModel | null;
    isLoading: boolean;
    errorMessage: string | null;
}>;

/**
 * Settings-home usage banner data: the widest (`year`) window through the single
 * view-model owner, so the banner reads lifetime tokens, a full-year activity
 * calendar, streaks, and leaders from one source of truth (one cached fetch).
 */
const BANNER_FILTERS: UsageFilterState = {
    period: 'year',
    metric: 'tokens',
    costMode: 'auto',
    focus: null,
};

export function resolveUsageBannerErrorMessage(error: unknown): string {
    if (error instanceof HappyError) {
        return error.message;
    }
    return t('errors.unknownError');
}

export function useUsageBannerModel(
    credentials: AuthCredentials | null,
    enabled: boolean,
): UseUsageBannerModelResult {
    const query = useUsageAnalyticsQuery({
        credentials,
        enabled,
        period: 'year',
    });
    const viewModel = React.useMemo(
        () => (query.data ? buildUsageAnalyticsViewModel(query.data, BANNER_FILTERS) : null),
        [query.data],
    );

    return {
        viewModel,
        isLoading: query.isLoading,
        errorMessage: query.error != null ? resolveUsageBannerErrorMessage(query.error) : null,
    };
}
