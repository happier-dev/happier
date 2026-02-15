import { describe, expect, it } from 'vitest';

describe('voiceActivityStore', () => {
  it('appends events per session and caps to maxEvents', async () => {
    const { createVoiceActivityStore } = await import('./voiceActivityStore');

    const store = createVoiceActivityStore({ maxEventsPerSession: 3 });
    store.getState().append({
      id: 'e1',
      ts: 1,
      sessionId: 's1',
      adapterId: 'local_conversation',
      kind: 'user.text',
      text: 'hi',
    });
    store.getState().append({
      id: 'e2',
      ts: 2,
      sessionId: 's1',
      adapterId: 'local_conversation',
      kind: 'assistant.text',
      text: 'hello',
    });
    store.getState().append({
      id: 'e3',
      ts: 3,
      sessionId: 's1',
      adapterId: 'local_conversation',
      kind: 'assistant.text',
      text: 'more',
    });
    store.getState().append({
      id: 'e4',
      ts: 4,
      sessionId: 's1',
      adapterId: 'local_conversation',
      kind: 'assistant.text',
      text: 'trim',
    });

    const events = store.getState().eventsBySessionId['s1'] ?? [];
    expect(events.map((e) => e.id)).toEqual(['e2', 'e3', 'e4']);
  });

  it('clears events for a session', async () => {
    const { createVoiceActivityStore } = await import('./voiceActivityStore');
    const store = createVoiceActivityStore({ maxEventsPerSession: 50 });

    store.getState().append({
      id: 'e1',
      ts: 1,
      sessionId: 's1',
      adapterId: 'realtime_elevenlabs',
      kind: 'status',
      status: 'connecting',
      mode: 'idle',
    });
    expect((store.getState().eventsBySessionId['s1'] ?? []).length).toBe(1);

    store.getState().clearSession('s1');
    expect((store.getState().eventsBySessionId['s1'] ?? []).length).toBe(0);
  });

  it('can replace events for a session (used by voice agent transcript hydration)', async () => {
    const { createVoiceActivityStore } = await import('./voiceActivityStore');
    const store = createVoiceActivityStore({ maxEventsPerSession: 3 });

    store.getState().append({
      id: 'e1',
      ts: 1,
      sessionId: 's1',
      adapterId: 'local_conversation',
      kind: 'user.text',
      text: 'hi',
    });

    store.getState().replaceSessionEvents('s1', [
      { id: 'r1', ts: 10, sessionId: 's1', adapterId: 'local_conversation', kind: 'user.text', text: 'u' },
      { id: 'r2', ts: 11, sessionId: 's1', adapterId: 'local_conversation', kind: 'assistant.text', text: 'a' },
      { id: 'r3', ts: 12, sessionId: 's1', adapterId: 'local_conversation', kind: 'assistant.text', text: 'b' },
      { id: 'r4', ts: 13, sessionId: 's1', adapterId: 'local_conversation', kind: 'assistant.text', text: 'c' },
    ] as any);

    const events = store.getState().eventsBySessionId['s1'] ?? [];
    expect(events.map((e) => e.id)).toEqual(['r2', 'r3', 'r4']);
  });
});
