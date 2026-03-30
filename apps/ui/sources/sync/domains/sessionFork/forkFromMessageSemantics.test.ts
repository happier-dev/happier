import { describe, expect, it } from 'vitest';

import { resolveForkFromMessageSemantics } from './forkFromMessageSemantics';

describe('resolveForkFromMessageSemantics', () => {
  it('preserves target seq for non-user messages', () => {
    const result = resolveForkFromMessageSemantics({
      message: { id: 'm1', kind: 'agent-text', localId: null, createdAt: 0, text: 'hi' } as any,
      messageSeqInclusive: 5,
    });
    expect(result).toEqual({ upToSeqInclusive: 5, restoredDraftText: null });
  });

  it('preserves target seq for user messages while restoring the draft (daemon decides effective cutoff)', () => {
    const result = resolveForkFromMessageSemantics({
      message: { id: 'm1', kind: 'user-text', localId: null, createdAt: 0, text: 'hello fork' } as any,
      messageSeqInclusive: 7,
    });
    expect(result).toEqual({ upToSeqInclusive: 7, restoredDraftText: 'hello fork' });
  });

  it('does not restore draft for the first message (no prior context to fork)', () => {
    const result = resolveForkFromMessageSemantics({
      message: { id: 'm1', kind: 'user-text', localId: null, createdAt: 0, text: 'hello fork' } as any,
      messageSeqInclusive: 1,
    });
    expect(result).toEqual({ upToSeqInclusive: 1, restoredDraftText: null });
  });
});

