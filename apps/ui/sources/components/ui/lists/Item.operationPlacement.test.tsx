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

// Load the real row graph during collection, outside the interaction deadline.
await import('./Item');

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

  it('keeps a field select beside its label in a pane column where a label and an inline field both fit', async () => {
    const { act } = await import('react-test-renderer');
    const { direction, layout } = measuredRow(
      await renderOperationRow('adaptive'),
      act,
    );

    // A 500px pane column holds the label column, the gap, an inline field (240) and both row insets,
    // so the select stays trailing, as on a desktop page.
    await layout({ row: 500, operation: 240 });
    expect(direction()).not.toBe('column');
    // Four pixels short of that, and on every phone sheet, it moves beneath rather than overflow the inset.
    await layout({ row: 480, operation: 240 });
    expect(direction()).toBe('column');
    await layout({ row: 398, operation: 132 });
    expect(direction()).toBe('column');
  });
    it('lets a field that measured inline keep its width beside the label instead of overflowing the trailing inset', async () => {
        const { act } = await import('react-test-renderer');
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <Item
                    title="Folder"
                    rightElement={React.createElement('Operation', { testID: 'operation' })}
                    accessoryLayout="adaptive"
                    showChevron={false}
                />
            </ListPresentationProvider>,
        );
        const { direction, layout } = measuredRow(screen, act);
        // A ~490px dialog row holds the label column, the gap, the 240px inline field and both insets.
        await layout({ row: 490, operation: 240 });
        expect(direction()).not.toBe('column');
        // No box around the field is also capped at half the row: half of 490 less the insets is
        // narrower than the field, which then drew past the sheet's trailing inset.
        const halfCaps = screen.findAll((node) => typeof node.type === 'string'
            && node.findAll((child) => child.props?.testID === 'operation').length > 0)
            .map((node) => [node.props.style].flat(Infinity).filter(Boolean)
                .reduce<unknown>((current, entry) => (entry as Record<string, unknown>).maxWidth ?? current, undefined))
            .filter((maxWidth) => maxWidth === '50%');
        expect(halfCaps).toEqual([]);
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

    it('keeps a field beside a short name and its marker in a narrow desktop pane, where the shared 200px label column would stack it', async () => {
        const { act } = await import('react-test-renderer');
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <Item
                    title="Reviewer"
                    titleAccessory={React.createElement('Marker', { testID: 'marker' })}
                    rightElement={React.createElement('Operation', { testID: 'operation' })}
                    rightElementOutsidePressable
                    accessoryLayout="adaptive"
                    fieldAccessory
                    showChevron={false}
                />
            </ListPresentationProvider>,
        );
        const { direction, layout } = measuredRow(screen, act);
        const report = async (matches: (node: ReturnType<typeof screen.findAll>[number]) => boolean, widthPx: number) => {
            await act(async () => {
                for (const node of screen.findAll((candidate) => typeof candidate.type === 'string' && matches(candidate)
                    && typeof candidate.props?.onLayout === 'function')) {
                    node.props.onLayout({ nativeEvent: { layout: { width: widthPx, height: 20, x: 0, y: 0 } } });
                }
            });
        };
        // The Work pane at its 340px default: a 323px row. The name (61) and its marker (57) are measured.
        await layout({ row: 323, operation: 132 });
        await report((node) => node.props?.children === 'Reviewer' && node.props?.onLayout !== undefined, 61);
        await report((node) => node.findAll((child) => child.props?.testID === 'marker').length > 0
            && node.findAll((child) => child.props?.testID === 'operation').length === 0, 57);
        expect(direction()).not.toBe('column');
    });

    it('counts a glyph that shares the field\'s slot against the room, so the name is never squeezed', async () => {
        const { act } = await import('react-test-renderer');
        const { Item } = await import('./Item');
        const { ListPresentationProvider } = await import('./listPresentation');
        const screen = await renderScreen(
            <ListPresentationProvider value="page">
                <Item
                    title="Reviewer"
                    titleAccessory={React.createElement('Marker', { testID: 'marker' })}
                    rightElement={React.createElement('Operation', { testID: 'operation' })}
                    rightElementOutsidePressable
                    accessoryLayout="adaptive"
                    fieldAccessory
                    fieldAccessorySiblingPx={60}
                    showChevron={false}
                />
            </ListPresentationProvider>,
        );
        const { direction, layout } = measuredRow(screen, act);
        const report = async (matches: (node: ReturnType<typeof screen.findAll>[number]) => boolean, widthPx: number) => {
            await act(async () => {
                for (const node of screen.findAll((candidate) => typeof candidate.type === 'string' && matches(candidate)
                    && typeof candidate.props?.onLayout === 'function')) {
                    node.props.onLayout({ nativeEvent: { layout: { width: widthPx, height: 20, x: 0, y: 0 } } });
                }
            });
        };
        // The same 323px row, name and marker as above: the field alone fits beside them, field and 60px of sibling do not.
        await layout({ row: 323, operation: 132 });
        await report((node) => node.props?.children === 'Reviewer' && node.props?.onLayout !== undefined, 61);
        await report((node) => node.findAll((child) => child.props?.testID === 'marker').length > 0
            && node.findAll((child) => child.props?.testID === 'operation').length === 0, 57);
        expect(direction()).toBe('column');
    });
});

