/**
 * Compatibility import for CLI-local consumers. Blocking approval decision
 * coordination is process-local host plumbing shared by CLI and UI, so its
 * canonical implementation lives with the Action executor contract.
 */
export { createBlockingApprovalCoordinator, getSharedBlockingApprovalCoordinator } from '@happier-dev/protocol/actions/blockingApprovalCoordinator';
export type { BlockingApprovalCoordinator, BlockingApprovalRequest, BlockingApprovalWaitDecision } from '@happier-dev/protocol';
