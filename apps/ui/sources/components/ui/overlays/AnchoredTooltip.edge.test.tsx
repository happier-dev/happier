import * as React from 'react';
import { StyleSheet } from 'react-native';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
  const { createReactNativeWebMock } =
    await import('@/dev/testkit/mocks/reactNative');
  return createReactNativeWebMock();
});

const { AnchoredTooltipBubble } = await import('./AnchoredTooltip');

// Owner 2026-11-11 (OWNER-1334-ROWS/04, the 'Look' tooltip): a full hairline boxes a label this small. Every tooltip
// keeps only the corner light the rim catches at its top left.
describe('tooltip edge', () => {
  it('draws no full hairline around the bubble, only the top-left light', async () => {
    const screen = await renderScreen(
      <AnchoredTooltipBubble label="Look" testID="tooltip" />,
    );
    const strokes = screen
      .findAll(
        (node) =>
          String(node.type) === 'Rect' && typeof node.props.stroke === 'string',
      )
      .map((node) => node.props.stroke as string);
    // The light is a gradient stroke anchored top left; a plain colour stroke is the full hairline.
    expect(strokes.some((stroke) => stroke.startsWith('url('))).toBe(true);
    expect(strokes.filter((stroke) => !stroke.startsWith('url('))).toEqual([]);
    const bubble = screen.findAll((node) => node.props.testID === 'tooltip');
    expect(bubble.length).toBeGreaterThan(0);
    for (const node of bubble) expect(Number(StyleSheet.flatten(node.props.style)?.borderWidth ?? 0)).toBe(0);
  });
});
