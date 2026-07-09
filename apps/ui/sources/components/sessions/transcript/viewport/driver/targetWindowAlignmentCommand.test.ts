import { describe, expect, it } from 'vitest';

import { resolveTargetWindowAlignmentCommand } from './targetWindowAlignmentCommand';

describe('target window alignment command', () => {
    it('aligns user-turn jumps near the top and pinned/far jumps at center', () => {
        expect(resolveTargetWindowAlignmentCommand({ anchorKind: 'user-turn' })).toEqual({
            kind: 'top-with-item-offset',
            itemOffsetPx: 24,
        });
        expect(resolveTargetWindowAlignmentCommand({ anchorKind: 'pinned-assistant' })).toEqual({
            kind: 'center',
        });
        expect(resolveTargetWindowAlignmentCommand({ anchorKind: 'deep-link-target' })).toEqual({
            kind: 'center',
        });
    });

    it('lets an explicit request override the anchor-kind default through the command path', () => {
        expect(resolveTargetWindowAlignmentCommand({
            anchorKind: 'user-turn',
            requestedAlign: 'center',
        })).toEqual({ kind: 'center' });
        expect(resolveTargetWindowAlignmentCommand({
            anchorKind: 'pinned-tool',
            requestedAlign: 'top',
        })).toEqual({
            kind: 'top-with-item-offset',
            itemOffsetPx: 24,
        });
    });
});
