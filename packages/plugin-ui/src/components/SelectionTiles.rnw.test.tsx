import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { ItemGroup, SelectionTiles, Text, type SelectionTilesOption } from './index.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { HappierSelectionTiles } from '../presentation/form/SelectionTiles.js';
import { HappierPageSheet } from '../presentation/layout/PageSection.js';
import { hitAreaClippingAncestors, readHitAreaReach } from '../presentation/interaction/hitArea.testSupport.js';
import { HAPPIER_TYPE_SCALE, resolveHappierTypeScale, type HappierTypeRole } from '../presentation/text/typeScale.js';
import { PluginUiScrollActivityProvider, type PluginUiScrollActivityTracker } from '../presentationHost/scrollActivity.js';

const ACTION_OPTIONS = [
  { id: 'phone', title: 'Add your phone', subtitle: 'Show a QR code', testID: 'action:phone' },
  { id: 'home', title: 'Add another Home', subtitle: 'Scan a QR code', testID: 'action:home' },
  { id: 'scan', title: 'Scan QR', disabled: true, testID: 'action:scan' },
] as const;
const TILE_COLORS = {
  tileBackground: 'white', tileBorder: 'gray', selection: 'black', glyph: 'black', ring: 'black',
  previewBackground: 'white', actionBackground: 'white', actionBorderHovered: 'black',
};
const SHEET_COLORS = { sheet: 'white', sheetBorder: 'gray', rowDivider: 'gray', groupDivider: 'gray' };

/**
 * The row hairlines a page sheet draws between its rows: decoration hidden from assistive technology since C77
 * (23239f43e5a), never a `separator` a row may own. Read by their drawn shape, an empty hidden one-pixel rule.
 */
function rowRules(container: HTMLElement): HTMLElement[] {
  expect(container.querySelector('[role="separator"]')).toBeNull();
  return [...container.querySelectorAll<HTMLElement>('[aria-hidden="true"]:empty')].filter((node) => getComputedStyle(node).height === '1px');
}

function measureTiles(container: HTMLElement, width: number) {
  // jsdom has no ResizeObserver. Deliver real RNW layout events to the tile's
  // measured ancestors, rather than an unrelated section header's first callback.
  const tile = container.querySelector<HTMLElement>('[data-testid="action:phone"]');
  expect(tile).not.toBeNull();
  for (let node = tile?.parentElement; node && node !== container; node = node.parentElement) {
    const handler = Reflect.get(node, '__reactLayoutHandler');
    if (typeof handler === 'function') {
      act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width, height: 240 } } }));
    }
  }
}

function mountTiles(element: React.ReactElement, context = createSurfaceContext()) {
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      {element}
    </PluginUiProvider>,
  );
}

const DENSITY_OPTIONS: readonly SelectionTilesOption<'comfortable' | 'compact' | 'dense' | 'cozy'>[] = [
  { id: 'comfortable', title: 'Comfortable', subtitle: 'More room' },
  { id: 'compact', title: 'Compact' },
  { id: 'dense', title: 'Dense', disabled: true },
  { id: 'cozy', title: 'Cozy' },
];

function ControlledSingle(props: Readonly<{ variant?: 'card' | 'visual'; onChange?: (next: string | null) => void }>) {
  const [value, setValue] = useState<'comfortable' | 'compact' | 'dense' | 'cozy' | null>('compact');
  return (
    <SelectionTiles
      variant={props.variant}
      accessibilityLabel="Row density"
      options={DENSITY_OPTIONS}
      value={value}
      onChange={(next) => {
        props.onChange?.(next);
        setValue(next);
      }}
      testID="density"
    />
  );
}

function radios(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
}

function checked(container: HTMLElement, role: 'radio' | 'checkbox'): string[] {
  return [...container.querySelectorAll<HTMLElement>(`[role="${role}"]`)]
    .filter((tile) => tile.getAttribute('aria-checked') === 'true')
    .map((tile) => tile.textContent ?? '');
}

async function pressKey(target: HTMLElement, key: string): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
  });
}

