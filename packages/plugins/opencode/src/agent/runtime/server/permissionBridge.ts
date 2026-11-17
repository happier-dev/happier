import {
  AgentRuntimeJsonValueSchema,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
  InteractionTransientApprovalAuthorRequestV1,
  InteractionTransientApprovalResultV1,
} from '@happier-dev/plugin-sdk/interactions';

import type { OpenCodeServerPermissionReply } from './openCodeServerClient.js';
import { asRecord, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
import { canonicalizeOpenCodeProjectedMcpToolName, type OpenCodeSessionMcpProjection } from './mcpRegistration.js';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

export type OpenCodePermissionAsk = Readonly<{
  requestId: string;
  providerSessionId: string | null;
  permission: string;
  patterns: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}>;

/**
 * The one value every alias of a provider-authored field agrees on.
 *
 * Every field read through here -- the request id, the owning session id, the
 * permission name and its patterns -- is authored by OpenCode and handed back
 * to OpenCode, so agreement is decided on exact bytes and the accepted value is
 * never re-minted. Two aliases that differ only in whitespace are a genuine
 * disagreement, and the caller fails closed on it.
 */
function readUniqueNonBlankString(values: readonly unknown[]): string | null {
  const defined = values.filter((value) => value !== undefined);
  if (defined.length === 0) return null;
  const admitted = defined.map((value) => readNonBlankOpaqueIdentifier(value));
  if (admitted.some((value) => value === null)) return null;
  const unique = [...new Set(admitted)];
  return unique.length === 1 ? unique[0] ?? null : null;
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
    const normalized = properties.patterns.map((value) => readNonBlankOpaqueIdentifier(value) ?? '');
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
  mcpProjection?: OpenCodeSessionMcpProjection,
  policy?: AgentSessionOpenRequest['mcpToolPolicy'],
  resolvedToolName?: string,
): InteractionTransientApprovalAuthorRequestV1 {
  const toolName = resolvedToolName ?? (mcpProjection ? canonicalizeOpenCodeProjectedMcpToolName(ask.permission, mcpProjection, policy) : ask.permission);
  return {
    kind: 'approval',
    title: `Allow OpenCode to use ${toolName}?`,
    description: `OpenCode requested permission to use ${toolName}.`,
    subject: {
      kind: 'tool',
      name: toolName,
      // The native permission envelope owns routing and reply identity. Host
      // tool policy and presentation consume its operands, not that envelope.
      input: AgentRuntimeJsonValueSchema.parse(ask.metadata ?? { patterns: ask.patterns }),
    },
    allowSessionPersistence: true,
    nativeChoices: {
      requirementId: ask.requestId,
      source: 'opencode',
      choices: [
        { id: 'allow', label: 'Allow once', decision: 'approved', scope: 'once', response: { approved: true, decision: 'approved' } },
        { id: 'allow_session', label: 'Allow for this session', decision: 'approved_for_session', scope: 'session',
          response: { approved: true, decision: 'approved_for_session', allowedTools: [toolName] } },
        { id: 'deny', label: 'Deny', decision: 'denied', scope: 'once', response: { approved: false, decision: 'denied' } },
        { id: 'stop', label: 'Stop', decision: 'abort', scope: 'once', response: { approved: false, decision: 'abort' } },
      ],
    },
  };
}

export function mapOpenCodeApprovalResultToReply(
  result: InteractionTransientApprovalResultV1,
  isMcpTool = false,
): OpenCodeServerPermissionReply {
  if (result.status === 'approved') {
    return result.persistence === 'session' && !isMcpTool ? 'always' : 'once';
  }
  return 'reject';
}

export function readOpenCodeApprovalReplyMessage(
  _result: InteractionTransientApprovalResultV1,
): string | null {
  return null;
}
