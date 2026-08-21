import { describe, expect, it } from 'vitest';

import { codexStateSharingDescriptor } from './descriptor.js';

describe('codexStateSharingDescriptor', () => {
  it('declares Codex config, state, auth, and SQLite sharing facts', () => {
    expect(codexStateSharingDescriptor.providerId).toBe('codex');
    expect(codexStateSharingDescriptor.config.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'config.toml', mode: 'force_copied' }),
      expect.objectContaining({ path: 'skills', mode: 'linked_or_copied' }),
    ]));
    expect(codexStateSharingDescriptor.state.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'sessions', mode: 'linked' }),
      expect.objectContaining({ path: 'history.jsonl', mode: 'linked' }),
    ]));
    expect(codexStateSharingDescriptor.authIsolation).toMatchObject({
      mode: 'materialized_home',
      secretEntries: ['auth.json', 'accounts'],
    });
    expect(codexStateSharingDescriptor.dynamicEntryPatterns).toBeUndefined();
  });
});
