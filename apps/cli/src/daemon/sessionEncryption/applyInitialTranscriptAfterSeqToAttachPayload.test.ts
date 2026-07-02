import { describe, expect, it } from 'vitest';

import { applyInitialTranscriptAfterSeqToAttachPayload } from './applyInitialTranscriptAfterSeqToAttachPayload';

describe('applyInitialTranscriptAfterSeqToAttachPayload', () => {
  it('applies an explicit resume transcript cursor to the attach payload', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain' },
        36,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 36,
      initialTranscriptAfterSeq: 36,
    });
  });

  it('overrides a stale attach payload cursor with the explicit wake cursor', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
        36,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 36,
      initialTranscriptAfterSeq: 36,
    });
  });

  it('preserves an explicit zero cursor as a trusted wake boundary', () => {
    expect(
      applyInitialTranscriptAfterSeqToAttachPayload(
        { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 },
        0,
      ),
    ).toEqual({
      v: 2,
      encryptionMode: 'plain',
      lastObservedMessageSeq: 0,
      initialTranscriptAfterSeq: 0,
    });
  });

  it('leaves the attach payload unchanged when no valid cursor is provided', () => {
    const payload = { v: 2, encryptionMode: 'plain', lastObservedMessageSeq: 99 } as const;

    expect(applyInitialTranscriptAfterSeqToAttachPayload(payload, -1)).toBe(payload);
  });
});
