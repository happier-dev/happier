import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { act, createContext, useContext, type ReactNode } from 'react';
import { HappierTechnicalDetailsDisclosure } from '../collection/TechnicalDetailsDisclosure.js';
import { resolveHappierFactsRevealOffset } from './approvalFactsReveal.js';
import { HappierApprovalFields } from './ApprovalFields.js';
import { HappierApprovalPromptChrome, resolveHappierApprovalFactsEdges, type HappierApprovalPromptChromeProps } from './ApprovalPromptChrome.js';

const base: HappierApprovalPromptChromeProps = {
  title: 'Open machine terminal',
  cardRadius: 12,
  colors: { border: '#ddd', surface: '#fff', title: '#111', subtitle: '#666',
    status: { secondaryText: '#666', attention: { foreground: '#a60', background: '#fff7ec', border: '#f90' },
      danger: { foreground: '#b00', background: '#fee', border: '#f66' } } },
  spacing: { small: 8, medium: 12 },
  typography: null,
};

function mount(maxHeight?: number) {
  return mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={maxHeight}
    footer={<View testID="decision" />}>
    <View testID="facts" />
  </HappierApprovalPromptChrome>);
}

describe('HappierApprovalPromptChrome', () => {
  it('compact: a small tinted card with no ring, its source line above the title and everything on one edge', () => {
    const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" chrome="compact" tone="attention"
      eyebrow="Bash" surfaceStyle={{ backgroundColor: 'rgb(1, 2, 3)' }} icon={<View testID="dot" />}
      headerAccessory={<View testID="badge" />} footer={<View testID="decision" />}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      const card = view.container.querySelector<HTMLElement>('[data-testid="card"]')!;
      const style = getComputedStyle(card);
      expect(style.backgroundColor).toBe('rgb(1, 2, 3)');
      expect(style.borderTopWidth).toBe('0px');
      // Source line, then title: the head reads from who asks to what it asks.
      expect(card.textContent).toBe('BashOpen machine terminal');
      const edge = (testID: string) => {
        let node = view.container.querySelector(`[data-testid="${testID}"]`)!.parentElement!;
        while (getComputedStyle(node).paddingLeft === '0px' && node !== card) node = node.parentElement!;
        return getComputedStyle(node).paddingLeft;
      };
      // The facts and the decision keep the card's inset instead of hanging under the title's column.
      expect(edge('facts')).toBe('12px');
      expect(edge('decision')).toBe('12px');
      // The mark sizes itself: a dot is not given the card variant's shield slot.
      expect(getComputedStyle(view.container.querySelector('[data-testid="dot"]')!.parentElement!).width).not.toBe('18px');
    } finally { view.unmount(); }
  });

  it('card: the facts sit on the card inset beside the decision, so a full-width band is inset the same on both sides', () => {
    const view = mount();
    try {
      const card = view.container.querySelector<HTMLElement>('[data-testid="card"]')!;
      const facts = view.container.querySelector<HTMLElement>('[data-testid="facts"]')!;
      let body = facts.parentElement!;
      while (getComputedStyle(body).paddingLeft === '0px' && body !== card) body = body.parentElement!;
      const style = getComputedStyle(body);
      expect([style.paddingLeft, style.paddingRight]).toEqual(['12px', '12px']);
    } finally { view.unmount(); }
  });

  it('inline: the decision starts on the facts column under the title, not outdented to the card edge', () => {
    // DESIGN-ACCEPT-152 fix 18 (#1): Approve sat 23 px left of the card's text column in the composer tray.
    const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" chrome="inline"
      footer={<View testID="decision" />}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      const card = view.container.querySelector<HTMLElement>('[data-testid="card"]')!;
      const edge = (testID: string) => {
        let node = view.container.querySelector(`[data-testid="${testID}"]`)!.parentElement!;
        while (getComputedStyle(node).paddingLeft === '0px' && node !== card) node = node.parentElement!;
        return getComputedStyle(node).paddingLeft;
      };
      expect(edge('decision')).toBe(edge('facts'));
    } finally { view.unmount(); }
  });

  // UI refinements ruling 2026-11-24 10:02Z (DESIGN-ACCEPT-152 fix 6): a card's minimum counts its title, its first
  // fact row (the deciding value) and its buttons, so a tray sharing its room never cuts the deciding fact.
  it('counts the first fact row in a bounded card\'s minimum, and scrolls the rest and its Technical details inside', () => {
    const heights: Array<Readonly<{ natural: number; minimum: number }>> = [];
    const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={160}
      onMeasure={(value) => heights.push(value)} footer={<View testID="decision" />}>
      <HappierApprovalFields testID="fields" rows={[
        { kind: 'value', key: 'title', label: 'Title', value: 'Release notes' },
        { kind: 'value', key: 'session', label: 'Session', value: 'Review the checkout copy' },
      ]} footer={<View testID="technical" />} />
    </HappierApprovalPromptChrome>);
    try {
      const layout = (testID: string, y: number, height: number) => {
        const node = view.container.querySelector(`[data-testid="${testID}"]`) as unknown as {
          __reactLayoutHandler?: (event: { nativeEvent: { layout: { x: number; y: number; width: number; height: number } } }) => void;
        } | null;
        expect(node, testID).not.toBeNull();
        act(() => { node!.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y, width: 600, height } } }); });
      };
      layout('card-head', 0, 40);
      layout('card-decision', 0, 36);
      layout('fields', 0, 120);
      layout('fields.row:title', 8, 20);
      // Title row (40), the first fact's bottom (8 + 20), the decision and its inset (36 + 12).
      expect(heights.at(-1)?.minimum).toBe(40 + 28 + 36 + 12);
      const scroller = view.container.querySelector('[data-testid="card-facts"]')!;
      expect(scroller.contains(view.container.querySelector('[data-testid="technical"]'))).toBe(true);
    } finally { view.unmount(); }
  });

  it('keeps the decision outside the scrolling facts when the card is bounded', () => {
    const mounted = mount(240);
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      const facts = mounted.container.querySelector('[data-testid="facts"]') as HTMLElement;
      const decision = mounted.container.querySelector('[data-testid="decision"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('240px');
      // The facts scroll inside the card; the decision is pinned beneath them, never inside that scroll.
      const factsScroller = facts.closest('[data-testid="card-facts"]') as HTMLElement | null;
      expect(factsScroller).not.toBeNull();
      expect(factsScroller!.contains(decision)).toBe(false);
      expect(card.contains(decision)).toBe(true);
    } finally { mounted.unmount(); }
  });

  it('fades bounded facts at the edge that hides more, and only when real facts are hidden', () => {
    const at = (offset: number) => resolveHappierApprovalFactsEdges({ viewport: 120, content: 300, offset, threshold: 8 });
    expect(at(0)).toEqual({ top: false, bottom: true });
    expect(at(90)).toEqual({ top: true, bottom: true });
    expect(at(180)).toEqual({ top: true, bottom: false });
    // The body's own few pixels of inset are not hidden facts.
    expect(resolveHappierApprovalFactsEdges({ viewport: 120, content: 126, offset: 0, threshold: 8 })).toEqual({ top: false, bottom: false });
  });

  it('shows a fade only on the side where the facts continue, following the scroll, never a whole line deep', async () => {
    const edges: Array<Readonly<{ top: boolean; bottom: boolean }>> = [];
    let depth = 0;
    const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={240}
      renderFactsEdgeFade={(value, _fill, size) => { edges.push(value); depth = size; return null; }} footer={<View testID="decision" />}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      const scroller = view.container.querySelector('[data-testid="card-facts"]') as HTMLElement & { __reactLayoutHandler?: (event: unknown) => void };
      act(() => { scroller.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 120 } } }); });
      Object.defineProperty(scroller, 'scrollHeight', { value: 300, configurable: true });
      const content = scroller.firstElementChild as HTMLElement & { __reactLayoutHandler?: (event: unknown) => void };
      act(() => { content.__reactLayoutHandler?.({ nativeEvent: { layout: { x: 0, y: 0, width: 600, height: 300 } } }); });
      // The host reports where a scroll comes to rest once it settles.
      const scrollTo = async (top: number) => act(async () => {
        Object.defineProperty(scroller, 'scrollTop', { value: top, configurable: true });
        scroller.dispatchEvent(new Event('scroll'));
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
      expect(edges.at(-1)).toEqual({ top: false, bottom: true });
      edges.length = 0;
      for (let offset = 9; offset <= 180; offset += 9) await scrollTo(offset);
      // Twenty distinct offsets cross only two visible edge states; the card's
      // title, facts and decision must not render for every scroll frame.
      expect(edges).toEqual([{ top: true, bottom: true }, { top: true, bottom: false }]);
      expect(edges.at(-1)).toEqual({ top: true, bottom: false });
      await scrollTo(0);
      expect(edges.at(-1)).toEqual({ top: false, bottom: true });
      // A fact line is at least a body line tall; the fade only says "more this way" and never washes out a whole one.
      expect(depth).toBeGreaterThan(0);
      expect(depth).toBeLessThanOrEqual(base.spacing.medium);
    } finally { view.unmount(); }
  });

  it('draws the host fade over the scrolling facts of a pinned card, in place of the hairline', () => {
    const edges: unknown[] = [];
    const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={240}
      renderFactsEdgeFade={(value) => { edges.push(value); return <View testID="fade" />; }} footer={<View testID="decision" />}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      expect(view.container.querySelector('[data-testid="fade"]')).not.toBeNull();
      expect(edges.at(-1)).toEqual({ top: false, bottom: false });
      const facts = view.container.querySelector('[data-testid="card-facts"]')!;
      expect(facts.contains(view.container.querySelector('[data-testid="fade"]'))).toBe(false);
    } finally { view.unmount(); }
  });

  it('gives the fade the card\'s own fill, tone wash included, and no fill for an inline prompt', () => {
    const fillFor = (props: Partial<HappierApprovalPromptChromeProps>) => {
      let fill: string | null | undefined;
      const view = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} {...props} testID="card" maxHeight={240}
        renderFactsEdgeFade={(_edges, value) => { fill = value; return null; }} footer={<View testID="decision" />}>
        <View testID="facts" />
      </HappierApprovalPromptChrome>);
      view.unmount();
      return fill;
    };
    expect(fillFor({})).toBe(base.colors.surface);
    // An attention card is washed: its fade melts into that wash, not into the bare surface beneath it.
    const attention = fillFor({ tone: 'attention' });
    expect(attention).toEqual(expect.any(String));
    expect(attention).not.toBe(base.colors.surface);
    const inline = fillFor({ chrome: 'inline' });
    expect(inline).toBeNull();
  });

  it('never clips the facts of a card that has no decision to pin', () => {
    // A failed or settled card closes from its head: nothing needs pinning, so a shared room scrolls whole
    // cards between each other instead of cutting this card's last line in half.
    const mounted = mountThroughReactNativeWeb(<HappierApprovalPromptChrome {...base} testID="card" maxHeight={90}>
      <View testID="facts" />
    </HappierApprovalPromptChrome>);
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('');
      expect(mounted.container.querySelector('[data-testid="card-facts"]')).toBeNull();
    } finally { mounted.unmount(); }
  });

  it('brings an opened Technical details body into view instead of leaving it under the decision', async () => {
    // Design review R4 (1440 tray): the opened body sat under the fade with only its first label legible.
    const Open = createContext(false);
    let depth = 0;
    const Fold = (props: Readonly<{ title: string; testID?: string; children: ReactNode }>) => (
      <View testID={props.testID}>{useContext(Open) ? props.children : null}</View>
    );
    const card = (open: boolean) => (
      <Open.Provider value={open}>
        <HappierApprovalPromptChrome {...base} testID="card" maxHeight={200} footer={<View testID="decision" />}
          renderFactsEdgeFade={(_edges, _fill, value) => { depth = value; return null; }}>
          <View testID="facts" />
          <HappierTechnicalDetailsDisclosure testID="technical" title="Technical details" Disclosure={Fold}
            lines={[{ key: 'code', label: 'Code', value: 'workspace_sync_relationship_in_use' }]} />
        </HappierApprovalPromptChrome>
      </Open.Provider>
    );
    const view = mountThroughReactNativeWeb(card(false));
    try {
      const fire = (node: Element, height: number) => act(() => {
        (node as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 600, height } } });
      });
      const scroller = view.container.querySelector('[data-testid="card-facts"]') as HTMLElement & { scroll: unknown };
      const scrolls: Array<Readonly<{ top?: number }>> = [];
      scroller.scroll = (options: Readonly<{ top?: number }>) => { scrolls.push(options); };
      fire(scroller, 100);
      await view.render(card(true));
      const body = view.container.querySelector('[data-testid="technical.body"]') as HTMLElement;
      expect(body).not.toBeNull();
      // The fold opens 160px down the facts, its lines under its title, 60px in all: its end must reach the 100px
      // window's bottom, and rest clear of the bottom fade (K05, cut 52: the revealed lines sat under a fade a whole row deep).
      const fold = view.container.querySelector('[data-testid="technical"]')!.parentElement as HTMLElement;
      Object.defineProperty(fold, 'offsetTop', { value: 160 });
      Object.defineProperty(fold, 'offsetHeight', { value: 60 });
      fire(body, 60);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      expect(depth).toBeGreaterThan(0);
      const offset = scrolls.at(-1)?.top ?? 0;
      expect(160 + 60).toBeLessThanOrEqual(offset + 100 - depth);
      expect(160).toBeGreaterThanOrEqual(offset + depth);
    } finally { view.unmount(); }
  });

  it('rests a fold taller than the window with its title at the top, clear of the fade, its lines reading from the first', async () => {
    // K05, cut 53 (390 dark): the phone tray keeps a third of the room, the opened lines outgrow its window, and the
    // reveal anchored the lines' own top, so "Technical details" sat cut under the top fade above them.
    const Open = createContext(false);
    let depth = 0;
    const Fold = (props: Readonly<{ title: string; testID?: string; children: ReactNode }>) => (
      <View testID={props.testID}><View testID="toggle" />{useContext(Open) ? props.children : null}</View>
    );
    const card = (open: boolean) => (
      <Open.Provider value={open}>
        <HappierApprovalPromptChrome {...base} testID="card" maxHeight={200} footer={<View testID="decision" />}
          renderFactsEdgeFade={(_edges, _fill, value) => { depth = value; return null; }}>
          <View testID="facts" />
          <HappierTechnicalDetailsDisclosure testID="technical" title="Technical details" Disclosure={Fold}
            lines={[1, 2, 3, 4].map((n) => ({ key: `line-${n}`, label: `Intent ${n}`, value: `default:builtin:widget_${n}` }))} />
        </HappierApprovalPromptChrome>
      </Open.Provider>
    );
    const view = mountThroughReactNativeWeb(card(false));
    try {
      const fire = (node: Element, height: number) => act(() => {
        (node as unknown as { __reactLayoutHandler?: (event: unknown) => void }).__reactLayoutHandler?.({
          nativeEvent: { layout: { x: 0, y: 0, width: 600, height } } });
      });
      const scroller = view.container.querySelector('[data-testid="card-facts"]') as HTMLElement & { scroll: unknown };
      const scrolls: Array<Readonly<{ top?: number }>> = [];
      scroller.scroll = (options: Readonly<{ top?: number }>) => { scrolls.push(options); };
      fire(scroller, 100);
      await view.render(card(true));
      // The fold's title row starts 160px down the facts; its lines follow from 180px and run 300px.
      const fold = view.container.querySelector('[data-testid="technical"]')!.parentElement as HTMLElement;
      const body = view.container.querySelector('[data-testid="technical.body"]') as HTMLElement;
      Object.defineProperty(fold, 'offsetTop', { value: 160 });
      Object.defineProperty(fold, 'offsetHeight', { value: 320 });
      Object.defineProperty(body, 'offsetTop', { value: 180 });
      Object.defineProperty(body, 'offsetHeight', { value: 300 });
      fire(body, 300);
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
      expect(depth).toBeGreaterThan(0);
      expect(scrolls.at(-1)?.top).toBe(160 - depth);
    } finally { view.unmount(); }
  });

  it('reveals the least it must: never past the opened body\'s own start, and not at all when it is in view', () => {
    // It leaves the edge fade's depth clear, so the line it brings into view never rests under a fade.
    expect(resolveHappierFactsRevealOffset({ top: 180, height: 60, viewport: 100, offset: 0, clearance: 12 })).toBe(152);
    // Taller than the window: it reads from its first line, clear of the top fade.
    expect(resolveHappierFactsRevealOffset({ top: 180, height: 300, viewport: 100, offset: 0, clearance: 12 })).toBe(168);
    expect(resolveHappierFactsRevealOffset({ top: 20, height: 40, viewport: 100, offset: 0, clearance: 12 })).toBeNull();
  });

  it('lets an unbounded card grow with its facts', () => {
    const mounted = mount();
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('');
      expect(mounted.container.querySelector('[data-testid="decision"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });
});
