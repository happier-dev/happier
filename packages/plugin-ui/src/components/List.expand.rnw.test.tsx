import { act, useState } from 'react';
import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../rnwMount.testSupport.js';
import { createHostApiStub, createSurfaceContext } from '../surfaceFixture.testSupport.js';
import { DiffViewer } from './Content.js';
import { List } from './List.js';
import { ListCollectionControlContext } from './listCollectionControl.js';
import { PluginUiProvider } from './PluginUiProvider.js';
import { Text } from './Text.js';

/**
 * Plugin tabs round 2 (XP / PP): a row opens in place. Pressing it shows what it is to this session under its
 * text, with its actions at the bottom; pressing it again folds it. The body is the same disclosure owner the
 * Collection peek and the host's `ExpandableItem` use.
 */
function ExpandableRow() {
  const [expanded, setExpanded] = useState(false);
  return (
    <List accessibilityLabel="Conversations">
      <List.Item
        testID="conversation-row"
        title="happier-dev"
        subtitle="Discord · Happier Labs"
        expanded={expanded}
        expandedContent={<Text testID="conversation-peek" value="Hears messages addressed to the bot" />}
        onPress={() => setExpanded((current) => !current)}
      />
    </List>
  );
}

function mount() {
  const context = createSurfaceContext();
  return mountThroughReactNativeWeb(
    <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
      <ExpandableRow />
    </PluginUiProvider>,
  );
}

describe('plugin-ui List.Item expand in place', () => {
  it('opens its body under the row on press and folds it again, saying so to assistive technology', () => {
    const view = mount();
    const row = () => view.container.querySelector<HTMLElement>('[data-testid="conversation-row"] [role="button"], [role="button"][data-testid="conversation-row"]');
    expect(row(), 'the row is a real pressable').not.toBeNull();
    expect(row()?.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('[data-testid="conversation-peek"]')).toBeNull();

    act(() => row()!.click());
    expect(row()?.getAttribute('aria-expanded')).toBe('true');
    expect(view.container.querySelector('[data-testid="conversation-peek"]')?.textContent)
      .toBe('Hears messages addressed to the bot');

    act(() => row()!.click());
    expect(row()?.getAttribute('aria-expanded')).toBe('false');
    view.unmount();
  });

  it('lets the row name the diff it discloses: the diff keeps that name for readers and draws no second caption', () => {
    const context = createSurfaceContext();
    function FileRow() {
      const [expanded, setExpanded] = useState(false);
      return (
        <List accessibilityLabel="Files">
          <List.Item
            testID="file-row"
            title="src/review.ts"
            expanded={expanded}
            expandedContent={<DiffViewer unifiedDiff={'@@ -1 +1 @@\n-old\n+new'} filePath="src/review.ts" label="src/review.ts" />}
            onPress={() => setExpanded((current) => !current)}
          />
        </List>
      );
    }
    const view = mountThroughReactNativeWeb(
      <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
        <FileRow />
        <DiffViewer unifiedDiff={'@@ -1 +1 @@\n-a\n+b'} label="Standalone diff" />
      </PluginUiProvider>,
    );
    act(() => view.container.querySelector<HTMLElement>('[data-testid="file-row"] [role="button"], [role="button"][data-testid="file-row"]')!.click());
    const body = view.container.querySelector<HTMLElement>('[role="group"][aria-label="src/review.ts"]');
    expect(body, 'the disclosed diff is named by its file').not.toBeNull();
    expect(body!.textContent).toContain('+new');
    expect(body!.textContent).not.toContain('src/review.ts');
    // Outside a row the diff still captions itself.
    expect(view.container.textContent).toContain('Standalone diff');
    view.unmount();
  });

  it('draws a closed row flat: no rim, fill, shadow or lift until it opens', () => {
    const view = mount();
    const frame = () => view.container.querySelector<HTMLElement>('[data-testid="conversation-row:expanded"]')!.parentElement!;
    const closed = getComputedStyle(frame());
    const closedBox = { top: closed.marginTop, bottom: closed.marginBottom, border: closed.borderTopWidth };
    expect(closed.borderTopColor).toMatch(/transparent|rgba\(0, 0, 0, 0\)/);
    expect(closed.backgroundColor).toMatch(/^(transparent|rgba\(0, 0, 0, 0\))?$/);
    expect(closed.boxShadow === '' || closed.boxShadow === 'none').toBe(true);
    const row = () => view.container.querySelector<HTMLElement>('[data-testid="conversation-row"] [role="button"], [role="button"][data-testid="conversation-row"]')!;
    act(() => row().click());
    act(() => row().click());
    // Folded again, it is the same flat frame it was before it opened.
    const refolded = getComputedStyle(frame());
    expect({ top: refolded.marginTop, bottom: refolded.marginBottom, border: refolded.borderTopWidth }).toEqual(closedBox);
    expect(refolded.borderTopColor).toBe(closed.borderTopColor);
    expect(refolded.boxShadow === '' || refolded.boxShadow === 'none').toBe(true);
    view.unmount();
  });

  it('stands a plain List header, band titles, rows and end content on one text edge, in a page-scrolling panel too', () => {
    const context = createSurfaceContext();
    const px = (value: string) => Number.parseFloat(value) || 0;
    /** The text's left edge from the list root: every margin, border and padding between them. */
    const edge = (text: HTMLElement, root: HTMLElement) => {
      let total = 0;
      for (let node: HTMLElement | null = text; node !== null && node !== root; node = node.parentElement) {
        const style = getComputedStyle(node);
        total += px(style.marginLeft) + (node === text ? 0 : px(style.paddingLeft) + px(style.borderLeftWidth));
      }
      return total;
    };
    const leaf = (root: HTMLElement, value: string) => [...root.querySelectorAll<HTMLElement>('*')]
      .find(node => node.childElementCount === 0 && node.textContent === value)!;
    for (const control of [null, { pageScroll: true }] as const) {
      const view = mountThroughReactNativeWeb(
        <PluginUiProvider hostApi={createHostApiStub(context)} context={context}>
          <ListCollectionControlContext.Provider value={control}>
            <View testID="files-root">
              <List accessibilityLabel="Files" header={<Text value="Changed files" />} endContent={<Text value="Show more files" />}
                sections={[{ key: 'a', title: 'Source', data: ['alpha'] }, { key: 'b', title: 'Tests', data: ['beta'] }]}
                keyForItem={item => item} renderItem={item => <List.Item title={item} expanded={false}
                  expandedContent={<Text value="body" />} onPress={() => undefined} />} />
            </View>
          </ListCollectionControlContext.Provider>
        </PluginUiProvider>,
      );
      const root = view.container.querySelector<HTMLElement>('[data-testid="files-root"]')!;
      const edges = ['Changed files', 'Source', 'alpha', 'Tests', 'Show more files'].map(value => edge(leaf(root, value), root));
      expect(new Set(edges).size, `${JSON.stringify(control)}: ${edges.join(', ')}`).toBe(1);
      view.unmount();
    }
  });
});
