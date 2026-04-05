import { describe, expect, it } from 'vitest';

import type { SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';

describe('resolveSessionListHeaderViewState', () => {
    it('uses the project header view model when one exists for the group', () => {
        const item = {
            type: 'header',
            title: '/repo',
            headerKind: 'project',
            groupKey: 'server:server_a:active:project:abc',
            workspaceKey: 'legacy-key',
            workspaceScopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        } as const;
        const viewModel: SessionListProjectHeaderViewModel = {
            collapseKey: 'server:server_a:active:project:abc',
            displayTitle: 'Renamed workspace',
            hasCustomLabel: true,
            workspaceRefId: 'workspace_ref_1',
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
        };

        expect(resolveSessionListHeaderViewState({
            item,
            collapsedKeys: { [viewModel.collapseKey]: true },
            projectHeaderViewModelByGroupKey: new Map([[viewModel.collapseKey, viewModel]]),
            translateServerHeader: (server) => `Server ${server}`,
        })).toEqual({
            kind: 'project',
            collapseKey: 'server:server_a:active:project:abc',
            collapsed: true,
            displayTitle: 'Renamed workspace',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            workspaceRefId: 'workspace_ref_1',
        });
    });

    it('falls back to a translated section header title and generated collapse key for non-project headers', () => {
        const item = {
            type: 'header',
            title: 'Server A',
            headerKind: 'server',
            groupKey: '',
            serverId: 'server_a',
        } as const;

        expect(resolveSessionListHeaderViewState({
            item,
            collapsedKeys: { 'server:server_a': true },
            projectHeaderViewModelByGroupKey: new Map(),
            translateServerHeader: (server) => `Server ${server}`,
        })).toEqual({
            kind: 'section',
            collapseKey: 'server:server_a',
            collapsed: true,
            title: 'Server Server A',
        });
    });

    it('returns null when a non-project header has no title', () => {
        expect(resolveSessionListHeaderViewState({
            item: {
                type: 'header',
                title: '',
                headerKind: 'date',
                groupKey: 'server:server_a:day:2026-02-17',
            } as const,
            collapsedKeys: {},
            projectHeaderViewModelByGroupKey: new Map(),
            translateServerHeader: (server) => server,
        })).toBeNull();
    });
});
