import type { PromptResponse, StopReason } from '@agentclientprotocol/sdk';
import { RequestError } from '@agentclientprotocol/sdk';

import type { AcpExtensionHandlers } from '@/agent/acp/AcpBackend';
import { defineAcpExtensionNotification } from '@/agent/acp/connection/types';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { formatErrorForUi } from '@/ui/formatErrorForUi';
import { classifyProviderLimitEvidence, parseProviderResetAt } from '@/daemon/connectedServices/quotas/normalization';

export const GROK_PROMPT_COMPLETE_METHODS = [
  'x.ai/session/prompt_complete',
  '_x.ai/session/prompt_complete',
] as const;

type GrokPromptCompleteParams = Readonly<{
  sessionId: string;
  promptId: string;
  stopReason?: string;
  agentResult?: unknown;
}>;

const STANDARD_STOP_REASONS: ReadonlySet<string> = new Set<StopReason>([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

const grokPromptCompleteParamsParser = {
  parse(value: unknown): GrokPromptCompleteParams {
    const record = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const sessionId = readNonBlankOpaqueIdentifier(record?.sessionId);
    const promptId = readNonBlankOpaqueIdentifier(record?.promptId);
    if (!sessionId || !promptId) {
      throw RequestError.invalidParams({
        details: 'Grok prompt completion requires exact sessionId and promptId values',
      });
    }
    return {
      sessionId,
      promptId,
      ...(typeof record?.stopReason === 'string' ? { stopReason: record.stopReason } : {}),
      ...(record && Object.prototype.hasOwnProperty.call(record, 'agentResult')
        ? { agentResult: record.agentResult }
        : {}),
    };
  },
};

function buildGrokPromptCompletionError(notification: GrokPromptCompleteParams): Error {
  const summary = notification.stopReason === 'rate_limit'
    ? 'Grok prompt was rate limited'
    : notification.stopReason === 'error'
      ? 'Grok prompt failed'
      : 'Grok reported an unsupported prompt completion result';
  const detail = notification.agentResult == null
    ? ''
    : formatErrorForUi(notification.agentResult, { maxChars: 1_000 }).trim();
  const error = new Error(detail ? `${summary}: ${detail}` : summary);
  const result = notification.agentResult && typeof notification.agentResult === 'object' && !Array.isArray(notification.agentResult)
    ? notification.agentResult as Record<string, unknown>
    : null;
  const limitCategory = notification.stopReason === 'rate_limit'
    ? 'rate_limit'
    : classifyProviderLimitEvidence(notification.agentResult);
  if (limitCategory !== 'rate_limit' && limitCategory !== 'usage_limit') return error;
  return Object.assign(error, {
    code: limitCategory === 'rate_limit' ? 'rate_limit' : 'usage_limit_reached',
    data: { limitCategory, ...parseProviderResetAt({ body: notification.agentResult, headers: result?.headers, nowMs: Date.now() }) },
  });
}

function toPromptCompletionOutcome(notification: GrokPromptCompleteParams):
  | Readonly<{ kind: 'completed'; response: PromptResponse }>
  | Readonly<{ kind: 'failed'; error: Error }> {
  if (notification.stopReason === 'error' || notification.stopReason === 'rate_limit') {
    return { kind: 'failed', error: buildGrokPromptCompletionError(notification) };
  }
  if (
    notification.stopReason !== undefined
    && !STANDARD_STOP_REASONS.has(notification.stopReason)
  ) {
    return { kind: 'failed', error: buildGrokPromptCompletionError(notification) };
  }
  const stopReason = (notification.stopReason ?? 'end_turn') as StopReason;
  return {
    kind: 'completed',
    response: {
      stopReason,
      _meta: {
        sessionId: notification.sessionId,
        promptId: notification.promptId,
        requestId: notification.promptId,
      },
    },
  };
}

export function buildGrokPromptCompletionRequestMeta(params: Readonly<{
  correlationId: string;
}>): Readonly<Record<string, unknown>> {
  return {
    promptId: params.correlationId,
    requestId: params.correlationId,
  };
}

export function buildGrokPromptCompletionHandlers(): AcpExtensionHandlers {
  return GROK_PROMPT_COMPLETE_METHODS.map((method) => defineAcpExtensionNotification({
    method,
    params: grokPromptCompleteParamsParser,
    handler: (notification, context) => {
      if (notification.sessionId !== context.sessionId) return;
      context.promptCompletion?.settle({
        correlationId: notification.promptId,
        outcome: toPromptCompletionOutcome(notification),
      });
    },
  }));
}
