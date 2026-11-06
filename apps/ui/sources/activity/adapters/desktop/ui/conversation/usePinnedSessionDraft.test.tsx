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
    refuse: () => void;
    fail: () => void;
    invalidate: () => void;
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
    return new Promise((resolve, reject) => {
      ipc.writes.push({
        sessionId: ref.sessionId,
        text: transaction.operations[0]!.text,
        expectedRevision: transaction.expectedRevision,
        settle: (revision) =>
          resolve({ ok: true, result: { status: 'applied', revision } }),
        refuse: () => resolve({ ok: false, errorCode: 'target_unavailable', error: 'target_unavailable' }),
        fail: () => reject(Object.assign(new Error('IPC disconnected'), { code: 'ipc_disconnected' })),
        invalidate: () => resolve({ ok: true, result: { invalid: true } }),
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
    show: (visible: boolean) => void;
  } = {
    draft: null,
    retarget: () => {},
    show: () => {},
  };
  function Field({ target }: { target: Target }) {
    handle.draft = usePinnedSessionDraft({ ...target });
    return null;
  }
  function Host() {
    const [target, setTarget] = React.useState(initial);
    const [visible, setVisible] = React.useState(true);
    // The caller rebuilds the qualified target object on every render, as the route does.
    handle.retarget = setTarget;
    handle.show = setVisible;
    return visible ? <Field target={target} /> : null;
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
    await draft.settle(1, 3);
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
    await draft.settle(1, 3);
  });

  it('keeps a late send clear bound to its original Bot after retargeting', async () => {
    ipc.writes = [];
    const original = { ...flake, sessionId: 'late-send-original' };
    const next = { ...flake, sessionId: 'late-send-next' };
    const draft = await renderDraft(original);
    await draft.push(original.sessionId, 1, '');
    await draft.type('send this reply');
    // A send already in flight retains this callback when its composer unmounts on retarget.
    const clearSentDraft = draft.handle.draft!.setText;

    await act(async () => draft.handle.retarget(next));
    await flushHookEffects();
    await draft.push(next.sessionId, 4, 'saved next reply');
    await draft.type('keep the newest next reply');
    let stillCurrent = true;
    await act(async () => { stillCurrent = clearSentDraft(''); });

    expect(draft.handle.draft!.text).toBe('keep the newest next reply');
    expect(draft.handle.draft!.textRef.current).toBe('keep the newest next reply');
    expect(stillCurrent).toBe(false);
    await draft.settle(0, 2);
    expect(ipc.writes.map(({ sessionId, text }) => ({ sessionId, text }))).toEqual([
      { sessionId: original.sessionId, text: 'send this reply' },
      { sessionId: next.sessionId, text: 'keep the newest next reply' },
      { sessionId: original.sessionId, text: '' },
    ]);
    await draft.settle(1, 5);
    await draft.settle(2, 3);
  });

  it.each([
    ['refuse', 'target_unavailable'],
    ['fail', 'ipc_disconnected'],
    ['invalidate', 'invalid_action_output'],
  ] as const)('retains unsaved text through %s, close and retarget, and retries only on request', async (failure, code) => {
    ipc.writes = [];
    const target = { ...flake, sessionId: `recover-${failure}` };
    const draft = await renderDraft(target);
    await draft.push(target.sessionId, 1, 'saved');
    await draft.type('keep this reply');
    await act(async () => {
      ipc.writes[0]![failure]();
      await Promise.resolve();
    });
    await flushHookEffects();
    // An owner echo must not overwrite the unsaved local text after the failed write.
    await draft.push(target.sessionId, 2, 'saved elsewhere');
    expect(draft.handle.draft!.text).toBe('keep this reply');
    expect(draft.handle.draft!.writeError).toBe(code);
    expect(ipc.writes).toHaveLength(1);

    await act(async () => draft.handle.show(false));
    await flushHookEffects();
    await act(async () => draft.handle.show(true));
    await flushHookEffects();
    await draft.push(target.sessionId, 3, 'owner text');
    expect(draft.handle.draft!.text).toBe('keep this reply');
    expect(draft.handle.draft!.writeError).toBe(code);
    await act(async () => draft.handle.retarget({ ...target, sessionId: `other-${failure}` }));
    await flushHookEffects();
    await draft.push(`other-${failure}`, 4, 'other reply');
    expect(draft.handle.draft!.text).toBe('other reply');
    await act(async () => draft.handle.retarget(target));
    await flushHookEffects();
    await draft.push(target.sessionId, 5, 'owner text');
    expect(draft.handle.draft!.text).toBe('keep this reply');
    expect(ipc.writes).toHaveLength(1);
    await act(async () => draft.handle.draft!.retry());
    expect(ipc.writes[1]).toMatchObject({ text: 'keep this reply', expectedRevision: 5, sessionId: target.sessionId });
    await draft.settle(1, 6);
    expect(draft.handle.draft!.writeError).toBeNull();
    await draft.push(target.sessionId, 7, 'after recovery');
    expect(draft.handle.draft!.text).toBe('after recovery');
  });

  it('reattaches to an in-flight writer and retains the newest queued text when that write fails', async () => {
    ipc.writes = [];
    const target = { ...flake, sessionId: 'remount-in-flight' };
    const draft = await renderDraft(target);
    await draft.push(target.sessionId, 1, '');
    await draft.type('a');
    await act(async () => draft.handle.show(false));
    await flushHookEffects();
    await act(async () => draft.handle.show(true));
    await flushHookEffects();
    expect(draft.handle.draft!.text).toBe('a');
    await draft.type('ab');
    await act(async () => ipc.writes[0]!.refuse());
    await flushHookEffects();
    await draft.push(target.sessionId, 2, 'owner echo');
    expect(draft.handle.draft!.text).toBe('ab');
    expect(draft.handle.draft!.writeError).toBe('target_unavailable');
    expect(ipc.writes).toHaveLength(1);
    await act(async () => draft.handle.draft!.retry());
    expect(ipc.writes[1]).toMatchObject({ text: 'ab', expectedRevision: 2 });
    await draft.settle(1, 3);
  });
});
