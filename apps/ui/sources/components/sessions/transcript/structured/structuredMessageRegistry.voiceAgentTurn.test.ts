import { describe, expect, it } from 'vitest';

import { findStructuredMessageRenderer } from './structuredMessageRegistry';

describe('structured message registry (voice agent turn)', () => {
  it('registers voice_agent_turn.v1 but does not render a transcript card', () => {
    const entry = findStructuredMessageRenderer('voice_agent_turn.v1');
    expect(entry).not.toBeNull();

    const parsed = entry!.schema.safeParse({ v: 1, epoch: 0, role: 'assistant', voiceAgentId: 'va_1', ts: 1 });
    expect(parsed.success).toBe(true);

    const el = entry!.render(parsed.success ? parsed.data : (null as any), {
      sessionId: 's1',
      onJumpToAnchor: () => {},
    });
    expect(el).toBeNull();
  });

  it('registers session_synopsis.v1 but does not render a transcript card', () => {
    const entry = findStructuredMessageRenderer('session_synopsis.v1');
    expect(entry).not.toBeNull();

    const parsed = entry!.schema.safeParse({ v: 1, seqTo: 10, updatedAtMs: 1, synopsis: 'hello' });
    expect(parsed.success).toBe(true);

    const el = entry!.render(parsed.success ? parsed.data : (null as any), {
      sessionId: 's1',
      onJumpToAnchor: () => {},
    });
    expect(el).toBeNull();
  });

  it('registers session_summary_shard.v1 but does not render a transcript card', () => {
    const entry = findStructuredMessageRenderer('session_summary_shard.v1');
    expect(entry).not.toBeNull();

    const parsed = entry!.schema.safeParse({
      v: 1,
      seqFrom: 0,
      seqTo: 10,
      createdAtFromMs: 1,
      createdAtToMs: 2,
      summary: 'hello',
      keywords: [],
      entities: [],
      decisions: [],
    });
    expect(parsed.success).toBe(true);

    const el = entry!.render(parsed.success ? parsed.data : (null as any), {
      sessionId: 's1',
      onJumpToAnchor: () => {},
    });
    expect(el).toBeNull();
  });
});
