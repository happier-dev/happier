import { describe, expect, it } from 'vitest';
import { t } from '@/text';
import { resolveSpokenActionOutcome } from './spokenActionOutcome';
import { completeSpawnActionResult } from '@happier-dev/protocol/actions/executor/resultProjection';
import { UiActionDispatchResultV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { projectVoiceActionExecutionResult, serializeVoiceActionExecuteResult } from '@/voice/tools/voiceActionResult';

describe('spoken Action owner outcomes', () => {
  it.each([
    { canonicalResult: false, boundAgent: false }, { canonicalResult: false, boundAgent: true },
    { canonicalResult: true, boundAgent: false }, { canonicalResult: true, boundAgent: true },
  ])('retains spawn recovery without changing a refused Action into success (canonical=$canonicalResult, bound=$boundAgent)', ({ canonicalResult, boundAgent }) => {
    const refusal = { type: 'error' as const, code: 'spawn_failed' as const, retryable: false,
      launchError: { kind: 'launch_error' as const, code: 'agent_startup_failed', message: 'Agent startup failed',
        failureCause: { phase: 'client_start' as const, failureReason: 'unclassified_provider_error' as const,
          providerErrorMessage: 'Claude is signed out on the selected machine' } } };
    const settled = completeSpawnActionResult(refusal);
    const presented = JSON.parse(serializeVoiceActionExecuteResult('session.spawn_new', settled, {
      canonicalResult,
      ...(boundAgent ? {
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        alternativeAgent: { targetKey: 'agent:codex', label: 'Codex',
          agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
      } : {}),
    }));
    expect(presented).toMatchObject({ ok: false, errorCode: 'spawn_failed', details: refusal });
    if (boundAgent) expect(presented).toMatchObject({
      alternativeAgent: { label: 'Codex' }, errorMessage: expect.stringContaining('Codex') });
    else expect(presented).not.toHaveProperty('alternativeAgent');
    const spoken = resolveSpokenActionOutcome({ t: canonicalResult ? 'action_execute' : 'spawnSession',
      args: canonicalResult ? { actionId: 'session.spawn_new', input: {} } : {}, result: presented });
    expect(spoken).toMatch(/Claude.*signed out/i);
    if (boundAgent) expect(spoken).toContain('Codex');
    if (canonicalResult) {
      expect(UiActionDispatchResultV1Schema.parse({ v: 1,
        execution: projectVoiceActionExecutionResult('session.spawn_new', presented) }).execution).toEqual(settled);
    }
  });

  it.each([
    { t: 'requestVoiceBrief', args: {}, result: { ok: true, status: 'waiting', attemptId: 'attempt' } },
    { t: 'action_execute', args: { actionId: 'ui.voice_global.brief.request', input: {} },
      result: { ok: true, result: { status: 'sent', attemptId: 'attempt' } } },
  ])('leaves an admitted Brief reply with its mounted delivery owner: $t', entry => {
    expect(resolveSpokenActionOutcome(entry)).toEqual({ kind: 'delegated_reply' });
  });

  it('keeps a refused Brief with failure presentation instead of delegating a missing reply', () => {
    expect(resolveSpokenActionOutcome({ t: 'requestVoiceBrief', args: {},
      result: { ok: true, status: 'refused', attemptId: 'attempt' },
    })).toBe(t('voiceMoments.briefNotSpoken'));
    expect(resolveSpokenActionOutcome({ t: 'requestVoiceBrief', args: {},
      result: { ok: false, errorCode: 'voice_brief_unavailable' },
    })).toBeTypeOf('string');
  });

  it('reports Session creation without promising the accepted first turn will run', () => {
    expect(resolveSpokenActionOutcome({ t: 'spawnSession', args: {},
      result: { ok: true, type: 'success', sessionId: 's1', initialInput: { status: 'accepted', localId: 'm1' } },
    })).toBe('Session created.');
  });

  it('leaves named-model choices for the carrier to read aloud', () => {
    expect(resolveSpokenActionOutcome({ t: 'spawnSession', args: {},
      result: { ok: false, errorCode: 'provider_model_not_found', error: 'provider_model_not_found',
        details: { candidates: [{ label: 'Named Model', value: 'model' }] } },
    })).toBeNull();
  });

  it.each([false, true])('reports only admission for an asynchronous send (envelope=%s)', envelope => {
    const input = { message: 'Write a file', reply: 'none' };
    const result = { status: 'accepted', localId: 'message-1' };
    expect(resolveSpokenActionOutcome({ t: envelope ? 'action_execute' : 'sendSessionMessage',
      args: envelope ? { actionId: 'session.message.send', input } : input,
      result: envelope ? { ok: true, result } : { ok: true, ...result },
    })).toBe(t('session.askRecord.sent'));
  });

  it.each(['wait', 'return'])('leaves requested answers with the reply owner (reply=%s)', reply => {
    expect(resolveSpokenActionOutcome({ t: 'sendSessionMessage', args: { message: 'Answer me', reply },
      result: { ok: true, status: 'accepted', localId: 'message-1' },
    })).toBeNull();
  });

  it('does not turn unknown send custody into delivery or approval', () => {
    expect(resolveSpokenActionOutcome({ t: 'sendSessionMessage', args: { message: 'Write a file' },
      result: { ok: true, status: 'outcomeUnknown', localId: 'message-1', code: 'session_input_pending' },
    })).toBe(t('session.askRecord.unsure'));
  });

  it('reports a fanout as sent only when every destination accepted it', () => {
    const accepted = { target: { serverId: 'home', sessionId: 'worker' },
      result: { ok: true, result: { status: 'accepted', localId: 'message-1' } } };
    const unknown = { target: { serverId: 'home', sessionId: 'other' },
      result: { ok: true, result: { status: 'outcomeUnknown', localId: 'message-2', code: 'session_input_pending' } } };
    const entry = { t: 'sendSessionMessage', args: { message: 'Write a file' } };
    expect(resolveSpokenActionOutcome({ ...entry,
      result: { ok: true, kind: 'fanout', results: [accepted] },
    })).toBe(t('session.askRecord.sent'));
    expect(resolveSpokenActionOutcome({ ...entry,
      result: { ok: true, kind: 'fanout', results: [accepted, unknown] },
    })).toBe(t('session.askRecord.unsure'));
  });

  it.each([
    { t: 'approval_request_decide', args: { artifactId: 'request-1', decision: 'approve' } },
    { t: 'action_execute', args: { actionId: 'approval.request.decide', input: { artifactId: 'request-1', decision: 'approve' } } },
    { t: 'settings_set', args: { anchor: 'voiceConversations.verbosity', value: 'short' } },
    { t: 'action_execute', args: { actionId: 'settings.set', input: { anchor: 'voiceConversations.verbosity', value: 'short' } } },
  ])('describes a canceled operation without asserting a request disposition: $t $args.actionId', action => {
    expect(resolveSpokenActionOutcome({ ...action,
      result: { ok: false, errorCode: 'cancelled', error: 'cancelled' },
    })).toBe(t('voiceSurface.actionCanceled'));
  });

  it.each([false, true])('preserves a confirmed canceled request disposition (envelope=%s)', envelope => {
    const input = { artifactId: 'request-1', decision: 'cancel' };
    const result = { status: 'canceled' };
    expect(resolveSpokenActionOutcome({
      t: envelope ? 'action_execute' : 'approval_request_decide',
      args: envelope ? { actionId: 'approval.request.decide', input } : input,
      result: envelope ? { ok: true, result } : { ok: true, ...result },
    })).toBe(t('approvals.status.canceled'));
  });

  it.each([
    { t: 'approval_request_decide', args: { artifactId: 'request-1', decision: 'approve' } },
    { t: 'action_execute', args: { actionId: 'approval.request.decide', input: { artifactId: 'request-1', decision: 'approve' } } },
  ])('explains a present-user refusal without claiming a lookup or decision failed: $t', action => {
    expect(resolveSpokenActionOutcome({ ...action,
      result: { ok: false, errorCode: 'present_user_required', error: 'present_user_required' },
    })).toBe(t('voiceSurface.approvalTapRequired'));
  });
});
