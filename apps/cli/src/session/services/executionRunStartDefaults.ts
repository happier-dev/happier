/**
 * Compatibility exports for dedicated workflow adapters. The friendly
 * execution-run command and every remaining adapter consume one Action-owned
 * default rather than maintaining parallel tables.
 */
export { defaultExecutionRunPermissionMode as defaultPermissionModeForExecutionRunIntent, defaultExecutionRunClass as defaultRunClassForExecutionRunIntent, defaultExecutionRunIoMode as defaultIoModeForExecutionRunIntent, defaultExecutionRunRetention as defaultRetentionPolicyForExecutionRunIntent } from '@happier-dev/protocol/actions/specs/executionRunCli';