describe('SelectionTiles', () => {
  it('keeps a visual tile accessory outside the choice so its operation does not select the theme', async () => {
    const onChange = vi.fn();
    const onMenu = vi.fn();
    const mount = mountTiles(<SelectionTiles variant="visual" accessibilityLabel="Theme" value="linen"
      onChange={onChange} options={[{ id: 'linen', title: 'Linen', preview: <Text>Linen preview</Text> }]}
      renderOptionAccessory={({ option, revealed }) => revealed
        ? <button aria-label={`Manage ${option.title}`} onClick={onMenu}>Manage</button> : null} />);
    try {
      const accessory = mount.container.querySelector<HTMLElement>('[aria-label="Manage Linen"]');
      expect(accessory).not.toBeNull();
      expect(accessory!.closest('[role="radio"]')).toBeNull();
      await act(async () => { accessory!.click(); });
      expect(onMenu).toHaveBeenCalledOnce();
      expect(onChange).not.toHaveBeenCalled();
    } finally { mount.unmount(); }
  });

  it('renders theme card previews above their description and lets a leading option span the grid', () => {
    const mount = mountTiles(<SelectionTiles accessibilityLabel="Theme" value="linen" onChange={() => undefined}
      descriptionPlacement="below" maximumColumns={2} testID="themes"
      options={[
        { id: 'linen', title: 'Linen', subtitle: 'Warm paper', span: 'row', preview: <Text>Linen preview</Text> },
        { id: 'ink', title: 'Ink', subtitle: 'Deep night', preview: <Text>Ink preview</Text> },
        { id: 'mist', title: 'Mist', subtitle: 'Quiet grey', preview: <Text>Mist preview</Text> },
      ]} />);
    try {
      expect(mount.container.textContent).toContain('Linen preview');
      expect(mount.container.querySelector('[data-testid="themes:linen:description"]')?.textContent).toBe('Warm paper');
      const leading = mount.container.querySelector<HTMLElement>('[data-testid="themes:linen"]')!;
      const next = mount.container.querySelector<HTMLElement>('[data-testid="themes:ink"]')!;
      for (let node = leading.parentElement; node && node !== mount.container; node = node.parentElement) {
        const handler = Reflect.get(node, '__reactLayoutHandler');
        if (typeof handler === 'function') act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 300 } } }));
      }
      expect(getComputedStyle(leading).width).toBe('600px');
      expect(getComputedStyle(next).width).toBe('295px');
    } finally { mount.unmount(); }
  });

  it('draws a page-scrolled visual picker only near the page window, keeping the chosen tile', async () => {
    // A theme library scales with the person's data: its tiles window like the page Collection's (finding 4 + G13).
    const listeners = new Set<() => void>();
    let window = { top: 0, bottom: 400 };
    const tracker: PluginUiScrollActivityTracker = {
      onScroll() {}, onLayout() {}, onContentSizeChange() {}, invalidateLayout() {},
      getLayoutRevision: () => 0, getWindow: () => window,
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      measureSpan: async () => ({ top: 0 }),
    };
    const options = Array.from({ length: 200 }, (_, index) => ({ id: `theme-${index}`, title: `Theme ${index}`, preview: <Text>{`Preview ${index}`}</Text> }));
    const mount = mountTiles(<PluginUiScrollActivityProvider tracker={tracker}>
      <SelectionTiles variant="visual" tileSizing="fill" scroll="page" maximumColumns={4} previewAspectRatio={1.6}
        accessibilityLabel="Light mode" value="theme-150" onChange={() => undefined} options={options} />
    </PluginUiScrollActivityProvider>);
    try {
      const drawn = () => radios(mount.container).map((radio) => radio.getAttribute('aria-label'));
      await act(async () => {});
      expect(drawn().length).toBeGreaterThan(0);
      expect(drawn().length).toBeLessThan(40);
      expect(drawn()).toContain('Theme 0');
      // The chosen tile is the group's tab stop: it stays drawn wherever it is.
      expect(drawn()).toContain('Theme 150');
      window = { top: 2_000, bottom: 2_400 };
      await act(async () => { listeners.forEach((listener) => listener()); });
      expect(drawn()).not.toContain('Theme 0');
      // Lines further down the page take the window's place; the chosen line (148–151) stays besides them.
      expect(drawn().some((name) => !['Theme 148', 'Theme 149', 'Theme 150', 'Theme 151'].includes(name ?? ''))).toBe(true);
      expect(drawn().length).toBeLessThan(40);
    } finally { mount.unmount(); }
  });

  it('hides visual captions without losing accessible names or keyboard selection', async () => {
    const onChange = vi.fn();
    const mount = mountTiles(<SelectionTiles variant="visual" tileSizing="fill" labels="hidden"
      previewAspectRatio={1} labelLines={1} accessibilityLabel="Theme" value="light" onChange={onChange}
      options={[{ id: 'light', title: 'Light', preview: <Text>Day preview</Text>, previewEdge: 'dashed' },
        { id: 'dark', title: 'Dark', preview: <Text>Night preview</Text> }]} />);
    try {
      expect(mount.container.textContent).toBe('Day previewNight preview');
      expect(radios(mount.container).map((radio) => radio.getAttribute('aria-label'))).toEqual(['Light', 'Dark']);
      await pressKey(radios(mount.container)[0]!, 'ArrowRight');
      expect(onChange).toHaveBeenLastCalledWith('dark');
    } finally { mount.unmount(); }
  });
  it('recomposes shared action tiles into one contained page sheet, preserving activation and disabled state through resize', async () => {
    const onPress = vi.fn();
    const mount = mountTiles(
      <HappierPageSheet surface="none" colors={SHEET_COLORS}>
        <HappierSelectionTiles variant="action" accessibilityLabel="Devices" options={ACTION_OPTIONS}
          onPress={onPress} colors={TILE_COLORS} renderText={({ text }) => <span>{text}</span>} renderGlyph={() => null} />
      </HappierPageSheet>,
    );
    const separators = () => rowRules(mount.container);
    try {
      expect(separators()).toHaveLength(0);
      measureTiles(mount.container, 358);
      expect(separators()).toHaveLength(2);
      expect(mount.container.querySelector('[role="group"][aria-label="Devices"]')).not.toBeNull();
      const home = mount.container.querySelector<HTMLElement>('[data-testid="action:home"]')!;
      const scan = mount.container.querySelector<HTMLElement>('[data-testid="action:scan"]')!;
      expect(home.getAttribute('role')).toBe('button');
      expect(home.getAttribute('aria-label')).toBe('Add another Home, Scan a QR code');
      expect(scan.getAttribute('aria-disabled')).toBe('true');
      await act(async () => { home.click(); scan.click(); });
      expect(onPress.mock.calls).toEqual([['home']]);
      measureTiles(mount.container, 704);
      expect(separators()).toHaveLength(0);
      measureTiles(mount.container, 358);
      expect(separators()).toHaveLength(2);
    } finally { mount.unmount(); }
  });

  it('keeps each action option one control across the card/row change, so focus stays on it', () => {
    const mount = mountTiles(
      <HappierPageSheet surface="none" colors={SHEET_COLORS}>
        <HappierSelectionTiles variant="action" accessibilityLabel="Devices" options={ACTION_OPTIONS}
          onPress={() => undefined} colors={TILE_COLORS} renderText={({ text }) => <span>{text}</span>} renderGlyph={() => null} />
      </HappierPageSheet>,
    );
    const option = () => mount.container.querySelector<HTMLElement>('[data-testid="action:home"]')!;
    const separators = () => rowRules(mount.container);
    try {
      measureTiles(mount.container, 704);
      const control = option();
      act(() => control.focus());
      expect(document.activeElement).toBe(control);
      for (const width of [358, 704, 358]) {
        measureTiles(mount.container, width);
        // Rows when narrow, cards when wide: the anatomy changes, the control does not.
        expect(separators()).toHaveLength(width < 400 ? 2 : 0);
        expect(option()).toBe(control);
        expect(document.activeElement).toBe(control);
      }
    } finally { mount.unmount(); }
  });

  it('lets plugin authors use action tiles and inherits page rows from their section', async () => {
    const onPress = vi.fn();
    const mount = mountTiles(
      <ItemGroup title="Devices" surface="none">
        <SelectionTiles variant="action" accessibilityLabel="Add a device" options={ACTION_OPTIONS} onPress={onPress} />
      </ItemGroup>,
    );
    try {
      measureTiles(mount.container, 358);
      expect(rowRules(mount.container)).toHaveLength(2);
      await act(async () => { mount.container.querySelector<HTMLElement>('[data-testid="action:phone"]')!.click(); });
      expect(onPress).toHaveBeenCalledWith('phone');
      expect(mount.container.querySelector('[role="radio"]')).toBeNull();
    } finally { mount.unmount(); }
  });

  it('reserves the measured grid before its first layout, so a lone last tile never spans the row', () => {
    const options = [...ACTION_OPTIONS, { id: 'lima', title: 'Lima', subtitle: 'A light Linux VM', testID: 'action:lima' }];
    const mount = mountTiles(<HappierSelectionTiles variant="action" accessibilityLabel="Local" options={options}
      onPress={() => {}} colors={TILE_COLORS} renderText={({ text }) => <span>{text}</span>} renderGlyph={() => null}
      renderOptionFooter={({ option }) => <Text>{`${option.id} checking`}</Text>} />);
    try {
      // Before any layout event: every tile, the wrapped fourth included, is held to one of three columns.
      for (const id of ['phone', 'lima']) {
        const tile = mount.container.querySelector<HTMLElement>(`[data-testid="action:${id}"]`)!;
        expect(getComputedStyle(tile).maxWidth).toBe(getComputedStyle(mount.container.querySelector<HTMLElement>('[data-testid="action:phone"]')!).maxWidth);
        expect(getComputedStyle(tile).maxWidth).not.toBe('');
      }
    } finally { mount.unmount(); }
  });

  it.each(['standalone', 'grouped', 'footer'] as const)('retains action cards in the %s context', (context) => {
    const tiles = <HappierSelectionTiles variant="action" accessibilityLabel="Devices" options={ACTION_OPTIONS}
      onPress={() => {}} colors={TILE_COLORS} renderText={({ text }) => <span>{text}</span>} renderGlyph={() => null}
      listPresentation={context === 'grouped' ? 'grouped' : undefined}
      renderOptionFooter={context === 'footer' ? ({ option }) => <Text>{`${option.id} status`}</Text> : undefined} />;
    const mount = mountTiles(context !== 'standalone'
      ? <HappierPageSheet surface="none" colors={SHEET_COLORS}>{tiles}</HappierPageSheet> : tiles);
    try {
      measureTiles(mount.container, 358);
      expect(rowRules(mount.container)).toHaveLength(0);
      if (context === 'footer') {
        expect(mount.container.textContent).toContain('home status');
        expect(mount.container.querySelector('[data-testid="action:home"]')?.getAttribute('role')).toBe('group');
      }
    } finally { mount.unmount(); }
  });

  it('shows compact card previews beside their labels while retaining radio keyboard selection', async () => {
    function ControlledPreviewRows() {
      const [value, setValue] = useState<'list' | 'grid'>('grid');
      return <SelectionTiles
        density="compact" maximumColumns={1} accessibilityLabel="Layout" testID="layout"
        options={[
          { id: 'list', title: 'List', subtitle: 'One column', preview: <Text value="list preview" testID="preview:list" /> },
          { id: 'grid', title: 'Grid', subtitle: 'Two columns', preview: <Text value="grid preview" testID="preview:grid" /> },
        ]}
        value={value} onChange={setValue}
      />;
    }
    const mount = mountTiles(<ControlledPreviewRows />);
    const list = mount.container.querySelector<HTMLElement>('[data-testid="layout:list"]')!;
    const grid = mount.container.querySelector<HTMLElement>('[data-testid="layout:grid"]')!;
    expect(list.querySelector('[data-testid="preview:list"]')?.textContent).toBe('list preview');
    expect(grid.querySelector('[data-testid="preview:grid"]')?.textContent).toBe('grid preview');
    expect(list.textContent).toContain('List');
    expect(grid.getAttribute('aria-checked')).toBe('true');
    await pressKey(grid, 'ArrowUp');
    expect(list.getAttribute('aria-checked')).toBe('true');
    expect(grid.getAttribute('aria-checked')).toBe('false');
    expect(list.getAttribute('tabindex')).toBe('0');
    expect(document.activeElement).toBe(list);
    mount.unmount();
  });
  it('lets a finger reach a one-line compact tile past its drawn edge (the tile frame never clips it)', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query === '(pointer: coarse)' || query === '(hover: none)' }));
    const mount = mountTiles(<SelectionTiles density="compact" minimumColumns={2} maximumColumns={2} accessibilityLabel="Scope" testID="scope"
      options={[{ id: 'mine', title: 'Mine' }, { id: 'team', title: 'Team' }]} value="mine" onChange={() => undefined} />);
    try {
      const tile = mount.container.querySelector<HTMLElement>('[data-testid="scope:mine"]')!;
      // Drawn at the field height; the hit area reaches up and down to the finger target.
      expect(readHitAreaReach(tile)?.top).toBeGreaterThan(0);
      expect(hitAreaClippingAncestors(tile, mount.container)).toEqual([]);
    } finally {
      mount.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('presents author-supplied bare marks, badges and current option footers without losing choice semantics', async () => {
    const onChange = vi.fn();
    const mount = mountTiles(<SelectionTiles
      accessibilityLabel="Speech service" value="one" onChange={onChange}
      options={[{ id: 'one', title: 'One', mark: <Text>Identity</Text>, badge: 'Preview' },
        { id: 'two', title: 'Two' }]}
      density="compact" minimumColumns={2} maximumColumns={2} minimumTileWidth={170} subtitleLines={0}
      renderOptionFooter={({ option, selected }) => <Text>{`${option.id}:${selected ? 'selected' : 'available'}`}</Text>}
    />);
    expect(mount.container.textContent).toContain('Identity');
    expect(mount.container.textContent).toContain('Preview');
    expect(mount.container.textContent).toContain('one:selected');
    expect(mount.container.textContent).toContain('two:available');
    await act(async () => { radios(mount.container)[1]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('two');
    mount.unmount();
  });
  it('wraps a four-option visual picker into the requested two columns without changing selection order', async () => {
    const onChange = vi.fn();
    const mount = mountThroughReactNativeWeb(<HappierSelectionTiles
      variant="visual" tileSizing="fill" maximumColumns={2}
      accessibilityLabel="Starting style" options={DENSITY_OPTIONS} value="compact" onChange={onChange}
      colors={{ tileBackground: 'white', tileBorder: 'gray', selection: 'black', glyph: 'black', ring: 'black',
        previewBackground: 'white', actionBackground: 'white', actionBorderHovered: 'black' }}
      renderText={({ text }) => <span>{text}</span>}
      renderGlyph={() => null}
    />);
    // RNW exposes the wrapping basis in the real DOM. Three bases plus two gaps cannot fit
    // a row, so the four previews wrap into two equal pairs instead of being squeezed together.
    const basis = getComputedStyle(radios(mount.container)[0]!).flexBasis;
    expect(basis.endsWith('%')).toBe(true);
    expect(Number.parseFloat(basis) * 3).toBeGreaterThanOrEqual(100);
    await pressKey(radios(mount.container)[1]!, 'ArrowDown');
    expect(onChange).toHaveBeenLastCalledWith('cozy');
    mount.unmount();
  });
  it('keeps every wrapped row of natural-size visual tiles at one width, so a short last row lines up', async () => {
    const options = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id.toUpperCase() }));
    const mount = mountThroughReactNativeWeb(<HappierSelectionTiles
      variant="visual"
      accessibilityLabel="Theme" options={options} value="a" onChange={() => {}}
      colors={TILE_COLORS}
      renderText={({ text }) => <span>{text}</span>}
      renderGlyph={() => null}
    />);
    const tiles = radios(mount.container);
    const grid = tiles[0]!.parentElement!;
    const handler = Reflect.get(grid, '__reactLayoutHandler');
    expect(typeof handler).toBe('function');
    // A phone sheet: three shrunken tiles per row, then a row of two. Every tile, including the
    // short last row, takes the same width; nothing stretches to the natural maximum.
    act(() => handler({ nativeEvent: { layout: { x: 0, y: 0, width: 330, height: 240 } } }));
    expect(radios(mount.container).map((tile) => Number.parseFloat(tile.style.width)))
      .toEqual(Array(5).fill((330 - 20) / 3));
    mount.unmount();
  });
  it('is one named radio group whose tiles say which option is chosen, and a press chooses', async () => {
    const onChange = vi.fn();
    const mount = mountTiles(<ControlledSingle onChange={onChange} />);

    const group = mount.container.querySelector<HTMLElement>('[role="radiogroup"]');
    expect(group?.getAttribute('aria-label')).toBe('Row density');
    expect(radios(mount.container)).toHaveLength(4);
    expect(checked(mount.container, 'radio')).toEqual(['Compact']);
    expect(mount.container.textContent).toContain('More room');

    await act(async () => { radios(mount.container)[0]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith('comfortable');
    expect(checked(mount.container, 'radio')).toEqual(['Comfortable' + 'More room']);

    // A disabled tile is announced as disabled and never chooses.
    const dense = radios(mount.container)[2]!;
    expect(dense.getAttribute('aria-disabled')).toBe('true');
    await act(async () => { dense.click(); });
    expect(onChange).not.toHaveBeenCalledWith('dense');
    mount.unmount();
  });

  it.each(['card', 'visual'] as const)('keeps one tab stop and moves the %s selection with the arrow keys, skipping disabled tiles', async (variant) => {
    const mount = mountTiles(<ControlledSingle variant={variant} />);

    const tabStops = () => radios(mount.container).map((tile) => tile.getAttribute('tabindex'));
    expect(tabStops()).toEqual(['-1', '0', '-1', '-1']);

    await pressKey(radios(mount.container)[1]!, 'ArrowRight');
    expect(checked(mount.container, 'radio')).toEqual(['Cozy']);
    expect(tabStops()).toEqual(['-1', '-1', '-1', '0']);

    await pressKey(radios(mount.container)[3]!, 'Home');
    expect(checked(mount.container, 'radio')[0]).toContain('Comfortable');
    mount.unmount();
  });

  it('toggles checkbox tiles in multiple selection and keeps each one in the tab order', async () => {
    const onChange = vi.fn();
    function ControlledMultiple() {
      const [value, setValue] = useState<readonly string[]>(['compact']);
      return (
        <SelectionTiles
          selectionMode="multiple"
          accessibilityLabel="Columns"
          options={DENSITY_OPTIONS}
          value={value}
          onChange={(next) => {
            onChange(next);
            setValue(next);
          }}
        />
      );
    }
    const mount = mountTiles(<ControlledMultiple />);
    const boxes = () => [...mount.container.querySelectorAll<HTMLElement>('[role="checkbox"]')];

    expect(boxes()).toHaveLength(4);
    // Every enabled checkbox is its own tab stop (a disabled one leaves the order).
    expect(boxes().map((tile) => tile.getAttribute('tabindex'))).toEqual(['0', '0', '-1', '0']);
    await act(async () => { boxes()[3]?.click(); });
    expect(onChange).toHaveBeenLastCalledWith(['compact', 'cozy']);
    await pressKey(boxes()[1]!, ' ');
    expect(onChange).toHaveBeenLastCalledWith(['cozy']);
    expect(checked(mount.container, 'checkbox')).toEqual(['Cozy']);
    mount.unmount();
  });

  it('draws every tile text slot on a canonical type role (scale roles R1/R4)', () => {
    const roleMetrics = new Set((Object.keys(HAPPIER_TYPE_SCALE) as HappierTypeRole[]).map((role) => {
      const step = resolveHappierTypeScale(role, 'web');
      return `${step.fontSize}/${step.lineHeight}`;
    }));
    const mount = mountTiles(<>
      <SelectionTiles accessibilityLabel="Card" value="card-a" onChange={() => undefined}
        options={[{ id: 'card-a', title: 'Card title', subtitle: 'Card subtitle', badge: 'Card badge' }]} />
      <SelectionTiles density="compact" accessibilityLabel="Compact" value="compact-a" onChange={() => undefined}
        options={[{ id: 'compact-a', title: 'Compact title', subtitle: 'Compact subtitle' }]} />
      <SelectionTiles variant="visual" accessibilityLabel="Visual" value="visual-a" onChange={() => undefined}
        options={[{ id: 'visual-a', title: 'Visual chosen', subtitle: 'Visual sublabel', preview: <Text value="p" /> },
          { id: 'visual-b', title: 'Visual other', preview: <Text value="q" /> }]} />
      <SelectionTiles variant="action" accessibilityLabel="Actions" onPress={() => undefined}
        options={[{ id: 'action-a', title: 'Action title', subtitle: 'Action subtitle' }]} />
    </>);
    const texts = ['Card title', 'Card subtitle', 'Card badge', 'Compact title', 'Compact subtitle', 'Visual chosen',
      'Visual sublabel', 'Visual other', 'Action title', 'Action subtitle'];
    for (const text of texts) {
      const node = [...mount.container.querySelectorAll<HTMLElement>('*')]
        .find((candidate) => candidate.children.length === 0 && candidate.textContent === text);
      expect(node, text).toBeDefined();
      // The text owner may nest a run inside its styled host; read the nearest element carrying the step.
      let styled: HTMLElement | null = node!;
      while (styled && styled.style.fontSize === '') styled = styled.parentElement;
      expect(styled, `${text} carries a type step`).not.toBeNull();
      const style = styled!.style;
      expect(roleMetrics, `${text}: ${style.fontSize}/${style.lineHeight}`)
        .toContain(`${Number.parseFloat(style.fontSize)}/${Number.parseFloat(style.lineHeight)}`);
    }
    mount.unmount();
  });
  it('renders each visual tile as its preview with the label beneath, and rings the chosen one', async () => {
    const context = createSurfaceContext();
    function ControlledVisual() {
      const [value, setValue] = useState<'list' | 'grid'>('grid');
      return (
        <SelectionTiles
          variant="visual"
          accessibilityLabel="Layout"
          options={[
            { id: 'list', title: 'List', badge: 'Current', preview: <Text value="list preview" testID="preview:list" /> },
            { id: 'grid', title: 'Grid', preview: <Text value="grid preview" testID="preview:grid" /> },
          ]}
          value={value}
          onChange={(next) => { if (next !== null) setValue(next); }}
          testID="layout"
        />
      );
    }
    const mount = mountTiles(<ControlledVisual />, context);

    const list = mount.container.querySelector<HTMLElement>('[data-testid="layout:list"]')!;
    const grid = mount.container.querySelector<HTMLElement>('[data-testid="layout:grid"]')!;
    // The preview is the author's real element, inside its tile, above the label.
    expect(list.querySelector('[data-testid="preview:list"]')?.textContent).toBe('list preview');
    expect(grid.querySelector('[data-testid="preview:grid"]')?.textContent).toBe('grid preview');
    expect(list.textContent).toContain('Current');
    expect(list.getAttribute('aria-label')).toBe('List');
    expect(grid.getAttribute('aria-checked')).toBe('true');

    const ringOf = (tile: HTMLElement) => getComputedStyle(tile.firstElementChild as HTMLElement).borderTopColor;
    expect(ringOf(grid)).not.toBe(ringOf(list));
    await act(async () => { list.click(); });
    expect(list.getAttribute('aria-checked')).toBe('true');
    expect(grid.getAttribute('aria-checked')).toBe('false');
    mount.unmount();
  });
});
