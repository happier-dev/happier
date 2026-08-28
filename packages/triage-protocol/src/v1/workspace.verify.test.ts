import { describe, expect, it } from 'vitest';

import {
    TriageVerifyReviewWorkspaceInputV1Schema,
    TriageVerifyReviewWorkspaceResultV1Schema,
} from './workspace.js';

const input = {
    v: 1,
    instance: {
        v: 1,
        instance: {
            source: { pluginId: 'happier.scm.github', localId: 'github-forge' },
            sourceInstanceId: '11111111-1111-4111-8111-111111111111',
        },
        binding: {
            purpose: 'github.api',
            account: {
                service: { pluginId: 'happier.scm.github', localId: 'github' },
                accountId: 'account-1',
            },
        },
        localInstanceKey: 'github:example/repo',
        configuration: { v: 1, token: 'configured-source-token' },
        locator: { v: 1, displayLabel: 'example/repo' },
    },
    entryRef: {
        source: { pluginId: 'happier.scm.github', localId: 'github-forge' },
        kindId: 'pull-request',
        collisionScope: 'github:example/repo',
        entryId: '17',
    },
    lastKnownLocator: {
        v: 1,
        webUrl: 'https://github.com/example/repo/pull/17',
        displayPath: 'example/repo #17',
        routingToken: 'route-17',
    },
    observed: {
        baseSha: 'base-sha',
        headSha: 'head-sha',
        nativeRevision: 'native-revision',
        observedAtMs: 1_777_777_777_777,
    },
    workspace: {
        serverId: 'server-1',
        machineId: 'machine-1',
        rootPath: '/workspace/repo',
    },
    prepared: {
        repositoryPath: '/workspace/repo/.worktrees/pr-17',
        pullRequest: { provider: 'github', number: 17 },
    },
} as const;

describe('Triage final review workspace verification', () => {
    it('admits the exact selected source, observed revision, workspace and prepared facts', () => {
        expect(TriageVerifyReviewWorkspaceInputV1Schema.parse(input)).toEqual(input);
        expect(TriageVerifyReviewWorkspaceInputV1Schema.safeParse({
            ...input,
            prepared: { ...input.prepared, replacementPath: '/other' },
        }).success).toBe(false);
    });

    it('keeps verified, mismatch, unavailable and revision-refusal outcomes closed', () => {
        for (const result of [
            { kind: 'verified', pullRequest: input.prepared.pullRequest },
            { kind: 'workspaceMismatch' },
            { kind: 'unavailable', reason: 'scmResolver' },
            { kind: 'refused', reason: 'observedHeadMoved' },
        ] as const) {
            expect(TriageVerifyReviewWorkspaceResultV1Schema.parse(result)).toEqual(result);
        }
        expect(TriageVerifyReviewWorkspaceResultV1Schema.safeParse({
            kind: 'verified',
            pullRequest: input.prepared.pullRequest,
            repositoryPath: input.prepared.repositoryPath,
        }).success).toBe(false);
    });
});
