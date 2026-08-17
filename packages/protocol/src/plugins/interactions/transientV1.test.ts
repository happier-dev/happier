import { describe, expect, it } from 'vitest';

import {
  InteractionTransientRequestV1Schema,
  InteractionTransientResultV1Schema,
  normalizeInteractionTransientRequestV1,
  validateInteractionTransientSettlementV1,
} from './transientV1.js';

const stamp = {
  requestId: 'request-1',
  scope: { kind: 'session', sessionId: 'session-1' },
  requester: {
    pluginId: 'acme.widgets',
    contributionId: 'settings',
    generationId: 'generation-1',
    invocationId: 'invocation-1',
  },
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

const appScopeStamp = {
  requestId: 'request-app-1',
  scope: { kind: 'app' },
  requester: stamp.requester,
  createdAtMs: 1,
  expiresAtMs: 2,
} as const;

describe('transient interaction contract', () => {
  it('accepts host-stamped app scope while rejecting the retired top-level Session stamp', () => {
    const appRequest = {
      ...appScopeStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    } as const;

    expect(InteractionTransientRequestV1Schema.safeParse(appRequest).success).toBe(true);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appRequest,
      scope: { kind: 'session', sessionId: 'session-1' },
    }).success).toBe(true);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appRequest,
      sessionId: 'retired-top-level-session-id',
    }).success).toBe(false);
  });

  it('keeps scope and Session persistence outside author input', () => {
    expect(normalizeInteractionTransientRequestV1({
      kind: 'confirmation',
      message: 'Continue?',
      scope: { kind: 'app' },
    }, appScopeStamp).ok).toBe(false);

    const appApproval = normalizeInteractionTransientRequestV1({
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowSessionPersistence: true,
    }, appScopeStamp);
    expect(appApproval).toMatchObject({ ok: true, value: { scope: { kind: 'app' } } });
    if (appApproval.ok && appApproval.value.kind === 'approval') {
      expect(appApproval.value.allowedPersistenceScopes).toBeUndefined();
    }
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...appScopeStamp,
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowedPersistenceScopes: ['session'],
    }).success).toBe(false);
  });

  it('fails closed when author input throws during strict-schema inspection', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(normalizeInteractionTransientRequestV1(proxy, stamp)).toEqual({
      ok: false,
      code: 'invalid_interaction_request',
    });
  });

  it('keeps title and choice-label bounds distinct from prompt and description bounds', () => {
    const overTitle = 't'.repeat(513);
    const maxPrompt = 'p'.repeat(4_096);
    const overLabel = 'l'.repeat(513);

    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'confirmation',
      title: overTitle,
      message: maxPrompt,
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      questions: [{
        id: 'reason',
        prompt: maxPrompt,
        type: 'singleChoice',
        choices: [{ id: 'continue', label: overLabel }],
      }],
    }).success).toBe(false);
  });

  it('owns the retained tool-approval and structured-question semantics in the normalized request', () => {
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run Bash?',
      description: 'The Agent requests a shell command.',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
      allowedPersistenceScopes: ['session'],
    }).success).toBe(true);

    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      title: 'Choose a mode',
      questions: [{
        id: 'mode',
        prompt: 'Which mode should be used?',
        description: 'This choice controls the current operation.',
        type: 'singleChoice',
        required: true,
        allowCustom: true,
        choices: [{ id: 'safe', label: 'Safe', description: 'Make no destructive changes.' }],
      }],
    }).success).toBe(true);
  });

  it('rejects unknown keys, duplicate question ids, and mismatched terminal kinds', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'questions',
      questions: [{ id: 'reason', prompt: 'Why?', type: 'text', required: false }],
    });
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...request,
      unexpected: true,
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'questions',
      questions: [
        { id: 'same', prompt: 'One?', type: 'text', required: false },
        { id: 'same', prompt: 'Two?', type: 'text', required: false },
      ],
    }).success).toBe(false);
    expect(InteractionTransientResultV1Schema.safeParse({
      requestId: request.requestId, kind: 'questions', status: 'approved',
    }).success).toBe(false);
  });

  it('rejects malformed Unicode anywhere in normalized strict JSON input', () => {
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run tool?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { command: '\ud800' },
      },
    }).success).toBe(false);
    expect(InteractionTransientRequestV1Schema.safeParse({
      ...stamp,
      kind: 'approval',
      title: 'Run tool?',
      subject: {
        kind: 'tool',
        name: 'Bash',
        input: { ['bad\ud800']: 'value' },
      },
    }).success).toBe(false);
  });

  it('allows one kind-compatible terminal settlement and rejects a late incompatible answer', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId, kind: 'confirmation', status: 'declined',
    })).toEqual({ ok: true });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId, kind: 'questions', status: 'answered', answers: {},
    })).toEqual({ ok: false, code: 'interaction_kind_mismatch' });
  });

  it('rejects lifecycle-only statuses from a presenter, including Session-ended in app scope', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...appScopeStamp,
      kind: 'confirmation',
      title: 'Continue?',
      message: 'Continue with the current operation?',
    });

    for (const status of [
      'requesterAborted',
      'timedOut',
      'sessionEnded',
      'generationRetired',
      'hostRestarted',
      'unavailable',
    ] as const) {
      expect(validateInteractionTransientSettlementV1(request, {
        requestId: request.requestId,
        kind: 'confirmation',
        status,
      })).toEqual({ ok: false, code: 'owner_only_interaction_terminal_status' });
    }
  });

  it('validates selected choices and required answers against the stamped question request', () => {
    const request = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'questions',
      questions: [{
        id: 'mode',
        prompt: 'Which mode?',
        type: 'singleChoice',
        required: true,
        allowCustom: false,
        choices: [{ id: 'safe', label: 'Safe' }],
      }],
    });

    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: { mode: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'safe' } } },
    })).toEqual({ ok: true });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: {},
    })).toEqual({ ok: false, code: 'invalid_interaction_answer' });
    expect(validateInteractionTransientSettlementV1(request, {
      requestId: request.requestId,
      kind: 'questions',
      status: 'answered',
      answers: { mode: { kind: 'singleChoice', answer: { kind: 'choice', choiceId: 'unsafe' } } },
    })).toEqual({ ok: false, code: 'invalid_interaction_answer' });
  });

  it('rejects approval persistence that the stamped request did not authorize', () => {
    const onceOnly = InteractionTransientRequestV1Schema.parse({
      ...stamp,
      kind: 'approval',
      title: 'Run Bash?',
      subject: { kind: 'tool', name: 'Bash', input: { command: 'pwd' } },
    });
    expect(validateInteractionTransientSettlementV1(onceOnly, {
      requestId: onceOnly.requestId,
      kind: 'approval',
      status: 'approved',
      persistence: 'session',
    })).toEqual({ ok: false, code: 'invalid_interaction_persistence' });

    const sessionAllowed = InteractionTransientRequestV1Schema.parse({
      ...onceOnly,
      allowedPersistenceScopes: ['session'],
    });
    expect(validateInteractionTransientSettlementV1(sessionAllowed, {
      requestId: sessionAllowed.requestId,
      kind: 'approval',
      status: 'approved',
      persistence: 'session',
    })).toEqual({ ok: true });
    expect(InteractionTransientResultV1Schema.safeParse({
      requestId: sessionAllowed.requestId,
      kind: 'approval',
      status: 'declined',
      persistence: 'session',
    }).success).toBe(false);
  });
});
