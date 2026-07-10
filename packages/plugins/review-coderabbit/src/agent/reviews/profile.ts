import type { PluginManifestV2 } from '@happier-dev/plugin-sdk';

type ExecutionRunProfileContribution = NonNullable<
  NonNullable<PluginManifestV2['contributes']>['executionRunProfiles']
>[number];

export function createCodeRabbitReviewExecutionProfile() {
  return {
    id: 'coderabbit.review',
    kind: 'executionRun.profile',
    version: '1',
    intent: 'review',
    displayKey: 'plugins.coderabbit.executionRuns.review.label',
    actionIds: ['review.start'],
  } satisfies ExecutionRunProfileContribution;
}
