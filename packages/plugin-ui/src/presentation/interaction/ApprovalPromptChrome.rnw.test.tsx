import { View } from 'react-native';
import { describe, expect, it } from 'vitest';

import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
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

  it('lets an unbounded card grow with its facts', () => {
    const mounted = mount();
    try {
      const card = mounted.container.querySelector('[data-testid="card"]') as HTMLElement;
      expect(card.style.maxHeight).toBe('');
      expect(mounted.container.querySelector('[data-testid="decision"]')).not.toBeNull();
    } finally { mounted.unmount(); }
  });
});
