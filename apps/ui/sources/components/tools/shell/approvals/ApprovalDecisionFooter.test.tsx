import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ApprovalDecisionFooter } from './ApprovalDecisionFooter';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

afterEach(standardCleanup);

describe('ApprovalDecisionFooter', () => {
  it('withholds approval independently while keeping the actual rejection handler available', async () => {
    const approve = vi.fn(); const reject = vi.fn();
    const screen = await renderScreen(<ApprovalDecisionFooter isDeciding={false} approveDisabled
      onApprove={approve} onReject={reject} />);
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(false);
    await screen.pressByTestIdAsync('approval-prompt-reject');
    expect(reject).toHaveBeenCalledOnce(); expect(approve).not.toHaveBeenCalled();
    expect(screen.findByTestId('approval-prompt-dismiss')).toBeNull();
  });

  it('blocks competing decisions while the answer is in flight', async () => {
    const decide = vi.fn();
    const screen = await renderScreen(<ApprovalDecisionFooter isDeciding onApprove={decide} onReject={decide} />);
    expect(screen.findByTestId('approval-prompt-approve')?.props.disabled).toBe(true);
    expect(screen.findByTestId('approval-prompt-reject')?.props.disabled).toBe(true);
    await screen.pressByTestIdAsync('approval-prompt-approve');
    await screen.pressByTestIdAsync('approval-prompt-reject');
    expect(decide).not.toHaveBeenCalled();
  });

  it('withdraws inactive answer controls and explains sharing denial without exposing a decision', async () => {
    const decide = vi.fn();
    const screen = await renderScreen(<ApprovalDecisionFooter isDeciding={false} disabledReason="inactive"
      onApprove={decide} onReject={decide} />);
    expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
    await act(async () => { screen.update(<ApprovalDecisionFooter isDeciding={false} disabled disabledReason="notGranted"
      onApprove={decide} onReject={decide} />); });
    expect(screen.findByTestId('approval-prompt-approve')).toBeNull();
    expect(screen.findByTestId('approval-prompt-reject')).toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});
