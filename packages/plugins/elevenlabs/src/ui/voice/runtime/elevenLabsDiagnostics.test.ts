import { describe, expect, it, vi } from 'vitest';

import {
  createElevenLabsDiagnostics,
  createElevenLabsProviderDiagnosticEvent,
} from './elevenLabsDiagnostics.js';

describe('ElevenLabs diagnostics', () => {
  it('publishes bounded metadata instead of an oversized cyclic provider payload', () => {
    const payload: Record<string, unknown> = { type: 'agent_response' };
    let cursor = payload;
    for (let index = 0; index < 128; index += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.transcript = 'private transcript marker';
    cursor.next = payload;

    const event = createElevenLabsProviderDiagnosticEvent(payload);

    expect(event).toEqual({
      providerId: 'realtime_elevenlabs',
      eventType: 'agent_response',
      payloadBytes: null,
      redactionClass: 'unknown_redacted',
    });
    expect(JSON.stringify(event)).not.toContain('private transcript marker');
  });

  it('passes only sanitized provider event metadata to the diagnostic sink', () => {
    const appendProviderEvent = vi.fn();
    const diagnostics = createElevenLabsDiagnostics({
      appendSystem: vi.fn(),
      appendProviderEvent,
      appendError: vi.fn(),
    });

    diagnostics.providerEvent({
      type: 'user_transcript',
      user_transcription_event: { user_transcript: 'private transcript marker' },
    });

    expect(appendProviderEvent).toHaveBeenCalledWith({
      providerId: 'realtime_elevenlabs',
      eventType: 'user_transcript',
      payloadBytes: null,
      redactionClass: 'transcript_redacted',
    });
    expect(JSON.stringify(appendProviderEvent.mock.calls)).not.toContain('private transcript marker');
  });

  it('does not retain an arbitrary provider-controlled event type', () => {
    const event = createElevenLabsProviderDiagnosticEvent({
      type: 'private_transcript_marker',
    });

    expect(event.eventType).toBe('unknown');
    expect(JSON.stringify(event)).not.toContain('private_transcript_marker');
  });
});
