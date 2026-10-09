import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

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

const itemProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}));
vi.mock('@/components/ui/lists/Item', () => ({
  Item: (props: Record<string, unknown>) => {
    itemProps.current = props;
    return React.createElement('Item', props);
  },
}));

import { PlanOptionRow } from './SelectionListOptionRow';

describe('SelectionListOptionRow accessory ownership', () => {
  it('keeps interactive accessories outside the row pressable', async () => {
    await renderScreen(
      <PlanOptionRow
        option={{
          id: 'model-a',
          label: 'Model A',
          rightAccessory: <React.Fragment />,
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
    expect(itemProps.current?.rightElementOutsidePressable).toBe(true);
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
      return (resolved as { opacity?: number } | undefined)?.opacity;
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
