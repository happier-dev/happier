import { describe, expect, it } from 'vitest';

import { readHostEventNamespaceV1 } from './v1.js';
import {
  SESSION_PROVIDER_HOOK_EVENT_ID_V1,
  SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1,
  SessionProviderHookEventPayloadV1Schema,
  SessionProviderTranscriptEventPayloadV1Schema,
} from './session.js';
import { HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1 } from './hostV1.js';

describe('session provider host events', () => {
  it('declares canonical host session event ids and payload contracts', () => {
    expect(SESSION_PROVIDER_HOOK_EVENT_ID_V1).toBe('@happier/session/provider-hook');
    expect(SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1).toBe('@happier/session/provider-transcript');
    expect(readHostEventNamespaceV1(SESSION_PROVIDER_HOOK_EVENT_ID_V1)).toBe('session');
    expect(readHostEventNamespaceV1(SESSION_PROVIDER_TRANSCRIPT_EVENT_ID_V1)).toBe('session');
    expect(readHostEventNamespaceV1(HAPPIER_AUTOMATION_RUN_STATE_CHANGED_HOST_EVENT_ID_V1))
      .toBe('automation');

    expect(SessionProviderHookEventPayloadV1Schema.parse({
      providerId: 'claude',
      sessionId: 'happier-session-1',
      providerSessionId: 'provider-session-1',
      eventName: 'SessionStart',
      providerPayload: {
        session_id: 'provider-session-1',
        transcript_path: '/tmp/claude.jsonl',
      },
    })).toEqual({
      providerId: 'claude',
      sessionId: 'happier-session-1',
      providerSessionId: 'provider-session-1',
      eventName: 'SessionStart',
      providerPayload: {
        session_id: 'provider-session-1',
        transcript_path: '/tmp/claude.jsonl',
      },
    });

    expect(SessionProviderTranscriptEventPayloadV1Schema.parse({
      providerId: 'claude',
      sessionId: 'happier-session-1',
      providerSessionId: 'provider-session-1',
      kind: 'assistant_stop',
      providerPayload: {
        stop_reason: 'end_turn',
      },
    })).toEqual({
      providerId: 'claude',
      sessionId: 'happier-session-1',
      providerSessionId: 'provider-session-1',
      kind: 'assistant_stop',
      providerPayload: {
        stop_reason: 'end_turn',
      },
    });
  });
});
