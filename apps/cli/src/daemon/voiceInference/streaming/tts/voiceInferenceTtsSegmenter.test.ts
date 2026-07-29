import { describe, expect, it } from 'vitest';

import { segmentTextForDaemonTts } from './voiceInferenceTtsSegmenter';

describe('segmentTextForDaemonTts', () => {
  it('creates stable ordered sentence segments without losing text', () => {
    const segments = segmentTextForDaemonTts('Hello daemon. This is segment two. Final segment!');

    expect(segments.map((segment) => segment.index)).toEqual([0, 1, 2]);
    expect(segments.map((segment) => segment.text)).toEqual([
      'Hello daemon.',
      'This is segment two.',
      'Final segment!',
    ]);
    expect(segments.at(-1)?.isLastSegment).toBe(true);
    expect(segments.map((segment) => segment.segmentId)).toEqual(
      segmentTextForDaemonTts('Hello daemon. This is segment two. Final segment!').map((segment) => segment.segmentId),
    );
    expect(segments.map((segment) => segment.text).join(' ')).toBe(
      'Hello daemon. This is segment two. Final segment!',
    );
  });

  it('keeps abbreviations and decimal values inside the same segment', () => {
    const segments = segmentTextForDaemonTts('Dr. Smith measured 3.14 volts. It worked.');

    expect(segments.map((segment) => segment.text)).toEqual([
      'Dr. Smith measured 3.14 volts.',
      'It worked.',
    ]);
  });

  it('splits long text at phrase boundaries to keep the first segment short for TTFA', () => {
    const segments = segmentTextForDaemonTts(
      'Alpha beta gamma, delta epsilon zeta, eta theta iota, kappa lambda mu.',
      { preferredFirstSegmentMaxChars: 28, maxSegmentChars: 36 },
    );

    expect(segments[0]?.text).toBe('Alpha beta gamma,');
    expect(Math.max(...segments.map((segment) => segment.text.length))).toBeLessThanOrEqual(36);
    expect(segments.map((segment) => segment.text).join(' ')).toBe(
      'Alpha beta gamma, delta epsilon zeta, eta theta iota, kappa lambda mu.',
    );
  });
});
