import { describe, expect, it } from 'vitest';

import {
  combinePermissionModeQueuedPrompts,
  normalizePermissionModeQueuedPromptLocalIds,
} from './queuedPrompt';

describe('combinePermissionModeQueuedPrompts', () => {
  it('joins prompt texts and keeps the first localId', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
    ]);
    expect(combined.text).toBe('one\ntwo');
    expect(combined.localId).toBe('a');
  });

  it('aggregates every localId in an ordinary non-Pending batch', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: 'b' },
      { text: 'again', localId: 'a' },
      { text: 'anonymous', localId: null },
    ]);

    expect(combined).toMatchObject({
      localId: 'a',
      localIds: ['a', 'b'],
    });
  });

  it('preserves whitespace-distinct opaque local ids for exact provider outcome correlation', () => {
    expect(normalizePermissionModeQueuedPromptLocalIds({
      text: 'opaque ids',
      localId: ' local-id ',
      localIds: ['local-id', ' local-id ', '   '],
    })).toEqual([' local-id ', 'local-id']);
  });

  it('carries exact committed user-message seqs for host-consumed command replay suppression', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', userMessageSeq: 5 },
      { text: 'two', localId: 'b' },
      { text: 'three', localId: 'c', userMessageSeq: 9 },
    ]);
    expect(combined.userMessageSeq).toBe(9);
    expect(combined.userMessageSeqs).toEqual([5, 9]);
  });

  it('preserves the exact admitted authority when queue-key-compatible prompts batch', () => {
    const authority = {
      kind: 'admittedSessionInputV1' as const,
      admittedPermissionCeiling: 'read-only' as const,
      sourceAuthority: {
        kind: 'mediatedExternal' as const,
        mediatorPluginId: 'example.plugin',
        sourceRef: 'source-1',
        sourceRevisionOrEpoch: 'rev-1',
        admittedPermissionCeiling: 'read-only' as const,
        remoteApprovalMaxScope: 'request' as const,
      },
    };
    expect(combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a', causalPermissionAuthority: authority },
      { text: 'two', localId: 'b', causalPermissionAuthority: authority },
    ] as any)).toMatchObject({ causalPermissionAuthority: authority });
  });

  it('rejects an invalid batch containing multiple structured prompts instead of discarding later context', () => {
    expect(() => combinePermissionModeQueuedPrompts([
      {
        text: 'first structured prompt',
        localId: 'structured-1',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'first', path: '/skills/first/SKILL.md' }],
        },
      },
      {
        text: 'second structured prompt',
        localId: 'structured-2',
        structuredInput: {
          v: 1,
          skillMentions: [{ name: 'second', path: '/skills/second/SKILL.md' }],
        },
      },
    ])).toThrow('Cannot combine multiple structured prompts');
  });

  it('leaves userMessageSeq unset when no prompt in the batch carries one', () => {
    const combined = combinePermissionModeQueuedPrompts([
      { text: 'one', localId: 'a' },
      { text: 'two', localId: null },
    ]);
    expect(combined.userMessageSeq ?? null).toBeNull();
  });
});
