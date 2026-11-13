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
type Node = ReturnType<Screen['findAll']>[number];

async function renderDetailRow(detail: string, title = 'Advanced', withIcon = false, subtitle?: string) {
  const { Item } = await import('./Item');
  const { ListPresentationProvider } = await import('./listPresentation');
  return renderScreen(
    <ListPresentationProvider value="page">
      <Item
        title={title}
        detail={detail}
        {...(subtitle ? { subtitle } : {})}
        {...(withIcon ? { icon: <span />, showChevron: true } : {})}
        detailTestID="detail"
        onPress={() => {}}
      />
    </ListPresentationProvider>,
  );
}

/** Layout is the platform boundary: the row reports its width, the detail its natural width. */
async function layout(
  screen: Screen,
  widths: Readonly<{ row: number; detail: number; title?: number; titleText?: string }>,
) {
  const { act } = await import('react-test-renderer');
  const measured = () =>
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        typeof node.props?.onLayout === 'function',
    );
  await act(async () => {
    measured()[0]!.props.onLayout({
      nativeEvent: { layout: { width: widths.row, height: 52, x: 0, y: 0 } },
    });
  });
  await act(async () => {
    for (const node of measured().slice(1)) {
      if (
        node.findAll(
          (child: Node) =>
            child.props?.children ===
            'Service identity · API tokens · Encryption',
        ).length > 0 ||
        node.findAll((child: Node) => child.props?.children === '0.2.10')
          .length > 0 ||
        node.findAll((child: Node) => child.props?.children === 'Service identity · diagnostics')
          .length > 0 ||
        node.findAll(
          (child: Node) => child.props?.children === 'Orchestrator · hands-off',
        ).length > 0
      ) {
        node.props.onLayout({
          nativeEvent: {
            layout: { width: widths.detail, height: 20, x: 0, y: 0 },
          },
        });
      } else if (
        widths.title !== undefined &&
        node.props?.children === widths.titleText
      ) {
        node.props.onLayout({
          nativeEvent: {
            layout: { width: widths.title, height: 20, x: 0, y: 0 },
          },
        });
      }
    }
  });
}

/** The visible detail: the one a reader sees (testID), and whether it is clamped to one line. */
function visibleDetail(screen: Screen) {
  const nodes = screen.findAll(
    (node) => typeof node.type === 'string' && node.props?.testID === 'detail',
  );
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function sharesTitleColumn(screen: Screen, detail: Node, title = 'Advanced'): boolean {
  // Beneath the title: the detail and the title sit in the same text column.
  return (
    screen.findAll(
      (node) =>
        typeof node.type === 'string' &&
        node.findAll((child: Node) => child === detail).length > 0 &&
        node.findAll((child: Node) => child.props?.children === title)
          .length > 0 &&
        node.findAll(
          (child: Node) => typeof child.props?.onLayout === 'function',
        ).length === 0,
    ).length > 0
  );
}

describe('Item page row detail placement', () => {
  it('moves a summary that would squeeze its label beneath the title on a narrow row, unclamped', async () => {
    const screen = await renderDetailRow(
      'Service identity · API tokens · Encryption',
    );
    await layout(screen, { row: 358, detail: 260 });
    const detail = visibleDetail(screen);
    expect(sharesTitleColumn(screen, detail)).toBe(true);
    expect(detail.props.numberOfLines ?? null).toBeNull();
  });

  it('keeps a short value trailing beside its label on a narrow row', async () => {
    const screen = await renderDetailRow('0.2.10');
    await layout(screen, { row: 358, detail: 44 });
    expect(sharesTitleColumn(screen, visibleDetail(screen))).toBe(false);
  });

  it('keeps a value beside a short label that needs far less than the label column', async () => {
    // "Role · Orchestrator · hands-off" in a ~340px pane: the label needs ~32px, so reserving the
    // whole 200px label column stacked a value that fits on the line with room to spare.
    const screen = await renderDetailRow('Orchestrator · hands-off', 'Role');
    await layout(screen, { row: 340, detail: 150, title: 32, titleText: 'Role' });
    expect(sharesTitleColumn(screen, visibleDetail(screen), 'Role')).toBe(false);
  });

  it('counts the row\'s own padding and leading mark, so a short label is never squeezed into wrapping', async () => {
    // Measured live at 390 (Account → Happier Cloud → Advanced): the row is 356px wide, but 64px of it is
    // padding and the leading mark, so a 190px value left the 65px "Advanced" label less than its width.
    const screen = await renderDetailRow('Service identity · diagnostics', 'Advanced', true);
    await layout(screen, { row: 356, detail: 190, title: 65, titleText: 'Advanced' });
    expect(sharesTitleColumn(screen, visibleDetail(screen))).toBe(true);
  });

  it('moves a description beneath a short label on a phone row: only a short value sits beside a label (L13)', async () => {
    // Session Info › "Fork…  Native, replay or configure" on a 402 phone: the label is short, but the detail is
    // a sentence that takes most of the line, so it reads as the row's description, beneath its title.
    const screen = await renderDetailRow('Service identity · diagnostics', 'Fork', true);
    await layout(screen, { row: 366, detail: 176, title: 34, titleText: 'Fork' });
    expect(sharesTitleColumn(screen, visibleDetail(screen), 'Fork')).toBe(true);
  });

  it('keeps a row\'s facts under its name and moves a short value after them when it goes beneath', async () => {
    // All deployments on a 390 phone: a long Environment name sent "2d ago" beneath, between the name and its facts.
    const screen = await renderDetailRow('0.2.10', 'DEF-EDITOR-1110-stored-r121', true, 'NLDW3-5-36-33 · Compose');
    await layout(screen, { row: 358, detail: 44, title: 230, titleText: 'DEF-EDITOR-1110-stored-r121' });
    const detail = visibleDetail(screen);
    expect(sharesTitleColumn(screen, detail, 'DEF-EDITOR-1110-stored-r121')).toBe(true);
    const column = screen.findAll((node) => typeof node.type === 'string'
      && node.findAll((child: Node) => child === detail).length > 0
      && node.findAll((child: Node) => child.props?.children === 'NLDW3-5-36-33 · Compose').length > 0)[0]!;
    const order = column.findAll((node: Node) => node === detail || node.props?.children === 'NLDW3-5-36-33 · Compose');
    expect(order[0]).not.toBe(detail);
  });

  it('keeps a summary trailing on a wide row', async () => {
    const screen = await renderDetailRow(
      'Service identity · API tokens · Encryption',
    );
    await layout(screen, { row: 820, detail: 260 });
    expect(sharesTitleColumn(screen, visibleDetail(screen))).toBe(false);
  });
});
