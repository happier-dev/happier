import { act, useState, type ReactNode } from 'react';
import { Dimensions, View } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HappierUiPalette } from '../environment/types.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_EMPTY_STATE_FRAME } from '../presentation/state/InfoState.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { Item, ItemGroup, List } from './List.js';
import { PushedDetailHeader } from './DetailsPane.js';
import { PageHeader } from './PageHeader.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { EmptyState } from './State.js';
import { Select } from './Form.js';
import * as PublicUi from './index.public.js';

/**
 * Configuration-surfaces U9: a plugin page composes the same anatomy as
 * Happier's own settings pages — a page header, sentence-case sections with
 * their explanation above one hairline sheet, rows divided by full-width
 * hairlines, and page empty states — through the shared presentation owners
 * Happier core renders with.
 */
const PALETTE: HappierUiPalette = {
  page: '#fafafa',
  sheet: '#f1f2f3',
  sheetBorder: '#0a0b0c',
  rowDivider: '#070809',
  groupDivider: '#0d0e0f',
  controlBorder: '#d6d6d6',
  fieldBackground: '#ffffff',
  placeholder: '#999999',
  selection: '#111111',
  switchTrackOn: '#1976d2',
  switchTrackOff: '#dddddd',
  switchThumb: '#ffffff',
  segmentTrack: '#eeeeee',
  segmentThumb: '#ffffff',
  navigationSelected: '#e8e8e8',
  navigationHover: '#efefef',
};

function mountPage(children: ReactNode, host: Partial<PluginUiPresentationHost> = {}) {
  const context = createSurfaceContext();
  const presentationHost = {
    palette: PALETTE,
    renderMarkdown: () => null,
    renderPopover: () => null,
    renderIcon: () => null,
    ...host,
  } as unknown as PluginUiPresentationHost;
  return mountThroughReactNativeWeb(
    <PluginUiProviderInternal hostApi={createHostApiStub(context)} context={context} presentationHost={presentationHost}>
      {children}
    </PluginUiProviderInternal>,
  );
}

function textOf(element: Element | null | undefined): string {
  return element?.textContent?.trim() ?? '';
}

