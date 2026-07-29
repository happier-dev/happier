import { describe, expect, it } from 'vitest';

import type { ClaudeTerminalLifecycleObservation } from '../lifecycle.js';
import {
  mapClaudeUnifiedHookLifecyclePayload,
  mapClaudeUnifiedTranscriptLifecyclePayload,
} from './lifecycleEvents.js';
import { CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID } from './constants.js';

function createHarness() {
  const observations: ClaudeTerminalLifecycleObservation[] = [];

  const publishHook = async (providerPayload: Record<string, unknown>, eventName: string) => {
    const observation = mapClaudeUnifiedHookLifecyclePayload(
      { ...providerPayload, eventName },
      'happy-session-1',
    );
    if (observation) observations.push(observation);
  };

  const publishTranscript = async (payload: Record<string, unknown>) => {
    const observation = mapClaudeUnifiedTranscriptLifecyclePayload(payload, 'happy-session-1');
    if (observation) observations.push(observation);
  };

  return { observations, publishHook, publishTranscript };
}

describe('Claude unified direct lifecycle mapping (ported R-11 / HF-3)', () => {
  it('maps main-chain hook events into lifecycle observations', async () => {
    const { observations, publishHook } = createHarness();

    await publishHook({ hook_event_name: 'Stop', session_id: 'claude-session-1' }, 'Stop');

    expect(observations).toEqual([
      expect.objectContaining({ type: 'completion_candidate', source: 'hook' }),
    ]);
  });

  it('attaches a stable provider event id to compact boundary transcript observations', async () => {
    const { observations, publishTranscript } = createHarness();

    await publishTranscript({
      kind: 'compact_boundary',
      providerSessionId: 'claude-session-1',
      providerPayload: {
        type: 'system',
        subtype: 'compact_boundary',
        session_id: 'claude-session-1',
        uuid: 'compact-boundary-uuid-1',
        timestamp: '2026-07-08T06:00:00.000Z',
      },
    });

    expect(observations).toEqual([
      expect.objectContaining({
        type: 'compaction_completed',
        agentEventId: 'claude:compact_boundary:claude-session-1:compact-boundary-uuid-1',
      }),
    ]);
  });

  it('never lets sidechain (subagent) hooks drive the primary turn lifecycle', async () => {
    // Incident class cmq8171vw (R-11): subagent Stop/StopFailure/UserPromptSubmit hooks
    // terminalized or completed the PARENT canonical turn while the main agent kept working.
    const { observations, publishHook } = createHarness();

    await publishHook({ hook_event_name: 'Stop', session_id: 'sub-1', agent_id: 'agent-x' }, 'Stop');
    await publishHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sub-1', agent_id: 'agent-x', prompt: 'subagent task' }, 'UserPromptSubmit');

    expect(observations).toEqual([
      expect.objectContaining({
        type: 'sidechain_terminal',
        sidechainAgentId: 'agent-x',
        source: 'hook',
      }),
      expect.objectContaining({
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-x',
        source: 'hook',
      }),
    ]);
  });

  it('maps sidechain tool hooks into provider activity observations only', async () => {
    const { observations, publishHook } = createHarness();

    await publishHook({ hook_event_name: 'PreToolUse', session_id: 'sub-1', agent_id: 'agent-x' }, 'PreToolUse');
    await publishHook({ hook_event_name: 'PostToolUse', session_id: 'sub-1', agent_id: 'agent-x' }, 'PostToolUse');

    expect(observations).toEqual([
      expect.objectContaining({
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-x',
        source: 'hook',
      }),
      expect.objectContaining({
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-x',
        source: 'hook',
      }),
    ]);
  });

  it('keeps sidechain StopFailure flowing as turn_failed WITH sidechain attribution (account usage carve-out, HF-3)', async () => {
    const { observations, publishHook } = createHarness();

    await publishHook(
      { hook_event_name: 'StopFailure', session_id: 'sub-1', agent_id: 'agent-x', error: 'usage limit reached' },
      'StopFailure',
    );

    expect(observations).toEqual([
      expect.objectContaining({
        type: 'turn_failed',
        reason: 'stop_failure_hook',
        sidechainAgentId: 'agent-x',
      }),
    ]);
  });

  it('keeps main-chain StopFailure unattributed', async () => {
    const { observations, publishHook } = createHarness();

    await publishHook({ hook_event_name: 'StopFailure', session_id: 'claude-session-1', error: 'boom' }, 'StopFailure');

    expect(observations).toEqual([
      expect.objectContaining({ type: 'turn_failed', reason: 'stop_failure_hook' }),
    ]);
    expect((observations[0] as { sidechainAgentId?: string | null }).sidechainAgentId ?? null).toBeNull();
  });

  it('maps queued-command provider transcript events to evidence-only prompt submissions', async () => {
    const { observations, publishTranscript } = createHarness();

    await publishTranscript({
      kind: 'queued_command',
      text: 'prompt delivered through Claude queue',
      turnId: 'queued-command-row-1',
      observedAtMs: 123,
    });

    expect(observations).toEqual([
      expect.objectContaining({
        type: 'prompt_submitted',
        source: 'transcript',
        promptText: 'prompt delivered through Claude queue',
        providerEvidence: 'queued_command',
        observedAtMs: 123,
      }),
    ]);
  });

  it('maps a live assistant API error to one transcript-owned turn failure', async () => {
    const { observations, publishTranscript } = createHarness();

    await publishTranscript({
      kind: 'assistant_api_error',
      turnId: 'live-api-error-row',
      providerPayload: {
        type: 'assistant',
        uuid: 'live-api-error-row',
        isApiErrorMessage: true,
      },
    });

    expect(observations).toEqual([{
      type: 'turn_failed',
      agentId: CLAUDE_UNIFIED_TERMINAL_PROVIDER_ID,
      turnId: 'live-api-error-row',
      reason: 'transcript_api_error',
      source: 'transcript',
    }]);
  });
});
