import { describe, expect, it, vi, afterEach } from 'vitest';

import {
  ensurePendingTerminalConnectReadyForApproval,
  waitForTerminalConnectReadySurface,
  type TerminalConnectApprovalReadyPage,
} from './terminalConnectApprovalFlow';

type SurfaceCounts = Readonly<{
  restore?: readonly number[];
  brandHero?: readonly number[];
  welcomePrimary?: readonly number[];
  approve?: readonly number[];
  approveRole?: readonly number[];
  firstTimeRole?: readonly number[];
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
        if (selector === '[data-testid="brand-hero-get-started"]:visible') {
          return readCount('brandHero');
        }
        if (selector === '[data-testid="welcome-primary-start"]:visible') {
          return readCount('welcomePrimary');
        }
        if (selector === '[data-testid="terminal-connect-approve"]:visible') {
          return readCount('approve');
        }
        return 0;
      },
    }),
    getByRole: (role: 'button', options: Readonly<{ name: string; exact?: boolean }>) => ({
      count: async () => {
        if (role === 'button' && options.name === 'Accept Connection') {
          return readCount('approveRole');
        }
        if (role === 'button' && options.name === "First time here — let's start") {
          return readCount('firstTimeRole');
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

  it('returns the approval surface when only the accessible accept button is visible', async () => {
    const page = createPage({ restore: [0], approve: [0], approveRole: [1] });
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
  });

  it('prefers an approval surface over a stale restore surface when both are visible', async () => {
    const page = createPage({ restore: [1], approve: [1] });

    await expect(waitForTerminalConnectReadySurface(page, 500)).resolves.toBe('approve');
  });

  it('treats the unauth welcome start surface as requiring account restoration before approval', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const page = {
      ...createPage({ welcomePrimary: [1] }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
    };

    await expect(waitForTerminalConnectReadySurface(page, 500)).resolves.toBe('restore');
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
    expect(gotoConnectUrl).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/terminal/connect#key=abc',
      expect.any(Number),
    );
    expect(page.waitForURL).toHaveBeenCalledTimes(1);
  });

  it('does not revisit the pending connect URL after the overall timeout budget is spent', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const waitForTimeout = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const page: TerminalConnectApprovalReadyPage = {
      locator: () => ({ count: async () => 0 }),
      getByRole: () => ({ count: async () => 0 }),
      waitForTimeout,
      waitForURL: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/terminal/connect',
    };
    const gotoConnectUrl = vi.fn(async () => {});
    const restoreAccount = vi.fn(async () => {});

    await expect(
      ensurePendingTerminalConnectReadyForApproval({
        page,
        connectUrlForBrowser: 'http://127.0.0.1:3000/terminal/connect#key=abc',
        gotoConnectUrl,
        restoreAccount,
        timeoutMs: 500,
      }),
    ).rejects.toThrow('terminal connect did not reach restore or approve surface');

    expect(gotoConnectUrl).not.toHaveBeenCalled();
    expect(restoreAccount).not.toHaveBeenCalled();
  });

  it('revisits the pending connect URL when the initial pending page stalls before showing restore or approve', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    let revisited = false;
    let restored = false;
    const waitForTimeout = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const timeoutPage: TerminalConnectApprovalReadyPage = {
      locator: (selector: string) => ({
        count: async () => {
          if (!revisited) return 0;
          if (selector === '[data-testid="welcome-restore"]:visible') return restored ? 0 : 1;
          if (selector === '[data-testid="terminal-connect-approve"]:visible') return restored ? 1 : 0;
          return 0;
        },
      }),
      waitForTimeout,
      waitForURL: vi.fn(async (matcher) => {
        expect(matcher(new URL('http://127.0.0.1:3000/terminal/connect'))).toBe(true);
      }),
    };
    const gotoConnectUrl = vi.fn(async () => {
      revisited = true;
    });
    const restoreAccount = vi.fn(async () => {
      restored = true;
    });

    await expect(
      ensurePendingTerminalConnectReadyForApproval({
        page: timeoutPage,
        connectUrlForBrowser: 'http://127.0.0.1:3000/terminal/connect#key=abc',
        gotoConnectUrl,
        restoreAccount,
        timeoutMs: 31_000,
      }),
    ).resolves.toBe('approve');

    expect(gotoConnectUrl).toHaveBeenCalledTimes(2);
    expect(restoreAccount).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a future URL event when the current URL is already the terminal route', async () => {
    let restored = false;
    const page: TerminalConnectApprovalReadyPage & { url: () => string } = {
      locator: (selector: string) => ({
        count: async () => {
          if (selector === '[data-testid="welcome-restore"]:visible') return restored ? 0 : 1;
          if (selector === '[data-testid="terminal-connect-approve"]:visible') return restored ? 1 : 0;
          return 0;
        },
      }),
      getByRole: () => ({ count: async () => 0 }),
      waitForTimeout: vi.fn(async () => {}),
      waitForURL: vi.fn(async () => {
        throw new Error('should not wait for a future navigation');
      }),
      url: () => 'http://127.0.0.1:3000/terminal/connect',
    };
    const gotoConnectUrl = vi.fn(async () => {});
    const restoreAccount = vi.fn(async () => {
      restored = true;
    });

    await expect(
      ensurePendingTerminalConnectReadyForApproval({
        page,
        connectUrlForBrowser: 'http://127.0.0.1:3000/terminal/connect#key=abc',
        gotoConnectUrl,
        restoreAccount,
      }),
    ).resolves.toBe('approve');

    expect(page.waitForURL).not.toHaveBeenCalled();
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
