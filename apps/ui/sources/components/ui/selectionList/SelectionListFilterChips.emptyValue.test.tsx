import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SelectionListFilterChip } from './SelectionListFilterChips';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

it('names itself when it has no value yet, never an icon and a chevron alone', async () => {
  const screen = await renderScreen(<SelectionListFilterChip filter={{
    id: 'run-on', testID: 'run-on', label: 'Run on', muted: true, open: false, onOpenChange: () => {},
    renderPopoverContent: () => null,
  }} />);
  expect(screen.findAll((node) => node.props.children === 'Run on').length).toBeGreaterThan(0);
});

it('shows the value, not its own name, once it has one', async () => {
  const screen = await renderScreen(<SelectionListFilterChip filter={{
    id: 'run-on', testID: 'run-on', label: 'Run on', valueLabel: 'nl2', open: false, onOpenChange: () => {},
    renderPopoverContent: () => null,
  }} />);
  expect(screen.findAll((node) => node.props.children === 'nl2').length).toBeGreaterThan(0);
  expect(screen.findAll((node) => node.props.children === 'Run on')).toHaveLength(0);
});
