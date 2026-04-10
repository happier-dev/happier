import * as React from 'react';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { HappyError } from '@/utils/errors/errors';
import { getUsageForPeriod } from '@/sync/api/account/apiUsage';
import { buildUsageAnalyticsSummaryViewModel, type UsageAnalyticsSummaryViewModel } from '@/sync/api/account/usageAnalytics';
import { t } from '@/text';

type UseUsageAnalyticsSummaryResult = Readonly<{
    summary: UsageAnalyticsSummaryViewModel | null;
    isLoading: boolean;
    errorMessage: string | null;
}>;

export function resolveUsageSummaryErrorMessage(error: unknown): string {
    if (error instanceof HappyError) {
        return error.message;
    }
    return t('errors.unknownError');
}

export function useUsageAnalyticsSummary(
    credentials: AuthCredentials | null,
    enabled: boolean,
): UseUsageAnalyticsSummaryResult {
    const [summary, setSummary] = React.useState<UsageAnalyticsSummaryViewModel | null>(null);
    const [isLoading, setIsLoading] = React.useState(false);
    const [errorMessage, setErrorMessage] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        async function loadSummary() {
            if (!enabled || !credentials) {
                if (!cancelled) {
                    setSummary(null);
                    setErrorMessage(null);
                    setIsLoading(false);
                }
                return;
            }

            setIsLoading(true);

            try {
                const response = await getUsageForPeriod(credentials, '30days');
                if (cancelled) {
                    return;
                }

                setSummary(buildUsageAnalyticsSummaryViewModel(response));
                setErrorMessage(null);
            } catch (error) {
                if (cancelled) {
                    return;
                }

                setErrorMessage(resolveUsageSummaryErrorMessage(error));
                setSummary(null);
            } finally {
                if (!cancelled) {
                    setIsLoading(false);
                }
            }
        }

        void loadSummary();

        return () => {
            cancelled = true;
        };
    }, [credentials, enabled]);

    return {
        summary,
        isLoading,
        errorMessage,
    };
}
