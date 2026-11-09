/** @vitest-environment jsdom */
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRenderCommitCounter, renderScreen, standardCleanup } from '@/dev/testkit';

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

// Collect the real component graph before the interaction-test deadline starts.
await import('./Item');
await import('@/components/ui/text/Text');
const { AppShellMaterialFrame } = await import('@/components/navigation/shell/AppShellMaterialFrame');
const { Popover } = await import('@/components/ui/popover/Popover');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Screen = Awaited<ReturnType<typeof renderScreen>>;
type Node = ReturnType<Screen['findAll']>[number];

const TITLE = 'systematic-debugging-with-a-very-long-name';

async function renderMetaRow() {
  const { Item } = await import('./Item');
  const { Text } = await import('@/components/ui/text/Text');
  return renderScreen(
    <Item title={TITLE} subtitle="Find the root cause before fixing." titleMeta={<Text testID="meta">Everywhere · except Gemini</Text>} onPress={() => {}} />,
  );
}

/** Layout is the platform boundary: the row's text column reports its width, the meta its natural width. */
async function layout(screen: Screen, widths: Readonly<{ row: number; meta: number }>) {
  const { act } = await import('react-test-renderer');
  const holders = () => screen.findAll((node) => typeof node.type === 'string' && typeof node.props?.onLayout === 'function');
  await act(async () => {
    for (const node of holders()) {
      const holdsMeta = node.findAll((child: Node) => child.props?.testID === 'meta').length > 0;
      const holdsTitle = node.findAll((child: Node) => child.props?.children === TITLE).length > 0;
      if (holdsMeta && holdsTitle) node.props.onLayout({ nativeEvent: { layout: { width: widths.row, height: 40, x: 0, y: 0 } } });
    }
  });
  await act(async () => {
    for (const node of holders()) {
      const holdsMeta = node.findAll((child: Node) => child.props?.testID === 'meta').length > 0;
      const holdsTitle = node.findAll((child: Node) => child.props?.children === TITLE).length > 0;
      if (holdsMeta && !holdsTitle) node.props.onLayout({ nativeEvent: { layout: { width: widths.meta, height: 18, x: 0, y: 0 } } });
    }
  });
}

/** The smallest host element holding both the title and the meta: their shared line, or the whole column. */
function sharesTitleLine(screen: Screen): boolean {
  const rows = screen.findAll((node) => typeof node.type === 'string'
    && node.findAll((child: Node) => child.props?.testID === 'meta').length > 0
    && node.findAll((child: Node) => child.props?.children === TITLE).length > 0
    && node.findAll((child: Node) => child.props?.children === 'Find the root cause before fixing.').length === 0);
  return rows.length > 0;
}

