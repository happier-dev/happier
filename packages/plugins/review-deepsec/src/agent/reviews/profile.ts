import type { PluginManifestV2 } from '@happier-dev/plugin-sdk';

export type DeepSecReviewProfileKind = 'review' | 'repository_security_audit';

type ExecutionRunProfileContribution = NonNullable<
  NonNullable<PluginManifestV2['contributes']>['executionRunProfiles']
>[number];

export function createDeepSecReviewExecutionProfile(kind: DeepSecReviewProfileKind) {
  if (kind === 'repository_security_audit') {
    return {
      id: 'deepsec.securityReview',
      kind: 'executionRun.profile',
      version: '1',
      intent: 'review',
      displayKey: 'plugins.deepsec.executionRuns.securityReview.label',
      actionIds: ['review.start'],
    } satisfies ExecutionRunProfileContribution;
  }
  return {
    id: 'deepsec.review',
    kind: 'executionRun.profile',
    version: '1',
    intent: 'review',
    displayKey: 'plugins.deepsec.executionRuns.review.label',
    actionIds: ['review.start'],
  } satisfies ExecutionRunProfileContribution;
}
