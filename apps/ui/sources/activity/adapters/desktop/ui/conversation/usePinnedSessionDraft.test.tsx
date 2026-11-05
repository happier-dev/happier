// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

/**
 * The overlay ↔ main window action channel (N4 M6) is the IPC boundary: the watch pushes snapshots of
 * the Session's draft, and each `text.set` write settles when the test releases it.
 */
const ipc = vi.hoisted(() => ({
  watchers: new Map<
    string,
    (snapshot: { revision: number; text: string } | null) => void
  >(),
  writes: [] as Array<{
    sessionId: string;
    text: string;
    expectedRevision: number;
    settle: (revision: number) => void;
  }>,
}));
vi.mock('../../runtime/desktopActivityOverlayActions', () => ({
  watchDesktopActivityOverlaySessionDraft: async (
    target: { sessionId: string },
    onSnapshot: (snapshot: { revision: number; text: string } | null) => void,
  ) => {
    ipc.watchers.set(target.sessionId, onSnapshot);
    return async () => {
      ipc.watchers.delete(target.sessionId);
    };
  },
  executeDesktopActivityOverlayAction: (input: {
    request: {
      input: {
        ref: { sessionId: string };
        transaction: {
          expectedRevision: number;
          operations: Array<{ text: string }>;
        };
      };
    };
  }) => {
    const { ref, transaction } = input.request.input;
    return new Promise((resolve) => {
      ipc.writes.push({
        sessionId: ref.sessionId,
        text: transaction.operations[0]!.text,
        expectedRevision: transaction.expectedRevision,
        settle: (revision) =>
          resolve({ ok: true, result: { status: 'applied', revision } }),
      });
    });
  },
}));

type Target = Readonly<{
  serverId: string;
  accountId: string;
  sessionId: string;
}>;

async function renderDraft(initial: Target) {
  const { usePinnedSessionDraft } = await import('./usePinnedSessionDraft');
  const handle: {
    draft: ReturnType<typeof usePinnedSessionDraft> | null;
    retarget: (target: Target) => void;
  } = {
    draft: null,
    retarget: () => {},
  };
  function Host() {
    const [target, setTarget] = React.useState(initial);
    // The caller rebuilds the qualified target object on every render, as the route does.
    handle.draft = usePinnedSessionDraft({
      serverId: target.serverId,
      accountId: target.accountId,
      sessionId: target.sessionId,
    });
    handle.retarget = setTarget;
    return null;
  }
  await renderScreen(<Host />);
  await flushHookEffects();
  return {
    handle,
    type: async (text: string) => {
      await act(async () => {
        handle.draft!.setText(text);
      });
    },
    push: async (sessionId: string, revision: number, text: string) => {
      await act(async () => {
        ipc.watchers.get(sessionId)?.({ revision, text });
      });
    },
    settle: async (index: number, revision: number) => {
      await act(async () => {
        ipc.writes[index]!.settle(revision);
        await Promise.resolve();
      });
      await flushHookEffects();
    },
  };
}

const flake: Target = {
  serverId: 'home-1',
  accountId: 'account-1',
  sessionId: 'bot-flake',
};

describe('usePinnedSessionDraft', () => {
  it('drains an edit queued behind a slow write even though every render rebuilds the target', async () => {
    ipc.writes = [];
    const draft = await renderDraft(flake);
    await draft.push('bot-flake', 1, '');

    await draft.type('a');
    await draft.type('ab');
    // The owner echoes the first write before its result arrives; the newer local text stays.
    await draft.push('bot-flake', 2, 'a');
    expect(draft.handle.draft!.text).toBe('ab');
    await draft.settle(0, 2);

    expect(
      ipc.writes.map(({ sessionId, text, expectedRevision }) => ({
        sessionId,
        text,
        expectedRevision,
      })),
    ).toEqual([
      { sessionId: 'bot-flake', text: 'a', expectedRevision: 1 },
      { sessionId: 'bot-flake', text: 'ab', expectedRevision: 2 },
    ]);
  });

  it('keeps writing text already entered for a Bot after switching to another Bot', async () => {
    ipc.writes = [];
    const draft = await renderDraft(flake);
    await draft.push('bot-flake', 1, '');
    await draft.type('a');
    await draft.type('ab');

    await act(async () => {
      draft.handle.retarget({ ...flake, sessionId: 'bot-release' });
    });
    await flushHookEffects();
    await draft.push('bot-release', 4, 'Ship it');
    expect(draft.handle.draft!.text).toBe('Ship it');
    await draft.settle(0, 2);

    expect(
      ipc.writes.map(({ sessionId, text }) => ({ sessionId, text })),
    ).toEqual([
      { sessionId: 'bot-flake', text: 'a' },
      { sessionId: 'bot-flake', text: 'ab' },
    ]);
  });
});
