// Cross-app tests execute these real owners with importer-relative UI aliases.
export { createScmDiffSummaryResultOperations } from '@/sync/ops/scmDiffSummary/results';
export { createUiAccountActionTransport } from '@/sync/ops/actions/accountActionTransport';
export { resolveExecutionRunVisibleMessages } from '@/sync/domains/session/subagents/visibleMessages/resolveSessionSubagentVisibleMessages';
export { resolvePendingMessageContentPresentation } from '@/components/sessions/pending/pendingMessageVisualState';
export { createPendingMessageFixture } from '@/dev/testkit/fixtures/transcriptFixtures';