describe('Item titleMeta', () => {
  it('settles a 34-row popover across the title/meta fit boundary, resize, selection and Escape', async () => {
    const { Item } = await import('./Item');
    const { Text } = await import('@/components/ui/text/Text');
    const { Pressable, StyleSheet } = await import('react-native');
    const { act } = await import('react-test-renderer');
    const commits = createRenderCommitCounter();
    let mounts = 0;
    let unmounts = 0;
    let metaMounts = 0;
    let metaUnmounts = 0;
    let selections = 0;
    const title = 'leeroy-mbp · 5702';
    // PF-01's loaded Chromium trace: the name is 113px, the unpadded meta 166px,
    // and the 330px panel leaves a 298px text column. The audit held 34 Machines.
    const measuredTitle = 113;
    const measuredMeta = 166;
    function Meta({ index }: { index: number }) {
      React.useEffect(() => { metaMounts += 1; return () => { metaUnmounts += 1; }; }, []);
      return <Text testID={`settled-meta:${index}`}>Offline · last seen Aug 25</Text>;
    }
    function Row({ index, select }: { index: number; select: (index: number) => void }) {
      React.useEffect(() => { mounts += 1; return () => { unmounts += 1; }; }, []);
      return <Item testID={`settled-row:${index}`} title={title} titleLines={1} density="compact"
        titleMeta={<Meta index={index} />}
        showChevron={false} onPress={() => select(index)} />;
    }
    function Harness() {
      const [open, setOpen] = React.useState(false);
      const [selected, setSelected] = React.useState<number | null>(null);
      return <React.Profiler id="machines-popover" onRender={commits.commit}>
        <AppShellMaterialFrame showChrome={false} dragEnabled={false} leftOffsetPx={0} sidebarWidth={0}
          titleStrip={null} rail={null} column={null} peek={null}>
          <Pressable testID="settled-open" onPress={() => setOpen(true)}><Text>Machines</Text></Pressable>
          <Text testID="settled-selection">{selected === null ? '' : String(selected)}</Text>
          {open ? <Popover open anchor={{ kind: 'rect', rect: { left: 20, top: 200, width: 40, height: 40 }, coordinateSpace: 'window' }}
            portal={{ web: false, native: false }} maxWidthCap={330} onRequestClose={() => setOpen(false)}>
            {() => Array.from({ length: 34 }, (_, index) => <Row key={index} index={index}
              select={(index) => { selections += 1; setSelected(index); }} />)}
          </Popover> : null}
        </AppShellMaterialFrame>
      </React.Profiler>;
    }
    const screen = await renderScreen(<Harness />);
    // The OS reports border-box width, including padding but excluding margin.
    // Keep that boundary real to the authored box rather than feeding the rule its desired input.
    const frame = async (rowWidth: number) => {
      const holders = screen.findAll(node => typeof node.type === 'string' && typeof node.props.onLayout === 'function');
      await act(async () => {
        for (const node of holders) {
          const meta = node.findAll(child => typeof child.props.testID === 'string' && child.props.testID.startsWith('settled-meta:'));
          const name = node.findAll(child => child.props.children === title);
          if (!meta.length && !name.length) continue;
          const style = StyleSheet.flatten(node.props.style);
          const paddingLeft = typeof style?.paddingLeft === 'number' ? style.paddingLeft : 0;
          const width = meta.length && name.length ? rowWidth : meta.length
            ? measuredMeta + paddingLeft : measuredTitle;
          node.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width, height: 22 } } });
        }
      });
    };
    const settle = async (width: number) => { for (let pass = 0; pass < 8; pass += 1) await frame(width); };
    try {
      await screen.pressByTestIdAsync('settled-open');
      await settle(298);
      expect(mounts).toBe(34);
      for (let index = 0; index < 34; index += 1) expect(screen.findHostByTestId(`settled-row:${index}`)).not.toBeNull();
      const settledMounts = mounts;
      expect({ metaMounts, metaUnmounts }).toEqual({ metaMounts: 34, metaUnmounts: 0 });
      commits.reset();
      await settle(298);
      expect(commits.read().commits).toBe(0);
      expect(mounts).toBe(settledMounts);
      expect(unmounts).toBe(0);
      expect({ metaMounts, metaUnmounts }).toEqual({ metaMounts: 34, metaUnmounts: 0 });

      // A real narrower box still moves the meta beneath its title, then stops.
      await settle(240);
      expect(commits.read().commits).toBeGreaterThan(0);
      expect({ metaMounts, metaUnmounts }).toEqual({ metaMounts: 68, metaUnmounts: 34 });
      commits.reset();
      await settle(240);
      expect(commits.read().commits).toBe(0);
      expect({ metaMounts, metaUnmounts }).toEqual({ metaMounts: 68, metaUnmounts: 34 });
      await screen.pressByTestIdAsync('settled-row:0');
      expect(selections).toBe(1);
      expect(screen.findByTestId('settled-selection')!.props.children).toBe('0');
      commits.reset();
      await settle(240);
      expect(commits.read().commits).toBe(0);

      await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(screen.findHostByTestId('settled-row:0')).toBeNull();
      expect(unmounts).toBe(34);
      expect(metaUnmounts).toBe(metaMounts);
      commits.reset();
      await settle(240);
      expect(commits.read().commits).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it('draws the meta whole on the title line, and moves it beneath the title when the line is too narrow', async () => {
    const screen = await renderMetaRow();
    await layout(screen, { row: 480, meta: 170 });
    expect(screen.findAll((node) => node.props?.testID === 'meta').length).toBeGreaterThan(0);
    expect(sharesTitleLine(screen)).toBe(true);

    await layout(screen, { row: 240, meta: 170 });
    // Still drawn whole, now on its own line under the title.
    expect(screen.findAll((node) => node.props?.testID === 'meta').length).toBeGreaterThan(0);
    expect(sharesTitleLine(screen)).toBe(false);
  });

  it('lets a title that may wrap (titleLines 0) wrap beside its meta instead of cutting it to one line', async () => {
    const { Item } = await import('./Item');
    const { Text } = await import('@/components/ui/text/Text');
    const screen = await renderScreen(
      <Item title={TITLE} titleLines={0} titleMeta={<Text testID="meta">NLDW3-5-36-33 · eadc</Text>} onPress={() => {}} />,
    );
    await layout(screen, { row: 300, meta: 150 });
    // The drawn title, not the hidden copy the row measures its natural width with.
    const hidden = (node: Node | null): boolean => node !== null
      && (node.props?.['aria-hidden'] === true || node.props?.accessibilityElementsHidden === true || hidden(node.parent));
    const drawnTitles = screen.findAll((node) => typeof node.type === 'string' && node.props?.children === TITLE && !hidden(node));
    expect(drawnTitles.length).toBeGreaterThan(0);
    expect(drawnTitles.some((node) => node.props?.numberOfLines === 1)).toBe(false);
  });
});
