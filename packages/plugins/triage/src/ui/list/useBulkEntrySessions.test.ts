import { describe, expect, it } from 'vitest';

import { resolveTriageBulkSeedPlacementV1 } from './useBulkEntrySessions.js';

const REPOSITORY = Object.freeze({
    kind: 'github' as const,
    deployment: 'https://example.test',
    repository: 'example/repository',
});

function candidate(input: Readonly<{
    projectId: string;
    machineId: string;
    rootPath: string;
}>) {
    return {
        projectKey: { id: input.projectId },
        serverId: 'server-a',
        machineId: input.machineId,
        rootPath: input.rootPath,
        label: input.projectId,
        forge: REPOSITORY,
        reachable: true,
        worktrees: [],
    };
}

describe('bulk New Session placement seeding', () => {
    it('keeps common ambiguous candidates for the reader instead of dropping the placement question', () => {
        const result = resolveTriageBulkSeedPlacementV1({
            workspaceMode: 'repository',
            entries: [{ repository: REPOSITORY }, { repository: REPOSITORY }],
            projects: [
                candidate({ projectId: 'workspace-api', machineId: 'machine-a', rootPath: '/checkouts/api' }),
                candidate({ projectId: 'workspace-web', machineId: 'machine-b', rootPath: '/checkouts/web' }),
            ],
            registryComplete: true,
        });

        expect(result).toEqual({
            kind: 'candidates',
            candidates: [
                expect.objectContaining({
                    projectKey: { id: 'workspace-api' },
                    serverId: 'server-a',
                    machineId: 'machine-a',
                    rootPath: '/checkouts/api',
                }),
                expect.objectContaining({
                    projectKey: { id: 'workspace-web' },
                    serverId: 'server-a',
                    machineId: 'machine-b',
                    rootPath: '/checkouts/web',
                }),
            ],
        });
    });

    it('does not offer a candidate that only matches part of a bulk selection', () => {
        const otherRepository = {
            kind: 'github' as const,
            deployment: 'https://example.test',
            repository: 'example/other-repository',
        };
        const result = resolveTriageBulkSeedPlacementV1({
            workspaceMode: 'repository',
            entries: [{ repository: REPOSITORY }, { repository: otherRepository }],
            projects: [
                candidate({ projectId: 'workspace-api', machineId: 'machine-a', rootPath: '/checkouts/api' }),
                {
                    ...candidate({ projectId: 'workspace-other', machineId: 'machine-b', rootPath: '/checkouts/other' }),
                    forge: otherRepository,
                },
            ],
            registryComplete: true,
        });

        expect(result).toEqual({ kind: 'none' });
    });
});