describe('Item catalog row trailing placement', () => {
  it('keeps a catalog row\'s trailing count and menu on its line in a narrow rail (the description yields, ST-5)', async () => {
    const { act } = await import('react-test-renderer');
    const { Item } = await import('./Item');
    const screen = await renderScreen(
      <Item
        rowRole="catalogRow"
        title="Q1 Round 4 Source"
        subtitle="github.com/acme/q1-round-4-source"
        rightElement={React.createElement('Operation', { testID: 'operation' })}
        rightElementOutsidePressable
        showChevron={false}
      />,
    );
    // A 228px tree/rail row whose count and menu take 120px: wider than an operation's share of the row.
    await act(async () => {
      for (const node of screen.findAll((candidate) => typeof candidate.type === 'string'
        && typeof candidate.props?.onLayout === 'function'
        && candidate.findAll((child) => child.props?.testID === 'operation').length > 0)) {
        const operationOnly = node.findAll((child) => typeof child.type === 'string' && typeof child.props?.onLayout === 'function'
          && child !== node).length === 0;
        node.props.onLayout({ nativeEvent: { layout: { width: operationOnly ? 120 : 228, height: 40, x: 0, y: 0 } } });
      }
    });
    const operation = screen.findByTestId('operation')!;
    let ancestor = operation.parent;
    while (ancestor) {
      const style = [ancestor.props?.style].flat(Infinity).filter(Boolean) as Array<Record<string, unknown>>;
      expect(style.some((entry) => entry.flexDirection === 'column' || entry.flexBasis === '100%')).toBe(false);
      ancestor = ancestor.parent;
    }
  });
});

describe('Item chevron with a stacked accessory', () => {
  it('keeps a destination row\'s chevron on its label\'s line when its limits move beneath', async () => {
    const { act } = await import('react-test-renderer');
    const { Item } = await import('./Item');
    const { ListPresentationProvider } = await import('./listPresentation');
    const screen = await renderScreen(
      <ListPresentationProvider value="page">
        <Item
          title="Leeroy"
          rightElement={React.createElement('Operation', { testID: 'operation' })}
          accessoryLayout="adaptive"
          keepChevronWithRightElement
          onPress={() => {}}
        />
      </ListPresentationProvider>,
    );
    const { direction, layout } = measuredRow(screen, act);
    await layout({ row: 358, operation: 320 });
    expect(direction()).toBe('column');
    // One band holds the label and the chevron, without the control placed beneath them.
    const contains = (node: { findAll: (test: (child: any) => boolean) => unknown[] }, test: (child: any) => boolean) => node.findAll(test).length > 0;
    const isChevron = (child: any) => child.props?.name === 'caret-right';
    const isTitle = (child: any) => child.props?.children === 'Leeroy';
    const isOperation = (child: any) => child.props?.testID === 'operation';
    const bands = screen.findAll((node) => typeof node.type === 'string'
      && contains(node, isChevron) && contains(node, isTitle) && !contains(node, isOperation));
    expect(bands.length).toBeGreaterThan(0);
  });
});
