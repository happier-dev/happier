import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

describe('direct session linked metadata helpers', () => {
  it('normalizes and rebuilds follow policy metadata', () => {
    expect(typeof (protocol as any).readDirectSessionFollowPolicyV1).toBe('function');
    expect(typeof (protocol as any).buildDirectSessionFollowPolicyV1).toBe('function');

    const parsed = (protocol as any).readDirectSessionFollowPolicyV1({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
      extra: 'ignored',
    });

    expect(parsed).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
    expect((protocol as any).buildDirectSessionFollowPolicyV1(parsed)).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
  });

  it('derives observed progress and advances attention without clobbering viewed markers', () => {
    expect(typeof (protocol as any).deriveDirectSessionObservedProgress).toBe('function');
    expect(typeof (protocol as any).applyObservedProgressToDirectSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).buildDirectSessionAttentionV1).toBe('function');

    const progress = (protocol as any).deriveDirectSessionObservedProgress([
      { id: 'msg-2', createdAtMs: 20 },
    ]);

    expect(progress).toEqual({
      token: '20:msg-2',
      atMs: 20,
    });

    const nextAttention = (protocol as any).applyObservedProgressToDirectSessionAttentionV1({
      observedProgressToken: '10:msg-1',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 10,
      viewedAtMs: 10,
    }, progress);

    expect(nextAttention).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
    expect((protocol as any).buildDirectSessionAttentionV1(nextAttention)).toEqual({
      v: 1,
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
  });

  it('derives same-timestamp observed progress deterministically regardless of batch order', () => {
    const derive = (protocol as any).deriveDirectSessionObservedProgress;

    const first = derive([
      { id: 'msg-b', createdAtMs: 20 },
      { id: 'msg-a', createdAtMs: 20 },
    ]);
    const second = derive([
      { id: 'msg-a', createdAtMs: 20 },
      { id: 'msg-b', createdAtMs: 20 },
    ]);

    expect(first).toEqual({
      token: '20:msg-b',
      atMs: 20,
    });
    expect(second).toEqual(first);
  });

  it('does not regress observed progress when a same-timestamp batch arrives out of order', () => {
    const apply = (protocol as any).applyObservedProgressToDirectSessionAttentionV1;

    const current = {
      observedProgressToken: '20:msg-b',
      viewedProgressToken: '20:msg-a',
      observedAtMs: 20,
      viewedAtMs: 20,
    };

    expect(apply(current, {
      token: '20:msg-a',
      atMs: 20,
    })).toEqual(current);

    expect(apply(current, {
      token: '20:msg-c',
      atMs: 20,
    })).toEqual({
      observedProgressToken: '20:msg-c',
      viewedProgressToken: '20:msg-a',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
  });

  it('marks attention viewed and derives unread from the normalized snapshot', () => {
    expect(typeof (protocol as any).readDirectSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).markDirectSessionAttentionViewedV1).toBe('function');
    expect(typeof (protocol as any).deriveDirectSessionAttentionHasUnread).toBe('function');

    const attention = (protocol as any).readDirectSessionAttentionV1({
      v: 1,
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });

    expect((protocol as any).deriveDirectSessionAttentionHasUnread(attention)).toBe(true);

    const viewed = (protocol as any).markDirectSessionAttentionViewedV1(attention);
    expect(viewed).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
    expect((protocol as any).deriveDirectSessionAttentionHasUnread(viewed)).toBe(false);
  });
});
