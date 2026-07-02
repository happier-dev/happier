import type { ExecutionRunIntent } from '@happier-dev/protocol';

import type { ExecutionRunManagerStartParams } from '@/agent/runtime/bridges/executionRun/executionRunTypes';

type ExecutionRunRetentionPolicy = ExecutionRunManagerStartParams['retentionPolicy'];
type ExecutionRunClass = ExecutionRunManagerStartParams['runClass'];
type ExecutionRunIoMode = ExecutionRunManagerStartParams['ioMode'];

export type ExecutionRunIntentPolicyConstraint = Readonly<{
  allowedRetentionPolicies: readonly ExecutionRunRetentionPolicy[];
  allowedRunClasses: readonly ExecutionRunClass[];
  allowedIoModes: readonly ExecutionRunIoMode[];
  invariant: string;
}>;

export const EXECUTION_RUN_INTENT_POLICY_MATRIX: Readonly<Record<ExecutionRunIntent, ExecutionRunIntentPolicyConstraint>> = Object.freeze({
  review: {
    allowedRetentionPolicies: ['ephemeral', 'resumable'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep review structured-output semantics and follow-up action behavior.',
  },
  plan: {
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep plan structured-output semantics and bounded profile behavior.',
  },
  delegate: {
    allowedRetentionPolicies: ['ephemeral', 'resumable'],
    allowedRunClasses: ['bounded', 'long_lived'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep delegate structured-output behavior and long-lived steering semantics.',
  },
  voice_agent: {
    allowedRetentionPolicies: ['resumable'],
    allowedRunClasses: ['long_lived'],
    allowedIoModes: ['streaming'],
    invariant: 'Keep voice-specific long-lived streaming lifecycle and action semantics.',
  },
  memory_hints: {
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response'],
    invariant: 'Keep memory_hints constrained/internal with safe permission behavior.',
  },
  scm_commit_message: {
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response'],
    invariant: 'Keep SCM commit-message generation read-only and execution-run-owned.',
  },
  scm_diff_summary: {
    allowedRetentionPolicies: ['ephemeral'],
    allowedRunClasses: ['bounded'],
    allowedIoModes: ['request_response', 'streaming'],
    invariant: 'Keep SCM diff-summary generation read-only and execution-run-owned.',
  },
});
