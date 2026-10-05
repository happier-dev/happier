import { act, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import type { HappierUiPalette } from '../environment/types.js';
import type { HappierLayoutChangeEvent } from '../presentation/portableTypes.js';
import type { PluginUiPresentationHost } from '../presentationHost/context.js';
import { HAPPIER_PAGE_METRICS } from '../presentation/layout/pageMetrics.js';
import { HAPPIER_EMPTY_STATE_FRAME } from '../presentation/state/InfoState.js';
import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { Button } from './Button.js';
import { Item, ItemGroup, List } from './List.js';
import { PageHeader } from './PageHeader.js';
import { PluginUiProviderInternal } from './PluginUiProvider.js';
import { EmptyState } from './State.js';

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

describe('plugin page anatomy through the shared page owners', () => {
  it('draws a titled ItemGroup as a page section: heading and description above one sheet, hairlines between rows only', () => {
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

    const separators = Array.from(section.querySelectorAll<HTMLElement>('[role="separator"]'));
    expect(separators).toHaveLength(2);
    for (const separator of separators) {
      expect(separator.style.backgroundColor).toBe('rgb(7, 8, 9)');
    }

    const sheet = Array.from(section.querySelectorAll<HTMLElement>('div'))
      .find((element) => element.style.borderTopLeftRadius === '14px');
    expect(sheet, 'the rows sit on one rounded page sheet').toBeDefined();
    expect(sheet?.style.backgroundColor).toBe('rgb(241, 242, 243)');
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
    expect(group.querySelectorAll('[role="separator"]')).toHaveLength(0);
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
