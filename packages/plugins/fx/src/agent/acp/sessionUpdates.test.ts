import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { FX_SESSION_UPDATES } from './sessionUpdates.js';

// fx 0.0.14, 2026-10-27. Recovery vectors follow the pinned serializer
// 1a070af32cdfaf8cd0da6de3dc7f053302828b17/src/acp/types.zig:43-92;
// recovery was source-characterized, not elicited by the harmless live probe.
const info = (recovery: JsonValue) => ({ sessionUpdate: 'session_info_update',
  _meta: { fx: { modelResponseRecovery: recovery } } });

describe('fx ACP session update codec', () => {
  it('translates only equivalent upstream stop aliases, leaving yielded and future values unknown', () => {
    expect(FX_SESSION_UPDATES.projectStopReason('max_output_tokens')).toBe('max_tokens');
    expect(FX_SESSION_UPDATES.projectStopReason('max_model_turns')).toBe('max_turn_requests');
    expect(FX_SESSION_UPDATES.projectStopReason('refused')).toBe('refusal');
    expect(FX_SESSION_UPDATES.projectStopReason('yielded')).toBeNull();
    expect(FX_SESSION_UPDATES.projectStopReason('future')).toBeNull();
  });
  it.each(['active', 'paused', 'recovered', 'failed'] as const)('preserves %s recovery facts as a diagnostic without lifecycle authority', state => {
    const update = { sessionUpdate: 'session_info_update', _meta: { fx: { modelResponseRecovery: {
      state, kind: 'terminal_provider_error', cause: 'rate_limit', action: 'paused',
      requiredAction: 'retry', attempt: 2, attemptLimit: 4, delaySeconds: 3,
      durable: true, message: 'Provider recovery detail',
    } } } };
    expect(FX_SESSION_UPDATES.project(update)).toMatchObject({ diagnostic: {
      severity: state === 'failed' ? 'error' : state === 'paused' ? 'warning' : 'info',
      details: { state, attempt: 2, attemptLimit: 4, delaySeconds: 3, requiredAction: 'retry' },
    } });
  });

  it('distinguishes explicit clear from absent or malformed extension data', () => {
    expect(FX_SESSION_UPDATES.project(info(null))).toMatchObject({ diagnostic: {
      code: 'provider_recovery_cleared', details: { state: 'cleared' },
    } });
    expect(FX_SESSION_UPDATES.project({ sessionUpdate: 'session_info_update', title: 'Request to Reply OK' })).toBeNull();
    expect(FX_SESSION_UPDATES.project(info({ state: 'future' }))).toBeNull();
  });

  it('projects active recovery attempts as closed retry facts without provider prose', () => {
    expect(FX_SESSION_UPDATES.project(info({ state: 'active', attempt: 2, cause: 'rate_limit',
      message: 'Provider detail', attemptLimit: 4, delaySeconds: 3,
    }))).toHaveProperty('retry', { attempt: 2, reason: 'rate_limited' });
    expect(FX_SESSION_UPDATES.project(info({ state: 'active', attempt: 1, cause: 'future_cause' })))
      .toHaveProperty('retry', { attempt: 1, reason: 'unknown' });
    for (const attempt of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2', null]) {
      expect(FX_SESSION_UPDATES.project(info({ state: 'active', attempt, cause: 'rate_limit' })))
        .not.toHaveProperty('retry');
    }
  });

  it.each(['recovered', null] as const)('clears retry facts on recovered or explicitly cleared recovery %s', state => {
    expect(FX_SESSION_UPDATES.project(info(state === null ? null : { state, attempt: 2, cause: 'rate_limit' })))
      .toMatchObject({ retry: null });
  });

  it.each(['paused', 'failed'] as const)('preserves %s as diagnostic evidence without asserting response progress', state => {
    expect(FX_SESSION_UPDATES.project(info({ state, attempt: 2 }))).not.toHaveProperty('retry');
  });

  it('decodes explicit MCP/internal provenance independently of opaque names and call ids', () => {
    // Tool envelope: E-fx-live-probe.md §3, 2026-10-27; MCP metadata is
    // source-derived from the same build's types.zig tool serializer.
    expect(FX_SESSION_UPDATES.project({ sessionUpdate: 'tool_call', toolCallId: 'opaque',
      name: 'write_file', title: 'file_mutation', kind: 'edit',
      _meta: { fx: { toolCall: { internal: true, mcp: { server: 'docs', tool: 'read' } } } },
    })).toEqual({ toolMetadata: { internal: true, mcp: { server: 'docs', tool: 'read' } } });
    expect(FX_SESSION_UPDATES.project({ sessionUpdate: 'agent_message_chunk', content: {
      type: 'text', text: '[context] skill catalog shortened…',
    } })).toBeNull();
  });
});