function rowHairlines(section: Element): HTMLElement[] {
  return Array.from(section.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
    .filter(node => getComputedStyle(node).backgroundColor === 'rgb(7, 8, 9)');
}

describe('plugin page anatomy through the shared page owners', () => {
  beforeEach(() => {
    // The lane varies pane width within a roomy window. jsdom's unmeasured
    // viewport otherwise looks like a phone, where selects always stack.
    vi.spyOn(Dimensions, 'get').mockReturnValue({ width: 1200, height: 800, scale: 1, fontScale: 1 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('exposes one add row with a semantic add glyph, controlled expansion and disabled activation', async () => {
    const onPress = vi.fn();
    const renderIcon: PluginUiPresentationHost['renderIcon'] = ({ name }) => <span data-testid={`mark-${name}`} />;
    expect(PublicUi).toHaveProperty('ItemAddRow');
    const AddRow = PublicUi.ItemAddRow;
    function Harness() {
      const [expanded, setExpanded] = useState(false);
      return <PublicUi.ItemGroup title="Variables">
        <AddRow testID="add" title="Add variable" expanded={expanded} onPress={() => { onPress(); setExpanded(true); }} />
        <AddRow testID="disabled-add" title="Add model" disabled onPress={onPress} />
      </PublicUi.ItemGroup>;
    }
    const mount = mountPage(<Harness />, { renderIcon });
    try {
      const row = mount.container.querySelector<HTMLElement>('[data-testid="add"]')!;
      expect(row.getAttribute('aria-expanded')).toBe('false');
      expect(row.getAttribute('role')).toBe('button');
      expect(row.textContent).toContain('Add variable');
      expect(row.querySelector('[data-testid="mark-add"]')).not.toBeNull();
      expect(row.querySelector('[data-testid="mark-chevron-right"]')).toBeNull();
      await act(async () => row.click());
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(row.getAttribute('aria-expanded')).toBe('true');
      const disabled = mount.container.querySelector<HTMLElement>('[data-testid="disabled-add"]')!;
      expect(disabled.getAttribute('aria-disabled')).toBe('true');
      await act(async () => disabled.click());
      expect(onPress).toHaveBeenCalledTimes(1);
      expect(rowHairlines(mount.container)).toHaveLength(0);
    } finally { mount.unmount(); }
  });

  it.each([
    { title: 'Advanced', row: 358, detail: 260, titleWidth: 65, icon: false, beneath: true },
    { title: 'Advanced', row: 358, detail: 44, titleWidth: 65, icon: false, beneath: false },
    { title: 'Role', row: 340, detail: 150, titleWidth: 32, icon: false, beneath: false },
    { title: 'Advanced', row: 356, detail: 215, titleWidth: 65, icon: true, beneath: true },
    // A phone row: a Machine name the label column could hold whole, beside "Not shared with you". The
    // detail moves beneath rather than cutting the name down to the section floor's width.
    { title: 'NLDW3-5-36-33', row: 358, detail: 125, titleWidth: 150, icon: true, beneath: true },
    // A long label beside a short value: the label keeps the section floor and the value stays on its line.
    { title: 'Notify me when a session finishes', row: 358, detail: 30, titleWidth: 280, icon: false, beneath: false },
  ])('fits page detail using the label and row chrome ($row/$detail/$title)', ({ title, row: rowWidth, detail: detailWidth, titleWidth, icon, beneath }) => {
    const value = 'Service identity and diagnostics';
    const mount = mountPage(<PublicUi.ItemGroup title="Account">
      <PublicUi.Item testID="detail-row" title={title} detail={value} icon={icon ? <View /> : undefined} />
    </PublicUi.ItemGroup>);
    try {
      const row = mount.container.querySelector<HTMLElement>('[data-testid="detail-row"]')!;
      const handler = (node: Element) => (node as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      const layout = (node: Element, width: number) => act(() => handler(node)!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } }));
      layout(row, rowWidth);
      const measurements = Array.from(row.querySelectorAll<HTMLElement>('[aria-hidden="true"]')).filter(node => handler(node));
      expect(measurements, 'natural title and detail measurements come from the real page row').toHaveLength(2);
      for (const node of measurements) layout(node, node.textContent === title ? titleWidth : detailWidth);
      const visible = (text: string) => Array.from(row.querySelectorAll<HTMLElement>('div')).find(node => node.textContent === text && node.children.length === 0 && !node.closest('[aria-hidden="true"]'))!;
      expect(visible(value).parentElement === visible(title).parentElement).toBe(beneath);
      if (!beneath && title === 'Role') expect(Number.parseFloat(getComputedStyle(visible(value)).maxWidth)).toBeGreaterThanOrEqual(detailWidth);
      // Resizing uses the same mounted row and returns a long detail to the trailing column.
      layout(row, 820);
      expect(visible(value).parentElement === visible(title).parentElement).toBe(false);
      expect(mount.container.querySelector('[data-testid="detail-row"]')).toBe(row);
    } finally { mount.unmount(); }
  });

  it('measures a narrow page row\'s detail in the type it draws, so a time that cannot fit beside the label moves beneath instead of wrapping', () => {
    const value = 'Oct 22, 2026, 12:23 PM';
    const mount = mountPage(<PublicUi.ItemGroup title="Incoming messages">
      <PublicUi.Item testID="time-row" title="Support group" subtitle="Could not deliver to the Session" detail={value} />
    </PublicUi.ItemGroup>);
    try {
      const row = mount.container.querySelector<HTMLElement>('[data-testid="time-row"]')!;
      const handler = (node: Element) => (node as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      act(() => handler(row)!({ nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 52 } } }));
      const measured = Array.from(row.querySelectorAll<HTMLElement>('[aria-hidden="true"]'))
        .find(node => handler(node) && node.textContent === value)!;
      const drawn = Array.from(row.querySelectorAll<HTMLElement>('div'))
        .find(node => node.textContent === value && node.children.length === 0 && !node.closest('[aria-hidden="true"]'))!;
      const measuredText = measured.querySelector<HTMLElement>('div') ?? measured;
      // The rendered elements' own declarations (RNW's inline style), not jsdom's partial cascade.
      expect(drawn.style.fontSize).not.toBe('');
      expect(measuredText.style.fontSize).toBe(drawn.style.fontSize);
      expect(measuredText.style.lineHeight).toBe(drawn.style.lineHeight);
    } finally { mount.unmount(); }
  });

  it('keeps a compact identity glyph on the same title edge as a standard page-row glyph', () => {
    const mount = mountPage(
      <ItemGroup title="Devices">
        <Item title="Compact identity" icon={<View testID="compact-glyph" style={{ width: 16, height: 16 }} />} />
        <Item title="Standard identity" icon={<View testID="standard-glyph" style={{ width: HAPPIER_PAGE_METRICS.rowLeadingColumnPx, height: HAPPIER_PAGE_METRICS.rowLeadingColumnPx }} />} />
        <Item title="Larger identity" icon={<View testID="larger-glyph" style={{ width: 24, height: 24 }} />} />
      </ItemGroup>,
    );
    try {
      // Read the rendered layout constraint, not the authored component's props. A smaller glyph
      // must retain the page's leading column so its title aligns with the standard row below it.
      const leadingWidth = (id: string) => {
        const glyph = mount.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
        const column = getComputedStyle(glyph.parentElement!);
        const fixedWidth = Number.parseFloat(column.width);
        if (Number.isFinite(fixedWidth)) return fixedWidth;
        return Math.max(Number.parseFloat(getComputedStyle(glyph).width), Number.parseFloat(column.minWidth) || 0);
      };
      expect(leadingWidth('compact-glyph')).toBe(leadingWidth('standard-glyph'));
      expect(leadingWidth('larger-glyph')).toBeGreaterThan(leadingWidth('standard-glyph'));
    } finally { mount.unmount(); }
  });

  it('starts each row seam at its text and runs it to the sheet trailing edge (P7-R2)', () => {
    const mount = mountPage(
      <ItemGroup title="Devices">
        <Item title="Laptop" subtitle="Connected" icon={<View style={{ width: 16, height: 16 }} />} />
        <Item title="Phone" subtitle="Connected" />
        <Item title="Tablet" />
      </ItemGroup>,
    );
    try {
      const seams = rowHairlines(mount.container).map((separator) => {
        const style = getComputedStyle(separator);
        return [style.marginInlineStart || style.marginLeft, style.marginInlineEnd || style.marginRight];
      });
      const inset = HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx;
      const text = inset + HAPPIER_PAGE_METRICS.rowLeadingColumnPx + HAPPIER_PAGE_METRICS.rowLeadingGapPx;
      expect(seams).toEqual([[`${text}px`, '0px'], [`${inset}px`, '0px']]);
    } finally { mount.unmount(); }
  });

  it('lets an explicit radio-group name override its visible title', () => {
    const mount = mountPage(
      <ItemGroup title="Use" accessibilityRole="radiogroup" accessibilityLabel="Checkout preparation">
        <List.Item title="A fresh clone" accessibilityRole="radio" onPress={() => undefined} />
      </ItemGroup>,
    );
    expect(mount.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Checkout preparation');
    mount.unmount();
  });

  it('rejects a radio group with neither a title nor an explicit name', () => {
    expect(() => mountPage(
      <ItemGroup accessibilityRole="radiogroup">
        <List.Item title="A fresh clone" accessibilityRole="radio" onPress={() => undefined} />
      </ItemGroup>,
    )).toThrow(/accessible name/i);
  });

  it('draws a titled ItemGroup with its heading above one sheet and rules beneath multiline rows', () => {
    const mount = mountPage(
      <ItemGroup title="Sync" description="How often the plugin checks for new issues." testID="section">
        <Item title="Interval" subtitle="Every 5 minutes" />
        <Item title="Only while open" />
        <Item title="Notify me" />
      </ItemGroup>,
    );

    const section = mount.container.querySelector('[data-testid="section"]')!;
    const heading = section.querySelector('[role="heading"]');
    expect(textOf(heading)).toBe('Sync');
    const text = textOf(section);
    // The explanation is read before the rows, never as a footer under them.
    expect(text.indexOf('How often the plugin checks')).toBeLessThan(text.indexOf('Interval'));

    expect(rowHairlines(section)).toHaveLength(1);
    expect(section.querySelector('[role="separator"]')).toBeNull();

    const sheet = Array.from(section.querySelectorAll<HTMLElement>('div'))
      .find((element) => element.style.borderTopLeftRadius === '14px');
    expect(sheet, 'the rows sit on one rounded page sheet').toBeDefined();
    expect(sheet?.style.borderTopColor).toBe('rgb(10, 11, 12)');
    // The group is named by its title for assistive technology.
    expect(section.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Sync');
    mount.unmount();
  });

  it('keeps an untitled ItemGroup a semantic group with no sheet, heading or dividers', () => {
    const mount = mountPage(
      <ItemGroup accessibilityLabel="Quick actions" testID="group">
        <Item title="Reload" />
        <Item title="Open logs" />
      </ItemGroup>,
    );

    const group = mount.container.querySelector('[data-testid="group"]')!;
    expect(group.querySelector('[role="heading"]')).toBeNull();
    expect(rowHairlines(group)).toHaveLength(0);
    expect(Array.from(group.querySelectorAll<HTMLElement>('div')).some((element) => element.style.borderTopLeftRadius === '14px'))
      .toBe(false);
    mount.unmount();
  });

  it('keeps radio roving through a titled section sheet', async () => {
    function Harness() {
      const [selected, setSelected] = useState<'daily' | 'weekly'>('daily');
      return (
        <ItemGroup title="Digest" accessibilityRole="radiogroup">
          <List.Item title="Daily" accessibilityRole="radio" selected={selected === 'daily'} onPress={() => setSelected('daily')} />
          <List.Item title="Weekly" accessibilityRole="radio" selected={selected === 'weekly'} onPress={() => setSelected('weekly')} />
        </ItemGroup>
      );
    }
    const mount = mountPage(<Harness />);
    const radios = Array.from(mount.container.querySelectorAll<HTMLElement>('[role="radio"]'));
    expect(radios.map((radio) => radio.getAttribute('tabindex'))).toEqual(['0', '-1']);

    await act(async () => {
      radios[0]?.focus();
      radios[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });

    expect(radios.map((radio) => radio.getAttribute('aria-checked'))).toEqual(['false', 'true']);
    expect(mount.container.querySelector('[role="radiogroup"]')?.getAttribute('aria-label')).toBe('Digest');
    mount.unmount();
  });

  it('draws the page header title as the page heading with its purpose, meta line and actions', () => {
    const mount = mountPage(
      <PageHeader
        title="Sentry"
        description="Link Sentry issues to the sessions that fix them."
        meta={[{ key: 'version', text: 'v2.4.0' }, { key: 'org', text: 'acme' }]}
        actions={<Button title="Disconnect" onPress={() => undefined} />}
        testID="header"
      />,
    );

    const header = mount.container.querySelector('[data-testid="header"]')!;
    expect(textOf(header.querySelector('[role="heading"]'))).toBe('Sentry');
    expect(textOf(header)).toContain('Link Sentry issues to the sessions that fix them.');
    expect(textOf(header.querySelector('[data-testid="header-meta"]'))).toBe('v2.4.0·acme');
    expect(textOf(header)).toContain('Disconnect');
    mount.unmount();
  });

  it('keeps each meta separator with the fact before it so a wrapped line never starts with one', () => {
    const mount = mountPage(
      <PageHeader
        title="Run"
        meta={[{ key: 'origin', text: 'Scheduled', testID: 'f1' }, { key: 'machine', text: 'mac', testID: 'f2' }, { key: 'time', text: '13:50', testID: 'f3' }]}
        testID="header"
      />,
    );
    // Each fact is one wrapping unit: a unit that began with "·" would orphan it at a line start.
    expect(['f1', 'f2', 'f3'].map((id) => textOf(mount.container.querySelector(`[data-testid="${id}"]`))))
      .toEqual(['Scheduled·', 'mac·', '13:50']);
    mount.unmount();
  });

  it('leaves the title to host chrome that already shows it and places the host back control', () => {
    const shown = mountPage(
      <PageHeader title="Sentry" description="Link Sentry issues." testID="header" />,
      { pageChrome: { showsTitle: true, renderBack: () => <button data-testid="host-back" /> } },
    );
    const header = shown.container.querySelector('[data-testid="header"]')!;
    expect(header.querySelector('[role="heading"]')).toBeNull();
    expect(textOf(header)).toBe('Link Sentry issues.');
    // No title line, so no back beside it: the host chrome carries both.
    expect(header.querySelector('[data-testid="host-back"]')).toBeNull();
    shown.unmount();

    const own = mountPage(
      <PageHeader title="Sentry" testID="header" />,
      { pageChrome: { showsTitle: false, renderBack: () => <button data-testid="host-back" /> } },
    );
    const ownHeader = own.container.querySelector('[data-testid="header"]')!;
    expect(textOf(ownHeader.querySelector('[role="heading"]'))).toBe('Sentry');
    expect(ownHeader.querySelector('[data-testid="host-back"]')).not.toBeNull();
    own.unmount();
  });

  it('aligns a right-to-left title with the page, keeping its own reading order', () => {
    const mount = mountPage(<PageHeader title="تعطل تسجيل الدخول — QA-F fixture" testID="header" />);
    try {
      const heading = mount.container.querySelector<HTMLElement>('[data-testid="header"] [role="heading"]')!;
      // The text keeps its own direction (the browser orders its words), but it starts on the page's edge, beside
      // its mark, rather than on the far side of the row an Arabic first word would choose.
      expect(heading.getAttribute('dir')).toBe('auto');
      expect(heading.style.textAlign).toBe('left');
    } finally { mount.unmount(); }
  });

  it.each(['band', 'backOnly'] as const)('publishes the presented detail title in %s placement independently of phone chrome', (placement) => {
    const published: Array<string | undefined> = [];
    const mount = mountPage(<PushedDetailHeader title="New task" placement={placement} onClose={() => {}} />,
      { pageChrome: { showsTitle: false, publishPageTitle: (title: string | undefined) => { published.push(title); } } });
    expect(published).toEqual(['New task']);
    mount.unmount();
    expect(published.at(-1)).toBeUndefined();
  });

  it('hands its title to host chrome that hides it, and withdraws it on leaving', () => {
    const published: Array<string | undefined> = [];
    const mount = mountPage(
      <PageHeader title="wilson@test.local" description="Routes mail into sessions." testID="header" />,
      { pageChrome: { showsTitle: true, publishTitle: (title: string | undefined) => { published.push(title); } } },
    );
    // The body omits the title, so the chrome is the only place the page names itself.
    expect(mount.container.querySelector('[data-testid="header"] [role="heading"]')).toBeNull();
    expect(published).toEqual(['wilson@test.local']);
    mount.unmount();
    expect(published).toEqual(['wilson@test.local', undefined]);
  });

  it('keeps an entity header whole in the page under chrome that shows the title, with the host controls in its row', () => {
    const published: Array<string | undefined> = [];
    const placements: Array<string | undefined> = [];
    const mount = mountPage(
      <PageHeader
        title="forge-qa-failing"
        leading={<View testID="mark" />}
        meta={[{ key: 'run', text: '#9' }]}
        actions={<button data-testid="fix">Fix in a session</button>}
        testID="header"
      />,
      {
        pageChrome: {
          showsTitle: true,
          publishTitle: (title: string | undefined) => { published.push(title); },
          // A host hoists ordinary actions into its navigation; a page placement stays in the header row.
          renderNavigationActions: (actions: ReactNode, placement?: 'navigation' | 'page') => {
            placements.push(placement);
            return placement === 'page'
              ? <>{actions}<button data-testid="host-hide">Hide</button></>
              : <div data-testid="nav-actions">{actions}</div>;
          },
        },
      },
    );
    const header = mount.container.querySelector('[data-testid="header"]')!;
    // The mark never stands without its title: the identity, its facts and its actions stay together.
    expect(textOf(header.querySelector('[role="heading"]'))).toBe('forge-qa-failing');
    expect(header.querySelector('[data-testid="fix"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="nav-actions"]')).toBeNull();
    // The host's own controls still join the entity's row.
    expect(header.querySelector('[data-testid="host-hide"]')).not.toBeNull();
    expect(new Set(placements)).toEqual(new Set(['page']));
    // The chrome keeps the destination's own name rather than repeating the entity.
    expect(published).toEqual([]);
    mount.unmount();
  });

  it('gives an entity header the host page controls (main-column Hide) beside the desktop title', () => {
    const mount = mountPage(
      <PageHeader
        title="forge-qa-failing"
        leading={<View testID="mark" />}
        actions={<button data-testid="fix">Fix in a session</button>}
        testID="header"
      />,
      {
        pageChrome: {
          showsTitle: false,
          renderNavigationActions: (actions: ReactNode) => <>{actions}<button data-testid="host-hide">Hide</button></>,
        },
      },
    );
    const header = mount.container.querySelector('[data-testid="header"]')!;
    expect(header.querySelector('[data-testid="fix"]')).not.toBeNull();
    expect(header.querySelector('[data-testid="host-hide"]')).not.toBeNull();
    expect(mount.container.querySelectorAll('[data-testid="host-hide"]')).toHaveLength(1);
    mount.unmount();
  });

  it('places host page actions beside the desktop title even when the plugin declares no actions', () => {
    const mount = mountPage(<PageHeader title="Sentry" testID="header" />, {
      pageChrome: {
        showsTitle: false,
        renderNavigationActions: (actions: ReactNode) => <><button data-testid="execution-origin">Runs on · Workstation</button>{actions}</>,
      },
    });
    expect(mount.container.querySelector('[data-testid="header"] [data-testid="execution-origin"]')).not.toBeNull();
    expect(mount.container.querySelectorAll('[data-testid="execution-origin"]')).toHaveLength(1);
    mount.unmount();
  });

  it('keeps a page row control on the row inset, and moves a wide one beneath its label on a narrow row', () => {
    const mount = mountPage(
      <ItemGroup title="Reviews">
        <Item
          testID="depth-row"
          title="Depth"
          accessory={<View testID="depth-control" />}
          accessoryOutsidePressable
          accessoryWraps
        />
      </ItemGroup>,
    );
    const row = mount.container.querySelector('[data-testid="depth-row"]')!;
    const control = () => mount.container.querySelector<HTMLElement>('[data-testid="depth-control"]')!.parentElement!;
    const onLayout = (row as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
    expect(onLayout, 'a row with a wide control measures itself').toBeDefined();

    act(() => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 900, height: 52 } } }));
    // Beside the label: the control keeps the row's trailing inset instead of touching the sheet edge.
    expect(control().style.paddingRight).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);

    act(() => onLayout!({ nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 52 } } }));
    // Too narrow for both: the control drops beneath the label, on the label's edge.
    expect(control().style.paddingLeft).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    expect(control().style.alignSelf).toBe('stretch');
    mount.unmount();
  });

  it('keeps a short page operation beside its label on a narrow row, and moves it beneath only when it would squeeze the label', () => {
    const mount = mountPage(
      <ItemGroup title="Machines">
        <Item testID="where-row" title="Where" accessory={<View testID="where-control" />} accessoryOutsidePressable />
      </ItemGroup>,
    );
    const row = mount.container.querySelector<HTMLElement>('[data-testid="where-row"]')!;
    const container = () => mount.container.querySelector<HTMLElement>('[data-testid="where-control"]')!.parentElement!;
    const handler = (node: Element) => (node as unknown as { __reactLayoutHandler?: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
    const layout = (node: Element, width: number) => act(() => handler(node)!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } }));
    layout(row, 390);
    expect(handler(container()), 'an inline page operation reports its natural width').toBeDefined();
    // A short button (Change): the label keeps its 200 px column, so the button stays on its line.
    layout(container(), 90 + HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
    expect(container().style.alignSelf).not.toBe('stretch');
    // A wide one would leave the label less than its column: it moves beneath, on the label's edge.
    layout(container(), 260 + HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx);
    expect(container().style.alignSelf).toBe('stretch');
    expect(container().style.paddingLeft).toBe(`${HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx}px`);
    mount.unmount();
  });

  it.each([
    { rowWidth: 481, trailing: true },
    { rowWidth: 398, trailing: true },
    { rowWidth: 280, trailing: false },
  ])('fits a page select beside its label when the measured row has room and beneath it otherwise ($rowWidth)', ({ rowWidth, trailing }) => {
    const mount = mountPage(
      <ItemGroup title="Acquisition">
        <Item
          testID="strategy-row"
          title="Strategy"
          accessoryWraps
          fieldAccessory
          accessoryOutsidePressable
          accessory={<Select
            label="Strategy"
            presentation="field"
            value="round-robin"
            options={[{ value: 'priority', label: 'Priority order' }, { value: 'round-robin', label: 'Round robin' }]}
            onChange={() => undefined}
          />}
        />
      </ItemGroup>,
    );
    try {
      const row = mount.container.querySelector<HTMLElement>('[data-testid="strategy-row"]')!;
      const layout = (row as unknown as { __reactLayoutHandler: (event: HappierLayoutChangeEvent) => void }).__reactLayoutHandler;
      const trigger = mount.container.querySelector<HTMLElement>('[role="button"][aria-label="Strategy: Round robin"]')!;
      expect(trigger).not.toBeNull();
      act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: rowWidth, height: 52 } } }));

      const composition = row.firstElementChild as HTMLElement;
      expect(composition.style.flexDirection).toBe(trailing ? 'row' : 'column');
      const field = trigger.firstElementChild as HTMLElement;
      expect(getComputedStyle(field).width).not.toBe('240px');
      if (rowWidth === 481) {
        const availableWidth = rowWidth - 2 * HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx
          - HAPPIER_PAGE_METRICS.rowLeadingGapPx - HAPPIER_PAGE_METRICS.sectionTextMinWidthPx;
        expect(Array.from(trigger.querySelectorAll<HTMLElement>('div')).some((node) => getComputedStyle(node).maxWidth === `${availableWidth}px`)).toBe(true);
      }
      // Placement follows the row's available width, including within a narrow pane.
      act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: 280, height: 52 } } }));
      expect(composition.style.flexDirection).toBe('column');
      act(() => layout({ nativeEvent: { layout: { x: 0, y: 0, width: 481, height: 52 } } }));
      expect(composition.style.flexDirection).toBe('row');
      // Recomposition must retain the trigger and its focus/menu owner.
      expect(mount.container.querySelector('[role="button"][aria-label="Strategy: Round robin"]')).toBe(trigger);
      expect(trigger.textContent).toContain('Round robin');
    } finally {
      mount.unmount();
    }
  });

  // The same facts core's Item measures (Item.operationPlacement.test.tsx): a short measured name, and a
  // sibling control sharing the field's slot. Row 358 at a 16 px inset: 358 - 32 - 12 - 120 = 194 px of room.
  it.each([
    { siblingPx: 40, trailing: true },
    { siblingPx: 80, trailing: false },
  ])('fits a field beside a short measured name and its sibling control in a narrow row, as core rows do (sibling $siblingPx)', ({ siblingPx, trailing }) => {
    const mount = mountPage(
      <ItemGroup title="Engines">
        <Item
          testID="engine-row"
          title="Reviewer"
          accessoryWraps
          fieldAccessory
          fieldAccessorySiblingPx={siblingPx}
          accessoryOutsidePressable
          accessory={<Select
            label="Engine"
            presentation="field"
            value="fast"
            options={[{ value: 'fast', label: 'Fast' }, { value: 'deep', label: 'Deep' }]}
            onChange={() => undefined}
          />}
        />
      </ItemGroup>,
    );
    try {
      const handler = (node: Element) => Reflect.get(node, '__reactLayoutHandler') as ((event: HappierLayoutChangeEvent) => void) | undefined;
      const row = mount.container.querySelector<HTMLElement>('[data-testid="engine-row"]')!;
      act(() => handler(row)!({ nativeEvent: { layout: { x: 0, y: 0, width: 358, height: 52 } } }));
      const nameMeasure = [...mount.container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
        .find((node) => node.textContent === 'Reviewer' && handler(node) !== undefined);
      expect(nameMeasure, 'a narrow field row measures its name').toBeDefined();
      act(() => handler(nameMeasure!)!({ nativeEvent: { layout: { x: 0, y: 0, width: 120, height: 20 } } }));
      const composition = row.firstElementChild as HTMLElement;
      expect(composition.style.flexDirection).toBe(trailing ? 'row' : 'column');
    } finally {
      mount.unmount();
    }
  });

  it('moves a select beneath its label once its value fills the room beside it, even though the row was measured first', () => {
    const mount = mountPage(
      <ItemGroup title="Messages">
        <Item
          testID="incoming-row"
          title="Incoming messages"
          accessoryWraps
          fieldAccessory
          accessoryOutsidePressable
          accessory={<Select
            label="Incoming messages"
            presentation="field"
            value="all"
            options={[{ value: 'all', label: 'All allowed messages' }, { value: 'mentions', label: 'Mentions only' }]}
            onChange={() => undefined}
          />}
        />
      </ItemGroup>,
    );
    try {
      const handler = (node: Element) => Reflect.get(node, '__reactLayoutHandler') as ((event: HappierLayoutChangeEvent) => void) | undefined;
      const layout = (node: Element, width: number) => act(() => handler(node)!({ nativeEvent: { layout: { x: 0, y: 0, width, height: 52 } } }));
      const row = mount.container.querySelector<HTMLElement>('[data-testid="incoming-row"]')!;
      // React Native Web starts observing a view's size only when it mounts with an `onLayout`, so the
      // field box must carry one from its first render, before any room beside the label is known.
      const trigger = mount.container.querySelector<HTMLElement>('[role="button"][aria-label="Incoming messages: All allowed messages"]')!;
      const box = trigger.firstElementChild as HTMLElement;
      expect(handler(box), 'a field box mounts observing its size').toBeDefined();
      // A 358px phone row, and the name's measured 140px: the field gets 358 - 32 - 12 - 140 = 174px beside it.
      layout(row, 358);
      const nameMeasure = [...mount.container.querySelectorAll<HTMLElement>('[aria-hidden="true"]')]
        .find((node) => node.textContent === 'Incoming messages' && handler(node) !== undefined);
      expect(nameMeasure, 'a narrow field row measures its name').toBeDefined();
      layout(nameMeasure!, 140);
      const composition = row.firstElementChild as HTMLElement;
      expect(composition.style.flexDirection).toBe('row');
      // The value fills the 174px it was given and would be cut, so the field moves beneath its label.
      layout(box, 174);
      expect(composition.style.flexDirection).toBe('column');
    } finally {
      mount.unmount();
    }
  });

  it('draws an empty page in the page frame and an empty list as one quiet line', () => {
    const mount = mountPage(
      <>
        <EmptyState layout="page" title="No projects yet" description="Projects you link appear here." testID="page-empty" />
        <EmptyState layout="page" variant="add" title="No webhooks yet" testID="page-add-empty" />
        <ItemGroup title="Projects">
          <EmptyState layout="line" title="No matches" testID="line-empty" />
        </ItemGroup>
        <EmptyState variant="add" title="Add a webhook" testID="add-empty" />
      </>,
    );

    // The page frame is the shared empty-state owner's, on the sheets' edges.
    const page = mount.container.querySelector<HTMLElement>('[data-testid="page-empty"]')!;
    expect(page.style.paddingTop).toBe(`${HAPPIER_EMPTY_STATE_FRAME.page.paddingTop}px`);
    expect(page.style.marginLeft).toBe(`${HAPPIER_PAGE_METRICS.sheetInsetPx}px`);
    // Only an invitation to add is framed (dashed means "add something here").
    expect(page.style.borderTopStyle).not.toBe('dashed');
    const pageAdd = mount.container.querySelector<HTMLElement>('[data-testid="page-add-empty"]')!;
    expect(pageAdd.style.borderTopStyle).toBe('dashed');
    expect(pageAdd.style.borderTopColor).toBe('rgb(10, 11, 12)');

    const line = mount.container.querySelector<HTMLElement>('[data-testid="line-empty"]')!;
    expect(textOf(line)).toBe('No matches');
    // ItemGroup is a group, not a list. An empty-state sentence is not a collection item
    // and stays quiet unless its caller requests a lifecycle announcement.
    expect(line.closest('[role="group"]')?.getAttribute('aria-label')).toBe('Projects');
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('aria-live')).toBeNull();

    const add = mount.container.querySelector<HTMLElement>('[data-testid="add-empty"]')!;
    expect(add.style.borderTopStyle).toBe('dashed');
    expect(add.style.borderTopColor).toBe('rgb(10, 11, 12)');
    mount.unmount();
  });
});
