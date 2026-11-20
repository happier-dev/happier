// @vitest-environment jsdom

import * as React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  installWebLayoutBridge,
  measureWebLayout,
  type WebLayoutRect,
} from '@/dev/testkit/render/measureWebLayout';

/** A phone File page's facts as a browser wraps them (files lab FV1p/FV6p). */

vi.mock('react-native', async () => vi.importActual('react-native-web'));
vi.mock('react-native-unistyles', async () => {
  const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
  return createUnistylesMock();
});
// The in-app text size is device-local storage, outside the line owner.
vi.mock('@/sync/store/hooks', () => ({ useLocalSetting: () => 1 }));

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

const FACTS = [
  'New, not tracked yet',
  'MPEG-4 video',
  '0:04',
  '55.8 KB',
] as const;

async function measureLargeLine(width: number, lineEnd?: React.ReactNode) {
  const { PaneHeaderLineView } = await import('./PaneHeader');
  const { Text } = await import('@/components/ui/text/Text');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <View testID="column" style={{ width }}>
        <PaneHeaderLineView
          large
          testID="header"
          line={{
            leading: <Text testID="crumb">assets</Text>,
            leadingSeparated: true,
            segments: FACTS,
          }}
          lineEnd={lineEnd}
        />
      </View>,
    );
  });
  return measureWebLayout(host, {
    viewport: { width: Math.max(width, 400), height: 300 },
    texts: ['·', 'assets', 'by Codex 3m ago', ...FACTS],
  });
}

const sameLine = (a: WebLayoutRect, b: WebLayoutRect) =>
  Math.abs((a.top + a.bottom) / 2 - (b.top + b.bottom) / 2) <= 3;

