import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { SelectionListFilterChips } = await import('./SelectionListFilterChips');
afterEach(() => { standardCleanup(); vi.unstubAllGlobals(); });

it('keeps a chip on the sideways-scrolling row inside the row it clips to: its reach stops at the row\'s top padding', async () => {
  // The browser's primary pointer, rather than touchscreen presence, decides the target.
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' || query === '(hover: none)',
  }));
  const screen = await renderScreen(
    <SelectionListFilterChips placement="row" filters={[{ id: 'scope', label: 'Scope', valueLabel: 'This Home', testID: 'chip' }]} />,
  );
  const chip = screen.findHostByTestId('chip')!;
  await act(async () => (chip.props.onLayout as (event: unknown) => void)({ nativeEvent: { layout: { x: 0, y: 0, width: 60, height: 32 } } }));
  const { insets } = readHitArea(screen.findHostByTestId('chip')!, { width: 60, height: 32 });
  // The 32 px chip still reaches the 44 px finger target below, but never up past the row's 2 px padding.
  expect(insets.top).toBeLessThanOrEqual(2);
  expect(insets.bottom).toBeGreaterThan(2);
});
