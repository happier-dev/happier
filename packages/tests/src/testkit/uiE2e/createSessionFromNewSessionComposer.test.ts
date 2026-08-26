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
  selectFirstAvailableMachineForNewSession,
} from './createSessionFromNewSessionComposer';

type CountableLocator = Readonly<{
  count: () => Promise<number>;
  click: () => Promise<void>;
}>;

const MACHINE_OPTION_SELECTOR = '[data-testid^="new-session-machine:"]:visible, [data-testid^="new-session-machine-option:"]:visible';
function exactMachineSelector(machineId: string): string {
  return `[data-testid="new-session-machine:${machineId}"]:visible, [data-testid="new-session-machine-option:${machineId}"]:visible`;
}

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
        if (selector === MACHINE_OPTION_SELECTOR) {
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

  it('falls back to the route picker when the in-place machine chip is not actionable', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    const machineChip = {
      count: async (): Promise<number> => 1,
      click: vi.fn(async () => {
        throw new Error('not actionable');
      }),
    };
    const machineOptions = createCountableLocator({ counts: [1] });
    const gotoSpy = vi.fn(async (url: string) => {
      currentUrl = url;
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
        if (selector === MACHINE_OPTION_SELECTOR) {
          return { first: () => machineOptions };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: gotoSpy,
      waitForTimeout: waitForTimeoutSpy,
      url: vi.fn(() => currentUrl),
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await expect(openNewSessionMachineSelection({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      popoverWaitMs: 1_000,
      routeFallbackWaitMs: 1_000,
    })).resolves.toBe('picker_open');

    expect(machineChip.click).toHaveBeenCalledTimes(1);
    expect(gotoSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/new/pick/machine',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
  });

  it('uses the route fallback when the machine chip is not actionable even if the composer is visible', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    const machineChip = {
      count: async (): Promise<number> => 1,
      click: vi.fn(async () => {
        throw new Error('covered by modal transition');
      }),
    };
    const composerInput = createCountableLocator({ counts: [1] });
    const machineOptions = createCountableLocator({ counts: [1] });
    const gotoSpy = vi.fn(async (url: string) => {
      currentUrl = url;
    });
    const waitForTimeoutSpy = vi.fn(async (delayMs: number) => {
      nowMs += delayMs;
    });
    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'agent-input-machine-chip') return machineChip;
        if (testId === 'new-session-composer-input') return composerInput;
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === MACHINE_OPTION_SELECTOR) {
          return { first: () => machineOptions };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: gotoSpy,
      waitForTimeout: waitForTimeoutSpy,
      url: vi.fn(() => currentUrl),
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await expect(openNewSessionMachineSelection({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      popoverWaitMs: 1_000,
      routeFallbackWaitMs: 1_000,
    })).resolves.toBe('picker_open');

    expect(machineChip.click).toHaveBeenCalledTimes(1);
    expect(gotoSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/new/pick/machine',
      expect.objectContaining({ waitUntil: 'domcontentloaded' }),
    );
    expect(composerInput.clickSpy).toHaveBeenCalledTimes(0);
  });

});

describe('selectFirstAvailableMachineForNewSession', () => {
  it('clicks the first current-or-legacy machine option through the canonical selector', async () => {
    const machineChip = createCountableLocator({});
    const machineOption = createCountableLocator({ counts: [1, 1] });
    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'agent-input-machine-chip') return machineChip;
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === MACHINE_OPTION_SELECTOR) return { first: () => machineOption };
        throw new Error(`unexpected selector: ${selector}`);
      }),
      waitForTimeout: vi.fn(async () => {}),
    };

    await selectFirstAvailableMachineForNewSession({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
    });

    expect(page.locator).toHaveBeenCalledWith(MACHINE_OPTION_SELECTOR);
    expect(machineOption.clickSpy).toHaveBeenCalledTimes(1);
  });

  it('does not require a second click when route fallback auto-selects the only machine', async () => {
    let currentUrl = 'http://127.0.0.1:3000/new/pick/machine';
    const machineOptions = createCountableLocator({ counts: [0, 0, 0] });
    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'agent-input-machine-chip') return createCountableLocator({ counts: [0] });
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === MACHINE_OPTION_SELECTOR) return { first: () => machineOptions };
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: vi.fn(async () => {
        currentUrl = 'http://127.0.0.1:3000/new';
      }),
      url: vi.fn(() => currentUrl),
      waitForTimeout: vi.fn(async () => {}),
    };

    await selectFirstAvailableMachineForNewSession({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      routeFallbackWaitMs: 1,
    });

    expect(machineOptions.clickSpy).not.toHaveBeenCalled();
  });
});

