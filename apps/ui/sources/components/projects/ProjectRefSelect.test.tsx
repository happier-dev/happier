import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen, standardCleanup } from '@/dev/testkit';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});

vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));

afterEach(() => {
  standardCleanup();
});

async function renderRefSelect(compact: boolean, needsBranch = false) {
  const { ProjectRefSelect } = await import('./ProjectRefSelect');
  const { DropdownMenu } =
    await import('@/components/ui/forms/dropdown/DropdownMenu');
  const { ListPresentationProvider } =
    await import('@/components/ui/lists/listPresentation');
  const screen = await renderScreen(
    <ListPresentationProvider value="page">
      <ProjectRefSelect
        testID="ref"
        title="Branch"
        value={needsBranch ? null : 'release/0.4'}
        defaultLabel={needsBranch ? 'Choose a branch' : 'v0.3 (default)'}
        defaultIsPrompt={needsBranch}
        compact={compact}
        onChange={() => {}}
      />
    </ListPresentationProvider>,
  );
  const hasFieldBox = () =>
    screen.findAllByType('View' as never).some((node) => {
      const style = flattenTestStyle(node.props.style);
      return (
        typeof style.borderWidth === 'number' &&
        style.borderWidth > 0 &&
        typeof style.borderRadius === 'number'
      );
    });
  const menu = () => screen.findAllByType(DropdownMenu)[0]!;
  return { screen, hasFieldBox, menu };
}

describe('ProjectRefSelect', () => {
  it('is a bordered field select on a computer', async () => {
    const { hasFieldBox } = await renderRefSelect(false);
    expect(hasFieldBox()).toBe(true);
  });

  it.each([false, true])('keeps the unselected branch prompt on its trigger (compact=%s)', async (compact) => {
    const { screen } = await renderRefSelect(compact, true);
    expect(screen.getTextContent()).toContain('Choose a branch');
  });

  it('is a value row on a phone: the label and the chosen ref, as the same menu\'s trigger', async () => {
    const { screen, hasFieldBox, menu } = await renderRefSelect(true);
    expect(hasFieldBox()).toBe(false);
    expect(screen.getTextContent()).toContain('Branch');
    expect(screen.getTextContent()).toContain('release/0.4');
    // The row is the menu's own trigger (its press runs the menu's toggle), not a second picker.
    expect(menu().props.itemTrigger).toBeUndefined();
    expect(typeof menu().props.trigger).toBe('function');
    expect(screen.findByTestId('ref.row')?.props.onPress).toEqual(expect.any(Function));
  });
});
