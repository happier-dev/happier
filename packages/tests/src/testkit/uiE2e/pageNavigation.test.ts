import { describe, expect, it, vi } from 'vitest';
import {
  gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries,
  hasPathname,
  normalizeLoopbackBaseUrl,
} from './pageNavigation';
import * as pageNavigation from './pageNavigation';

type WaitForAuthenticatedHomeUiPage = Readonly<{
  getByTestId(testId: string): { count: () => Promise<number> };
  goto?: (_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>;
  reload: () => Promise<void>;
  url: () => string;
  waitForTimeout: (delayMs: number) => Promise<void>;
}>;

describe('gotoDomContentLoadedWithRetries', () => {
  it('falls back to localhost when the requested IPv4 loopback origin refuses connections', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockImplementation(async (url) => {
        if (url.startsWith('http://127.0.0.1:3000')) {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }
      });
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://127.0.0.1:3000');

    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(goto).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it('falls back to IPv6 loopback when localhost and IPv4 loopback both refuse connections', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockImplementation(async (url) => {
        if (url.startsWith('http://localhost:3000') || url.startsWith('http://127.0.0.1:3000')) {
          throw new Error('net::ERR_CONNECTION_REFUSED');
        }
      });
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://localhost:3000');

    expect(goto).toHaveBeenCalledTimes(3);
    expect(goto).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(goto).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(goto).toHaveBeenNthCalledWith(
      3,
      'http://[::1]:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it('treats navigation-interrupted errors as retryable and falls back to other loopback candidates', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockImplementation(async (url) => {
        if (url.startsWith('http://127.0.0.1:3000')) {
          throw new Error(
            'Navigation to "http://127.0.0.1:3000" is interrupted by another navigation to "http://localhost:3000".',
          );
        }
      });
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://127.0.0.1:3000');

    expect(goto).toHaveBeenCalledTimes(2);
    expect(goto).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(goto).toHaveBeenNthCalledWith(
      2,
      'http://localhost:3000',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(waitForTimeout).not.toHaveBeenCalled();
  });

  it('retries retryable network errors before succeeding', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(undefined);
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://localhost:3000');

    expect(goto).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('retries raw ECONNRESET transport errors before succeeding', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('read ECONNRESET'))
      .mockResolvedValueOnce(undefined);
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://localhost:3000');

    expect(goto).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('keeps retrying connection-refused navigations until the page becomes reachable', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const goto = vi.fn(async () => {
      const attempt = goto.mock.calls.length;
      if (attempt <= 12) {
        throw new Error('net::ERR_CONNECTION_REFUSED');
      }
    });
    const waitForTimeout = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await expect(gotoDomContentLoadedWithRetries(page as never, 'http://localhost:3000', 30_000)).resolves.toBeUndefined();

    expect(goto).toHaveBeenCalledTimes(13);
    expect(waitForTimeout).toHaveBeenCalled();
  });

  it('rejects a timed-out navigation when waiting for DOM content (even if the target URL committed)', async () => {
    const targetUrl = 'http://localhost:3000/';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => {}),
      url: () => targetUrl,
    };

    await expect(gotoDomContentLoadedWithRetries(page as never, targetUrl)).rejects.toThrow(/timeout/i);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('treats a timed-out navigation as usable once the expected pathname has committed', async () => {
    const targetUrl = 'http://localhost:3000/?server=http%3A%2F%2F127.0.0.1%3A1';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => {}),
      url: () => 'http://localhost:3000/',
    };

    await expect(gotoDomContentLoadedWithPathFallback(page as never, targetUrl, '/')).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('gotoCommittedWithRetries', () => {
  it('retries retryable network errors before succeeding', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'commit'; timeout: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(undefined);
    const waitForTimeout = vi.fn(async () => {});

    type PageStub = {
      goto: typeof goto;
      waitForTimeout: typeof waitForTimeout;
      url: () => string;
    };

    const page: PageStub = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    const helper = (pageNavigation as Record<string, unknown>).gotoCommittedWithRetries;
    expect(helper).toBeTypeOf('function');
    await expect((helper as (page: PageStub, url: string, timeoutMs?: number) => Promise<void>)(page, 'http://localhost:3000')).resolves.toBeUndefined();

    expect(goto).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('treats a timed-out navigation as usable once the target URL has committed', async () => {
    const targetUrl = 'http://localhost:3000/';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const waitForTimeout = vi.fn(async () => {});
    type PageStub = {
      goto: typeof goto;
      waitForTimeout: typeof waitForTimeout;
      url: () => string;
    };

    const page: PageStub = {
      goto,
      waitForTimeout,
      url: () => targetUrl,
    };

    const helper = (pageNavigation as Record<string, unknown>).gotoCommittedWithRetries;
    expect(helper).toBeTypeOf('function');
    await expect((helper as (page: PageStub, url: string, timeoutMs?: number) => Promise<void>)(page, targetUrl)).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeLoopbackBaseUrl', () => {
  it('preserves explicitly routable loopback hosts and only rewrites derived loopback aliases', () => {
    // Canonicalize loopback hosts to IPv4 to avoid flaky IPv6-only binds in CI/Metro.
    expect(normalizeLoopbackBaseUrl('http://127.0.0.1:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://localhost:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://[::1]:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://0.0.0.0:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://happier-transcript-rollout-unify-0405.localhost:60674/')).toBe(
      'http://127.0.0.1:60674',
    );
  });
});

describe('hasPathname', () => {
  it('matches the same route across loopback host variants', () => {
    expect(hasPathname('http://127.0.0.1:49801/v1/auth/external/github/finalize-keyless', '/v1/auth/external/github/finalize-keyless')).toBe(true);
    expect(hasPathname('http://localhost:49801/v1/auth/external/github/finalize-keyless', '/v1/auth/external/github/finalize-keyless')).toBe(true);
  });

  it('returns false for a different pathname', () => {
    expect(hasPathname('http://localhost:49801/v1/auth/external/github/params', '/v1/auth/external/github/finalize-keyless')).toBe(false);
  });
});

describe('waitForAuthenticatedHomeUi', () => {
  it('waits past connect_machine until the authenticated root exposes session actions after terminal-connect success', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [1, 1, 0, 0],
      'session-getting-started-kind-connect_machine': [1, 1, 1, 1],
      'session-getting-started-kind-create_session': [0, 0, 1, 1],
      'session-getting-started-kind-select_session': [0, 0, 1, 1],
      'setupWizard.surface': [0, 0, 0, 0],
    };
    const counts = new Map<string, number>();
    let sessionsTabActivated = false;
    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      if (key === 'session-getting-started-kind-select_session') {
        return sessionsTabActivated ? 1 : 0;
      }
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const page = {
      getByTestId: (testId: string) => ({ count: async () => nextCount(testId) }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => (nowMs < 250 ? 'http://127.0.0.1:3000/terminal/connect' : 'http://127.0.0.1:3000/'),
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(page.reload).not.toHaveBeenCalled();
    expect(counts.get('welcome-create-account')).toBeGreaterThanOrEqual(2);
    expect(counts.get('session-getting-started-kind-connect_machine')).toBeGreaterThanOrEqual(2);
    expect(counts.get('session-getting-started-kind-create_session')).toBeGreaterThanOrEqual(2);
    expect(nowMs).toBeGreaterThanOrEqual(500);
  });

  it('recovers to the sessions chooser when the authenticated root lands on the settings tab', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [0, 0, 0, 0],
      'session-getting-started-kind-connect_machine': [0, 0, 0, 0],
      'session-getting-started-kind-create_session': [0, 0, 1, 1],
      'session-getting-started-kind-select_session': [0, 0, 0, 0],
      'setupWizard.surface': [0, 0, 0, 0],
      'tabbar-tab-sessions': [1, 1, 1, 1],
    };
    const counts = new Map<string, number>();
    let nowMs = 0;
    let onSessionsTabClickCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => nextCount(testId),
        click: async () => {
          if (testId === 'tabbar-tab-sessions') {
            onSessionsTabClickCount += 1;
            testIdCounts['session-getting-started-kind-create_session'] = [0, 0, 0, 1];
            testIdCounts['session-getting-started-kind-select_session'] = [0, 0, 1, 1];
          }
        },
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(onSessionsTabClickCount).toBeGreaterThan(0);
    expect(counts.get('session-getting-started-kind-select_session')).toBeGreaterThanOrEqual(2);
  });

  it('retries the sessions tab switch when the first click fails before confirming navigation', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [0, 0, 0, 0, 0],
      'session-getting-started-kind-connect_machine': [0, 0, 0, 0, 0],
      'session-getting-started-kind-create_session': [0, 0, 0, 0, 0],
      'session-getting-started-kind-select_session': [0, 0, 0, 0, 0],
      'setupWizard.surface': [0, 0, 0, 0, 0],
      'tabbar-tab-sessions': [1, 1, 1, 1, 1],
    };
    const counts = new Map<string, number>();
    let nowMs = 0;
    let onSessionsTabClickCount = 0;
    let sessionsTabActivated = false;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      if (key === 'session-getting-started-kind-select_session') {
        return sessionsTabActivated ? 1 : 0;
      }
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => nextCount(testId),
        click: async () => {
          if (testId !== 'tabbar-tab-sessions') return;
          onSessionsTabClickCount += 1;
          if (onSessionsTabClickCount === 1) {
            throw new Error('intermittent click failure');
          }
          sessionsTabActivated = true;
        },
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(onSessionsTabClickCount).toBeGreaterThan(1);
    expect(sessionsTabActivated).toBe(true);
  });

  it('accepts the authenticated sessions list as home after restore', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [0, 0, 0, 0],
      'session-getting-started-kind-connect_machine': [0, 0, 0, 0],
      'session-getting-started-kind-create_session': [0, 0, 0, 0],
      'session-getting-started-kind-select_session': [0, 0, 0, 0],
      'main-header-start-new-session': [1, 1, 1, 1],
      'setupWizard.surface': [0, 0, 0, 0],
    };
    const counts = new Map<string, number>();
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => nextCount(testId),
        click: async () => {},
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(page.reload).not.toHaveBeenCalled();
    expect(counts.get('main-header-start-new-session')).toBeGreaterThanOrEqual(1);
  });

  it('dismisses an auto-open setup wizard before authenticated home markers render', async () => {
    let nowMs = 0;
    let setupWizardDismissed = false;
    let skipClickCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => {
          if (testId === 'welcome-create-account') return 0;
          if (testId === 'setupWizard.surface') return setupWizardDismissed ? 0 : 1;
          if (testId === 'setupWizard.surface-skip') return setupWizardDismissed ? 0 : 1;
          if (testId === 'main-header-start-new-session') return setupWizardDismissed ? 1 : 0;
          return 0;
        },
        click: async () => {
          if (testId === 'setupWizard.surface-skip') {
            skipClickCount += 1;
            setupWizardDismissed = true;
          }
        },
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(skipClickCount).toBe(1);
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('does not accept desktop shell chrome alone as authenticated home readiness', async () => {
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => {
          if (testId === 'welcome-create-account') return 0;
          if (testId === 'desktop-sidebar-chrome') return 1;
          return 0;
        },
        click: async () => {},
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).rejects.toThrow(/authenticated home ui/i);

    expect(page.reload).not.toHaveBeenCalled();
  });
});

describe('waitForAuthenticatedRouteUi', () => {
  it('waits for an authenticated route to expose its required test ids after storage-based restore', async () => {
    const counts = new Map<string, number>();
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const nextCount = (testId: string): number => {
      const index = counts.get(testId) ?? 0;
      counts.set(testId, index + 1);

      if (testId === 'welcome-create-account') {
        return nowMs < 500 ? 1 : 0;
      }

      if (testId === 'settings-provider-field-codexBackendMode') {
        return nowMs < 750 ? 0 : 1;
      }

      return 0;
    };

    const page = {
      getByTestId: (testId: string) => ({ count: async () => nextCount(testId) }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => (nowMs < 250
        ? 'http://127.0.0.1:3000/'
        : 'http://127.0.0.1:3000/settings/providers/codex'),
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedRouteUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{
          page: WaitForAuthenticatedHomeUiPage;
          expectedPathname: string;
          requiredTestIds: readonly string[];
          timeoutMs?: number;
          reloadOnFailure?: boolean;
        }>,
      ) => Promise<void>)({
        page,
        expectedPathname: '/settings/providers/codex',
        requiredTestIds: ['settings-provider-field-codexBackendMode'],
        timeoutMs: 2_000,
        reloadOnFailure: false,
      }),
    ).resolves.toBeUndefined();

    expect(page.reload).not.toHaveBeenCalled();
    expect(counts.get('welcome-create-account')).toBeGreaterThanOrEqual(2);
    expect(counts.get('settings-provider-field-codexBackendMode')).toBeGreaterThanOrEqual(2);
    expect(nowMs).toBeGreaterThanOrEqual(750);
  });

  it('revisits the original route when authenticated bootstrap falls back to home before the route becomes ready', async () => {
    let nowMs = 0;
    let restoredRoute = false;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => {
          if (testId === 'welcome-create-account') return 0;
          if (testId === 'settings.plugins.marketplace.catalogUrl') return restoredRoute ? 1 : 0;
          return 0;
        },
      }),
      goto: vi.fn(async () => {
        restoredRoute = true;
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => (
        restoredRoute || nowMs < 250
          ? 'http://127.0.0.1:3000/settings/plugins'
          : 'http://127.0.0.1:3000/'
      ),
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedRouteUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{
          page: WaitForAuthenticatedHomeUiPage;
          expectedPathname: string;
          requiredTestIds: readonly string[];
          timeoutMs?: number;
          reloadOnFailure?: boolean;
        }>,
      ) => Promise<void>)({
        page,
        expectedPathname: '/settings/plugins',
        requiredTestIds: ['settings.plugins.marketplace.catalogUrl'],
        timeoutMs: 500,
      }),
    ).resolves.toBeUndefined();

    expect(page.goto).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/settings/plugins',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(page.reload).not.toHaveBeenCalled();
  });

  it('uses an explicit target url when the page has already fallen back home before route waiting starts', async () => {
    let restoredRoute = false;
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => {
          if (testId === 'welcome-create-account') return restoredRoute ? 0 : 1;
          if (testId === 'new-session-composer-input') return restoredRoute ? 1 : 0;
          return 0;
        },
      }),
      goto: vi.fn(async () => {
        restoredRoute = true;
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => (
        restoredRoute
          ? 'http://127.0.0.1:3000/new'
          : 'http://127.0.0.1:3000/'
      ),
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedRouteUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{
          page: WaitForAuthenticatedHomeUiPage;
          expectedPathname: string;
          requiredTestIds: readonly string[];
          targetUrl?: string;
          timeoutMs?: number;
          reloadOnFailure?: boolean;
        }>,
      ) => Promise<void>)({
        page,
        expectedPathname: '/new',
        requiredTestIds: ['new-session-composer-input'],
        targetUrl: 'http://127.0.0.1:3000/new?happier_hmr=0',
        timeoutMs: 2_000,
      }),
    ).resolves.toBeUndefined();

    expect(page.goto).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/new?happier_hmr=0',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(page.reload).not.toHaveBeenCalled();
  });
});

