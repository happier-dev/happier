import { describe, expect, it } from 'vitest';

import { resolveDetailsTabOpenAs } from './resolveDetailsTabOpenAs';

describe('resolveDetailsTabOpenAs', () => {
    it('returns pinned when details pane tabs are persistent', () => {
        const res = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: 'persistent',
            intent: 'default',
            platform: 'web',
            nowMs: 1000,
            tabKey: 'file:README.md',
            existingTab: null,
            lastPreviewOpen: null,
        });
        expect(res.openAs).toBe('pinned');
    });

    it('pins an existing preview tab when opened twice quickly on web', () => {
        const first = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: 'preview',
            intent: 'default',
            platform: 'web',
            nowMs: 1000,
            tabKey: 'file:README.md',
            existingTab: null,
            lastPreviewOpen: null,
        });
        expect(first.openAs).toBe('preview');

        const second = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: 'preview',
            intent: 'default',
            platform: 'web',
            nowMs: 1200,
            tabKey: 'file:README.md',
            existingTab: { isPreview: true, isPinned: false },
            lastPreviewOpen: first.nextLastPreviewOpen,
        });
        expect(second.openAs).toBe('pinned');
    });

    it('does not pin when the second open is outside the threshold', () => {
        const first = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: 'preview',
            intent: 'default',
            platform: 'web',
            nowMs: 1000,
            tabKey: 'file:README.md',
            existingTab: null,
            lastPreviewOpen: null,
        });

        const second = resolveDetailsTabOpenAs({
            detailsPaneTabsBehavior: 'preview',
            intent: 'default',
            platform: 'web',
            nowMs: 2000,
            tabKey: 'file:README.md',
            existingTab: { isPreview: true, isPinned: false },
            lastPreviewOpen: first.nextLastPreviewOpen,
        });
        expect(second.openAs).toBe('preview');
    });
});
