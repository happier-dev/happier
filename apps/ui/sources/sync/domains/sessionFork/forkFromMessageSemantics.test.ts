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

  it('restores what the transcript showed, not the expanded transport text', () => {
    const result = resolveForkFromMessageSemantics({
      message: {
        id: 'm1',
        kind: 'user-text',
        localId: null,
        createdAt: 0,
        text: 'Fix this\n\n[attachments]\n{"v":1,"files":[]}\n[/attachments]',
        displayText: 'Fix this',
      } as any,
      messageSeqInclusive: 7,
    });
    expect(result).toEqual({ upToSeqInclusive: 7, restoredDraftText: 'Fix this' });
  });

  it('restores an empty draft when the user saw nothing but the transport text was scaffolding', () => {
    const result = resolveForkFromMessageSemantics({
      message: {
        id: 'm1',
        kind: 'user-text',
        localId: null,
        createdAt: 0,
        text: '[attachments]\n{"v":1,"files":[]}\n[/attachments]',
        displayText: '',
      } as any,
      messageSeqInclusive: 7,
    });
    expect(result).toEqual({ upToSeqInclusive: 7, restoredDraftText: null });
  });

  it('does not restore draft for the first message (no prior context to fork)', () => {
    const result = resolveForkFromMessageSemantics({
      message: { id: 'm1', kind: 'user-text', localId: null, createdAt: 0, text: 'hello fork' } as any,
      messageSeqInclusive: 1,
    });
    expect(result).toEqual({ upToSeqInclusive: 1, restoredDraftText: null });
  });
});

