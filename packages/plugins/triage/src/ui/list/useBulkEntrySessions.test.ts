import { describe, expect, it } from 'vitest';

import {
    isTriageBulkSessionOutcomeRetryableV1,
    resolveTriageBulkSeedPlacementV1,
} from './useBulkEntrySessions.js';

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

describe('bulk retry custody', () => {
    it('retries an uncertain creation under its retained key but not a terminal creation failure', () => {
        const entryOutcome = {
            entryRef: {
                source: { pluginId: 'happier.test', localId: 'entries' },
                kindId: 'issue',
                collisionScope: 'example',
                entryId: '17',
            },
            session: 'notCreated',
            attachment: 'notRequested',
            link: 'notAttempted',
            newSessionSeed: 'notRequested',
            directSend: 'notRequested',
        } as const;
        const base = {
            unit: { creationKey: 'creation-17', entries: [] },
            status: 'settled',
        } as const;

        expect(isTriageBulkSessionOutcomeRetryableV1({
            ...base,
            outcome: {
                start: { v: 1, type: 'creationPending', outcome: 'unknown' },
                entries: [entryOutcome],
            },
        })).toBe(true);
        expect(isTriageBulkSessionOutcomeRetryableV1({
            ...base,
            outcome: {
                start: {
                    v: 1,
                    type: 'openPending',
                    sessionId: 'session-17',
                    disposition: 'created',
                    delivery: 'accepted',
                },
                entries: [{
                    ...entryOutcome,
                    session: 'created',
                    attachment: 'carried',
                    link: 'created',
                    directSend: 'applied',
                }],
            },
        })).toBe(true);
        expect(isTriageBulkSessionOutcomeRetryableV1({
            ...base,
            outcome: {
                start: { v: 1, type: 'creationFailed' },
                entries: [entryOutcome],
            },
        })).toBe(false);
    });
});
