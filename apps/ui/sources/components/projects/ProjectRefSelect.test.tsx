import React from 'react';
import { act } from 'react-test-renderer';
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

async function renderRefSelect(compact: boolean) {
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
        value="release/0.4"
        defaultLabel="v0.3 (default)"
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

  it('is a value row on a phone: the label, the chosen ref and a press that opens the same menu', async () => {
    const { screen, hasFieldBox, menu } = await renderRefSelect(true);
    expect(hasFieldBox()).toBe(false);
    expect(screen.getTextContent()).toContain('Branch');
    expect(screen.getTextContent()).toContain('release/0.4');
    expect(menu().props.open).toBe(false);
    await act(async () => {
      await screen.pressByTestIdAsync('ref.row');
    });
    expect(menu().props.open).toBe(true);
  });
});
