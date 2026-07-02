import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountAndReachConnectMachineState,
  createAccountAndReachSetupWizardState,
  dismissSetupWizardIfVisible,
  type CreateAccountAndReachConnectMachineStatePage,
} from './createAccountAndReachConnectMachineState';

type FakeLocator = Locator & {
  countCalls: number;
  clickCalls: number;
  visibleCalls: number;
};

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  testIdVisibility?: Record<string, boolean[]>;
  onEvaluate?: () => void;
  evaluateResults?: unknown[];
  localStorageSnapshots?: Array<Record<string, string>>;
}>): CreateAccountAndReachConnectMachineStatePage {
  const countCalls = new Map<string, number>();
  const visibleCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const testIdVisibility = params.testIdVisibility ?? {};
  const clickCounts = new Map<string, number>();
  const evaluateResults = [...(params.evaluateResults ?? [])];
  const localStorageSnapshots = [...(params.localStorageSnapshots ?? [])];

  const nextCount = (key: string): number => {
    const idx = countCalls.get(key) ?? 0;
    countCalls.set(key, idx + 1);
    const sequence = testIdCounts[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const nextVisible = (key: string): boolean => {
    const idx = visibleCalls.get(key) ?? 0;
    visibleCalls.set(key, idx + 1);
    const countSequence = testIdCounts[key] ?? [0];
    const visibleSequence = testIdVisibility[key] ?? countSequence.map((value) => value > 0);
    return visibleSequence[Math.min(idx, visibleSequence.length - 1)] ?? false;
  };

  const makeLocator = (key: string): FakeLocator => ({
    count: async () => nextCount(key),
    isVisible: async () => nextVisible(key),
    click: async () => {
      clickCounts.set(key, (clickCounts.get(key) ?? 0) + 1);
    },
    first: () => makeLocator(key),
    get countCalls() {
      return countCalls.get(key) ?? 0;
    },
    get clickCalls() {
      return clickCounts.get(key) ?? 0;
    },
    get visibleCalls() {
      return visibleCalls.get(key) ?? 0;
    },
  } as unknown as FakeLocator);

  return {
    getByTestId: ((testId) => makeLocator(String(testId))) as Page['getByTestId'],
    evaluate: vi.fn(async (fn: unknown, _arg?: unknown) => {
      params.onEvaluate?.();
      if (typeof fn === 'function' && localStorageSnapshots.length > 0) {
        const snapshot = localStorageSnapshots.shift() ?? {};
        const entries = Object.entries(snapshot);
        const previousWindow = (globalThis as { window?: unknown }).window;
        (globalThis as { window?: unknown }).window = {
          localStorage: {
            get length() {
              return entries.length;
            },
            key(index: number) {
              return entries[index]?.[0] ?? null;
            },
            getItem(key: string) {
              return snapshot[key] ?? null;
            },
          },
        };
        try {
          return await (fn as () => unknown)();
        } finally {
          if (previousWindow === undefined) {
            delete (globalThis as { window?: unknown }).window;
          } else {
            (globalThis as { window?: unknown }).window = previousWindow;
          }
        }
      }
      if (evaluateResults.length > 0) {
        return evaluateResults.shift();
      }
      return undefined;
    }) as unknown as Page['evaluate'],
  };
}

function createBrandHeroThenWelcomePage(
  afterWelcome: 'connect-machine' | 'setup-wizard',
): CreateAccountAndReachConnectMachineStatePage {
  const visibleByTestId = new Map<string, boolean>([
    ['brand-hero-get-started', true],
  ]);
  const clickCounts = new Map<string, number>();
  let welcomeVisibleReads = 0;

  const makeLocator = (key: string): FakeLocator => ({
    count: async () => (visibleByTestId.get(key) === true ? 1 : 0),
    isVisible: async () => {
      const isVisible = visibleByTestId.get(key) === true;
      if (key === 'welcome-primary-start' && isVisible) {
        welcomeVisibleReads += 1;
        if (welcomeVisibleReads > 1) {
          visibleByTestId.set('welcome-primary-start', false);
          return false;
        }
      }
      return isVisible;
    },
    click: async () => {
      clickCounts.set(key, (clickCounts.get(key) ?? 0) + 1);
      if (key === 'brand-hero-get-started') {
        visibleByTestId.set('brand-hero-get-started', false);
        visibleByTestId.set('welcome-primary-start', true);
        visibleByTestId.set(
          afterWelcome === 'connect-machine' ? 'session-getting-started-kind-connect_machine' : 'setupWizard.surface',
          true,
        );
        return;
      }
      if (key === 'welcome-primary-start') {
        visibleByTestId.set('welcome-primary-start', false);
      }
    },
    first: () => makeLocator(key),
    get countCalls() {
      return 0;
    },
    get clickCalls() {
      return clickCounts.get(key) ?? 0;
    },
    get visibleCalls() {
      return 0;
    },
  } as unknown as FakeLocator);

  return {
    getByTestId: ((testId) => makeLocator(String(testId))) as Page['getByTestId'],
    evaluate: vi.fn(async () => true) as unknown as Page['evaluate'],
  };
}

describe('createAccountAndReachConnectMachineState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches connect-machine directly when no setup wizard appears', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 1, 1],
        'setupWizard.surface': [0, 0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('accepts the current unauth shell primary start CTA as create-account entry', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [0, 0, 0, 0],
        'welcome-primary-start': [1, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 1, 1],
        'setupWizard.surface': [0, 0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect((page.getByTestId('welcome-primary-start') as FakeLocator).clickCalls).toBe(1);
  });

  it('dismisses the mobile brand hero before clicking the real welcome CTA', async () => {
    const page = createBrandHeroThenWelcomePage('connect-machine');

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect((page.getByTestId('brand-hero-get-started') as FakeLocator).clickCalls).toBe(1);
    expect((page.getByTestId('welcome-primary-start') as FakeLocator).clickCalls).toBe(1);
  });

  it('dismisses the setup wizard before requiring connect-machine', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 1, 1],
        'setupWizard.surface': [0, 1, 1, 0],
        'setupWizard.surface-skip': [1, 1],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('accepts an already-visible connect-machine state without requiring create-account first', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [0],
        'session-getting-started-kind-connect_machine': [1, 1],
        'setupWizard.surface': [0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('treats a lingering hidden create-account CTA as inactive once connect-machine is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1, 1, 1],
        'session-getting-started-kind-connect_machine': [0, 1, 1],
        'setupWizard.surface': [0, 0, 0],
      },
      testIdVisibility: {
        'welcome-create-account': [true, true, false, false],
        'session-getting-started-kind-connect_machine': [false, true, true],
        'setupWizard.surface': [false, false, false],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('waits for create-account to disappear before accepting connect-machine as authenticated state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1, 1, 0, 0],
        'session-getting-started-kind-connect_machine': [1, 1, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect((page.getByTestId('welcome-create-account') as FakeLocator).visibleCalls).toBeGreaterThanOrEqual(4);
  });

  it('waits for persisted auth credentials before accepting connect-machine as authenticated state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 1, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
      },
      evaluateResults: [false, false, true],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('waits for persisted auth credentials that match the active server profile', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 1, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
      },
      localStorageSnapshots: [
        {
          'server-profiles:server-state-v1': JSON.stringify({
            activeServerId: '127.0.0.1-33628',
            servers: {
              '127.0.0.1-33628': {
                id: '127.0.0.1-33628',
                serverUrl: 'http://127.0.0.1:33628',
              },
            },
          }),
          'auth_credentials__srv_127.0.0.1-3009': JSON.stringify({ token: 'wrong-token', secret: 'wrong-secret' }),
        },
        {
          'server-profiles:server-state-v1': JSON.stringify({
            activeServerId: '127.0.0.1-33628',
            servers: {
              '127.0.0.1-33628': {
                id: '127.0.0.1-33628',
                serverUrl: 'http://127.0.0.1:33628',
              },
            },
          }),
          'auth_credentials__srv_127.0.0.1-3009': JSON.stringify({ token: 'wrong-token', secret: 'wrong-secret' }),
        },
        {
          'server-profiles:server-state-v1': JSON.stringify({
            activeServerId: '127.0.0.1-33628',
            servers: {
              '127.0.0.1-33628': {
                id: '127.0.0.1-33628',
                serverUrl: 'http://127.0.0.1:33628',
              },
            },
          }),
          'auth_credentials__srv_127.0.0.1-3009': JSON.stringify({ token: 'wrong-token', secret: 'wrong-secret' }),
          'auth_credentials__srv_127.0.0.1-33628': JSON.stringify({ token: 'right-token', secret: 'right-secret' }),
        },
      ],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('can stop at connect-machine without waiting for persisted auth credentials when requested', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0],
        'sessions-empty-state-open-setup': [0, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
      },
      evaluateResults: Array.from({ length: 128 }, () => false),
    });

    await expect(
      createAccountAndReachConnectMachineState({ page, requirePersistedAuthCredentials: false }),
    ).resolves.toBeUndefined();
  });

  it('switches to the sessions tab when the mobile shell hides session actions off-tab', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 1, 1],
        'session-getting-started-kind-create_session': [0, 0, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
        'tabbar-tab-sessions': [1, 1, 1],
      },
      evaluateResults: [true],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect((page.getByTestId('tabbar-tab-sessions') as FakeLocator).clickCalls).toBeGreaterThanOrEqual(1);
  });

  it('accepts the create-session surface as an authenticated mobile home state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 0, 0],
        'session-getting-started-kind-create_session': [0, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
        'tabbar-tab-sessions': [1, 1, 1],
      },
      evaluateResults: [true],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('accepts the start-daemon surface as an authenticated mobile home state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 0, 0],
        'session-getting-started-kind-start_daemon': [0, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0],
        'tabbar-tab-sessions': [1, 1, 1],
      },
      evaluateResults: [true],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('waits for persisted auth credentials before accepting the start-daemon surface', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0, 0, 0, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 0, 0, 0],
        'session-getting-started-kind-start_daemon': [0, 1, 1, 1, 1],
        'setupWizard.surface': [0, 0, 0, 0, 0],
        'tabbar-tab-sessions': [1, 1, 1, 1],
      },
      evaluateResults: [false, false, true],
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(3);
  });

  it('dismisses setup wizard only when visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'setupWizard.surface': [1, 1, 0],
        'setupWizard.surface-skip': [1, 1],
      },
    });

    await expect(dismissSetupWizardIfVisible({ page })).resolves.toBeUndefined();
  });
});

describe('createAccountAndReachSetupWizardState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks create-account and waits for the setup wizard', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1],
        'setupWizard.surface': [0, 1, 1],
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
  });

  it('dismisses the mobile brand hero before clicking the real welcome CTA', async () => {
    const page = createBrandHeroThenWelcomePage('setup-wizard');

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
    expect((page.getByTestId('brand-hero-get-started') as FakeLocator).clickCalls).toBe(1);
    expect((page.getByTestId('welcome-primary-start') as FakeLocator).clickCalls).toBe(1);
  });

  it('accepts an already-visible setup wizard without requiring create-account first', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [0],
        'setupWizard.surface': [1, 1],
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
  });

  it('navigates to the setup wizard when the authenticated shell is visible but the modal did not auto-open', async () => {
    const testIdCounts = {
      'welcome-create-account': [1, 1],
      'setupWizard.surface': [0, 0, 0, 1],
      'setup.postAuth': [0, 1, 1],
    };

    const page = createFakePage({
      testIdCounts: {
        ...testIdCounts,
      },
      onEvaluate: () => {
        testIdCounts['setupWizard.surface'] = [1, 1];
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
