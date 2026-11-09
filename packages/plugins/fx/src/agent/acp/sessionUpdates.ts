import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : null;
}

function nonblank(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export const FX_SESSION_UPDATES = {
  // Temporary upstream equivalences until fx#1335 emits ACP v1 spellings.
  projectStopReason(stopReason: string) {
    switch (stopReason) {
      case 'max_output_tokens': return 'max_tokens' as const;
      case 'max_model_turns': return 'max_turn_requests' as const;
      case 'refused': return 'refusal' as const;
      default: return null;
    }
  },
  project(update: JsonValue) {
    const input = record(update);
    const native = record(record(input?._meta)?.fx);
    if (!input || !native) return null;
    if (input.sessionUpdate === 'tool_call' || input.sessionUpdate === 'tool_call_update') {
      const toolCall = record(native.toolCall);
      if (!toolCall) return null;
      const mcp = record(toolCall.mcp);
      const toolMetadata = {
        ...(typeof toolCall.internal === 'boolean' ? { internal: toolCall.internal } : {}),
        ...(mcp && nonblank(mcp.server) && nonblank(mcp.tool)
          ? { mcp: { server: mcp.server, tool: mcp.tool } } : {}),
      };
      return Object.keys(toolMetadata).length ? { toolMetadata } : null;
    }
    if (input.sessionUpdate !== 'session_info_update'
      || !Object.prototype.hasOwnProperty.call(native, 'modelResponseRecovery')) return null;
    const recovery = native.modelResponseRecovery;
    const status = record(recovery);
    const state = recovery === null ? 'cleared' : status?.state;
    if (state !== 'active' && state !== 'paused' && state !== 'recovered'
      && state !== 'failed' && state !== 'cleared') return null;
    const details: Record<string, JsonValue> = { state };
    for (const key of ['kind', 'cause', 'action', 'requiredAction'] as const) {
      if (nonblank(status?.[key])) details[key] = status[key];
    }
    for (const key of ['attempt', 'attemptLimit', 'delaySeconds'] as const) {
      const value = status?.[key];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) details[key] = value;
    }
    const labels = {
      active: 'The model provider is recovering this response.',
      paused: 'Model response recovery is paused.',
      recovered: 'The model response recovered.',
      failed: 'Model response recovery failed.',
      cleared: 'Model response recovery cleared.',
    };
    const attempt = status?.attempt;
    const retry = state === 'active' && typeof attempt === 'number'
      && Number.isSafeInteger(attempt) && attempt > 0
      ? { attempt, reason: status?.cause === 'rate_limit' ? 'rate_limited' as const : 'unknown' as const }
      : undefined;
    return {
      ...(retry ? { retry } : state === 'recovered' || state === 'cleared' ? { retry: null } : {}),
      diagnostic: {
        code: state === 'active' ? 'provider_retry' : `provider_recovery_${state}`,
        severity: state === 'failed' ? 'error' as const : state === 'paused' ? 'warning' as const : 'info' as const,
        message: nonblank(status?.message) ? status.message : labels[state],
        details,
      },
    };
  },
} satisfies NonNullable<AgentAcpRuntimeDefinition['sessionUpdates']>;
