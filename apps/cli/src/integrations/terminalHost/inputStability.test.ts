import { describe, expect, it } from 'vitest';

import { captureTerminalInputState, type TerminalInputSample } from './inputStability';

function samples(...values: TerminalInputSample[]): () => Promise<TerminalInputSample> {
  let index = 0;
  return async () => values[Math.min(index++, values.length - 1)]!;
}

describe('captureTerminalInputState', () => {
  it('counts a cursor-only move as typing when the host reports the cursor', async () => {
    await expect(captureTerminalInputState({
      sample: samples({ text: '> ab', cursor: { x: 4, y: 0 } }, { text: '> ab', cursor: { x: 3, y: 0 } }),
      wait: async () => {},
      now: () => 7,
    })).resolves.toEqual({ stable: false, currentInput: '> ab', cursor: { x: 3, y: 0 }, observedAt: 7 });
  });

  it('compares text alone on hosts without a cursor', async () => {
    await expect(captureTerminalInputState({
      sample: samples({ text: '> ab' }, { text: '> ab' }),
      wait: async () => {},
      now: () => 8,
    })).resolves.toEqual({ stable: true, currentInput: '> ab', observedAt: 8 });
    await expect(captureTerminalInputState({
      sample: samples({ text: '> a' }, { text: '> ab' }),
      wait: async () => {},
      now: () => 9,
    })).resolves.toMatchObject({ stable: false, currentInput: '> ab' });
  });

  it('treats a cursor that appears or disappears between samples as unstable', async () => {
    await expect(captureTerminalInputState({
      sample: samples({ text: '> ab', cursor: null }, { text: '> ab', cursor: { x: 4, y: 0 } }),
      wait: async () => {},
      now: () => 10,
    })).resolves.toMatchObject({ stable: false });
  });
});
