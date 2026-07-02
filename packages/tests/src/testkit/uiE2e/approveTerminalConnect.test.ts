import { afterEach, describe, expect, it, vi } from 'vitest';

import { approveTerminalConnect, type TerminalConnectApprovePage } from './approveTerminalConnect';

type FakeLocator = ReturnType<TerminalConnectApprovePage['locator']>;

function createLocator(params: Readonly<{
  count: () => number;
  onClick?: () => void;
  onEvaluateClick?: () => void;
}>): FakeLocator {
  const evaluate: NonNullable<FakeLocator['evaluate']> = async <T,>(callback: (element: HTMLElement) => T | Promise<T>): Promise<T> =>
    await callback({ click: () => params.onEvaluateClick?.() } as HTMLElement);

  return {
    count: async () => params.count(),
    click: vi.fn(async () => {
      params.onClick?.();
    }),
    evaluate,
  };
}

function createPage(params: Readonly<{
  visibleTestIdCount?: () => number;
  hiddenTestIdCount?: () => number;
  roleCount?: () => number;
  confirmCount?: () => number;
  onConfirmClick?: () => void;
  onVisibleClick?: () => void;
  onVisibleEvaluateClick?: () => void;
  onRoleClick?: () => void;
  onRoleEvaluateClick?: () => void;
  waitForURL?: TerminalConnectApprovePage['waitForURL'];
}>): TerminalConnectApprovePage {
  return {
    locator: (selector: string) => {
      if (selector === '[data-testid="terminal-connect-approve"]:visible') {
        return createLocator({
          count: params.visibleTestIdCount ?? (() => 0),
          onClick: params.onVisibleClick,
          onEvaluateClick: params.onVisibleEvaluateClick,
        });
      }
      if (selector === '[data-testid="web-modal-confirm"]:visible') {
        return createLocator({
          count: params.confirmCount ?? (() => 0),
          onClick: params.onConfirmClick,
        });
      }
      if (selector === '[data-testid="web-modal-button-0"]:visible') {
        return createLocator({ count: () => 0 });
      }
      return createLocator({ count: () => 0 });
    },
    getByTestId: (testId: string) => createLocator({
      count: () => testId === 'terminal-connect-approve' ? params.hiddenTestIdCount?.() ?? 0 : 0,
    }),
    getByRole: (role: 'button', options: Readonly<{ name: string; exact?: boolean }>) => createLocator({
      count: () => role === 'button' && options.name === 'Accept Connection' ? params.roleCount?.() ?? 0 : 0,
      onClick: params.onRoleClick,
      onEvaluateClick: params.onRoleEvaluateClick,
    }),
    waitForTimeout: vi.fn(async () => {}),
    waitForURL: params.waitForURL,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approveTerminalConnect', () => {
  it('clicks the visible role button when a hidden test-id locator is present', async () => {
    let roleVisible = true;
    let roleClicks = 0;
    const page = createPage({
      hiddenTestIdCount: () => 1,
      visibleTestIdCount: () => 0,
      roleCount: () => roleVisible ? 1 : 0,
      onRoleClick: () => {
        roleClicks += 1;
        roleVisible = false;
      },
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(roleClicks).toBe(1);
  });

  it('retries approval clicks until the visible approval surface disappears', async () => {
    let visibleClicks = 0;
    const page = createPage({
      visibleTestIdCount: () => visibleClicks >= 2 ? 0 : 1,
      roleCount: () => 0,
      onVisibleClick: () => {
        visibleClicks += 1;
      },
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(visibleClicks).toBe(2);
  });

  it('continues retrying when approval temporarily disappears without leaving terminal connect', async () => {
    let roleClicks = 0;
    let approvalVisible = true;
    const waitForURL = vi.fn(async () => {
      if (roleClicks < 2) {
        approvalVisible = true;
        throw new Error('still on terminal connect');
      }
    });
    const page = createPage({
      roleCount: () => approvalVisible ? 1 : 0,
      onRoleClick: () => {
        roleClicks += 1;
        approvalVisible = false;
      },
      waitForURL,
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(roleClicks).toBe(2);
    expect(waitForURL).toHaveBeenCalled();
  });

  it('falls back to DOM activation when locator click does not trigger the approval action', async () => {
    let approvalVisible = true;
    let evaluateClicks = 0;
    const page = createPage({
      visibleTestIdCount: () => approvalVisible ? 1 : 0,
      roleCount: () => 0,
      onVisibleClick: () => {},
      onVisibleEvaluateClick: () => {
        evaluateClicks += 1;
        approvalVisible = false;
      },
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(evaluateClicks).toBe(1);
  });

  it('dismisses the success modal before waiting for terminal-connect navigation', async () => {
    let approvalVisible = true;
    let confirmVisible = false;
    let leftTerminalConnect = false;
    let confirmClicks = 0;
    const page = createPage({
      visibleTestIdCount: () => approvalVisible ? 1 : 0,
      roleCount: () => 0,
      confirmCount: () => confirmVisible ? 1 : 0,
      onVisibleClick: () => {
        approvalVisible = false;
        confirmVisible = true;
      },
      onConfirmClick: () => {
        confirmClicks += 1;
        confirmVisible = false;
        leftTerminalConnect = true;
      },
      waitForURL: vi.fn(async () => {
        if (!leftTerminalConnect) {
          throw new Error('success modal has not redirected yet');
        }
      }),
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(confirmClicks).toBe(1);
  });

  it('dismisses the success modal when the disabled approval surface remains mounted behind it', async () => {
    let approvalVisible = true;
    let confirmVisible = false;
    let leftTerminalConnect = false;
    let confirmClicks = 0;
    const page = createPage({
      visibleTestIdCount: () => approvalVisible ? 1 : 0,
      roleCount: () => 0,
      confirmCount: () => confirmVisible ? 1 : 0,
      onVisibleClick: () => {
        confirmVisible = true;
      },
      onConfirmClick: () => {
        confirmClicks += 1;
        confirmVisible = false;
        approvalVisible = false;
        leftTerminalConnect = true;
      },
      waitForURL: vi.fn(async () => {
        if (!leftTerminalConnect) {
          throw new Error('success modal has not redirected yet');
        }
      }),
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });

    expect(confirmClicks).toBe(1);
  });
});
