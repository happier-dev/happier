import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import type { InboxMachineSignInTarget } from '@/components/inbox/inboxItems';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
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
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

afterEach(() => {
  standardCleanup();
});

const { MachineSignInAction, MachineSignInFailureLine, useMachineSignInConfirmation } = await import('./MachineSignInConfirm');
const { Modal } = await import('@/modal');

const target: InboxMachineSignInTarget = {
  kind: 'managed_machine_sign_in_approval', serverId: 'home-a', requesterAccountId: 'account-a',
  homeId: 'home-id', managedId: 'managed-1', operationId: 'operation-1', taskId: 'task-1',
};
const BUTTON = 'row.confirm';

/** The two slots the Inbox row places: the action, and the failure line beneath the row's text. */
function Row(props: Readonly<{ confirm: (target: InboxMachineSignInTarget) => Promise<ActionExecuteResult>; onOpen?: () => void }>) {
  const confirmation = useMachineSignInConfirmation(target, props.confirm);
  return <>
    <MachineSignInAction confirmation={confirmation} onOpen={props.onOpen ?? (() => {})} testID={BUTTON} />
    {confirmation.failure ? <MachineSignInFailureLine failure={confirmation.failure} testID="row.failure" /> : null}
  </>;
}

describe('confirming a machine sign-in from the Inbox', () => {
  it('answers the exact occurrence once, stays busy while it runs, and is gone once confirmed', async () => {
    const answer = createDeferred<ActionExecuteResult>();
    const confirm = vi.fn(() => answer.promise);
    const screen = await renderScreen(<Row confirm={confirm} />);
    await screen.pressByTestIdAsync(BUTTON);
    expect(confirm).toHaveBeenCalledWith(target);
    expect(screen.findHostByTestId(BUTTON)?.props.accessibilityState?.disabled).toBe(true);
    await screen.pressByTestIdAsync(BUTTON);
    expect(confirm).toHaveBeenCalledOnce();
    answer.resolve({ ok: true, result: { ok: true } });
    await vi.waitFor(() => expect(screen.findHostByTestId(BUTTON)).toBeFalsy());
    expect(Modal.alert).not.toHaveBeenCalled();
  });

  it('settles an expired sign-in on the row with its cause, its code behind the toggle and Retry setup, never an alert', async () => {
    const onOpen = vi.fn();
    const confirm = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: false, errorCode: 'auth_request_expired', error: 'auth_request_expired' }));
    const screen = await renderScreen(<Row confirm={confirm} onOpen={onOpen} />);
    await screen.pressByTestIdAsync(BUTTON);
    await vi.waitFor(() => expect(screen.findByTestId('row.failure')).toBeTruthy());
    expect(screen.getTextContent()).toContain('machineSignIn.notConfirmed');
    expect(screen.getTextContent()).toContain('machineSignIn.causeExpired');
    expect(screen.getTextContent()).not.toContain('common.requestFailed');
    expect(screen.findByTestId('row.failure.details')).toBeTruthy();
    expect(screen.findHostByTestId(BUTTON)).toBeFalsy();
    await screen.pressByTestIdAsync(`${BUTTON}.next`);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(Modal.alert).not.toHaveBeenCalled();
  });

  it('never says a generic "Request failed" for a cause the presenter cannot word: the code stays in the details', async () => {
    const confirm = vi.fn(async (): Promise<ActionExecuteResult> => ({ ok: false, errorCode: 'managed_response_invalid', error: 'managed_response_invalid' }));
    const screen = await renderScreen(<Row confirm={confirm} />);
    await screen.pressByTestIdAsync(BUTTON);
    await vi.waitFor(() => expect(screen.findByTestId('row.failure')).toBeTruthy());
    expect(screen.getTextContent()).not.toContain('common.requestFailed');
    expect(screen.findByTestId(`${BUTTON}.next`)).toBeTruthy();
    expect(Modal.alert).not.toHaveBeenCalled();
  });
});
