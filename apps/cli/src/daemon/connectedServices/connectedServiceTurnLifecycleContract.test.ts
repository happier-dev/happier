import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceTurnLifecycleRequestBodySchema,
  ConnectedServiceTurnLifecycleResultSchema,
} from './connectedServiceTurnLifecycleContract';

describe('connected-service turn lifecycle private contract', () => {
  it('keeps predecessor terminal bodies readable while preserving missing prompt witnesses', () => {
    expect(ConnectedServiceTurnLifecycleRequestBodySchema.parse({
      sessionId: 'sess-1',
      turnId: 'session-turn:exact-1',
      event: 'assistant_message_end',
      terminalStatus: 'completed',
    })).toEqual({
      sessionId: 'sess-1',
      turnId: 'session-turn:exact-1',
      event: 'assistant_message_end',
      terminalStatus: 'completed',
    });

    const legacyPrompt =
      ConnectedServiceTurnLifecycleRequestBodySchema.parse({
        sessionId: 'sess-1',
        event: 'prompt_or_steer',
    });
    expect(legacyPrompt.requestedAction).toBeUndefined();
    expect(legacyPrompt.activeTurnId).toBeUndefined();
  });

  it('accepts the runner-owned prompt action and explicit active-turn witness', () => {
    expect(ConnectedServiceTurnLifecycleRequestBodySchema.parse({
      sessionId: 'sess-1',
      event: 'prompt_or_steer',
      requestedAction: { v: 1, kind: 'steer_now' },
      activeTurnId: 'session-turn:exact-1',
    })).toEqual({
      sessionId: 'sess-1',
      event: 'prompt_or_steer',
      requestedAction: { v: 1, kind: 'steer_now' },
      activeTurnId: 'session-turn:exact-1',
    });
    expect(ConnectedServiceTurnLifecycleRequestBodySchema.parse({
      sessionId: 'sess-1',
      event: 'prompt_or_steer',
      requestedAction: { v: 1, kind: 'enqueue' },
      activeTurnId: null,
    }).activeTurnId).toBeNull();
  });

  it('admits only continue or the typed source-cutover block result', () => {
    expect(ConnectedServiceTurnLifecycleResultSchema.parse({
      status: 'continue',
      turnCustody: {
        status: 'recorded',
        activeTurnId: null,
      },
    })).toEqual({
      status: 'continue',
      turnCustody: {
        status: 'recorded',
        activeTurnId: null,
      },
    });
    expect(ConnectedServiceTurnLifecycleResultSchema.parse({
      status: 'input_blocked',
      reason: 'request_auth_source_cutover',
    })).toEqual({
      status: 'input_blocked',
      reason: 'request_auth_source_cutover',
    });
    expect(() => ConnectedServiceTurnLifecycleResultSchema.parse({
      status: 'recorded',
    })).toThrow();
  });
});
