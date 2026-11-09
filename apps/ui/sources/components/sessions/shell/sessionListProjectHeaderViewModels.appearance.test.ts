import { describe, expect, it } from 'vitest';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';

describe('Project header appearance', () => {
    it('does not apply an unqualified colour map to headers from several Homes', () => {
        const listItems: SessionListIndexItem[] = ['home-a', 'home-b'].map(serverId => ({
            type: 'header', headerKind: 'project', groupKey: `unqualified-colour-${serverId}`,
            title: 'Project', workspaceKey: 'wl_12345678', serverId,
            workspaceScopeHint: { serverId, machineId: 'machine', rootPath: '/repo' },
        }));
        const input = { listItems, workspaceRefs: [], workspaceRefsServerId: 'home-a',
            workspaceColors: { wl_12345678: { kind: 'accent', key: 'blue' } as const } };
        const state = buildSessionListProjectHeaderViewModels(input);
        for (const serverId of ['home-a', 'home-b']) {
            expect(state.projectHeaderViewModelByGroupKey.get(`unqualified-colour-${serverId}`)?.appearanceColor).toBeNull();
        }
    });

    it('never inherits another Home colour when predecessor workspace hashes collide', () => {
        const listItems: SessionListIndexItem[] = ['home-a', 'home-b'].map(serverId => ({ type: 'header', headerKind: 'project',
            groupKey: `colour-scope-${serverId}`, title: 'Folder', workspaceKey: 'wl_12345678', serverId,
            workspaceScopeHint: { serverId, machineId: 'same-machine', rootPath: '/same' } }));
        const color = { kind: 'custom', hex: '#123456' } as const;
        const state = buildSessionListProjectHeaderViewModels({ listItems, workspaceRefs: [],
            workspaceColorsByServerId: { 'home-a': { wl_12345678: color } } });
        expect(state.projectHeaderViewModelByGroupKey.get('colour-scope-home-a')).toMatchObject({ serverId: 'home-a', appearanceColor: color });
        expect(state.projectHeaderViewModelByGroupKey.get('colour-scope-home-b')).toMatchObject({ serverId: 'home-b', appearanceColor: null });
    });

    it('updates only the addressed header colour and clears it without changing Project names', () => {
        const listItems: SessionListIndexItem[] = ['a', 'b'].map(id => ({ type: 'header', headerKind: 'project',
            groupKey: `colour-${id}`, title: `Project ${id}`, workspaceKey: `workspace-${id}`,
            workspaceScopeHint: { serverId: 'header-color-home', machineId: id, rootPath: `/${id}` } }));
        const input = { listItems, workspaceRefs: [] };
        const before = buildSessionListProjectHeaderViewModels(input);
        const color = { kind: 'custom', hex: '#123456' } as const;
        const changed = buildSessionListProjectHeaderViewModels({ ...input, workspaceColorsByServerId: { 'header-color-home': { 'workspace-a': color } } });
        expect(changed.projectHeaderViewModelByGroupKey.get('colour-a')).toMatchObject({ appearanceColor: color,
            displayTitle: before.projectHeaderViewModelByGroupKey.get('colour-a')!.displayTitle });
        expect(changed.projectHeaderViewModelByGroupKey.get('colour-b')).toBe(before.projectHeaderViewModelByGroupKey.get('colour-b'));
        const repeated = buildSessionListProjectHeaderViewModels({ ...input, workspaceColorsByServerId: { 'header-color-home': { 'workspace-a': { ...color } } } });
        expect(repeated).toBe(changed);
        const reset = buildSessionListProjectHeaderViewModels(input);
        expect(reset.projectHeaderViewModelByGroupKey.get('colour-a')).toHaveProperty('appearanceColor', null);
    });
});
