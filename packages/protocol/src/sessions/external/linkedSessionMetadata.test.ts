import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';
import {
  deriveExternalSessionAttentionHasUnread,
  markExternalSessionAttentionUnreadV1,
} from '../index.js';

describe('direct session linked metadata helpers', () => {
  it('normalizes legacy directSessionV1 metadata to canonical externalSessionV1', () => {
    expect(typeof (protocol as any).readLinkedExternalSessionV1FromMetadata).toBe('function');
    expect(typeof (protocol as any).normalizeLinkedExternalSessionMetadataV1).toBe('function');

    const metadata = {
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 42,
      },
    };

    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toEqual({
      v: 1,
      agentId: 'claude',
      machineId: 'machine-legacy',
      remoteSessionId: 'remote-legacy',
      source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      linkedAtMs: 42,
    });
    expect((protocol as any).normalizeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      directSessionV1: metadata.directSessionV1,
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 42,
      },
    });
  });

  it('prefers canonical externalSessionV1 over legacy directSessionV1 metadata', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-canonical',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toEqual(metadata.externalSessionV1);
    expect((protocol as any).normalizeLinkedExternalSessionMetadataV1(metadata)).toBe(metadata);
  });

  it('fails closed when canonical and deployed linked-session identities conflict', () => {
    const metadata = {
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        providerId: 'claude',
        machineId: 'machine-conflict',
        remoteSessionId: 'remote-conflict',
        source: { kind: 'codexHome', home: 'user' },
      },
    };

    expect((protocol as any).readLinkedExternalSessionV1FromMetadata(metadata)).toBeNull();
  });

  it('removes canonical and legacy linked external session metadata', () => {
    expect(typeof (protocol as any).removeLinkedExternalSessionMetadataV1).toBe('function');

    const metadata = {
      path: '/tmp/project',
      externalSessionV1: {
        v: 1,
        agentId: 'codex',
        machineId: 'machine-canonical',
        remoteSessionId: 'remote-canonical',
        source: { kind: 'codexHome', home: 'user' },
      },
      directSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-legacy',
        remoteSessionId: 'remote-legacy',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    };

    expect((protocol as any).removeLinkedExternalSessionMetadataV1(metadata)).toEqual({
      path: '/tmp/project',
    });
  });

  it('normalizes and rebuilds follow policy metadata', () => {
    expect(typeof (protocol as any).readExternalSessionFollowPolicyV1).toBe('function');
    expect(typeof (protocol as any).buildExternalSessionFollowPolicyV1).toBe('function');

    const parsed = (protocol as any).readExternalSessionFollowPolicyV1({
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
    expect((protocol as any).buildExternalSessionFollowPolicyV1(parsed)).toEqual({
      v: 1,
      policy: 'background_follow',
      updatedAtMs: 42,
    });
  });

  it('derives observed progress and advances attention without clobbering viewed markers', () => {
    expect(typeof (protocol as any).deriveExternalSessionObservedProgress).toBe('function');
    expect(typeof (protocol as any).applyObservedProgressToExternalSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).buildExternalSessionAttentionV1).toBe('function');

    const progress = (protocol as any).deriveExternalSessionObservedProgress([
      { id: 'msg-2', createdAtMs: 20 },
    ]);

    expect(progress).toEqual({
      token: '20:msg-2',
      atMs: 20,
    });

    const nextAttention = (protocol as any).applyObservedProgressToExternalSessionAttentionV1({
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
    expect((protocol as any).buildExternalSessionAttentionV1(nextAttention)).toEqual({
      v: 1,
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '10:msg-1',
      observedAtMs: 20,
      viewedAtMs: 10,
    });
  });

  it('derives same-timestamp observed progress deterministically regardless of batch order', () => {
    const derive = (protocol as any).deriveExternalSessionObservedProgress;

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
    const apply = (protocol as any).applyObservedProgressToExternalSessionAttentionV1;

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
    expect(typeof (protocol as any).readExternalSessionAttentionV1).toBe('function');
    expect(typeof (protocol as any).markExternalSessionAttentionViewedV1).toBe('function');
    expect(typeof (protocol as any).deriveExternalSessionAttentionHasUnread).toBe('function');

    const attention = (protocol as any).readExternalSessionAttentionV1({
      v: 1,
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });

    expect((protocol as any).deriveExternalSessionAttentionHasUnread(attention)).toBe(true);

    const viewed = (protocol as any).markExternalSessionAttentionViewedV1(attention);
    expect(viewed).toEqual({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });
    expect((protocol as any).deriveExternalSessionAttentionHasUnread(viewed)).toBe(false);
  });

  it('marks viewed direct-session attention unread by clearing viewed progress only', () => {
    const unread = markExternalSessionAttentionUnreadV1({
      observedProgressToken: '20:msg-2',
      viewedProgressToken: '20:msg-2',
      observedAtMs: 20,
      viewedAtMs: 20,
    });

    expect(unread).toEqual({
      observedProgressToken: '20:msg-2',
      observedAtMs: 20,
    });
    expect(deriveExternalSessionAttentionHasUnread(unread)).toBe(true);
  });

  it('does not invent unread direct-session attention without observed progress', () => {
    expect(markExternalSessionAttentionUnreadV1(null)).toBeNull();
    expect(markExternalSessionAttentionUnreadV1({
      viewedProgressToken: '20:msg-2',
      viewedAtMs: 20,
    })).toEqual({
      viewedProgressToken: '20:msg-2',
      viewedAtMs: 20,
    });
  });
});
