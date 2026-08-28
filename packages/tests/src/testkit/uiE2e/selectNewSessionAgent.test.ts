import { describe, expect as vitestExpect, it, vi } from 'vitest';

import type { Page } from '@playwright/test';

const playwrightExpectStubs = vi.hoisted(() => ({
  expect: ((received: unknown) => ({
    async toBeEnabled() {
      const enabled = await (received as { isEnabled?: () => Promise<boolean> })?.isEnabled?.();
      if (enabled === false) {
        throw new Error('expected locator to be enabled');
      }
    },
  })),
}));

vi.mock('@playwright/test', () => ({ expect: playwrightExpectStubs.expect }));

import { buildAgentOptionTestIds, selectNewSessionAgent } from './selectNewSessionAgent';

const QUALIFIED_AGENT_ID = 'agent:examples.session-agent/session-agent';
const QUALIFIED_AGENT_LABEL = 'Deterministic Session Agent';

function createAgentPickerFakePage(params: Readonly<{
  chipText: () => string;
  onChipClick?: () => void;
  selectableOptionTestId?: string;
  onOptionClick?: (testId: string) => void;
}>): Page {
  const state = { pickerOpen: false };
  const clickable = (testId: string, count: number) => {
    const locator: {
      count: () => Promise<number>;
      textContent: () => Promise<string>;
      isVisible: () => Promise<boolean>;
      isEnabled: () => Promise<boolean>;
      click: () => Promise<void>;
      first: () => unknown;
    } = {
      count: async () => count,
      textContent: async () => (testId === 'agent-input-agent-chip' ? params.chipText() : testId),
      isVisible: async () => count > 0,
      isEnabled: async () => count > 0,
      click: async () => {
        if (testId === 'agent-input-agent-chip') {
          state.pickerOpen = true;
          params.onChipClick?.();
          return;
        }
        params.onOptionClick?.(testId);
      },
      first: () => locator,
    };
    return locator;
  };
  const locatorFor = (selector: string) => {
    const inlineOption = /^\[data-testid="(.+)"\]:visible$/u.exec(selector);
    const openDialogs = selector === '[role="dialog"][data-state="open"]';
    const optionTestId = inlineOption?.[1];
    const count = !openDialogs
      && state.pickerOpen
      && optionTestId
      && optionTestId === params.selectableOptionTestId
      ? 1
      : 0;
    return {
      last: () => ({
        getByTestId: (testId: string) => clickable(String(testId), 0),
      }),
      first: () => clickable(optionTestId ?? selector, count),
      count: async () => count,
      evaluateAll: async () => [],
    };
  };
  return {
    getByTestId: ((testId: string) => {
      if (testId === 'new-session-agent-dropdown-trigger') return clickable(testId, 0);
      if (testId === 'agent-input-agent-chip') return clickable(testId, 1);
      return clickable(testId, 0);
    }) as unknown as Page['getByTestId'],
    locator: ((selector: string) => locatorFor(selector)) as unknown as Page['locator'],
    getByRole: (() => []) as unknown as Page['getByRole'],
    waitForTimeout: async () => {},
  } as unknown as Page;
}

describe('selectNewSessionAgent qualified plugin Agent support', () => {
  it('resolves the exact wizard and chip-picker option testIDs for the qualified example Agent', () => {
    vitestExpect(buildAgentOptionTestIds(QUALIFIED_AGENT_ID)).toEqual([
      'dropdown-option-agent_examples_session-agent_session-agent',
      `new-session-agent:${QUALIFIED_AGENT_ID}`,
      `agent-input-chip-picker.option:${QUALIFIED_AGENT_ID}`,
      `agent-input-chip-picker.option:engine:${QUALIFIED_AGENT_ID}`,
    ]);
    vitestExpect(buildAgentOptionTestIds('codex')).toContain('new-session-agent:codex');
  });

  it('selects the qualified plugin Agent through its chip-picker option and reports it by display label', async () => {
    const clickedOptionTestIds: string[] = [];
    let chipText = 'Local Agent';
    const page = createAgentPickerFakePage({
      chipText: () => chipText,
      selectableOptionTestId: `agent-input-chip-picker.option:${QUALIFIED_AGENT_ID}`,
      onOptionClick: (testId) => {
        clickedOptionTestIds.push(testId);
        chipText = QUALIFIED_AGENT_LABEL;
      },
    });

    await selectNewSessionAgent({
      page,
      agentId: QUALIFIED_AGENT_ID,
      label: QUALIFIED_AGENT_LABEL,
      timeoutMs: 5_000,
    });

    vitestExpect(clickedOptionTestIds).toEqual([`agent-input-chip-picker.option:${QUALIFIED_AGENT_ID}`]);
  });

  it('fails instead of misreporting selection when the qualified id is never rendered as a label', async () => {
    let chipText = 'Local Agent';
    const page = createAgentPickerFakePage({
      chipText: () => chipText,
      selectableOptionTestId: `agent-input-chip-picker.option:${QUALIFIED_AGENT_ID}`,
      onOptionClick: () => {
        // Selecting the option renders the display title, never the id.
        chipText = QUALIFIED_AGENT_LABEL;
      },
    });

    await vitestExpect(selectNewSessionAgent({
      page,
      agentId: QUALIFIED_AGENT_ID,
      timeoutMs: 600,
    })).rejects.toThrow(/Expected selectable new-session agent option/u);
  });
});
