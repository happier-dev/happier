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

await import('./Item');
await import('@/components/ui/text/Text');

afterEach(() => {
  standardCleanup();
  vi.resetModules();
});

type Scope = 'page' | 'widgetBody' | 'popoverFromWidgetBody';

/** Where the row's leading glyph starts: the horizontal inset of the row box that holds its title. */
async function rowInset(scope: Scope): Promise<number> {
  const { Item } = await import('./Item');
  const { Text } = await import('@/components/ui/text/Text');
  const { ListPresentationProvider } = await import('./listPresentation');
  const { HappierBodyEdgeContext } =
    await import('@happier-dev/plugin-ui/presentation');
  const { StyleSheet } = await import('react-native');
  const row = (
    <Item
      testID="row"
      title="Nightly triage"
      subtitle="Succeeded"
      density="compact"
      icon={<Text>mark</Text>}
      onPress={() => {}}
    />
  );
  const tree =
    scope === 'page' ? (
      row
    ) : scope === 'widgetBody' ? (
      <HappierBodyEdgeContext.Provider value>
        {row}
      </HappierBodyEdgeContext.Provider>
    ) : (
      // A menu opened from a row inside a widget body (React context crosses portals) draws its own rows.
      <HappierBodyEdgeContext.Provider value>
        <ListPresentationProvider value="grouped" floating>
          {row}
        </ListPresentationProvider>
      </HappierBodyEdgeContext.Provider>
    );
  const screen = await renderScreen(tree);
  const boxes = screen.findAll((node) => {
    const style = StyleSheet.flatten(node.props?.style);
    return (
      typeof style?.paddingHorizontal === 'number' &&
      style.flexDirection === 'row' &&
      node.findAll((child) => child.props?.children === 'Nightly triage')
        .length > 0
    );
  });
  return StyleSheet.flatten(boxes.at(-1)!.props.style)
    .paddingHorizontal as number;
}

describe('Item on a widget body edge', () => {
  it('a list row in a widget body stands its glyph on the body edge, beside the frame mark', async () => {
    expect(await rowInset('page')).toBeGreaterThan(0);
    expect(await rowInset('widgetBody')).toBe(0);
  });

  it('a floating surface opened from the body keeps its own row inset', async () => {
    expect(await rowInset('popoverFromWidgetBody')).toBe(
      await rowInset('page'),
    );
  });
});