describe("a phone header's wrapped facts, as a browser lays them out", () => {
  it("starts every line on the title's text edge and never opens or closes a line with a separator", async () => {
    // The facts start where the title's text starts (labs cshead H1, ideas-1118 PR header); no ruling puts them right.
    const layout = await measureLargeLine(300);
    const column = layout.rect('column');
    const clip = layout.rect('header.subtitle');
    const crumb = layout.textRects('assets')[0]!;
    const facts = FACTS.map((fact) => layout.textRects(fact)[0]!);
    const words = [crumb, ...facts];
    expect(sameLine(crumb, facts[0]!)).toBe(true);
    const wrapped = facts.filter((fact) => !sameLine(fact, crumb));
    expect(wrapped.length).toBeGreaterThan(0);
    // Each line starts at the column's left edge (the title's text edge).
    for (const line of [[crumb, ...facts.filter((fact) => sameLine(fact, crumb))], wrapped]) {
      expect(Math.min(...line.map((word) => word.left))).toBeCloseTo(column.left, 0);
    }
    // Every separator a reader can see sits between two facts on its own line.
    const visibleDots = layout
      .textRects('·')
      .filter((dot) => dot.left < clip.right - 0.5 && dot.right > clip.left + 0.5);
    expect(visibleDots.length).toBe(FACTS.length - 1);
    for (const dot of visibleDots) {
      expect(
        words.some(
          (word) => sameLine(word, dot) && word.right <= dot.left + 0.5,
        ),
      ).toBe(true);
      expect(
        words.some(
          (word) => sameLine(word, dot) && word.left >= dot.right - 0.5,
        ),
      ).toBe(true);
    }
    // Two lines at most, inside the column.
    expect(clip.right).toBeLessThanOrEqual(column.right + 0.5);
  });

  it('keeps the crumb and every fact on one line when they fit', async () => {
    const layout = await measureLargeLine(640);
    const crumb = layout.textRects('assets')[0]!;
    for (const fact of FACTS)
      expect(sameLine(layout.textRects(fact)[0]!, crumb)).toBe(true);
    expect(
      layout
        .textRects('·')
        .filter((dot) => dot.left < layout.rect('header.subtitle').right - 0.5 && dot.right > layout.rect('header.subtitle').left + 0.5),
    ).toHaveLength(FACTS.length);
    // One line, starting at the column's left edge (the title's text edge).
    expect(crumb.left).toBeCloseTo(layout.rect('column').left, 0);
  });

  it('wraps the final fact\'s own trailing words with it, never floating them beside the facts', async () => {
    const { Text } = await import('@/components/ui/text/Text');
    const layout = await measureLargeLine(300, <Text>by Codex 3m ago</Text>);
    const clip = layout.rect('header.subtitle');
    const last = layout.textRects(FACTS[FACTS.length - 1]!)[0]!;
    const byline = layout.textRects('by Codex 3m ago')[0]!;
    // It reads after the last fact on that fact's line, inside the wrapped row.
    expect(sameLine(byline, last)).toBe(true);
    expect(byline.left).toBeGreaterThanOrEqual(last.right - 0.5);
    expect(byline.right).toBeLessThanOrEqual(clip.right + 0.5);
  });
  it('keeps a band line\'s trailing controls inside the column when large text makes them wider than its room', async () => {
    // A desktop step header's hold navigation (R171-2): at a large minimum font its words and buttons outgrow the band.
    const { PaneHeaderLineView } = await import('./PaneHeader');
    const { Text } = await import('@/components/ui/text/Text');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <View testID="column" style={{ width: 320 }}>
          <PaneHeaderLineView
            testID="header"
            line={{ segments: ['First review hold'] }}
            lineTrailing={
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 12 }}>
                <Text style={{ fontSize: 24 }}>1 of 2</Text>
                <Text numberOfLines={1} style={{ fontSize: 24, flexShrink: 1, minWidth: 0 }}>Next: Second review hold · Second</Text>
                <View testID="previous" style={{ width: 36, height: 26 }} />
                <View testID="next" style={{ width: 36, height: 26 }} />
              </View>
            }
          />
        </View>,
      );
    });
    const layout = await measureWebLayout(host, { viewport: { width: 400, height: 300 }, texts: ['1 of 2'] });
    const column = layout.rect('column');
    for (const id of ['previous', 'next']) expect(layout.rect(id).right).toBeLessThanOrEqual(column.right + 0.5);
  });
  it('keeps a glyph that leads the facts apart from the first fact', async () => {
    // A phone pane's live line led by a machine glyph ("Previews from MacBook Pro"): the glyph and its
    // first fact read as one item, but never touch.
    const { PaneHeaderLineView } = await import('./PaneHeader');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <View testID="column" style={{ width: 360 }}>
          <PaneHeaderLineView
            large
            testID="header"
            line={{
              leading: <View testID="mark" style={{ width: 13, height: 13 }} />,
              segments: ['Previews from MacBook Pro'],
            }}
          />
        </View>,
      );
    });
    const layout = await measureWebLayout(host, {
      viewport: { width: 400, height: 300 },
      texts: ['Previews from MacBook Pro'],
    });
    const mark = layout.rect('mark');
    const fact = layout.textRects('Previews from MacBook Pro')[0]!;
    expect(sameLine(mark, fact)).toBe(true);
    expect(fact.left - mark.right).toBeGreaterThanOrEqual(4);
    expect(fact.left - mark.right).toBeLessThanOrEqual(8);
  });
  it.each([false, true])('keeps whole lines of facts when the browser enlarges text (large header: %s)', async (large) => {
    // A phone sheet header at Chrome's minimum font size 24 (DARK-1109-L1, row 32): the clip follows
    // the line the browser lays out, so its facts are never cut through the middle of a line.
    installWebLayoutBridge();
    const { PaneHeaderLineView } = await import('./PaneHeader');
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <View testID="column" style={{ width: 360 }}>
          <PaneHeaderLineView large={large} testID="header" line={{ segments: FACTS }} />
        </View>,
      );
    });
    const layout = await measureWebLayout(host, {
      viewport: { width: 400, height: 300 },
      texts: [...FACTS],
      minimumFontSize: 24,
      settle: (replay) => act(replay),
    });
    const clip = layout.rect('header.subtitle');
    const first = layout.textRects(FACTS[0])[0]!;
    expect(first.fontSize).toBeGreaterThanOrEqual(24);
    expect(first.height, 'the fact keeps a line taller than its glyphs').toBeGreaterThanOrEqual(24);
    expect(clip.height, 'the clip holds the fact\'s whole line').toBeGreaterThanOrEqual(first.height - 0.5);
    const lines = clip.height / first.height;
    expect(Math.abs(lines - Math.round(lines)), 'the clip ends between lines, never through one').toBeLessThan(0.05);
  });
});
