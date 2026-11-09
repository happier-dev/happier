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
  it('stacks two one-row cards beside a two-row card, and gives a full-width card its own band', async () => {
    const screen = await renderScreen(
      <CardGrid testID="grid" columns={2}>
        <CardGridCell key="medium" rows={2}>
          {card('medium')}
        </CardGridCell>
        <CardGridCell key="small-a" rows={1}>
          {card('small-a')}
        </CardGridCell>
        <CardGridCell key="small-b" rows={1}>
          {card('small-b')}
        </CardGridCell>
        <CardGridCell key="wide" span="row" rows={1}>
          {card('wide')}
        </CardGridCell>
        <CardGridCell key="lone" rows={2}>
          {card('lone')}
        </CardGridCell>
      </CardGrid>,
    );
    const beside = screen.findByTestId('grid.band.medium.column.1');
    expect(beside).not.toBeNull();
    // Both Smalls share the column beside the Medium: one band, not two rows of stretched pairs.
    expect(
      beside!.findAll((node) => node.props.testID === 'card.small-a'),
    ).toHaveLength(1);
    expect(
      beside!.findAll((node) => node.props.testID === 'card.small-b'),
    ).toHaveLength(1);
    expect(
      screen
        .findByTestId('grid.band.medium.column.0')!
        .findAll((node) => node.props.testID === 'card.medium'),
    ).toHaveLength(1);
    // The wide card is in no column band; a lone half card keeps its half (its partner column stays empty).
    expect(
      screen
        .findAll(
          (node) =>
            typeof node.props.testID === 'string' &&
            /^grid\.band\..*\.column\./.test(node.props.testID),
        )
        .some(
          (column) =>
            column.findAll((node) => node.props.testID === 'card.wide').length >
            0,
        ),
    ).toBe(false);
    const lone = screen.findByTestId('grid.band.lone.column.0');
    expect(
      lone!.findAll((node) => node.props.testID === 'card.lone'),
    ).toHaveLength(1);
    expect(
      screen
        .findByTestId('grid.band.lone.column.1')!
        .findAll(
          (node) =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('card.'),
        ),
    ).toHaveLength(0);
  });

  it('keeps one card per column when no card says how many rows it takes', async () => {
    const screen = await renderScreen(
      <CardGrid testID="grid" columns={2}>
        <CardGridCell key="one">{card('one')}</CardGridCell>
        {card('two')}
      </CardGrid>,
    );
    expect(
      screen.findAll(
        (node) =>
          typeof node.props.testID === 'string' &&
          /^grid\.band\./.test(node.props.testID),
      ),
    ).toHaveLength(0);
    expect(screen.findByTestId('card.one')).not.toBeNull();
    expect(screen.findByTestId('card.two')).not.toBeNull();
  });
});
