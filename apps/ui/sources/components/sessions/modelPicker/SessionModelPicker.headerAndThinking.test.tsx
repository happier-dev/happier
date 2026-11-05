/**
 * The shared model pane (New Session, the Session composer, Workflow authoring, Role details):
 * the chosen model carries its own check, so the header never repeats it as "Effective: …"
 * (07 §2.3 item 18), and a model option with more choices than one segmented control holds
 * becomes the one bordered field select (DESIGN control table; `resolveHappierChoiceControl`); thinking
 * effort, an ordinal scale, stays one segmented row up to five levels (owner ruling 2026-11-04).
 */
import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const selection = {
  agentTargetKey: 'agent:happier.agent.codex/codex',
  providerConnectionId: null,
  modelId: 'gpt-6.1-terra',
} as const;

const effortChoices = (values: readonly string[]) =>
  values.map((value) => ({
    value,
    name: value[0]!.toUpperCase() + value.slice(1),
  }));

const controls = (values: readonly string[]) => [
  {
    option: {
      id: 'reasoning_effort',
      name: 'Thinking',
      type: 'select' as const,
      currentValue: 'medium',
      options: effortChoices(values),
    },
    effectiveValue: 'medium',
    isPending: false,
  },
];

const { SessionModelPicker } = await import('./SessionModelPicker');
const { DropdownMenu } = await import('@/components/ui/forms/dropdown/DropdownMenu');

function picker(
  values: readonly string[],
  onChange: (configId: string, value: string) => void = () => {},
) {
  return (
    <SessionModelPicker
      agentTargetKey={selection.agentTargetKey}
      nativeModels={[
        { value: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' },
        { value: 'gpt-6.1-sol', label: 'GPT-6.1-Sol' },
      ]}
      providerGroups={[]}
      providerProjectionAuthoritative
      selected={selection}
      selectedOptionControls={controls(values)}
      onSelectOptionControlValue={onChange}
      multiColumn
      onSelect={() => {}}
    />
  );
}

const OPTION =
  'model-picker-overlay-selected-option-control-option:reasoning_effort';

describe('SessionModelPicker header and selected-model choices', () => {
  it('names the pane without an "Effective:" restatement of the checked model', async () => {
    const screen = await renderScreen(picker(['low', 'medium']));
    const texts = screen
      .findAll((node) => typeof node.children?.[0] === 'string')
      .map((node) => String(node.children[0]));
    expect(texts.some((text) => text.startsWith('Effective'))).toBe(false);
    await screen.unmount();
  });

  it('draws Codex\'s six thinking levels as one segmented row (owner, 2026-11-05: never behind a click)', async () => {
    const screen = await renderScreen(picker(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']));
    expect(screen.findByTestId(`${OPTION}:ultra`)).not.toBeNull();
    expect(screen.findByTestId(`${OPTION}:select`)).toBeNull();
    await screen.unmount();
  });

  it('draws a longer scale as one field select showing the chosen level, and selects through it', async () => {
    const onChange = vi.fn();
    const levels = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const screen = await renderScreen(picker(levels, onChange));
    expect(screen.findByTestId(`${OPTION}:select`)).not.toBeNull();
    expect(screen.findByTestId(`${OPTION}:low`)).toBeNull();
    const menu = screen.root.findByType(DropdownMenu);
    expect(menu.props.items.map((item: { id: string }) => item.id)).toEqual(levels);
    expect(menu.props.selectedId).toBe('medium');
    act(() => {
      menu.props.onSelect('ultra');
    });
    expect(onChange).toHaveBeenCalledWith('reasoning_effort', 'ultra');
    await screen.unmount();
  });

  it('draws five thinking levels as one segmented row (owner ruling 2026-11-04, lab rpicker-MP1)', async () => {
    const screen = await renderScreen(picker(['low', 'medium', 'high', 'xhigh', 'max']));
    expect(
      screen.findByTestId(`${OPTION}:medium`)?.props.accessibilityState
        ?.checked,
    ).toBe(true);
    expect(screen.findByTestId(`${OPTION}:max`)).not.toBeNull();
    expect(screen.findByTestId(`${OPTION}:select`)).toBeNull();
    await screen.unmount();
  });

  it('keeps two to four short levels as the segmented control', async () => {
    const screen = await renderScreen(picker(['low', 'medium', 'high', 'max']));
    expect(
      screen.findByTestId(`${OPTION}:medium`)?.props.accessibilityState
        ?.checked,
    ).toBe(true);
    expect(screen.findByTestId(`${OPTION}:select`)).toBeNull();
    await screen.unmount();
  });
});
