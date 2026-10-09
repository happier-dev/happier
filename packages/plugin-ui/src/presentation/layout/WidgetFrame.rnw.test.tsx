import { act, useEffect, useState } from 'react';
import { Pressable, Text, TextInput } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import {
  HAPPIER_WIDGET_FRAME_METRICS,
  HappierWidgetFrame,
  isHappierWidgetFrameSourceShown,
  type HappierWidgetFrameProps,
} from './WidgetFrame.js';

/**
 * The one widget frame (lab `cwidgets` F1, round 2 WK): the same header grammar — mark, title,
 * source, meta, the widget's controls — the same body and the same one footer in every placement,
 * drawn either as a card (its own surface) or plain (no surface, a hairline above).
 */
const CHROME = {
  card: { backgroundColor: 'rgb(1, 2, 3)', borderRadius: 14 },
  divider: 'rgb(9, 8, 7)',
} as const;

function mount(props: Partial<HappierWidgetFrameProps> = {}) {
  return mountThroughReactNativeWeb(
    <HappierWidgetFrame
      testID="frame"
      frameStyle="card"
      placement="board"
      cardStyle={CHROME.card}
      dividerColor={CHROME.divider}
      mark={<Text>mark</Text>}
      title="Release checklist"
      source="Note"
      meta={<Text>as of 10:42</Text>}
      accessory={<Text>menu</Text>}
      footer={<Text>Open Channels</Text>}
      {...props}
    >
      <Text>body</Text>
    </HappierWidgetFrame>,
  );
}

function byId(root: ParentNode, id: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

describe('HappierWidgetFrame', () => {
  it('keeps controlled disclosure separate from header actions and retains the body input across collapse', async () => {
    let mounts = 0;
    let inspections = 0;
    function Body() {
      const [text, setText] = useState('draft');
      useEffect(() => { mounts += 1; }, []);
      return <><TextInput testID="retained-input" value={text} onChangeText={setText} />
        <Pressable testID="edit-input" onPress={() => setText('edited draft')}><Text>Edit</Text></Pressable></>;
    }
    function Frame() {
      const [collapsed, setCollapsed] = useState(false);
      return <HappierWidgetFrame frameStyle="plain" placement="companion" title="Notes" testID="disclosure"
        disclosure={{ collapsed, onCollapsedChange: setCollapsed, expandLabel: 'Expand notes', collapseLabel: 'Collapse notes' }}
        accessory={<Pressable accessibilityRole="button" testID="header-action" onPress={() => { inspections += 1; }}><Text>About</Text></Pressable>}>
        <Body />
      </HappierWidgetFrame>;
    }
    const view = mountThroughReactNativeWeb(<Frame />);
    const input = byId(view.container, 'retained-input') as HTMLInputElement;
    const toggle = () => byId(view.container, 'disclosure.disclosure')!;
    expect(toggle()).not.toBeNull();
    await act(async () => { byId(view.container, 'edit-input')!.click(); });
    expect(input.value).toBe('edited draft');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(byId(view.container, 'header-action')).not.toBeNull();
    expect(byId(view.container, 'retained-input')).toBe(input);
    expect(input.closest('[aria-hidden="true"]')).not.toBeNull();
    await act(async () => { byId(view.container, 'header-action')!.click(); });
    expect(inspections).toBe(1);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    await act(async () => { toggle().click(); });
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(byId(view.container, 'retained-input')).toBe(input);
    expect(input.closest('[aria-hidden="true"]')).toBeNull();
    expect(input.value).toBe('edited draft');
    expect(mounts).toBe(1);
    view.unmount();
  });

  it('draws a card: the adapter surface around the header, body and a footer on a divider', () => {
    const view = mount();
    const frame = byId(view.container, 'frame')!;
    expect(frame.style.backgroundColor).toBe('rgb(1, 2, 3)');
    expect(frame.textContent).toContain('Release checklist');
    expect(frame.textContent).toContain('Note');
    expect(frame.textContent).toContain('as of 10:42');
    expect(frame.textContent).toContain('menu');
    expect(frame.textContent).toContain('body');
    const footer = byId(frame, 'frame.footer')!;
    expect(footer.style.borderTopColor).toBe('rgb(9, 8, 7)');
    expect(frame.style.borderTopColor).not.toBe('rgb(9, 8, 7)');
  });

  it('draws plain with no surface and a hairline above, keeping the same header, body and footer', () => {
    const view = mount({ frameStyle: 'plain' });
    const frame = byId(view.container, 'frame')!;
    expect(frame.style.backgroundColor).not.toBe('rgb(1, 2, 3)');
    expect(frame.style.borderTopColor).toBe('rgb(9, 8, 7)');
    for (const text of ['Release checklist', 'Note', 'as of 10:42', 'menu', 'body', 'Open Channels']) {
      expect(frame.textContent).toContain(text);
    }
    // The footer sits on the page, not on a second divider.
    expect(byId(frame, 'frame.footer')!.style.borderTopColor).not.toBe('rgb(9, 8, 7)');
  });

  it('puts the source under the title when asked (phones), and beside it otherwise', () => {
    const inline = mount();
    const below = mount({ sourcePlacement: 'below' });
    const titleRowOf = (root: ParentNode) => byId(root, 'frame.titleBlock')!;
    expect(titleRowOf(inline.container).style.flexDirection).toBe('row');
    expect(titleRowOf(below.container).style.flexDirection).toBe('column');
  });

  it('aligns body and header on the placement inset: a card keeps its padding, plain lines up with the page', () => {
    const card = mount();
    const plain = mount({ frameStyle: 'plain' });
    const headerOf = (root: ParentNode) => byId(root, 'frame.header')!;
    expect(headerOf(card.container).style.paddingLeft).toBe(`${HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx}px`);
    expect(headerOf(plain.container).style.paddingLeft).toBe(`${HAPPIER_WIDGET_FRAME_METRICS.plainInsetPx}px`);
    expect(byId(card.container, 'frame.body')!.style.paddingLeft).toBe(`${HAPPIER_WIDGET_FRAME_METRICS.cardInsetPx}px`);
  });

  it('lets the source leave before the title truncates: hidden only below the narrowing width', () => {
    const limit = HAPPIER_WIDGET_FRAME_METRICS.sourceHiddenBelowPx;
    expect(isHappierWidgetFrameSourceShown(null)).toBe(true);
    expect(isHappierWidgetFrameSourceShown(limit)).toBe(true);
    expect(isHappierWidgetFrameSourceShown(limit - 1)).toBe(false);
  });
});
