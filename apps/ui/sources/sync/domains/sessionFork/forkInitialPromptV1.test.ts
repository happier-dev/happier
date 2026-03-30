import { describe, expect, it } from 'vitest';

import {
  clearForkInitialPromptV1,
  readForkInitialPromptV1,
  writeForkInitialPromptV1,
} from './forkInitialPromptV1';

describe('forkInitialPromptV1', () => {
  it('preserves exact prompt text while still rejecting blank prompts', () => {
    const metadata = writeForkInitialPromptV1({
      metadata: {} as any,
      text: '  first line\nsecond line  ',
      createdAtMs: 1,
      sourceMessageId: 'm1',
    });

    expect(readForkInitialPromptV1(metadata as any)).toEqual({
      v: 1,
      text: '  first line\nsecond line  ',
      createdAtMs: 1,
      sourceMessageId: 'm1',
    });
    expect(writeForkInitialPromptV1({ metadata: {} as any, text: '   \n\t  ', createdAtMs: 1 })).toEqual({});
  });

  it('clears the stored prompt marker without disturbing other metadata', () => {
    const metadata = {
      other: 'value',
      forkInitialPromptV1: {
        v: 1,
        text: 'hello',
        createdAtMs: 1,
      },
    };

    expect(clearForkInitialPromptV1({ metadata: metadata as any })).toEqual({ other: 'value' });
  });
});
