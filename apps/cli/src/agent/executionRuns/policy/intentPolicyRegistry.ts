import type {
  ExecutionRunClass,
  ExecutionRunIntent,
  ExecutionRunIoMode,
  ExecutionRunRetentionPolicy,
  FeatureId,
} from '@happier-dev/protocol';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

import {
  executionRunStartNotAllowed,
  type ExecutionRunIntentStartPreflightParams,
  type ExecutionRunStartIntentPolicyResult,
} from './executionRunStartPreflight';
import { EXECUTION_RUN_INTENT_POLICY_MATRIX } from './executionRunIntentPolicyMatrix';

export type ExecutionRunIntentPermissionModePolicy = 'safe_only' | 'permissive';

export type ExecutionRunIntentPolicy = Readonly<{
  intent: ExecutionRunIntent;
  permissionModePolicy: ExecutionRunIntentPermissionModePolicy;
  allowedRetentionPolicies: readonly ExecutionRunRetentionPolicy[];
  allowedRunClasses: readonly ExecutionRunClass[];
  allowedIoModes: readonly ExecutionRunIoMode[];
  usesReviewBoundedTimeoutOverride: boolean;
  requiredFeatureId?: FeatureId;
  startPreflight?: (params: ExecutionRunIntentStartPreflightParams) => Promise<ExecutionRunStartIntentPolicyResult>;
}>;

const PERMISSION_MODE_POLICY_BY_INTENT: Readonly<Record<ExecutionRunIntent, ExecutionRunIntentPermissionModePolicy>> = {
  review: 'safe_only',
  plan: 'safe_only',
  delegate: 'permissive',
  voice_agent: 'safe_only',
  memory_hints: 'safe_only',
  scm_commit_message: 'safe_only',
  scm_diff_summary: 'safe_only',
};

function notAllowed(error: string): ExecutionRunStartIntentPolicyResult {
  return executionRunStartNotAllowed(error);
}

export const EXECUTION_RUN_INTENT_POLICY_REGISTRY: Readonly<Record<ExecutionRunIntent, ExecutionRunIntentPolicy>> = Object.freeze(
  Object.fromEntries(
    (Object.keys(EXECUTION_RUN_INTENT_POLICY_MATRIX) as ExecutionRunIntent[]).map((intent) => {
      const matrix = EXECUTION_RUN_INTENT_POLICY_MATRIX[intent];
      const policy: ExecutionRunIntentPolicy = {
        intent,
        permissionModePolicy: PERMISSION_MODE_POLICY_BY_INTENT[intent],
        allowedRetentionPolicies: matrix.allowedRetentionPolicies,
        allowedRunClasses: matrix.allowedRunClasses,
        allowedIoModes: matrix.allowedIoModes,
        usesReviewBoundedTimeoutOverride: intent === 'review',
        ...(intent === 'voice_agent' ? { requiredFeatureId: 'voice.agent' as const } : {}),
      };
      return [intent, policy];
    }),
  ) as Record<ExecutionRunIntent, ExecutionRunIntentPolicy>,
);

export function resolveExecutionRunIntentPolicy(intent: ExecutionRunIntent): ExecutionRunIntentPolicy {
  return EXECUTION_RUN_INTENT_POLICY_REGISTRY[intent];
}

export function resolveExecutionRunStartBoundedTimeoutMs(args: Readonly<{
  policy: Readonly<{
    boundedTimeoutMs?: number | null;
    reviewBoundedTimeoutMs?: number | null;
  }>;
  intent: ExecutionRunIntent;
}>): number | null {
  const intentPolicy = resolveExecutionRunIntentPolicy(args.intent);
  if (intentPolicy.usesReviewBoundedTimeoutOverride && typeof args.policy.reviewBoundedTimeoutMs === 'number') {
    return args.policy.reviewBoundedTimeoutMs;
  }
  return typeof args.policy.boundedTimeoutMs === 'number' ? args.policy.boundedTimeoutMs : null;
}

export function isSafePermissionModeForIntent(intent: ExecutionRunIntent, permissionModeRaw: string): boolean {
  const raw = permissionModeRaw.trim().toLowerCase();
  const mode =
    raw === 'no_tools' || raw === 'read_only' || raw === 'workspace_write'
      ? raw
      : parsePermissionIntentAlias(raw);
  if (resolveExecutionRunIntentPolicy(intent).permissionModePolicy === 'safe_only') {
    return mode === 'no_tools' || mode === 'read_only' || mode === 'read-only';
  }
  return true;
}

export function validateExecutionRunStartIntentPolicy(args: Readonly<{
  intent: ExecutionRunIntent;
  permissionMode: string;
  retentionPolicy: ExecutionRunRetentionPolicy;
  runClass: ExecutionRunClass;
  ioMode: ExecutionRunIoMode;
}>): ExecutionRunStartIntentPolicyResult {
  const policy = resolveExecutionRunIntentPolicy(args.intent);

  if (!policy.allowedRetentionPolicies.includes(args.retentionPolicy)) {
    return notAllowed('Unsupported retentionPolicy');
  }
  if (!policy.allowedRunClasses.includes(args.runClass)) {
    return notAllowed('Unsupported runClass');
  }
  if (!policy.allowedIoModes.includes(args.ioMode)) {
    return notAllowed('Unsupported ioMode');
  }
  if (!isSafePermissionModeForIntent(args.intent, args.permissionMode)) {
    return { ok: false, error: 'Permission denied', errorCode: 'permission_denied' };
  }

  return { ok: true };
}
