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
});

