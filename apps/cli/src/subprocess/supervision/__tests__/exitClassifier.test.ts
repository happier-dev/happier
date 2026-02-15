import { describe, expect, it } from 'vitest';

import { classifyChildExit, isExpectedTermination, isUnexpectedTermination } from '../exitClassifier';

describe('exitClassifier', () => {
  it('treats code 0 as expected', () => {
    const event = classifyChildExit({ code: 0, signal: null });
    expect(event).toEqual({ type: 'exited', code: 0 });
    expect(isExpectedTermination(event)).toBe(true);
    expect(isUnexpectedTermination(event)).toBe(false);
  });

  it('treats non-zero codes as unexpected', () => {
    const event = classifyChildExit({ code: 2, signal: null });
    expect(event).toEqual({ type: 'exited', code: 2 });
    expect(isExpectedTermination(event)).toBe(false);
    expect(isUnexpectedTermination(event)).toBe(true);
  });

  it('treats SIGTERM as expected', () => {
    const event = classifyChildExit({ code: null, signal: 'SIGTERM' });
    expect(event).toEqual({ type: 'signaled', signal: 'SIGTERM' });
    expect(isExpectedTermination(event)).toBe(true);
    expect(isUnexpectedTermination(event)).toBe(false);
  });
});

