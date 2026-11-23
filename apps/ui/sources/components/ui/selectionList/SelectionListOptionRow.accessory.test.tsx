import * as React from 'react';
import { View } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock({
    Platform: {
      OS: 'android',
      select: <T,>(options: {
        android?: T;
        default?: T;
        native?: T;
        ios?: T;
        web?: T;
      }) =>
        options.android ??
        options.native ??
        options.default ??
        options.ios ??
        options.web,
    },
  });
});

installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { PlanOptionRow } = await import('./SelectionListOptionRow');

describe('SelectionListOptionRow accessory ownership', () => {
  it('keeps interactive accessories outside the row pressable', async () => {
    const screen = await renderScreen(
      <PlanOptionRow
        option={{
          id: 'model-a',
          label: 'Model A',
          rightAccessory: <View testID="accessory" />,
          rightAccessoryOutsidePressable: true,
        }}
        rootTestID="models"
        stepId="root"
        isSelected={false}
        isFocused={false}
        onSelect={() => {}}
        onPushStep={() => {}}
      />,
    );
    const row = screen.findByTestId('models:root:option:model-a');
    const accessory = screen.findByTestId('accessory');
    expect(row).not.toBeNull();
    expect(accessory).not.toBeNull();
    for (let ancestor = accessory!.parent; ancestor; ancestor = ancestor.parent) {
      expect(ancestor).not.toBe(row);
    }
  });

  it('uses one native button owner without leaking the web option role onto custom content', async () => {
    const screen = await renderScreen(
      <PlanOptionRow
        option={{
          id: 'custom',
          label: 'Custom',
          accessibilityLabel: 'Provider, connection, Custom',
          content: <React.Fragment>Custom content</React.Fragment>,
        }}
        rootTestID="models"
        stepId="root"
        isSelected
        isFocused={false}
        onSelect={() => {}}
        onPushStep={() => {}}
        positionInSet={2}
        setSize={3}
      />,
    );

    const option = screen.findByTestId('models:root:option:custom');
    expect(option?.props.accessibilityRole).toBe('button');
    expect(option?.props.role).toBeUndefined();
    expect(option?.props.accessibilityLabel).toBe(
      'Provider, connection, Custom',
    );
    expect(option?.props.accessibilityState).toMatchObject({ selected: true });
  });

  it('dims a disabled custom-content choice but keeps a static disclosure at full strength', async () => {
    const opacityOf = (node: { props: { style?: unknown } } | null) => {
      const style = node?.props.style;
      const resolved =
        typeof style === 'function' ? style({ pressed: false }) : style;
      return flattenTestStyle(resolved).opacity;
    };
    const render = (option: Parameters<typeof PlanOptionRow>[0]['option']) =>
      renderScreen(
        <PlanOptionRow
          option={option}
          rootTestID="share"
          stepId="root"
          isSelected={false}
          isFocused={false}
          onSelect={() => {}}
          onPushStep={() => {}}
        />,
      );
    const choice = await render({
      id: 'choice',
      label: 'Choice',
      disabled: true,
      onSelect: () => {},
      content: <React.Fragment>Choice</React.Fragment>,
    });
    expect(opacityOf(choice.findByTestId('share:root:option:choice'))).toBe(
      0.5,
    );
    await choice.unmount();
    const disclosure = await render({
      id: 'note',
      label: 'Note',
      disabled: true,
      content: <React.Fragment>Note</React.Fragment>,
    });
    expect(opacityOf(disclosure.findByTestId('share:root:option:note'))).toBe(
      1,
    );
    await disclosure.unmount();
  });
});
