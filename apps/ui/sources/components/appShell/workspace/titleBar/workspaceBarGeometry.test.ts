import { describe, expect, it } from 'vitest';

import * as geometry from './workspaceBarGeometry';

describe('measured title-strip reservation', () => {
    it('clips pane spans between leading controls and the trailing accessory across origin and width changes', () => {
        expect(geometry.resolveWorkspaceBarSegmentFrame({
            frame: { x: 156, width: 804 }, originX: 100, leadingEndPx: 372, trailingStartPx: 850,
        })).toEqual({ paneLeft: 56, left: 372, width: 478 });
        expect(geometry.resolveWorkspaceBarSegmentFrame({
            frame: { x: 970, width: 560 }, originX: 100, leadingEndPx: 0, trailingStartPx: 1200,
        })).toEqual({ paneLeft: 870, left: 870, width: 330 });
        expect(geometry.resolveWorkspaceBarSegmentFrame({
            frame: { x: 970, width: 560 }, originX: 100, leadingEndPx: 0, trailingStartPx: 850,
        })).toBeNull();
    });
});
