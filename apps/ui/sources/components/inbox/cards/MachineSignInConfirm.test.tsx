import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { InboxMachineSignInTarget } from '@/components/inbox/inboxItems';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
vi.mock('@/text', async () => {
  const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
  return createTextModuleMock({ translate: (key) => key });
});
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

afterEach(() => {
  standardCleanup();
});

const { MachineSignInConfirm } = await import('./MachineSignInConfirm');
const { Modal } = await import('@/modal');

const target: InboxMachineSignInTarget = {
  kind: 'managed_machine_sign_in_approval',
  serverId: 'home-a',
  requesterAccountId: 'account-a',
  homeId: 'home-id',
  managedId: 'managed-1',
  operationId: 'operation-1',
  taskId: 'task-1',
};
const BUTTON = 'row.confirm';

describe('confirming a machine sign-in from the Inbox', () => {
  it('answers the exact occurrence once, stays busy while it runs, and is gone once confirmed', async () => {
    const answer = createDeferred<ActionExecuteResult>();
    const confirm = vi.fn(() => answer.promise);
    const screen = await renderScreen(
      <MachineSignInConfirm
        target={target}
        confirm={confirm}
        testID={BUTTON}
      />,
    );
    await screen.pressByTestIdAsync(BUTTON);
    expect(confirm).toHaveBeenCalledWith(target);
    expect(
      screen.findHostByTestId(BUTTON)?.props.accessibilityState?.disabled,
    ).toBe(true);
    await screen.pressByTestIdAsync(BUTTON);
    expect(confirm).toHaveBeenCalledOnce();
    answer.resolve({ ok: true, result: { ok: true } });
    await vi.waitFor(() => expect(screen.findHostByTestId(BUTTON)).toBeFalsy());
    expect(Modal.alert).not.toHaveBeenCalled();
  });

  it('says a typed refusal through the shared failure presentation and offers the action again', async () => {
    const confirm = vi.fn(async (): Promise<ActionExecuteResult> => ({
      ok: false,
      errorCode: 'no_prompt',
      error: 'no_prompt',
    }));
    const screen = await renderScreen(
      <MachineSignInConfirm
        target={target}
        confirm={confirm}
        testID={BUTTON}
      />,
    );
    await screen.pressByTestIdAsync(BUTTON);
    await vi.waitFor(() => expect(Modal.alert).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        screen.findHostByTestId(BUTTON)?.props.accessibilityState?.disabled,
      ).toBe(false),
    );
  });
});
