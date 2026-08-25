import { describe, expect, it } from 'vitest';

import { browserViewContextId, browserViewKey } from './key.js';
import { BrowserViewV1Schema } from './v1.js';

const NUL = '\u0000';

/**
 * SB-D. The collision case is reachable through the schema, not hypothetical: `browserSessionId`
 * and `viewId` are `z.string().trim().min(1).max(256)`, so a space, a colon and a NUL are all legal
 * inside a component. Every pre-consolidation builder concatenated with a single separator, so each
 * tuple pair below produced one key — one automation controller entry, one diagnostics bucket, for
 * two different views.
 */
describe('browserViewKey', () => {
  it('accepts ids that contain each separator the pre-consolidation builders used', () => {
    for (const id of ['a b', 'a:b', `a${NUL}b`]) {
      expect(BrowserViewV1Schema.shape.viewId.safeParse(id).success).toBe(true);
    }
  });

  it('never collides across distinct (browserSessionId, viewId) tuples', () => {
    const separatorCollisionPairs = [
      // space-separated builders (daemon automation service + owners registry)
      [{ browserSessionId: 'a b', viewId: 'c' }, { browserSessionId: 'a', viewId: 'b c' }],
      // colon-separated builders (UI automation control service, runtime registries)
      [{ browserSessionId: 'a:b', viewId: 'c' }, { browserSessionId: 'a', viewId: 'b:c' }],
      // NUL-separated builders (both diagnostics stores, sidecar control adapter, ring buffer)
      [
        { browserSessionId: `a${NUL}b`, viewId: 'c' },
        { browserSessionId: 'a', viewId: `b${NUL}c` },
      ],
    ] as const;

    for (const [left, right] of separatorCollisionPairs) {
      expect(browserViewKey(left)).not.toBe(browserViewKey(right));
    }
  });

  it('is stable for the same tuple and distinguishes the scoped variants', () => {
    const view = { browserSessionId: 'session_1', viewId: 'view_1' };
    expect(browserViewKey(view)).toBe(browserViewKey({ ...view }));
    expect(browserViewKey(view, 'machine_1')).not.toBe(browserViewKey(view));
    expect(browserViewKey(view, 'machine_1', 3)).not.toBe(browserViewKey(view, 'machine_1', 4));
    // A scope part cannot be absorbed into an adjacent component either.
    expect(browserViewKey({ browserSessionId: 'a', viewId: 'b' }, 'c'))
      .not.toBe(browserViewKey({ browserSessionId: 'a', viewId: 'b c' }));
  });

    /**
     * F2. The daemon-derived context id is the primary map key of the browser context store
     * (`itemsByContextId`). Both builders that composed it joined the three components with a plain
     * space, so the two tuples below keyed the same entry: one capture silently overwrote the
     * other's context item, and clearing one removed the wrong one.
     */
    it('never collides across distinct (browserSessionId, viewId, navigationGeneration) tuples', () => {
        const compositeCollisionPairs = [
            // The exact space-joined shape both context-id builders used.
            [
                { browserSessionId: 'a b', viewId: 'c', navigationGeneration: 1 },
                { browserSessionId: 'a', viewId: 'b c', navigationGeneration: 1 },
            ],
            // The generation must not be absorbable into the adjacent component either.
            [
                { browserSessionId: 's', viewId: 'v 1', navigationGeneration: 2 },
                { browserSessionId: 's', viewId: 'v', navigationGeneration: 12 },
            ],
        ] as const;

        for (const [left, right] of compositeCollisionPairs) {
            expect(browserViewContextId(left)).not.toBe(browserViewContextId(right));
        }
    });

    it('scopes the context id by navigation generation and agrees with the view key', () => {
        const view = { browserSessionId: 'session_1', viewId: 'view_1' };
        expect(browserViewContextId({ ...view, navigationGeneration: 1 }))
            .not.toBe(browserViewContextId({ ...view, navigationGeneration: 2 }));
        expect(browserViewContextId({ ...view, navigationGeneration: 3 }))
            .toBe(browserViewKey(view, 3));
    });
});
