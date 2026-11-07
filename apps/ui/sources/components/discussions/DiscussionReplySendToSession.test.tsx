import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';

// The Action front door is the UI's boundary to the Action runtime and its Home transport.
const execute = vi.fn();
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createFrontDoorActionExecute: () => execute,
}));

const { DiscussionReplySendToSession } =
  await import('./DiscussionReplySendToSession');
afterEach(() => {
  execute.mockReset();
  standardCleanup();
});

const SOURCE = {
  kind: 'discussion',
  serverId: 'server-a',
  discussionId: 'discussion-a',
  messageIds: ['reply-1'],
} as const;

function row(messageId: string) {
  return (
    <DiscussionReplySendToSession
      scope={{ serverId: 'server-a', accountId: 'account-a' }}
      sessionId="session-a"
      sessionName="Checkout UI"
      discussionId="discussion-a"
      messageId={messageId}
      prepare={() => ({
        text: 'Check the retry path',
        source: { ...SOURCE, messageIds: [messageId] },
      })}
    />
  );
}
const sentLocalIds = () =>
  execute.mock.calls.map((call) => (call[1] as { localId: string }).localId);

describe('DiscussionReplySendToSession', () => {
  it('settles in place, and Retry sends the exact same message again', async () => {
    execute
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'target_unavailable',
        error: 'target_unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { status: 'accepted', localId: 'x' },
      });
    const screen = await renderScreen(row('reply-1'));
    await screen.pressByTestIdAsync('discussion-reply-send:reply-1:send');
    expect(
      screen.findAllHostsByTestId('discussion-reply-send:reply-1:send'),
        ).toHaveLength(0);
    await screen.pressByTestIdAsync('discussion-reply-send:reply-1:retry');
    expect(
      screen.findAllHostsByTestId('discussion-reply-send:reply-1:retry'),
        ).toHaveLength(0);
    expect(
      screen.findByTestId('discussion-reply-send:reply-1:receipt'),
    ).toBeTruthy();
    const [first, second] = sentLocalIds();
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('an unknown outcome offers only a check, which is the same send, and a recycled row keeps its receipt', async () => {
    execute
      .mockResolvedValueOnce({
        ok: true,
        result: {
          status: 'outcomeUnknown',
          localId: 'x',
          code: 'transport_lost',
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        result: { status: 'alreadyAccepted', localId: 'x' },
      });
    const screen = await renderScreen(row('reply-2'));
    await screen.pressByTestIdAsync('discussion-reply-send:reply-2:send');
    await screen.pressByTestIdAsync('discussion-reply-send:reply-2:retry');
    const [first, second] = sentLocalIds();
    expect(second).toBe(first);
    act(() => screen.tree.unmount());
    const again = await renderScreen(row('reply-2'));
    expect(
      again.findByTestId('discussion-reply-send:reply-2:receipt'),
    ).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});
