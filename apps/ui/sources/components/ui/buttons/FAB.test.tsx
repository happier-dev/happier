import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { SessionCockpitBottomChromeHeightContext } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';

const { FAB } = await import('./FAB');

function styleBottom(style: unknown): number | undefined {
  return [style]
    .flat(Infinity)
    .map((entry: unknown) => (entry && typeof entry === 'object' ? (entry as { bottom?: unknown }).bottom : undefined))
    .find((value: unknown): value is number => typeof value === 'number');
}

function fabBottom(screen: Awaited<ReturnType<typeof renderScreen>>): number {
  const frame = screen.root.findAll((node) => node.type === 'View' && styleBottom(node.props?.style) !== undefined)[0];
  if (!frame) throw new Error('FAB has no bottom offset');
  return styleBottom(frame.props.style)!;
}

describe('FAB', () => {
  it('rises above the floating phone tab bar, whose primary action sits in the same corner', async () => {
    // The bar publishes its measured height; a page action that ignored it was drawn under the bar's "+" at 390.
    const screen = await renderScreen(
      <SessionCockpitBottomChromeHeightContext.Provider value={84}>
        <FAB onPress={() => {}} accessibilityLabel="New document" />
      </SessionCockpitBottomChromeHeightContext.Provider>,
    );
    expect(fabBottom(screen)).toBeGreaterThanOrEqual(84 + 16);
  });

  it('keeps its corner inset when no bar floats over the page', async () => {
    const screen = await renderScreen(
      <FAB onPress={() => {}} accessibilityLabel="New document" />,
    );
    expect(fabBottom(screen)).toBeLessThan(84);
  });
});
