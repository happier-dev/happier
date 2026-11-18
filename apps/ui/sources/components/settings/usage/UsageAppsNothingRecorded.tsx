import * as React from 'react';
import { useRouter } from 'expo-router';
import { EmptyState } from '@/components/ui/empty/EmptyState';
import { SERVICES_ROUTE } from '@/components/projects/deployments/deploymentNavigation';
import { t } from '@/text';

/**
 * Your apps recorded no model call in the period (lab p7Cost-empty): the page says it once, with its scene, and the way
 * forward is the apps themselves, where an Environment's Telemetry adds recording. Starting a session is the Agents' next
 * step, never this one. The cards below keep their one quiet line (`UsageBodyNothingYet`).
 */
export function UsageAppsNothingRecorded() {
  const router = useRouter();
  const action = React.useMemo(() => ({
    label: t('usage.board.page.appsNothingAction'),
    onPress: () => router.push(SERVICES_ROUTE),
    testID: 'usage-page.appsNothingRecorded.action',
  }), [router]);
  return (
    <EmptyState
      testID="usage-page.appsNothingRecorded"
      layout="page"
      scene="searchWaiting"
      title={t('usage.board.page.appsNothingTitle')}
      subtitle={t('usage.board.page.appsNothingBody')}
      primaryAction={action}
    />
  );
}
