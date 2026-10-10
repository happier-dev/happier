import { describe, expect, it } from 'vitest';
import type { ProjectKeyV1 } from '@happier-dev/plugin-sdk/sessions';

import {
    isTriageBulkSharedPlacementCompatibleV1,
    isTriageBulkSessionOutcomeRetryableV1,
    mergeTriageBulkRetryResultsV1,
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
    it('allows error entries without forge identity to share a user-selected project', () => {
        expect(isTriageBulkSharedPlacementCompatibleV1({
            workspaceMode: 'repository', entries: [{}, {}],
        })).toBe(true);
        expect(resolveTriageBulkSeedPlacementV1({
            workspaceMode: 'repository', entries: [{}, {}], projects: [], registryComplete: true,
        })).toEqual({ kind: 'none' });
    });

    it('allows an explicit shared project choice when repository identities differ', () => {
        expect(isTriageBulkSharedPlacementCompatibleV1({
            workspaceMode: 'repository',
            entries: [{ repository: REPOSITORY }, {
                repository: {
                    kind: 'gitlab',
                    deployment: 'https://example.test',
                    repository: REPOSITORY.repository,
                },
            }],
        })).toBe(true);
    });

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

    it.each([
        {
            name: 'different Project anchors',
            left: { serverId: 'server-a', projectKey: 'project-a' },
            right: { serverId: 'server-a', projectKey: 'project-b' },
            matches: false,
        },
        {
            name: 'the same Project anchor',
            left: { serverId: 'server-a', projectKey: 'project-a' },
            right: { serverId: 'server-a', projectKey: 'project-a' },
            matches: true,
        },
        {
            name: 'different Home-qualified checkout ids',
            left: { serverId: 'server-a', id: 'workspace-a' },
            right: { serverId: 'server-b', id: 'workspace-a' },
            matches: false,
        },
        {
            name: 'an anchor and a legacy checkout scope',
            left: { serverId: 'server-a', projectKey: 'project-a' },
            right: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/checkout' },
            matches: false,
        },
        {
            name: 'the same legacy checkout scope',
            left: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/checkout' },
            right: { serverId: 'server-a', machineId: 'machine-a', rootPath: '/checkout' },
            matches: true,
        },
    ] satisfies readonly Readonly<{
        name: string;
        left: ProjectKeyV1;
        right: ProjectKeyV1;
        matches: boolean;
    }>[])('retains an exact candidate only when its project identity agrees: $name', ({ left, right, matches }) => {
        const otherRepository = { ...REPOSITORY, repository: 'example/other-repository' };
        const first = {
            ...candidate({ projectId: 'workspace-a', machineId: 'machine-a', rootPath: '/checkout' }),
            projectKey: left,
        };
        const result = resolveTriageBulkSeedPlacementV1({
            workspaceMode: 'repository',
            entries: [{ repository: REPOSITORY }, { repository: otherRepository }],
            projects: [first, { ...first, projectKey: right, forge: otherRepository }],
            registryComplete: true,
        });

        expect(result).toMatchObject({ kind: 'exact' });
        expect(result.kind === 'exact' ? result.candidate?.projectKey : undefined)
            .toEqual(matches ? left : undefined);
    });
});

describe('bulk retry custody', () => {
    it('keeps an unknown original start recoverable after an early retry refusal', () => {
        const unit = { creationKey: 'creation-17', entries: [] } as const;
        const previous = [{ unit, status: 'unknownOutcome' as const }];
        const refused = mergeTriageBulkRetryResultsV1(previous, [{
            unit,
            status: 'settled',
            outcome: { start: { v: 1, type: 'creationFailed' }, entries: [] },
        }]);
        expect(refused).toEqual(previous);
        expect(isTriageBulkSessionOutcomeRetryableV1(refused[0]!)).toBe(true);
        expect(mergeTriageBulkRetryResultsV1(refused, [{
            unit,
            status: 'settled',
            outcome: {
                start: { v: 1, type: 'opened', sessionId: 'session-17', disposition: 'rejoined' },
                entries: [],
            },
        }])[0]).toMatchObject({
            unit: { creationKey: 'creation-17' },
            outcome: { start: { type: 'opened', sessionId: 'session-17' } },
        });
    });

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

    it('keeps a known Session result when a cancelled retry observes nothing newer', () => {
        const unit = { creationKey: 'creation-17', entries: [] } as const;
        const previous = [{
            unit,
            status: 'settled' as const,
            outcome: {
                start: {
                    v: 1 as const,
                    type: 'openPending' as const,
                    sessionId: 'session-17',
                    disposition: 'created' as const,
                    delivery: 'accepted' as const,
                },
                entries: [],
            },
        }];

        expect(mergeTriageBulkRetryResultsV1(previous, [{
            unit,
            status: 'unknownOutcome' as const,
        }])).toEqual(previous);
        expect(mergeTriageBulkRetryResultsV1(previous, [{
            unit,
            status: 'notStarted' as const,
        }])).toEqual(previous);
    });

    it('keeps accepted delivery and entry successes while adopting a later retry phase', () => {
        const entryRef = {
            source: { pluginId: 'happier.test', localId: 'entries' },
            kindId: 'issue',
            collisionScope: 'example',
            entryId: '17',
        } as const;
        const unit = { creationKey: 'creation-17', entries: [] } as const;
        const previous = [{
            unit,
            status: 'settled' as const,
            outcome: {
                start: {
                    v: 1 as const,
                    type: 'openPending' as const,
                    sessionId: 'session-17',
                    disposition: 'created' as const,
                    delivery: 'accepted' as const,
                },
                entries: [{
                    entryRef,
                    session: 'created' as const,
                    attachment: 'carried' as const,
                    link: 'created' as const,
                    newSessionSeed: 'notRequested' as const,
                    directSend: 'applied' as const,
                }],
            },
        }];

        expect(mergeTriageBulkRetryResultsV1(previous, [{
            unit,
            status: 'settled' as const,
            outcome: {
                start: {
                    v: 1 as const,
                    type: 'opened' as const,
                    sessionId: 'session-17',
                    disposition: 'created' as const,
                    delivery: 'outcomeUnknown' as const,
                },
                entries: [{
                    entryRef,
                    session: 'uncertain' as const,
                    attachment: 'uncertain' as const,
                    link: 'conflictedOrUnavailable' as const,
                    newSessionSeed: 'notRequested' as const,
                    directSend: 'uncertain' as const,
                }],
            },
        }])).toEqual([expect.objectContaining({
            status: 'settled',
            outcome: {
                start: expect.objectContaining({
                    type: 'opened',
                    delivery: 'accepted',
                }),
                entries: [expect.objectContaining({
                    session: 'created',
                    attachment: 'carried',
                    link: 'created',
                    directSend: 'applied',
                })],
            },
        })]);
    });

    it('adopts a terminal creation answer over an earlier creation-pending observation', () => {
        const unit = { creationKey: 'creation-17', entries: [] } as const;
        const previous = [{
            unit,
            status: 'settled' as const,
            outcome: {
                start: { v: 1 as const, type: 'creationPending' as const, outcome: 'unknown' as const },
                entries: [],
            },
        }];

        expect(mergeTriageBulkRetryResultsV1(previous, [{
            unit,
            status: 'settled' as const,
            outcome: {
                start: { v: 1 as const, type: 'creationFailed' as const },
                entries: [],
            },
        }])).toEqual([expect.objectContaining({
            outcome: expect.objectContaining({
                start: { v: 1, type: 'creationFailed' },
            }),
        })]);
    });
});
