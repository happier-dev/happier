import { afterEach, describe, expect, it, vi } from 'vitest';

import { approveTerminalConnect, type TerminalConnectApprovePage } from './approveTerminalConnect';

type FakeLocator = ReturnType<TerminalConnectApprovePage['locator']>;

function createLocator(params: Readonly<{
  count: () => number;
  onClick?: (options?: Parameters<FakeLocator['click']>[0]) => void;
}>): FakeLocator {
  // Like a real Locator, this re-resolves the selector after the UI changes.
  const evaluate = async <T,>(callback: (element: HTMLElement) => T | Promise<T>): Promise<T> => {
    if (params.count() === 0) throw new Error('locator.evaluate timed out waiting for the removed button');
    return await callback({ click: () => params.onClick?.() } as HTMLElement);
  };

  const locator = {
    count: async () => params.count(),
    click: vi.fn(async (options?: Parameters<FakeLocator['click']>[0]) => {
      params.onClick?.(options);
    }),
    evaluate,
  };
  return locator;
}

function createPage(params: Readonly<{
  visibleTestIdCount?: () => number;
  hiddenTestIdCount?: () => number;
  approvalEnabled?: () => boolean;
  waitForTimeout?: TerminalConnectApprovePage['waitForTimeout'];
  roleCount?: () => number;
  confirmCount?: () => number;
  continueCount?: () => number;
  onContinueClick?: (options?: Parameters<FakeLocator['click']>[0]) => void;
  onConfirmClick?: (options?: Parameters<FakeLocator['click']>[0]) => void;
  onVisibleClick?: () => void;
  onRoleClick?: () => void;
  waitForURL?: TerminalConnectApprovePage['waitForURL'];
}>): TerminalConnectApprovePage {
  return {
    locator: (selector: string) => {
      const approveSelector = '[data-testid="terminal-connect-approve"]:visible';
      const enabledApproveSelector = `${approveSelector}:not(:disabled):not([aria-disabled="true"])`;
      if (selector === approveSelector || selector === enabledApproveSelector) {
        return createLocator({
          count: () => selector === enabledApproveSelector && params.approvalEnabled?.() === false
            ? 0
            : params.visibleTestIdCount?.() ?? 0,
          onClick: params.onVisibleClick,
        });
      }
      if (selector === '[data-testid="terminal-connect-continue"]:visible') {
        return createLocator({
          count: params.continueCount ?? (() => 0),
          onClick: params.onContinueClick,
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
    }),
    waitForTimeout: params.waitForTimeout ?? vi.fn(async () => {}),
    waitForURL: params.waitForURL,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('approveTerminalConnect', () => {
  it('continues after a browser click replaces the approval button', async () => {
    let approved = false;
    let acknowledged = false;
    let routeVerified = false;
    const page = createPage({
      visibleTestIdCount: () => approved ? 0 : 1,
      onVisibleClick: () => { approved = true; },
      continueCount: () => approved && !acknowledged ? 1 : 0,
      onContinueClick: (options) => {
        acknowledged = true;
        if (options?.noWaitAfter !== true) throw new Error('scheduled navigation is still loading');
      },
      waitForURL: async () => {
        expect(acknowledged).toBe(true);
        routeVerified = true;
      },
    });
    await approveTerminalConnect({ page, timeoutMs: 1_000 });
    expect(routeVerified).toBe(true);
  });

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

  it('acknowledges approval after the busy button disappears without clicking it again', async () => {
    let submitted = false;
    let acknowledged = false;
    let waitsAfterSubmit = 0;
    const busy = () => submitted && waitsAfterSubmit < 8;
    const page = createPage({
      visibleTestIdCount: () => !submitted || busy() ? 1 : 0,
      approvalEnabled: () => !submitted,
      onVisibleClick: () => {
        if (submitted) throw new Error('disabled approval cannot be clicked');
        submitted = true;
      },
      waitForTimeout: async () => { if (submitted) waitsAfterSubmit += 1; },
      continueCount: () => submitted && !busy() && !acknowledged ? 1 : 0,
      onContinueClick: () => { acknowledged = true; },
      waitForURL: async () => {
        if (!acknowledged) throw new Error('still on terminal connect');
      },
    });

    await approveTerminalConnect({ page, timeoutMs: 1_000 });
    expect(acknowledged).toBe(true);
  });

  it('accepts confirmed CLI authentication when the browser loses the approval surface without navigating', async () => {
    let approvalVisible = true;
    let resolveCliAuthentication!: () => void;
    const cliAuthentication = new Promise<void>(resolve => {
      resolveCliAuthentication = resolve;
    });
    const page = createPage({
      visibleTestIdCount: () => approvalVisible ? 1 : 0,
      onVisibleClick: () => {
        approvalVisible = false;
        resolveCliAuthentication();
      },
      waitForURL: async () => { throw new Error('still on the terminal connect route'); },
    });

    await expect(approveTerminalConnect({
      page, timeoutMs: 1_000, cliAuthentication,
    })).resolves.toBeUndefined();
  });
});
