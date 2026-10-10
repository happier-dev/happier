import { act, type ReactNode } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
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

  it('labels a group with its title and count', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionListGroupLabel host={host} title="Available to install" count={4} first />,
    );
    expect(textOf(mount.container, 'text-groupTitle')).toBe('Available to install');
    expect(textOf(mount.container, 'text-groupCount')).toBe('4');
    mount.unmount();
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
