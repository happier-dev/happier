import type {
  SessionPermissionDecisionRequestV1,
  SessionPermissionDecisionResultV1,
} from '@happier-dev/plugin-sdk';

import type { OpenCodeServerPermissionReply } from './openCodeServerClient.js';
import { asRecord, normalizeString } from './openCodeParsing.js';

export type OpenCodePermissionAsk = Readonly<{
  requestId: string;
  providerSessionId: string | null;
  permission: string;
  patterns: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

export function readOpenCodePermissionAsk(
  properties: Readonly<Record<string, unknown>>,
  fallbackProviderSessionId: string | null,
): OpenCodePermissionAsk | null {
  const requestId = normalizeString(properties.id)
    || normalizeString(properties.requestID)
    || normalizeString(properties.requestId);
  if (!requestId) return null;

  const action = asRecord(properties.action);
  const permission = normalizeString(properties.permission)
    || normalizeString(action?.permission);
  const rawPatterns = Array.isArray(properties.patterns)
    ? properties.patterns
    : [properties.pattern ?? action?.pattern];
  const patterns = rawPatterns
    .map((value) => normalizeString(value))
    .filter((value) => value.length > 0);
  const providerSessionId = normalizeString(properties.sessionID)
    || normalizeString(asRecord(properties.session)?.id)
    || fallbackProviderSessionId
    || null;
  const metadata = asRecord(properties.metadata) ?? undefined;

  return {
    requestId,
    providerSessionId,
    permission,
    patterns,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildOpenCodePermissionDecisionRequest(
  ask: OpenCodePermissionAsk,
): SessionPermissionDecisionRequestV1 {
  return {
    provider: 'opencode',
    requestId: ask.requestId,
    toolName: ask.permission || 'opencode_permission',
    input: {
      providerSessionId: ask.providerSessionId,
      permission: ask.permission,
      patterns: ask.patterns,
      ...(ask.metadata ? { metadata: ask.metadata } : {}),
    },
  };
}

export function mapOpenCodePermissionDecisionToReply(
  result: SessionPermissionDecisionResultV1,
): OpenCodeServerPermissionReply {
  if (result.decision === 'approved_for_session'
    || result.decision === 'approved_execpolicy_amendment'
    || result.persistAllowRule
    || (result.updatedPermissions?.length ?? 0) > 0
  ) {
    return 'always';
  }
  if (result.decision === 'approved') return 'once';
  return 'reject';
}

export function readOpenCodePermissionReplyMessage(
  result: SessionPermissionDecisionResultV1,
): string | null {
  return normalizeString(result.rationale) || null;
}
