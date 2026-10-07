import { describe, expect, it } from 'vitest';

import {
  HAPPIER_RAISED_EDGE_SIDE,
  happierRaisedEdgeStyle,
  resolveHappierGloss,
  resolveHappierRaisedEdge,
  settleHappierRaisedEdge,
} from './raisedEdge.js';

const LIFT = { boxShadow: '0 1px 2px rgba(0, 0, 0, 0.05)' } as const;

describe('raised edge recipe', () => {
  it('lights the top border on dark and lips the bottom border on light, with its lift', () => {
    expect(happierRaisedEdgeStyle(resolveHappierRaisedEdge({ colorScheme: 'dark', color: 'edge-dark', lift: LIFT })))
      .toEqual({ ...LIFT, borderTopColor: 'edge-dark' });
    expect(happierRaisedEdgeStyle(resolveHappierRaisedEdge({ colorScheme: 'light', color: 'edge-light', lift: LIFT })))
      .toEqual({ ...LIFT, borderBottomColor: 'edge-light' });
    expect(HAPPIER_RAISED_EDGE_SIDE).toEqual({ light: 'bottom', dark: 'top' });
  });

  it('sits flat (no edge, no lift) while pressed, disabled, focused or invalid, and stands at rest or hover', () => {
    for (const state of [{ pressed: true }, { disabled: true }, { focused: true }, { invalid: true }]) {
      expect(resolveHappierRaisedEdge({ colorScheme: 'dark', color: 'edge', lift: LIFT, state })).toBeNull();
      expect(happierRaisedEdgeStyle(settleHappierRaisedEdge({ side: 'top', color: 'edge', lift: LIFT }, state))).toBeNull();
    }
    expect(resolveHappierRaisedEdge({ colorScheme: 'dark', color: 'edge', state: { pressed: false, focused: false } }))
      .toEqual({ side: 'top', color: 'edge' });
  });

  it('puts a filled accent control\'s gloss on its top edge in both schemes and drops it under the finger', () => {
    expect(happierRaisedEdgeStyle(resolveHappierGloss({ color: 'gloss' }))).toEqual({ borderTopColor: 'gloss' });
    expect(resolveHappierGloss({ color: 'gloss', state: { pressed: true } })).toBeNull();
  });
});
