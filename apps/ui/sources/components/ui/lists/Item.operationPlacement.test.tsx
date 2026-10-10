import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

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

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;

/**
 * The row and its operation, both measured (layout is the platform boundary here): the row is the
 * measured view that holds the operation; the operation's own measured wrapper reports its width.
 */
function measuredRow(
  screen: Screen,
  act: (callback: () => Promise<void>) => Promise<void>,
) {
  const measured = () =>
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props?.onLayout === 'function' &&
        node.findAll((child) => child.props?.testID === 'operation').length > 0,
    );
  const styleOf = (node: { props: { style?: unknown } }) =>
    [node.props.style].flat(Infinity).filter(Boolean) as Array<
      Record<string, unknown>
    >;
  // The outermost measured host is the row; the innermost wraps the operation alone.
  const row = () => measured()[0]!;
  const operation = () => measured()[measured().length - 1]!;
  const direction = () =>
    styleOf(row()).reduce<unknown>(
      (current, entry) => entry.flexDirection ?? current,
      undefined,
    );
  const layout = async (
    widths: Readonly<{ row: number; operation: number }>,
  ) => {
    await act(async () => {
      row().props.onLayout({
        nativeEvent: { layout: { width: widths.row, height: 52, x: 0, y: 0 } },
      });
    });
    await act(async () => {
      if (operation() !== row())
        operation().props.onLayout({
          nativeEvent: {
            layout: { width: widths.operation, height: 32, x: 0, y: 0 },
          },
        });
    });
  };
  return { direction, layout };
}

async function renderOperationRow(accessoryLayout?: 'adaptive') {
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  return renderScreen(
    <ListPresentationProvider value="page">
      <Item
        title="Where"
        subtitle="~/code/happier"
        rightElement={React.createElement('Operation', { testID: 'operation' })}
        rightElementOutsidePressable
        accessoryLayout={accessoryLayout}
      />
    </ListPresentationProvider>,
  );
}

describe('Item page operation placement', () => {
  it('keeps a short operation beside its label in a narrow row (a dialog pane, a phone)', async () => {
    const { act } = await import('react-test-renderer');
    const { direction, layout } = measuredRow(await renderOperationRow(), act);

    // "Change" in a 400pt dialog pane: the label keeps well over its column.
    await layout({ row: 400, operation: 84 });
    expect(direction()).not.toBe('column');
  });

  it('moves an operation beneath its label once it would squeeze the label below its column', async () => {
    const { act } = await import('react-test-renderer');
    const { direction, layout } = measuredRow(await renderOperationRow(), act);

    await layout({ row: 358, operation: 180 });
    expect(direction()).toBe('column');
  });

  it('still moves a wide control (a segmented choice, a field select) beneath its label in a narrow row', async () => {
    const { act } = await import('react-test-renderer');
    const { direction, layout } = measuredRow(
      await renderOperationRow('adaptive'),
      act,
    );

    await layout({ row: 400, operation: 84 });
    expect(direction()).toBe('column');
  });
    it('starts a control placed under its label at the label\'s edge, after the section\'s mark column', async () => {
        const { act } = await import('react-test-renderer');
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const { PAGE_LIST_METRICS } = await import('./pageListMetrics');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <Item
                    title="Branch"
                    icon={React.createElement('Mark')}
                    rightElement={React.createElement('Operation', { testID: 'operation' })}
                    accessoryLayout="adaptive"
                    onPress={() => {}}
                />
            </ListPresentationProvider>,
        );
        const { direction, layout } = measuredRow(screen, act);
        await layout({ row: 358, operation: 200 });
        expect(direction()).toBe('column');
        const insets = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'operation').length > 0)
            .map((node) => [node.props.style].flat(Infinity).filter(Boolean)
                .reduce<unknown>((current, entry) => (entry as Record<string, unknown>).marginLeft ?? current, undefined))
            .filter((inset) => typeof inset === 'number' && inset > 0);
        expect(insets).toEqual([PAGE_LIST_METRICS.rowLeadingColumnPx + PAGE_LIST_METRICS.rowLeadingGapPx]);
    });
});
