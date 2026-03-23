import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@playwright/test', () => ({
  expect: (locator: { count: () => Promise<number> }) => ({
    async toHaveCount(expectedCount: number) {
      const actualCount = await locator.count();
      if (actualCount !== expectedCount) {
        throw new Error(`expected locator count ${expectedCount}, received ${actualCount}`);
      }
    },
  }),
}));

import {
  createSessionFromNewSessionComposer,
  openNewSessionMachineSelection,
  openNewSessionPathSelection,
} from './createSessionFromNewSessionComposer';

type CountableLocator = Readonly<{
  count: () => Promise<number>;
  click: () => Promise<void>;
}>;

function createCountableLocator(params: Readonly<{
  counts?: number[];
}>): CountableLocator & { clickSpy: ReturnType<typeof vi.fn> } {
  const counts = [...(params.counts ?? [1])];
  const clickSpy = vi.fn(async () => {});
  return {
    count: async () => {
      const next = counts.length > 0 ? counts.shift() : counts.at(-1) ?? 0;
      return next ?? 0;
    },
    click: clickSpy,
    clickSpy,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('openNewSessionMachineSelection', () => {
  it('prefers the in-place machine popover and avoids route fallback when the options appear quickly', async () => {
    let nowMs = 0;
    const machineChip = createCountableLocator({});
    const machineOptions = createCountableLocator({ counts: [0, 0, 1] });
    const gotoSpy = vi.fn(async () => {
      throw new Error('unexpected navigation');
    });
    const waitForTimeoutSpy = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'agent-input-machine-chip') return machineChip;
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid^="new-session-machine:"]') {
          return { first: () => machineOptions };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: gotoSpy,
      waitForTimeout: waitForTimeoutSpy,
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await openNewSessionMachineSelection({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      popoverWaitMs: 1_000,
      routeFallbackWaitMs: 1_000,
    });

    expect(machineChip.clickSpy).toHaveBeenCalledTimes(1);
    expect(gotoSpy).toHaveBeenCalledTimes(0);
    expect(machineOptions.clickSpy).toHaveBeenCalledTimes(0);
    expect(waitForTimeoutSpy).toHaveBeenCalledWith(250);
  });
});

describe('openNewSessionPathSelection', () => {
  it('prefers the in-place path popover and avoids route fallback when the input appears quickly', async () => {
    let nowMs = 0;
    const pathChip = createCountableLocator({});
    const pathInput = createCountableLocator({ counts: [0, 1] });
    const gotoSpy = vi.fn(async () => {
      throw new Error('unexpected navigation');
    });
    const waitForTimeoutSpy = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'agent-input-path-chip') return pathChip;
        if (testId === 'path-selector-input') return pathInput;
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn(() => {
        throw new Error('unexpected locator lookup');
      }),
      goto: gotoSpy,
      waitForTimeout: waitForTimeoutSpy,
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await openNewSessionPathSelection({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      popoverWaitMs: 1_000,
      routeFallbackWaitMs: 1_000,
    });

    expect(pathChip.clickSpy).toHaveBeenCalledTimes(1);
    expect(gotoSpy).toHaveBeenCalledTimes(0);
    expect(pathInput.clickSpy).toHaveBeenCalledTimes(0);
    expect(waitForTimeoutSpy).toHaveBeenCalledWith(250);
  });
});

describe('createSessionFromNewSessionComposer', () => {
  it('continues when the fallback machine picker auto-selects the only machine and returns to /new', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let machineChipText = 'Select machine';
    let sessionComposerVisible = false;

    const machineChipClickSpy = vi.fn(async () => {});
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-123';
      sessionComposerVisible = true;
    });
    const inputFillSpy = vi.fn(async () => {});
    const inputPressSpy = vi.fn(async () => {});

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: inputFillSpy,
            press: inputPressSpy,
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: machineChipClickSpy,
            textContent: async () => machineChipText,
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: sendClickSpy,
          };
        }
        if (testId === 'new-session-machine:machine-1') {
          return {
            count: async (): Promise<number> => 0,
            click: vi.fn(async () => {}),
          };
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid^="new-session-machine:"]') {
          return {
            first: () => ({
              count: async (): Promise<number> => 0,
            }),
          };
        }
        if (selector === 'textarea[data-testid="session-composer-input"]:visible') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
          };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
        if (url.endsWith('/new/pick/machine')) {
          machineChipText = 'leeroy-mbp';
          currentUrl = 'http://127.0.0.1:3000/new';
        }
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      waitForURL: vi.fn(async (matcher: (url: URL) => boolean) => {
        const url = new URL(currentUrl);
        if (!matcher(url)) {
          throw new Error(`url predicate did not match: ${currentUrl}`);
        }
      }),
      url: vi.fn(() => currentUrl),
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await expect(createSessionFromNewSessionComposer({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      machineId: 'machine-1',
      prompt: 'hello world',
    })).resolves.toBe('session-123');

    expect(machineChipClickSpy).toHaveBeenCalledTimes(1);
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(inputFillSpy).toHaveBeenCalledWith('hello world');
    expect(inputPressSpy).not.toHaveBeenCalled();
  });
});
