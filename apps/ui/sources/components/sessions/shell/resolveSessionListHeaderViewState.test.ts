import { describe, expect, it } from 'vitest';

import { buildSessionListProjectHeaderViewModels, type SessionListProjectHeaderViewModel } from './sessionListProjectHeaderViewModels';
import { resolveSessionListHeaderViewState } from './resolveSessionListHeaderViewState';

describe('resolveSessionListHeaderViewState', () => {
    it('preserves an admitted Project model with no baseline instead of restoring the raw checkout hint', () => {
        const item = {
            type: 'header', title: '/private/lead', headerKind: 'project',
            groupKey: JSON.stringify(['project', 'no-baseline-home', 'accepted']),
            projectKey: { serverId: 'no-baseline-home', projectKey: 'accepted' },
            workspaceScopeHint: { serverId: 'no-baseline-home', machineId: 'lead-machine', rootPath: '/private/lead' },
        } as const;
        const model = buildSessionListProjectHeaderViewModels({ listItems: [item], workspaceRefs: [] });
        expect(model.projectHeaderViewModelByGroupKey.get(item.groupKey)?.scopeHint).toBeNull();
        const state = resolveSessionListHeaderViewState({ item, collapsedKeys: {},
            projectHeaderViewModelByGroupKey: model.projectHeaderViewModelByGroupKey,
            translateServerHeader: server => server });
        expect(state?.kind === 'project' ? state.scopeHint : undefined).toBeNull();
        expect(state?.kind === 'project' ? state.newSessionTarget : undefined).toBeNull();
    });

    it('reuses the same header view state object for identical project inputs', () => {
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
            seedSessionId: null,
        };
        const input = {
            item,
            collapsedKeys: { [viewModel.collapseKey]: true },
            projectHeaderViewModelByGroupKey: new Map([[viewModel.collapseKey, viewModel]]),
            translateServerHeader: (server: string) => `Server ${server}`,
        } as const;

        const first = resolveSessionListHeaderViewState(input);
        const second = resolveSessionListHeaderViewState(input);

        expect(first).toBe(second);
        expect(first).toEqual({
            kind: 'project',
            collapseKey: 'server:server_a:active:project:abc',
            collapsed: true,
            displayTitle: 'Renamed workspace',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy-key',
            scopeHint: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            newSessionTarget: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            seedSessionId: null,
            workspaceRefId: 'workspace_ref_1',
        });
    });

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
            seedSessionId: null,
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
            newSessionTarget: { serverId: 'server_a', machineId: 'machine_a', rootPath: '/repo' },
            seedSessionId: null,
            workspaceRefId: 'workspace_ref_1',
        });
    });

    it('returns the same section header view state shape for identical section inputs', () => {
        const item = {
            type: 'header',
            title: 'Server A',
            headerKind: 'server',
            groupKey: '',
            serverId: 'server_a',
        } as const;
        const input = {
            item,
            collapsedKeys: { 'server:server_a': true },
            projectHeaderViewModelByGroupKey: new Map(),
            translateServerHeader: (server: string) => `Server ${server}`,
        } as const;

        const first = resolveSessionListHeaderViewState(input);
        const second = resolveSessionListHeaderViewState(input);

        expect(first).toEqual({
            kind: 'section',
            collapseKey: 'server:server_a',
            collapsed: true,
            title: 'Server Server A',
        });
        expect(second).toEqual(first);
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

    it('starts a Chats group\'s new session as a no-folder session on its machine', () => {
        const state = resolveSessionListHeaderViewState({
            item: {
                type: 'header',
                title: 'Chats',
                headerKind: 'project',
                groupKey: 'chats-m1',
                workspaceScopeHint: null,
                workspace: { t: 'managedSessions', serverId: 'server_a', machineId: 'machine_a' },
            },
            collapsedKeys: {},
            projectHeaderViewModelByGroupKey: new Map(),
            translateServerHeader: (server: string) => server,
        });
        expect(state?.kind === 'project' ? state.newSessionTarget : undefined)
            .toEqual({ kind: 'managed', serverId: 'server_a', machineId: 'machine_a' });
        expect(state?.kind === 'project' ? state.scopeHint : undefined).toBeNull();
    });
});
