import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { SelectionListFilterChip } from './SelectionListFilterChips';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

afterEach(standardCleanup);

it('draws an on chip exactly as wide as an off one: the fill says it is on, a glyph would push its neighbours', async () => {
  const chip = (selected: boolean) => ({ id: 'failed', testID: 'chip', label: 'Failed', valueLabel: 'Failed', selected, onToggle: () => {} });
  const on = await renderScreen(<SelectionListFilterChip filter={chip(true)} />);
  expect(on.findByTestId('chip')?.props['aria-checked']).toBe(true);
  expect(on.findAll((node) => node.props.name === 'check')).toHaveLength(0);
});

it('announces the chooser as a listbox', async () => {
  const screen = await renderScreen(<SelectionListFilterChip filter={{ id: 'scope', testID: 'scope', label: 'Scope', selectedId: 'a', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo' }], onChange: () => {} }} />);
  expect(screen.findByTestId('scope')?.props['aria-haspopup']).toBe('listbox');
});
