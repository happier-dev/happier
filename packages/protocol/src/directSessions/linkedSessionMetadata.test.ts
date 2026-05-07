import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

const exportedProtocol = protocol as Record<string, unknown>;

describe('direct session linked metadata helpers', () => {
  it('normalizes and rebuilds follow policy metadata', () => {
    expect(typeof exportedProtocol.readDirectSessionFollowPolicyV1).toBe('function');
    expect(typeof exportedProtocol.buildDirectSessionFollowPolicyV1).toBe('function');

    const readFollowPolicy = exportedProtocol.readDirectSessionFollowPolicyV1 as (value: unknown) => unknown;
    const buildFollowPolicy = exportedProtocol.buildDirectSessionFollowPolicyV1 as (value: unknown) => unknown;

    const parsed = readFollowPolicy({
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
    expect(buildFollowPolicy(parsed)).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
  });

  it('derives observed progress and advances attention without clobbering viewed markers', () => {
    expect(typeof exportedProtocol.deriveDirectSessionObservedProgress).toBe('function');
    expect(typeof exportedProtocol.applyObservedProgressToDirectSessionAttentionV1).toBe('function');
    expect(typeof exportedProtocol.buildDirectSessionAttentionV1).toBe('function');

    const deriveProgress = exportedProtocol.deriveDirectSessionObservedProgress as (items: unknown[]) => unknown;
    const applyProgress = exportedProtocol.applyObservedProgressToDirectSessionAttentionV1 as (
      current: unknown,
      progress: unknown,
    ) => unknown;
    const buildAttention = exportedProtocol.buildDirectSessionAttentionV1 as (value: unknown) => unknown;

    const progress = deriveProgress([
      { id: 'msg-2', createdAtMs: 20 },
    ]);

    expect(progress).toEqual({
      token: '20:msg-2',
      atMs: 20,
    });

    const nextAttention = applyProgress({
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
    expect(buildAttention(nextAttention)).toEqual({
      v: 1,
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
  });

  it('derives same-timestamp observed progress deterministically regardless of batch order', () => {
    const deriveProgress = exportedProtocol.deriveDirectSessionObservedProgress as (items: unknown[]) => unknown;

    const first = deriveProgress([
      { id: 'msg-b', createdAtMs: 20 },
      { id: 'msg-a', createdAtMs: 20 },
    ]);
    const second = deriveProgress([
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
    const applyProgress = exportedProtocol.applyObservedProgressToDirectSessionAttentionV1 as (
      current: unknown,
      progress: unknown,
    ) => unknown;

    const current = {
      observedProgressToken: '20:msg-b',
      viewedProgressToken: '20:msg-a',
      observedAtMs: 20,
      viewedAtMs: 20,
    };

    expect(applyProgress(current, {
      token: '20:msg-a',
      atMs: 20,
    })).toEqual(current);

    expect(applyProgress(current, {
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
    expect(typeof exportedProtocol.readDirectSessionAttentionV1).toBe('function');
    expect(typeof exportedProtocol.markDirectSessionAttentionViewedV1).toBe('function');
    expect(typeof exportedProtocol.deriveDirectSessionAttentionHasUnread).toBe('function');

    const readAttention = exportedProtocol.readDirectSessionAttentionV1 as (value: unknown) => unknown;
    const markViewed = exportedProtocol.markDirectSessionAttentionViewedV1 as (value: unknown) => unknown;
    const hasUnread = exportedProtocol.deriveDirectSessionAttentionHasUnread as (value: unknown) => unknown;

    const attention = readAttention({
      v: 1,
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });

    expect(hasUnread(attention)).toBe(true);

    const viewed = markViewed(attention);
    expect(viewed).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
    expect(hasUnread(viewed)).toBe(false);
  });
});
