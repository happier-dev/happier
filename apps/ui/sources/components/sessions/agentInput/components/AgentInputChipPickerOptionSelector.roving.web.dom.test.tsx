/** @vitest-environment jsdom */
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentInputChipPickerOptionSection } from './AgentInputChipPickerTypes';

// React Native Web is the platform under test: its tabIndex, key and press handling stay real.
vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const { AgentInputChipPickerOptionSelector } =
  await import('./AgentInputChipPickerOptionSelector');

const SECTIONS: ReadonlyArray<AgentInputChipPickerOptionSection> = [
  {
    id: 'agents',
    options: [
      { id: 'claude', label: 'Claude' },
      { id: 'codex', label: 'Codex' },
      { id: 'opencode', label: 'OpenCode', disabled: true },
      { id: 'gemini', label: 'Gemini' },
    ],
  },
];

let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

async function renderRail(variant: 'rail' | 'stacked') {
  const shown: string[] = [];
  function Harness() {
    const [focusedOptionId, setFocusedOptionId] = React.useState<string | null>(
      'claude',
    );
    return (
      <AgentInputChipPickerOptionSelector
        sections={SECTIONS}
        focusedOptionId={focusedOptionId}
        selectedOptionId="claude"
        onFocusOption={(optionId) => {
          shown.push(optionId);
          setFocusedOptionId(optionId);
        }}
        variant={variant}
      />
    );
  }
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Harness />));
  return shown;
}

const optionPrefix = (variant: 'rail' | 'stacked') =>
  variant === 'rail'
    ? 'agent-input-chip-picker.option:'
    : 'agent-input-chip-picker.top-selector-option:';

function option(variant: 'rail' | 'stacked', id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="${optionPrefix(variant)}${id}"]`,
  );
  if (!element) throw new Error(`missing option ${id}`);
  return element;
}

async function press(key: string) {
  const target = document.activeElement as HTMLElement;
  await act(async () => {
    const notCancelled = target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    // A browser turns Enter or Space on a native button into a click; jsdom does not synthesize that default action.
    if (notCancelled && target.tagName === 'BUTTON' && (key === 'Enter' || key === ' ')) {
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  });
}

describe('Agent rail keyboard (one roving tab stop)', () => {
  it.each([
    ['rail', 'ArrowDown', 'ArrowUp'],
    ['stacked', 'ArrowRight', 'ArrowLeft'],
  ] as const)(
    '%s: one Tab stop on the shown Agent; %s reaches Codex and Enter shows it',
    async (variant, next, previous) => {
      const shown = await renderRail(variant);
      // One Tab stop: the shown Agent; every other option is reached with the arrow keys.
      expect(option(variant, 'claude').tabIndex).toBe(0);
      expect(option(variant, 'codex').tabIndex).toBe(-1);
      expect(option(variant, 'gemini').tabIndex).toBe(-1);

      await act(async () => option(variant, 'claude').focus());
      await press(next);
      expect(document.activeElement).toBe(option(variant, 'codex'));
      // Moving focus shows nothing: Enter does.
      expect(shown).toEqual([]);
      await press('Enter');
      expect(shown).toEqual(['codex']);
      // The Tab stop follows the shown Agent.
      expect(option(variant, 'codex').tabIndex).toBe(0);
      expect(option(variant, 'claude').tabIndex).toBe(-1);

      // A disabled Agent is skipped; End and Home reach the ends; the arrows wrap.
      await press(next);
      expect(document.activeElement).toBe(option(variant, 'gemini'));
      await press('Home');
      expect(document.activeElement).toBe(option(variant, 'claude'));
      await press('End');
      expect(document.activeElement).toBe(option(variant, 'gemini'));
      await press(previous);
      expect(document.activeElement).toBe(option(variant, 'codex'));
      await press(' ');
      expect(shown).toEqual(['codex', 'codex']);
    },
  );
});