describe('openNewSessionPathSelection', () => {
  it('prefers the in-place path popover and avoids route fallback when the input appears quickly', async () => {
    // Phase 11 SelectionList migration: the helper queries the new
    // `path-selection-list:header:input` testID via `page.locator(...)`. The
    // legacy `path-selector-input` testID was deleted with `PathSelector.tsx`.
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
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === '[data-testid="path-selection-list:header:input"]') {
          return pathInput;
        }
        throw new Error(`unexpected selector: ${selector}`);
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
  it('selects the current-path checkout option before sending when the checkout chip is present', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let sessionComposerVisible = false;

    const exactMachineClickSpy = vi.fn(async () => {});
    const checkoutChipClickSpy = vi.fn(async () => {});
    const currentPathClickSpy = vi.fn(async () => {});
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-checkout';
      sessionComposerVisible = true;
    });

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: vi.fn(async () => {}),
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: vi.fn(async () => {}),
          };
        }
        if (testId === 'new-session-machine:machine-1') {
          return {
            count: async (): Promise<number> => 1,
            click: exactMachineClickSpy,
            first: () => ({
              click: exactMachineClickSpy,
            }),
          };
        }
        if (testId === 'new-session-checkout-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: checkoutChipClickSpy,
          };
        }
        if (testId === 'selection-list:worktree-root:option:current_path') {
          return {
            count: async (): Promise<number> => 1,
            click: currentPathClickSpy,
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: sendClickSpy,
          };
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === exactMachineSelector('machine-1')) {
          return {
            count: async (): Promise<number> => 1,
            first: () => ({
              click: exactMachineClickSpy,
            }),
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
          return {
            first: () => ({
              count: async (): Promise<number> => 1,
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
      prompt: 'hello checkout',
    })).resolves.toBe('session-checkout');

    expect(exactMachineClickSpy).toHaveBeenCalledTimes(1);
    expect(checkoutChipClickSpy).toHaveBeenCalledTimes(1);
    expect(currentPathClickSpy).toHaveBeenCalledTimes(1);
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
  });

  it('recovers when /new initially renders blocking guidance and only exposes the composer after the machine picker fallback returns', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let machineChipVisible = false;
    let sessionComposerVisible = false;

    const machineChipClickSpy = vi.fn(async () => {});
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-456';
      sessionComposerVisible = true;
    });
    const inputFillSpy = vi.fn(async () => {});

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
            fill: inputFillSpy,
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => (machineChipVisible ? 1 : 0),
            click: machineChipClickSpy,
            textContent: async () => (machineChipVisible ? 'leeroy-mbp' : ''),
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
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
        if (selector === exactMachineSelector('machine-1')) {
          return {
            count: async (): Promise<number> => 0,
            click: vi.fn(async () => {}),
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
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
          machineChipVisible = true;
          sessionComposerVisible = true;
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
      prompt: 'hello after guidance',
    })).resolves.toBe('session-456');

    expect(machineChipClickSpy).not.toHaveBeenCalled();
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(inputFillSpy).toHaveBeenCalledWith('hello after guidance');
  });

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
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
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
        if (selector === exactMachineSelector('machine-1')) {
          return {
            count: async (): Promise<number> => 0,
            click: vi.fn(async () => {}),
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
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

  it('clicks the first exact machine match when the picker exposes duplicate machine rows', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let sessionComposerVisible = false;

    const machineChipClickSpy = vi.fn(async () => {});
    const exactMachineClickSpy = vi.fn(async () => {});
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-456';
      sessionComposerVisible = true;
    });
    const inputFillSpy = vi.fn(async () => {});

    const exactMachineLocator = {
      count: async (): Promise<number> => 2,
      click: vi.fn(async () => {
        throw new Error('strict mode violation');
      }),
      first: () => ({
        click: exactMachineClickSpy,
      }),
    };

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: inputFillSpy,
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: machineChipClickSpy,
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: sendClickSpy,
          };
        }
        if (testId === 'new-session-machine:machine-dup') {
          return exactMachineLocator;
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === exactMachineSelector('machine-dup')) {
          return exactMachineLocator;
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
          return {
            first: () => ({
              count: async (): Promise<number> => 1,
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
      machineId: 'machine-dup',
      prompt: 'duplicate machine prompt',
    })).resolves.toBe('session-456');

    expect(exactMachineClickSpy).toHaveBeenCalledTimes(1);
    expect(inputFillSpy).toHaveBeenCalledWith('duplicate machine prompt');
  });

  it('waits for machine selection row to become actionable instead of failing on a temporarily disabled row', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let sessionComposerVisible = false;
    let machineClickable = false;

    const machineChipClickSpy = vi.fn(async () => {});
    const machineClickSpy = vi.fn(async () => {
      if (!machineClickable) {
        throw new Error('element is not enabled');
      }
      machineClickable = true;
    });
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-789';
      sessionComposerVisible = true;
    });
    const inputFillSpy = vi.fn(async () => {});

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: inputFillSpy,
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: machineChipClickSpy,
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: sendClickSpy,
          };
        }
        if (testId === 'new-session-machine:machine-delayed-enabled') {
          return {
            count: async (): Promise<number> => 1,
            click: machineClickSpy,
          };
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === exactMachineSelector('machine-delayed-enabled')) {
          return {
            count: async (): Promise<number> => 1,
            click: machineClickSpy,
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
          return {
            first: () => ({
              count: async (): Promise<number> => 1,
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
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
        if (nowMs >= 500) {
          machineClickable = true;
        }
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
      machineId: 'machine-delayed-enabled',
      prompt: 'wait for enabled machine',
    })).resolves.toBe('session-789');

    expect(machineClickSpy).toHaveBeenCalled();
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(inputFillSpy).toHaveBeenCalledWith('wait for enabled machine');
  });

  it('accepts session composer readiness when session-composer-input exists without a textarea wrapper', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';
    let sessionComposerVisible = false;

    const machineChipClickSpy = vi.fn(async () => {});
    const machineClickSpy = vi.fn(async () => {});
    const sendClickSpy = vi.fn(async () => {
      currentUrl = 'http://127.0.0.1:3000/session/session-901';
      sessionComposerVisible = true;
    });
    const inputFillSpy = vi.fn(async () => {});

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: inputFillSpy,
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => (sessionComposerVisible ? 1 : 0),
            click: vi.fn(async () => {}),
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: machineChipClickSpy,
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: sendClickSpy,
          };
        }
        if (testId === 'new-session-machine:machine-session-input-only') {
          return {
            count: async (): Promise<number> => 1,
            click: machineClickSpy,
          };
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === exactMachineSelector('machine-session-input-only')) {
          return {
            count: async (): Promise<number> => 1,
            click: machineClickSpy,
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
          return {
            first: () => ({
              count: async (): Promise<number> => 1,
            }),
          };
        }
        if (selector === 'textarea[data-testid="session-composer-input"]:visible') {
          return {
            count: async (): Promise<number> => 0,
          };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
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
      machineId: 'machine-session-input-only',
      prompt: 'session input only prompt',
    })).resolves.toBe('session-901');

    expect(machineClickSpy).toHaveBeenCalledTimes(1);
    expect(sendClickSpy).toHaveBeenCalledTimes(1);
    expect(inputFillSpy).toHaveBeenCalledWith('session input only prompt');
  });

  it('does not swallow unrelated locator errors while waiting for session composer readiness', async () => {
    let nowMs = 0;
    let currentUrl = 'http://127.0.0.1:3000/new';

    const page = {
      getByTestId: vi.fn((testId: string) => {
        if (testId === 'new-session-composer-input') {
          return {
            count: async (): Promise<number> => 1,
            fill: vi.fn(async () => {}),
          };
        }
        if (testId === 'session-composer-input') {
          return {
            count: async (): Promise<number> => 0,
          };
        }
        if (testId === 'agent-input-machine-chip') {
          return {
            count: async (): Promise<number> => 1,
            click: vi.fn(async () => {}),
          };
        }
        if (testId === 'new-session-composer-send') {
          return {
            count: async (): Promise<number> => 1,
            click: vi.fn(async () => {
              currentUrl = 'http://127.0.0.1:3000/session/session-xyz';
            }),
          };
        }
        if (testId === 'new-session-machine:machine-error') {
          return {
            count: async (): Promise<number> => 1,
            click: vi.fn(async () => {}),
          };
        }
        throw new Error(`unexpected test id: ${testId}`);
      }),
      locator: vi.fn((selector: string) => {
        if (selector === exactMachineSelector('machine-error')) {
          return {
            count: async (): Promise<number> => 1,
            click: vi.fn(async () => {}),
          };
        }
        if (selector === MACHINE_OPTION_SELECTOR) {
          return {
            first: () => ({
              count: async (): Promise<number> => 1,
            }),
          };
        }
        if (selector === 'textarea[data-testid="session-composer-input"]:visible') {
          return {
            count: async (): Promise<number> => {
              throw new Error('Target page, context or browser has been closed');
            },
          };
        }
        throw new Error(`unexpected selector: ${selector}`);
      }),
      goto: vi.fn(async (url: string) => {
        currentUrl = url;
      }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      waitForURL: vi.fn(async (matcher: (url: URL) => boolean) => {
        const url = new URL(currentUrl);
        if (!matcher(url)) throw new Error(`url predicate did not match: ${currentUrl}`);
      }),
      url: vi.fn(() => currentUrl),
    };

    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);

    await expect(createSessionFromNewSessionComposer({
      page: page as never,
      uiBaseUrl: 'http://127.0.0.1:3000',
      machineId: 'machine-error',
      prompt: 'propagate playwright error',
    })).rejects.toThrow('Target page, context or browser has been closed');
  });
});
