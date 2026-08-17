import { afterEach, describe, expect, it } from 'vitest';

import { resetVoiceQaStoreForTests, useVoiceQaStore } from './voiceQaStore';

describe('voiceQaStore', () => {
  afterEach(() => {
    resetVoiceQaStoreForTests();
  });

  it('retains only the newest 500 diagnostic entries', () => {
    for (let index = 0; index <= 500; index += 1) {
      useVoiceQaStore.getState().appendSystem(`entry ${index}`);
    }

    const entries = useVoiceQaStore.getState().entries;
    expect(entries).toHaveLength(500);
    expect(entries[0]?.text).toBe('entry 1');
    expect(entries.at(-1)?.text).toBe('entry 500');
  });
});
