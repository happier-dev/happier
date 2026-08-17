import { describe, expect, it } from 'vitest';

import { resolveFilesystemBrowserToolbarState } from './filesystemBrowserToolbarState';

describe('resolveFilesystemBrowserToolbarState', () => {
    it('keeps higher-priority toolbar actions visible and orders overflow by action order', () => {
        const result = resolveFilesystemBrowserToolbarState({
            toolbarWidth: 320,
            actions: [
                {
                    id: 'refresh',
                    priority: 0,
                    order: 2,
                    icon: null,
                    menuIcon: 'arrow-clockwise',
                    accessibilityLabel: 'Refresh',
                    onPress: () => {},
                },
                {
                    id: 'filter',
                    priority: 1,
                    order: 0,
                    icon: null,
                    menuIcon: 'funnel-simple',
                    accessibilityLabel: 'Filter',
                    onPress: () => {},
                },
                {
                    id: 'create-folder',
                    priority: 0,
                    order: 1,
                    icon: null,
                    menuIcon: 'folder',
                    accessibilityLabel: 'Create folder',
                    onPress: () => {},
                },
            ],
        });

        expect(result.visibleActions.map((action) => action.id)).toEqual(['filter']);
        expect(result.hiddenActions.map((action) => action.id)).toEqual(['create-folder', 'refresh']);
    });
});
