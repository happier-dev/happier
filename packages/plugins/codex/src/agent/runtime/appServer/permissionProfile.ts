import type { CodexAppServerPolicy } from './runtime.js';

import {
  isCodexAppServerInvalidParamsForFieldError,
  isCodexAppServerMethodNotFoundError,
} from './compatibility.js';

export type CodexAppServerPermissionProfileId = ':read-only' | ':workspace' | ':danger-no-sandbox';
export type CodexAppServerPermissionSupport = 'unknown' | 'supported' | 'legacy';
export type CodexAppServerPermissionTarget = 'thread' | 'turn';

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function resolveCodexAppServerPermissionProfileId(
  policy: CodexAppServerPolicy,
): CodexAppServerPermissionProfileId | null {
  const sandbox = readString(policy.sandbox);
  if (sandbox === 'read-only') return ':read-only';
  if (sandbox === 'workspace-write') return ':workspace';
  if (sandbox === 'danger-full-access') return ':danger-no-sandbox';

  const sandboxPolicy = readRecord(policy.sandboxPolicy);
  const sandboxPolicyType = readString(sandboxPolicy?.type);
  if (sandboxPolicyType === 'readOnly') return ':read-only';
  if (sandboxPolicyType === 'workspaceWrite') return ':workspace';
  if (sandboxPolicyType === 'dangerFullAccess') return ':danger-no-sandbox';

  return null;
}

export function buildCodexAppServerLegacyPermissionParams(params: Readonly<{
  policy: CodexAppServerPolicy;
  target: CodexAppServerPermissionTarget;
}>): Record<string, unknown> {
  return {
    ...(params.policy.approvalPolicy !== undefined ? { approvalPolicy: params.policy.approvalPolicy } : {}),
    ...(params.policy.approvalsReviewer ? { approvalsReviewer: params.policy.approvalsReviewer } : {}),
    ...(params.target === 'thread'
      ? (params.policy.sandbox !== undefined ? { sandbox: params.policy.sandbox } : {})
      : (params.policy.sandboxPolicy !== undefined ? { sandboxPolicy: params.policy.sandboxPolicy } : {})),
  };
}

export function buildCodexAppServerPermissionParams(params: Readonly<{
  policy: CodexAppServerPolicy | null;
  support: CodexAppServerPermissionSupport;
  target: CodexAppServerPermissionTarget;
}>): Record<string, unknown> {
  if (!params.policy) return {};
  if (params.support === 'legacy') {
    return buildCodexAppServerLegacyPermissionParams({
      policy: params.policy,
      target: params.target,
    });
  }
  const id = resolveCodexAppServerPermissionProfileId(params.policy);
  return id ? { permissions: { type: 'profile', id } } : {};
}

export function shouldRetryWithoutCodexAppServerPermissionProfile(
  error: unknown,
  requestParams: Readonly<Record<string, unknown>>,
): boolean {
  return Object.prototype.hasOwnProperty.call(requestParams, 'permissions')
    && (
      isCodexAppServerMethodNotFoundError(error)
      || isCodexAppServerInvalidParamsForFieldError(error, 'permissions')
    );
}
