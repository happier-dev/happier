import * as React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

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

const { CardGrid, CardGridCell } = await import('./CardGrid');

afterEach(() => {
  standardCleanup();
});

const card = (id: string) => (
  <View testID={`card.${id}`}>
    <Text>{id}</Text>
  </View>
);

describe('CardGrid', () => {
  it('finishes collapsed trio rows before placing another trio or pair', async () => {
    const screen = await renderScreen(
      <CardGrid testID="mixed" columns={3}>
        {['small-a', 'small-b', 'small-c'].map(id => <CardGridCell key={id} columns={3}>{card(id)}</CardGridCell>)}
        {['small-d', 'small-e', 'small-f'].map((id, index) => <CardGridCell key={id} columns={3} startRow={index === 0}>{card(id)}</CardGridCell>)}
        {['medium-a', 'medium-b'].map(id => <CardGridCell key={id} columns={2}>{card(id)}</CardGridCell>)}
      </CardGrid>,
    );
    const measured = screen.findAll(node => node.props.testID === 'mixed' && typeof node.props.onLayout === 'function')[0]!;
    await act(async () => measured.props.onLayout({ nativeEvent: { layout: { width: 500, height: 800 } } }));
    const cells = screen.findAll(node => typeof node.type === 'string'
      && StyleSheet.flatten(node.props.style)?.width === '50%'
      && StyleSheet.flatten(node.props.style)?.flexShrink === 0);
    const contents = cells.map(cell => [...new Set(cell.findAll(node => String(node.props.testID).startsWith('card.'))
      .map(node => node.props.testID))].join(' '));
    expect(contents).toEqual(['card.small-a', 'card.small-b', 'card.small-c', '', 'card.small-d', 'card.small-e', 'card.small-f', '', 'card.medium-a', 'card.medium-b']);
  });
});
