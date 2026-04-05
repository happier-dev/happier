import { describe, expect, it } from 'vitest';

import { buildSessionListProjectHeaderViewModels } from './sessionListProjectHeaderViewModels';

describe('buildSessionListProjectHeaderViewModels', () => {
    it('indexes project header display state and legacy scope hints from canonical workspace refs', () => {
        const scopeHint = {
            serverId: 'server_a',
            machineId: 'machine_a',
            rootPath: '/repo',
        };

        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    workspaceScopeHint: scopeHint,
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [
                {
                    id: 'wr_1',
                    serverId: 'server_a',
                    machineId: 'machine_a',
                    rootPath: '/repo',
                    label: 'Important Repo',
                    createdAtMs: 1,
                    lastOpenedAtMs: null,
                },
            ],
            workspaceLabels: {},
        });

        expect(result.scopeHintByLegacyWorkspaceKey.get('legacy_repo')).toEqual(scopeHint);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Important Repo',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint,
            workspaceRefId: 'wr_1',
        });
    });

    it('falls back to legacy labels when no canonical workspace scope hint exists', () => {
        const result = buildSessionListProjectHeaderViewModels({
            listItems: [
                {
                    type: 'header',
                    title: '/repo',
                    headerKind: 'project',
                    groupKey: 'project:repo',
                    workspaceKey: 'legacy_repo',
                    serverId: 'server_a',
                    serverName: 'Server A',
                },
            ] as any,
            workspaceRefs: [],
            workspaceLabels: {
                legacy_repo: 'Legacy Label',
            },
        });

        expect(result.scopeHintByLegacyWorkspaceKey.size).toBe(0);
        expect(result.projectHeaderViewModelByGroupKey.get('project:repo')).toMatchObject({
            collapseKey: 'project:repo',
            displayTitle: 'Legacy Label',
            hasCustomLabel: true,
            legacyWorkspaceKey: 'legacy_repo',
            scopeHint: null,
            workspaceRefId: null,
        });
    });
});
