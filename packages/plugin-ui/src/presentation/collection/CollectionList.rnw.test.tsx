import { act, type ReactNode } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierUiPlatformProvider } from '../../environment/context.js';
import { createHappierCollectionDraftTitleStore } from './collectionModel.js';
import {
  HappierCollectionList,
  HappierCollectionListGroupLabel,
  useHappierCollectionDraftRowTitle,
  type HappierCollectionListHost,
} from './CollectionList.js';

// The host primitives are the injected boundary; the anatomy under test is the presentation's own.
const host: HappierCollectionListHost = {
  Text: (props) => (
    <Text testID={`text-${props.role}`} {...(props.accessibilityRole ? { role: 'heading' as const } : {})}>
      {props.children}
    </Text>
  ),
  Scroller: (props: Readonly<{ children: ReactNode }>) => <ScrollView testID="scroller">{props.children}</ScrollView>,
  SearchField: (props) => <TextInput testID={props.testID ?? 'search'} value={props.value} placeholder={props.placeholder} />,
  surfaceStyle: null,
};

function textOf(container: HTMLElement, testID: string) {
  return container.querySelector(`[data-testid="${testID}"]`)?.textContent ?? null;
}

describe('HappierCollectionList (list presentation)', () => {
  it('renders the header slot: title, a count only once known, the add control, and search only when asked', async () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList host={host} title="Agents" count={null} headerAction={<View testID="add" />}>
        <Text>row</Text>
      </HappierCollectionList>,
    );
    expect(textOf(mount.container, 'text-title')).toBe('Agents');
    expect(textOf(mount.container, 'text-count')).toBeNull();
    expect(mount.container.querySelector('[data-testid="add"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="search"]')).toBeNull();

    await mount.render(
      <HappierCollectionList
        host={host}
        title="Agents"
        count={20}
        search={{ value: '', onChangeText: () => {}, placeholder: 'Search agents' }}
      >
        <Text>row</Text>
      </HappierCollectionList>,
    );
    expect(textOf(mount.container, 'text-count')).toBe('20');
    expect(mount.container.querySelector('[data-testid="search"]')).not.toBeNull();
    mount.unmount();
  });

  it('omits the heading for a list its surface already names, keeping its search', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList host={host} search={{ value: '', onChangeText: () => {}, placeholder: 'Search sources' }}>
        <Text>row</Text>
      </HappierCollectionList>,
    );
    expect(mount.container.querySelector('[data-testid="text-title"]')).toBeNull();
    expect(mount.container.querySelector('[role="heading"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="search"]')).not.toBeNull();
    mount.unmount();
  });

  it('keeps the count and add action when the surrounding page already names the collection', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList host={host} count={9} headerAction={<View testID="add" />} />,
    );
    expect(mount.container.querySelector('[role="heading"]')).toBeNull();
    expect(textOf(mount.container, 'text-count')).toBe('9');
    expect(mount.container.querySelector('[data-testid="add"]')).not.toBeNull();
    mount.unmount();
  });

  it('lets rows that own their scrolling replace the host scroller', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList host={host} title="Teams" scrollContent={<ScrollView testID="virtualized" />} />,
    );
    expect(mount.container.querySelector('[data-testid="virtualized"]')).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="scroller"]')).toBeNull();
    mount.unmount();
  });

  it('shows filters only while they have something to act on', async () => {
    const filters = (targetCount: number) => ({ targetCount, content: <Text testID="show-archived">Show archived</Text> });
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList host={host} title="Teams" filters={filters(0)} />,
    );
    expect(mount.container.querySelector('[data-testid="show-archived"]')).toBeNull();
    await mount.render(<HappierCollectionList host={host} title="Teams" filters={filters(2)} />);
    expect(mount.container.querySelector('[data-testid="show-archived"]')).not.toBeNull();
    mount.unmount();
  });

  it("sets the search field and the filters on the page's gutter when a page lists under its own title", () => {
    const leftMargin = (el: Element | null) => (el ? getComputedStyle(el).marginLeft : null);
    // This host draws the field's frame from the style the list hands it, as the app's field does.
    const styledHost: HappierCollectionListHost = {
      ...host,
      SearchField: (props) => <TextInput testID={props.testID ?? 'search'} style={props.style as never} value={props.value} />,
    };
    const tools = (toolsInsetPx?: number) => (
      <HappierCollectionList
        host={styledHost}
        testID="list"
        {...(toolsInsetPx === undefined ? {} : { toolsInsetPx })}
        search={{ testID: 'search', value: '', onChangeText: () => {}, placeholder: 'Search' }}
        filters={{ targetCount: 2, content: <Text testID="switch">All</Text> }}
      />
    );
    const column = mountThroughReactNativeWeb(tools());
    expect(leftMargin(column.container.querySelector('[data-testid="search"]'))).toBe('10px');
    const columnFilters = column.container.querySelector('[data-testid="switch"]')?.parentElement ?? null;
    expect(leftMargin(columnFilters)).toBe('10px');
    column.unmount();
    const page = mountThroughReactNativeWeb(tools(16));
    expect(leftMargin(page.container.querySelector('[data-testid="switch"]')?.parentElement ?? null)).toBe('16px');
    expect(leftMargin(page.container.querySelector('[data-testid="search"]'))).toBe('16px');
    page.unmount();
  });

  it('keeps a collapsible search behind its magnifier until opened, and closing it clears the query', async () => {
    let query = '';
    const searchHost: HappierCollectionListHost = {
      ...host,
      SearchToggle: (props) => <Pressable testID={props.testID} accessibilityState={{ selected: props.open }} onPress={props.onPress}><Text>find</Text></Pressable>,
    };
    const list = () => (
      <HappierCollectionList host={searchHost} title="Discussions"
        search={{ testID: 'search', value: query, onChangeText: (next) => { query = next; }, placeholder: 'Search discussions', collapsible: true }}>
        <Text>row</Text>
      </HappierCollectionList>
    );
    const mount = mountThroughReactNativeWeb(list());
    const toggle = () => mount.container.querySelector<HTMLElement>('[data-testid="search:toggle"]');
    expect(toggle()).not.toBeNull();
    expect(mount.container.querySelector('[data-testid="search"]')).toBeNull();

    act(() => { toggle()!.click(); });
    expect(mount.container.querySelector('[data-testid="search"]')).not.toBeNull();

    query = 'release';
    await mount.render(list());
    act(() => { toggle()!.click(); });
    expect(query).toBe('');
    await mount.render(list());
    expect(mount.container.querySelector('[data-testid="search"]')).toBeNull();
    mount.unmount();
  });

  it('labels a group with its title and count', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionListGroupLabel host={host} title="Available to install" count={4} first />,
    );
    expect(textOf(mount.container, 'text-groupTitle')).toBe('Available to install');
    expect(textOf(mount.container, 'text-groupCount')).toBe('4');
    mount.unmount();
  });

  // A colliding group names its Machine: a narrow column shortens the shared host name, never the end that
  // tells two same-named groups apart (its short id, Offline).
  it('shortens a long detail before the end that tells same-named groups apart', () => {
    const glyphHost: HappierCollectionListHost = { ...host, useGroupGlyphColor: () => '#000' };
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionListGroupLabel host={glyphHost} testID="group" title="Chats" detail="NLDW3-5-36-33"
        detailEnd="e3b5 · Offline" disclosure={{ expanded: true, onToggle: () => {} }} />,
    );
    const texts = [...mount.container.querySelectorAll('[data-testid="text-groupCount"]')] as HTMLElement[];
    const name = texts.find(element => element.textContent === 'NLDW3-5-36-33');
    const end = texts.find(element => element.textContent?.includes('e3b5 · Offline'));
    expect(name).toBeTruthy();
    expect(end).toBeTruthy();
    const slotShrink = (element: HTMLElement) => Number(getComputedStyle(element.parentElement!).flexShrink);
    expect(slotShrink(name!)).toBeGreaterThan(0);
    expect(slotShrink(end!)).toBe(0);
    mount.unmount();
  });

  it('folds its rows from the label, or opens what it stands for while a separate control folds', async () => {
    const calls: string[] = [];
    const glyphHost: HappierCollectionListHost = { ...host, useGroupGlyphColor: () => '#000' };
    const press = (container: HTMLElement, testID: string) => {
      const target = container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
      expect(target).not.toBeNull();
      act(() => { target!.click(); });
    };
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionListGroupLabel host={glyphHost} testID="group" title="happier" count={3} countPlacement="title"
        disclosure={{ expanded: true, onToggle: () => calls.push('toggle') }} rollup={<Text testID="rollup">3/5</Text>} />,
    );
    // Expanded: the rollup is redundant with the rows below, so it is not drawn.
    expect(mount.container.querySelector('[data-testid="rollup"]')).toBeNull();
    expect(mount.container.querySelector('[data-testid="group:open"]')?.getAttribute('aria-expanded')).toBe('true');
    press(mount.container, 'group:open');
    expect(calls).toEqual(['toggle']);
    expect(mount.container.querySelector('[data-testid="group:fold"]')).toBeNull();

    await mount.render(
      <HappierCollectionListGroupLabel host={glyphHost} testID="group" title="Needs you" count={4}
        disclosure={{ expanded: false, onToggle: () => calls.push('toggle'), onOpen: () => calls.push('open') }}
        rollup={<Text testID="rollup">4</Text>} />,
    );
    expect(mount.container.querySelector('[data-testid="rollup"]')).not.toBeNull();
    press(mount.container, 'group:open');
    press(mount.container, 'group:fold');
    expect(calls).toEqual(['toggle', 'open', 'toggle']);
    expect(mount.container.querySelector('[data-testid="group:fold"]')?.getAttribute('aria-expanded')).toBe('false');
    mount.unmount();
  });

  // The fold chevron abuts the lead it folds (no gap between the two targets): a finger's hit area on the
  // chevron must not reach back into the lead, or one tap near their seam is ambiguous.
  it('keeps the separate fold control\'s hit area off the lead it sits against', () => {
    const glyphHost: HappierCollectionListHost = { ...host, useGroupGlyphColor: () => '#000' };
    const mount = mountThroughReactNativeWeb(
      <HappierUiPlatformProvider platform={{ platform: 'ios', colorScheme: 'light' }}>
        <HappierCollectionListGroupLabel host={glyphHost} testID="group" title="Needs you" count={4}
          disclosure={{ expanded: true, onToggle: () => {}, onOpen: () => {} }} />
      </HappierUiPlatformProvider>,
    );
    try {
      const fold = mount.container.querySelector<HTMLElement>('[data-testid="group:fold"]')!;
      const frame = fold.querySelector<HTMLElement>(':scope > [data-happier-hit-area="true"]');
      expect(frame).not.toBeNull();
      const style = getComputedStyle(frame!);
      expect(Number.parseFloat(style.left)).toBeCloseTo(0);
      // Away from the lead it still reaches toward the 44 pt target.
      expect(-Number.parseFloat(style.right)).toBeGreaterThan(0);
      expect(-Number.parseFloat(style.top)).toBeGreaterThan(0);
    } finally {
      mount.unmount();
    }
  });

  it('titles the draft row from the typed name, falling back to the placeholder', () => {
    const titles = createHappierCollectionDraftTitleStore();
    function DraftRow() {
      const draft = useHappierCollectionDraftRowTitle(titles, 'New pool');
      return <Text testID="draft">{`${draft.title}|${draft.untitled}`}</Text>;
    }
    const mount = mountThroughReactNativeWeb(<DraftRow />);
    expect(textOf(mount.container, 'draft')).toBe('New pool|true');
    act(() => titles.publish('  Build box '));
    expect(textOf(mount.container, 'draft')).toBe('Build box|false');
    mount.unmount();
  });
});