describe('waitForSessionActionsHomeUi', () => {
  it('waits for the later home shell to expose session actions after terminal-connect', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [0, 0, 0, 0, 0],
      'session-getting-started-kind-connect_machine': [1, 1, 1, 1, 1],
      'session-getting-started-kind-create_session': [0, 0, 0, 1, 1],
      'session-getting-started-kind-select_session': [0, 0, 0, 1, 1],
      'setupWizard.surface': [0, 0, 0, 0, 0],
      'tabbar-tab-sessions': [1, 1, 1, 1, 1],
    };
    const counts = new Map<string, number>();
    let nowMs = 0;
    let sessionsTabActivated = false;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      if (key === 'main-header-start-new-session') {
        return sessionsTabActivated ? 1 : 0;
      }
      if (key === 'session-getting-started-kind-select_session') {
        return sessionsTabActivated ? 1 : 0;
      }
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };

    const page = {
      getByTestId: (testId: string) => ({
        count: async () => nextCount(testId),
        click: async () => {
          if (testId === 'tabbar-tab-sessions') {
            sessionsTabActivated = true;
          }
        },
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => 'http://127.0.0.1:3000/',
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForSessionActionsHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(sessionsTabActivated).toBe(true);
    expect(counts.get('session-getting-started-kind-connect_machine')).toBeGreaterThanOrEqual(2);
    expect(counts.get('session-getting-started-kind-create_session')).toBeGreaterThanOrEqual(1);
  });
});
