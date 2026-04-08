import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  ensurePendingTerminalConnectReadyForApproval,
  waitForTerminalConnectReadySurface,
  type TerminalConnectApprovalReadyPage,
} from './terminalConnectApprovalFlow';

type SurfaceCounts = Readonly<{
  restore?: readonly number[];
  approve?: readonly number[];
}>;

function createPage(surfaceCounts: SurfaceCounts): TerminalConnectApprovalReadyPage {
  const counters = new Map<string, number>();
  const readCount = (key: keyof SurfaceCounts): number => {
    const index = counters.get(key) ?? 0;
    counters.set(key, index + 1);
    const sequence = surfaceCounts[key] ?? [0];
    return sequence[Math.min(index, sequence.length - 1)] ?? 0;
  };

  return {
    locator: (selector: string) => ({
      count: async () => {
        if (selector === '[data-testid="welcome-restore"]:visible') {
          return readCount('restore');
        }
        if (selector === '[data-testid="terminal-connect-approve"]:visible') {
          return readCount('approve');
        }
        return 0;
      },
    }),
    waitForTimeout: vi.fn(async () => {}),
    waitForURL: vi.fn(async (matcher) => {
      expect(matcher(new URL('http://127.0.0.1:3000/terminal/connect'))).toBe(true);
    }),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('terminalConnectApprovalFlow', () => {
  it('returns the approval surface without revisiting the connect URL when approval is already visible', async () => {
    const page = createPage({ restore: [0], approve: [1] });
    const gotoConnectUrl = vi.fn(async () => {});
    const restoreAccount = vi.fn(async () => {});

    await expect(
      ensurePendingTerminalConnectReadyForApproval({
        page,
        connectUrlForBrowser: 'http://127.0.0.1:3000/terminal/connect#key=abc',
        gotoConnectUrl,
        restoreAccount,
      }),
    ).resolves.toBe('approve');

    expect(restoreAccount).not.toHaveBeenCalled();
    expect(gotoConnectUrl).not.toHaveBeenCalled();
    expect(page.waitForURL).not.toHaveBeenCalled();
  });

  it('revisits the pending connect URL after restore and waits for approval before returning', async () => {
    const page = createPage({ restore: [1, 0], approve: [0, 1] });
    const gotoConnectUrl = vi.fn(async () => {});
    const restoreAccount = vi.fn(async () => {});

    await expect(
      ensurePendingTerminalConnectReadyForApproval({
        page,
        connectUrlForBrowser: 'http://127.0.0.1:3000/terminal/connect#key=abc',
        gotoConnectUrl,
        restoreAccount,
      }),
    ).resolves.toBe('approve');

    expect(restoreAccount).toHaveBeenCalledTimes(1);
    expect(gotoConnectUrl).toHaveBeenCalledWith('http://127.0.0.1:3000/terminal/connect#key=abc');
    expect(page.waitForURL).toHaveBeenCalledTimes(1);
  });

  it('times out when neither restore nor approval surfaces appear', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const page = createPage({ restore: [0, 0, 0], approve: [0, 0, 0] });
    const waitForTimeout = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const timeoutPage: TerminalConnectApprovalReadyPage = {
      ...page,
      waitForTimeout,
    };

    await expect(waitForTerminalConnectReadySurface(timeoutPage, 500)).rejects.toThrow(
      'terminal connect did not reach restore or approve surface',
    );

    expect(waitForTimeout).toHaveBeenCalled();
  });
});
