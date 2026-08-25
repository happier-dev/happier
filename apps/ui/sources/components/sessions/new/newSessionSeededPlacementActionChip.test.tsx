import { describe, expect, it, vi } from 'vitest';

import { createNewSessionSeededPlacementActionChip } from './newSessionSeededPlacementActionChip';

describe('createNewSessionSeededPlacementActionChip', () => {
    it('keeps an ambiguous candidate as a reader choice instead of selecting the first one', () => {
        const onSelect = vi.fn();
        const candidates = [{
            projectKey: { id: 'project-api' },
            serverId: 'server-a',
            machineId: 'machine-a',
            rootPath: '/worktrees/api',
            label: 'API',
            reachable: true,
            worktrees: [],
        }, {
            projectKey: { id: 'project-web' },
            serverId: 'server-b',
            machineId: 'machine-b',
            rootPath: '/worktrees/web',
            reachable: true,
            worktrees: [],
        }];

        const chip = createNewSessionSeededPlacementActionChip({ candidates, onSelect });
        expect(chip?.collapsedOptionsPopover).toMatchObject({ presentation: 'list' });
        const popover = chip?.collapsedOptionsPopover;
        if (!popover || popover.presentation !== 'list') throw new Error('expected placement list');
        const section = popover.rootStep.sections[0];
        if (!section || section.kind !== 'static') throw new Error('expected placement options');

        expect(section.options).toHaveLength(2);
        expect(onSelect).not.toHaveBeenCalled();
        section.options[1]?.onSelect?.();
        expect(onSelect).toHaveBeenCalledWith(candidates[1]);
    });
});
