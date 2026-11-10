import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

// The phone column is the platform the iOS type column reads (`Platform.OS`), decided at module scope. The
// platform is the boundary; the list's geometry under it stays real.
vi.mock('react-native', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-native')>();
  return {
    ...actual,
    Platform: {
      ...actual.Platform,
      OS: 'ios',
      select: (options: Record<string, unknown>) =>
        options.ios ?? options.native ?? options.default,
    },
  };
});

const { ScrollView, Text, TextInput, View } =
  await import('react-native');
const { mountThroughReactNativeWeb } =
  await import('../../rnwMount.testSupport.js');
const { HAPPIER_PAGE_METRICS } = await import('../layout/pageMetrics.js');
const { HappierCollectionList } = await import('./CollectionList.js');
type Host = import('./CollectionList.js').HappierCollectionListHost;

const host: Host = {
  Text: (props) => <Text testID={`text-${props.role}`}>{props.children}</Text>,
  Scroller: (props: Readonly<{ children: ReactNode }>) => (
    <ScrollView testID="scroller">{props.children}</ScrollView>
  ),
  SearchField: (props) => (
    <View testID="search-frame" style={props.style as never}>
      <TextInput
        testID="search"
        value={props.value}
        placeholder={props.placeholder}
      />
    </View>
  ),
  surfaceStyle: null,
};

describe('HappierCollectionList on a phone', () => {
  it('stands its search field and filters on the box edge, like every sheet and field of the page (PHONE-GEOMETRY-1110 L2)', () => {
    // Boxes on the sheet inset (16), text on the page text inset (18); the field had kept the rows' 8 pt gutter.
    const mount = mountThroughReactNativeWeb(
      <HappierCollectionList
        host={host}
        title="Boards"
        search={{
          value: '',
          onChangeText: () => {},
          placeholder: 'Search boards',
        }}
        filters={{ targetCount: 4, content: <Text testID="filters">All</Text> }}
      >
        <Text>Row</Text>
      </HappierCollectionList>,
    );
    const field = mount.container.querySelector<HTMLElement>(
      '[data-testid="search-frame"]',
    )!.style;
    expect(field.marginLeft).toBe(`${HAPPIER_PAGE_METRICS.sheetInsetPx}px`);
    expect(field.marginRight).toBe(`${HAPPIER_PAGE_METRICS.sheetInsetPx}px`);
    const filters = mount.container.querySelector<HTMLElement>(
      '[data-testid="filters"]',
    )!.parentElement!;
    expect(filters.style.marginLeft).toBe(
      `${HAPPIER_PAGE_METRICS.sheetInsetPx}px`,
    );
    mount.unmount();
  });
});
