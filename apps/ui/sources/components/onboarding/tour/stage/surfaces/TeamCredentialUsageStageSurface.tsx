import * as React from 'react';

import { TeamSectionPageHeader } from '@/components/settings/teams/TeamSection';
import { TeamCredentialUsageSummary } from '@/components/settings/teams/credentials/TeamCredentialUsageScreen';
import { useUsageSeriesMotion } from '@/components/settings/usage/usageSeriesPresentation';
import { ItemList } from '@/components/ui/lists/ItemList';
import { getDemoModeServerId } from '@/demoMode/runtime/enterExitDemoMode';
import { buildDemoTeam } from '@/demoMode/world/team';
import { buildDemoTeamCredentialUsage } from '@/demoMode/world/teamCredentialUsage';
import { resolveUsageMeasuredTokens } from '@/sync/api/account/usageMeasuredTokens';
import { t } from '@/text';

/** Production usage totals and chart over fictional, non-sensitive aggregate facts. */
export function TeamCredentialUsageStageSurface(): React.ReactElement {
    const [team] = React.useState(() => buildDemoTeam(getDemoModeServerId() ?? 'demo-home'));
    const [result] = React.useState(buildDemoTeamCredentialUsage);
    const [showSeriesList, setShowSeriesList] = React.useState(false);
    const seriesMotion = useUsageSeriesMotion(result.series.length);
    const series = React.useMemo(() => result.series.map(bucket => ({
        timestamp: Math.floor(bucket.bucketStartMs / 1000),
        tokens: resolveUsageMeasuredTokens(bucket.totals.tokens).total, cost: bucket.totals.cost.reportedUsd,
        requests: bucket.totals.requestCount, reportCount: bucket.totals.eventCount,
    })), [result]);
    return <ItemList>
        <TeamSectionPageHeader title={t('teams.credentials.usage.title')}
            description={t('teams.pages.credentialUsageTeam')} alwaysShowTitle={false}
            teamName={team.context.team.name} homeName={team.context.homeName} />
        <TeamCredentialUsageSummary result={result} period="7days" costMode="reported"
            showRequests completeness={t('teams.credentials.usage.recordedByHappier')}
            costUsd={result.totals.cost.reportedUsd} series={series}
            chartMetrics={['requests', 'tokens', 'cost']} selectedMetric="tokens"
            seriesMotion={seriesMotion} showSeriesList={showSeriesList}
            onToggleSeriesList={() => setShowSeriesList(current => !current)}
            refreshing={false} onRefresh={() => {}} />
    </ItemList>;
}
