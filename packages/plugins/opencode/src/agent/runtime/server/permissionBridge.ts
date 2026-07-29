import {
  AgentRuntimeJsonValueSchema,
} from '@happier-dev/plugin-sdk/agent-runtime';
import type {
  PluginUiApprovalRequest,
  PluginUiApprovalResult,
} from '@happier-dev/plugin-sdk/runtime';

import type { OpenCodeServerPermissionReply } from './openCodeServerClient.js';
import { asRecord, normalizeString } from './openCodeParsing.js';

export type OpenCodePermissionAsk = Readonly<{
  requestId: string;
  providerSessionId: string | null;
  permission: string;
  patterns: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

function readUniqueNonBlankString(values: readonly unknown[]): string | null {
  const defined = values.filter((value) => value !== undefined);
  if (defined.length === 0) return null;
  const normalized = defined.map((value) => normalizeString(value));
  if (normalized.some((value) => value.length === 0)) return null;
  const unique = [...new Set(normalized)];
  return unique.length === 1 ? unique[0] : null;
}

export function readOpenCodePermissionRequestId(
  properties: Readonly<Record<string, unknown>>,
): string | null {
  return readUniqueNonBlankString([
    properties.id,
    properties.requestID,
    properties.requestId,
  ]);
}

export function readOpenCodePermissionAsk(
  properties: Readonly<Record<string, unknown>>,
  fallbackProviderSessionId: string | null,
): OpenCodePermissionAsk | null {
  const requestId = readOpenCodePermissionRequestId(properties);
  if (!requestId) return null;

  const action = asRecord(properties.action);
  if (properties.action !== undefined && !action) return null;
  const permission = readUniqueNonBlankString([
    properties.permission,
    action?.permission,
  ]);
  if (!permission) return null;

  let patterns: readonly string[];
  if (properties.patterns !== undefined) {
    if (!Array.isArray(properties.patterns)) return null;
    const normalized = properties.patterns.map((value) => normalizeString(value));
    if (normalized.some((value) => value.length === 0)) return null;
    const legacyPatternValues = [properties.pattern, action?.pattern]
      .filter((value) => value !== undefined);
    if (legacyPatternValues.length > 0) {
      const legacyPattern = readUniqueNonBlankString(legacyPatternValues);
      if (!legacyPattern || normalized.length !== 1 || normalized[0] !== legacyPattern) return null;
    }
    patterns = normalized;
  } else {
    const rawPatternValues = [properties.pattern, action?.pattern]
      .filter((value) => value !== undefined);
    if (rawPatternValues.length === 0) {
      patterns = [];
    } else {
      const pattern = readUniqueNonBlankString(rawPatternValues);
      if (!pattern) return null;
      patterns = [pattern];
    }
  }

  const session = asRecord(properties.session);
  if (properties.session !== undefined && !session) return null;
  const explicitProviderSessionId = readUniqueNonBlankString([
    properties.sessionID,
    session?.id,
    ...(fallbackProviderSessionId === null ? [] : [fallbackProviderSessionId]),
  ]);
  if (
    (properties.sessionID !== undefined
      || session?.id !== undefined
      || fallbackProviderSessionId !== null)
    && !explicitProviderSessionId
  ) return null;
  const providerSessionId = explicitProviderSessionId ?? null;

  const metadata = properties.metadata === undefined
    ? undefined
    : asRecord(properties.metadata);
  if (properties.metadata !== undefined && !metadata) return null;

  return {
    requestId,
    providerSessionId,
    permission,
    patterns,
    ...(metadata ? { metadata } : {}),
  };
}

export function buildOpenCodePermissionApprovalRequest(
  ask: OpenCodePermissionAsk,
): PluginUiApprovalRequest {
  const toolName = ask.permission;
  return {
    title: `Allow OpenCode to use ${toolName}?`,
    description: `OpenCode requested permission to use ${toolName}.`,
    subject: {
      kind: 'tool',
      name: toolName,
      input: AgentRuntimeJsonValueSchema.parse({
        providerSessionId: ask.providerSessionId,
        permission: ask.permission,
        patterns: ask.patterns,
        ...(ask.metadata ? { metadata: ask.metadata } : {}),
      }),
    },
    allowSessionPersistence: true,
  };
}

export function mapOpenCodeApprovalResultToReply(
  result: PluginUiApprovalResult,
): OpenCodeServerPermissionReply {
  if (result.status === 'approved') {
    return result.persistence === 'session' ? 'always' : 'once';
  }
  return 'reject';
}

export function readOpenCodeApprovalReplyMessage(
  result: PluginUiApprovalResult,
): string | null {
  if (result.status === 'denied') return normalizeString(result.rationale) || null;
  if (result.status === 'cancelled') {
    return normalizeString(result.diagnostic?.message) || null;
  }
  if (result.status === 'unavailable') {
    return normalizeString(result.diagnostic.message) || null;
  }
  return null;
}
