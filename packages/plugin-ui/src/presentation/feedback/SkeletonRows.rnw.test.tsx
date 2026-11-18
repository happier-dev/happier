import { describe, expect, it } from 'vitest';
import { SURFACE_CONTEXT_THEME_FIXTURE } from '@happier-dev/plugin-sdk/testing';

import type { ComponentProps, ComponentType } from 'react';

import { HappierUiPlatformProvider } from '../../environment/context.js';
import { mountThroughReactNativeWeb } from '../../rnwMount.testSupport.js';
import { HappierSkeletonBlock, HappierSkeletonRows } from './Skeleton.js';

const theme = SURFACE_CONTEXT_THEME_FIXTURE;

function cssColor(value: string): string {
  const probe = document.createElement('span');
  probe.style.color = value;
  return probe.style.color;
}

function rowsOf(container: HTMLElement): HTMLElement[] {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="rows:skeleton-row"]',
    ),
  ];
}

/** The pulsing bars inside one row: every leaf view with a fill. */
function barsOf(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>('div')].filter(
    (node) => node.children.length === 0 && node.style.backgroundColor !== '',
  );
}

/** The host root's private presentation projection (the app passes whether anyone can see the window). */
const HostPlatformProvider = HappierUiPlatformProvider as ComponentType<
  ComponentProps<typeof HappierUiPlatformProvider> & Readonly<{ presentationActive: boolean }>
>;

describe('HappierSkeletonBlock motion', () => {
  it('pulses only while the host presents it: a hidden window holds the bar still', () => {
    const render = (presentationActive: boolean) => (
      <HostPlatformProvider platform={{ platform: 'web', colorScheme: 'light' }} presentationActive={presentationActive}>
        <HappierSkeletonBlock testID="bar" color="#102030" width={40} height={8} />
      </HostPlatformProvider>
    );
    const bar = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-testid="bar"]')!;
    const visible = mountThroughReactNativeWeb(render(true));
    expect(bar(visible.container).style.animationName).toBe('happierSkeletonPulse');
    visible.unmount();
    const hidden = mountThroughReactNativeWeb(render(false));
    expect(bar(hidden.container).style.animationName).toBe('');
    hidden.unmount();
  });
});

describe('HappierSkeletonRows (the one loading-rows owner)', () => {
  it('stands each row in the host row geometry: its height, its hairline, its glyph column and ink', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierSkeletonRows
        testID="rows"
        rows={3}
        theme={theme}
        color="#102030"
        rowHeight={36}
        lines={1}
        dividerColor="#405060"
        geometry={{ insetStart: 22, insetEnd: 22, glyphColumn: 20, gap: 10 }}
      />,
    );
    const rows = rowsOf(mount.container);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.style.height).toBe('36px');
      expect(row.style.paddingLeft).toBe('22px');
      expect(row.style.borderBottomColor).toBe(cssColor('#405060'));
      // One line: the glyph and the title bar, no meta bar.
      const bars = barsOf(row);
      expect(bars).toHaveLength(2);
      for (const bar of bars)
        expect(bar.style.backgroundColor).toBe(cssColor('#102030'));
    }
    mount.unmount();
  });

  it('adds the meta bar for two-line rows and keeps a default row height from the theme roles', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierSkeletonRows testID="rows" rows={2} theme={theme} />,
    );
    const rows = rowsOf(mount.container);
    expect(rows).toHaveLength(2);
    expect(barsOf(rows[0]!)).toHaveLength(3);
    const expected =
      theme.typography.label.lineHeight +
      theme.typography.body.lineHeight +
      2 * theme.spacing.small +
      theme.spacing.xsmall;
    expect(rows[0]!.style.height).toBe(`${expected}px`);
    mount.unmount();
  });

  it('draws in the theme text ink at the quiet skeleton strength when no host ink is given (hosted-web frames)', () => {
    const text = theme.colors.text;
    const mount = mountThroughReactNativeWeb(
      <HappierSkeletonRows testID="rows" rows={1} theme={theme} lines={1} />,
    );
    const [bar] = barsOf(rowsOf(mount.container)[0]!);
    const channels = [1, 3, 5].map((index) => parseInt(text.slice(index, index + 2), 16));
    expect(bar!.style.backgroundColor).toBe(cssColor(`rgba(${channels.join(', ')}, 0.16)`));
    mount.unmount();
  });
  it('holds a row shape given by the host: line boxes, a padded row box, hairlines between rows, a glyph size and the row index', () => {
    const mount = mountThroughReactNativeWeb(
      <HappierSkeletonRows
        testID="rows"
        rows={2}
        firstIndex={3}
        theme={theme}
        color="#102030"
        rowBox={{ minHeight: 36, paddingVertical: 5 }}
        lineHeights={[20, 16]}
        dividerColor="#405060"
        dividerPlacement="between"
        geometry={{ insetStart: 50, insetEnd: 22, glyphColumn: 14, glyphSize: 14, gap: 10 }}
        rowTestID={(index) => `row:${index}`}
      />,
    );
    const first = mount.container.querySelector<HTMLElement>('[data-testid="row:3"]')!;
    const second = mount.container.querySelector<HTMLElement>('[data-testid="row:4"]')!;
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    // A padded box, not a fixed height: the line boxes and padding give the loaded row's height.
    expect(first.style.height).toBe('');
    expect(first.style.minHeight).toBe('36px');
    expect(first.style.paddingTop).toBe('5px');
    // Hairlines only between rows.
    expect(first.style.borderTopWidth).toBe('');
    expect(second.style.borderTopColor).toBe(cssColor('#405060'));
    // Each bar stands in its line's own box.
    const boxes = [...first.querySelectorAll<HTMLElement>('div')].filter((node) => node.style.height === '20px' || node.style.height === '16px');
    expect(boxes.map((node) => node.style.height)).toEqual(['20px', '16px']);
    // The glyph square takes the host's mark size.
    const glyph = barsOf(first)[0]!;
    expect(glyph.style.width).toBe('14px');
    // The row index continues the width cycle (a per-row virtualized host).
    expect(barsOf(first)[1]!.style.width).not.toBe(barsOf(second)[1]!.style.width);
    mount.unmount();
  });
});

