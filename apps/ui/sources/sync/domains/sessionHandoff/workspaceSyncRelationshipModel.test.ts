import { describe, expect, it } from 'vitest';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol';

import {
    projectWorkspaceSyncRelationships,
    projectWorkspaceSyncRelationshipSummaries,
    resolveWorkspaceSyncSetAttention,
    projectWorkspaceSyncSetAttentionByWorkspaceRefId,
    selectWorkspaceSyncRelationshipSummariesForHandoff,
    selectWorkspaceSyncLinkedHandoffChoice,
    selectWorkspaceSyncAddMachineHub,
} from './workspaceSyncRelationshipModel';

const policyFields = {
    v: 1 as const,
    selection: 'git_worktree' as const,
    extraIgnorePatterns: [],
    extraIncludePatterns: [],
};
const policy = {
    ...policyFields,
    policyDigest: computeWorkspaceSyncPolicyDigest(policyFields),
};

describe('projectWorkspaceSyncRelationships', () => {
    it('does not collapse duplicate endpoint IDs from different Homes', () => {
        const alpha = { id: 'alpha', serverId: 'home-a', machineId: 'machine-a', rootPath: '/repo', createdAtMs: 1 };
        const beta = { id: 'beta', serverId: 'home-a', machineId: 'machine-b', rootPath: '/target', createdAtMs: 1 };
        const relationship = { v: 1 as const, relationshipId: 'link', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'alpha', betaWorkspaceRefId: 'beta', mode: 'keep_synced' as const,
            contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        const input = { relationships: projectWorkspaceSyncRelationships([relationship]), statuses: [],
            workspaceRefs: [alpha, beta, { ...alpha, serverId: 'home-b' }] };
        expect(projectWorkspaceSyncRelationshipSummaries(input)[0]?.alpha.workspaceRef).toBeNull();
        expect(projectWorkspaceSyncRelationshipSummaries({ ...input, serverId: 'home-a' })[0]?.alpha.workspaceRef).toEqual(alpha);
    });
    it('selects the actual controller hub when Add machine starts from a beta-controlled editable spoke', () => {
        const refs = [
            { id: 'spoke', serverId: 'server-1', machineId: 'machine-c', rootPath: '/spoke', createdAtMs: 1 },
            { id: 'hub', serverId: 'server-1', machineId: 'machine-a', rootPath: '/hub', createdAtMs: 1 },
        ];
        const relationship = {
            v: 1 as const, relationshipId: 'a-c', controllerMachineId: 'machine-a',
            alphaWorkspaceRefId: 'spoke', betaWorkspaceRefId: 'hub',
            mode: 'keep_both_in_sync' as const, contentPolicy: policy, enabled: true,
            createdAtMs: 1, updatedAtMs: 1,
        };
        const summaries = projectWorkspaceSyncRelationshipSummaries({
            relationships: projectWorkspaceSyncRelationships([relationship]),
            workspaceRefs: refs, statuses: [],
        });
        expect(selectWorkspaceSyncAddMachineHub(summaries, 'spoke')).toEqual(refs[1]);
    });

    it('offers the existing destination through its hub only for a directional two-link route', () => {
        const refs = [
            { id: 'hub', serverId: 'server-1', machineId: 'machine-a', rootPath: '/hub', createdAtMs: 1 },
            { id: 'source', serverId: 'server-1', machineId: 'machine-c', rootPath: '/source', createdAtMs: 1 },
            { id: 'target', serverId: 'server-1', machineId: 'machine-b', rootPath: '/target', createdAtMs: 1 },
        ];
        const sourceLink = { v: 1 as const, relationshipId: 'a-c', controllerMachineId: 'machine-a', alphaWorkspaceRefId: 'hub', betaWorkspaceRefId: 'source', mode: 'keep_both_in_sync' as const, contentPolicy: policy, enabled: true, createdAtMs: 1, updatedAtMs: 1 };
        const targetLink = { ...sourceLink, relationshipId: 'a-b', betaWorkspaceRefId: 'target', mode: 'keep_synced' as const };
        const summaries = projectWorkspaceSyncRelationshipSummaries({
            relationships: projectWorkspaceSyncRelationships([sourceLink, targetLink]),
            workspaceRefs: refs,
            statuses: [],
            machineNamesById: { 'machine-a': 'Mac Studio' },
        });
        const choice = selectWorkspaceSyncLinkedHandoffChoice(summaries, {
            source: { serverId: 'server-1', machineId: 'machine-c', rootPath: '/source/packages/app' },
            target: { serverId: 'server-1', machineId: 'machine-b', rootPath: '/target' },
        });
        expect(choice).toMatchObject({
            sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target',
            hubMachineName: 'Mac Studio', relationshipIds: ['a-c', 'a-b'],
        });
        const receiveOnlySource = projectWorkspaceSyncRelationshipSummaries({
            relationships: projectWorkspaceSyncRelationships([{ ...sourceLink, mode: 'keep_synced' }, targetLink]),
            workspaceRefs: refs, statuses: [],
        });
        expect(selectWorkspaceSyncLinkedHandoffChoice(receiveOnlySource, {
            source: { serverId: 'server-1', machineId: 'machine-c', rootPath: '/source/packages/app' },
            target: { serverId: 'server-1', machineId: 'machine-b', rootPath: '/target' },
        })).toBeNull();
    });

    it('keeps one strict enabled relationship model and reports malformed entries without defaulting them', () => {
        const result = projectWorkspaceSyncRelationships([
            {
                v: 1,
                relationshipId: ' relationship-1 ',
                controllerMachineId: 'machine-1',
                alphaWorkspaceRefId: 'workspace-alpha',
                betaWorkspaceRefId: 'workspace-beta',
                mode: 'keep_both_in_sync',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'relationship-invalid',
                controllerMachineId: 'machine-1',
                alphaWorkspaceRefId: 'same',
                betaWorkspaceRefId: 'same',
                mode: 'unknown_mode',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
        ]);

        expect(result.enabled).toEqual([
            expect.objectContaining({
                relationshipId: 'relationship-1',
                mode: 'keep_both_in_sync',
            }),
        ]);
        expect(result.byId.get('relationship-1')?.alphaWorkspaceRefId).toBe('workspace-alpha');
        expect(result.invalidCount).toBe(1);
    });

    it('keeps disabled relationships manageable without exposing them as selectable', () => {
        const result = projectWorkspaceSyncRelationships([{
            v: 1,
            relationshipId: 'relationship-disabled',
            controllerMachineId: 'machine-1',
            alphaWorkspaceRefId: 'workspace-alpha',
            betaWorkspaceRefId: 'workspace-beta',
            mode: 'keep_synced',
            contentPolicy: policy,
            enabled: false,
            createdAtMs: 1,
            updatedAtMs: 2,
        }]);

        expect(result.enabled).toEqual([]);
        expect(result.all).toEqual([expect.objectContaining({ relationshipId: 'relationship-disabled', enabled: false })]);
        expect(result.byId.size).toBe(1);
        expect(result.invalidCount).toBe(0);
    });

    it('resolves endpoint identities once and deduplicates conflict counts by relationship', () => {
        const relationships = projectWorkspaceSyncRelationships([
            {
                v: 1,
                relationshipId: 'relationship-1',
                controllerMachineId: 'machine-alpha',
                alphaWorkspaceRefId: 'workspace-alpha',
                betaWorkspaceRefId: 'workspace-beta',
                mode: 'keep_both_in_sync',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'relationship-2',
                controllerMachineId: 'machine-alpha',
                alphaWorkspaceRefId: 'workspace-alpha',
                betaWorkspaceRefId: 'workspace-gamma',
                mode: 'keep_synced',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
        ]);
        const summaries = projectWorkspaceSyncRelationshipSummaries({
            relationships,
            workspaceRefs: [
                { id: 'workspace-alpha', serverId: 'server-1', machineId: 'machine-alpha', rootPath: '/alpha', label: 'Alpha', createdAtMs: 1 },
                { id: 'workspace-beta', serverId: 'server-1', machineId: 'machine-beta', rootPath: '/beta', label: 'Beta', createdAtMs: 1 },
                { id: 'workspace-gamma', serverId: 'server-1', machineId: 'machine-gamma', rootPath: '/gamma', label: null, createdAtMs: 1 },
            ],
            statuses: [
                { relationshipId: 'relationship-1', controllerMachineId: 'machine-alpha', state: 'conflicted', alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_both_in_sync', endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } }, conflictCount: 3, lastCycleObservedAtMs: 4 },
                // A repeated status observation must never double the session-header count.
                { relationshipId: 'relationship-1', controllerMachineId: 'machine-alpha', state: 'conflicted', alphaPath: '/alpha', betaPath: '/beta', mode: 'keep_both_in_sync', endpointStates: { alpha: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 }, beta: { connected: true, scanned: true, scanProblemCount: 0, transitionProblemCount: 0 } }, conflictCount: 3, lastCycleObservedAtMs: 4 },
            ],
            machineNamesById: {
                'machine-alpha': 'Alpha Mac',
                'machine-beta': 'Beta workstation',
            },
        });

        expect(summaries.map((summary) => [summary.relationshipId, summary.alpha.label, summary.beta.label])).toEqual([
            ['relationship-1', 'Alpha', 'Beta'],
            ['relationship-2', 'Alpha', '/gamma'],
        ]);
        expect(summaries[0]).toMatchObject({
            alpha: { machineName: 'Alpha Mac' },
            beta: { machineName: 'Beta workstation' },
        });
        expect(summaries[1]?.beta.machineName).toBeNull();
        const attention = { conflictedLinkCount: 1, unknownLinkCount: 1 };
        expect(resolveWorkspaceSyncSetAttention(summaries, 'workspace-alpha')).toEqual(attention);
        expect(resolveWorkspaceSyncSetAttention(summaries, 'workspace-beta')).toEqual(attention);
        expect(resolveWorkspaceSyncSetAttention(summaries, 'workspace-gamma')).toEqual(attention);
        expect(projectWorkspaceSyncSetAttentionByWorkspaceRefId(summaries)).toEqual(new Map([
            ['workspace-alpha', attention], ['workspace-beta', attention], ['workspace-gamma', attention],
        ]));
    });

    it('selects only enabled relationships that safely match the current handoff endpoint direction', () => {
        const relationships = projectWorkspaceSyncRelationships([
            {
                v: 1,
                relationshipId: 'forward-one-way',
                controllerMachineId: 'machine-source',
                alphaWorkspaceRefId: 'workspace-source',
                betaWorkspaceRefId: 'workspace-target',
                mode: 'keep_synced',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'reverse-one-way',
                controllerMachineId: 'machine-target',
                alphaWorkspaceRefId: 'workspace-target',
                betaWorkspaceRefId: 'workspace-source',
                mode: 'mirror_exactly',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'reverse-two-way',
                controllerMachineId: 'machine-target',
                alphaWorkspaceRefId: 'workspace-target',
                betaWorkspaceRefId: 'workspace-source',
                mode: 'keep_both_in_sync',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'disabled-match',
                controllerMachineId: 'machine-source',
                alphaWorkspaceRefId: 'workspace-source',
                betaWorkspaceRefId: 'workspace-target',
                mode: 'keep_synced',
                contentPolicy: policy,
                enabled: false,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
            {
                v: 1,
                relationshipId: 'wrong-source',
                controllerMachineId: 'machine-other',
                alphaWorkspaceRefId: 'workspace-other-source',
                betaWorkspaceRefId: 'workspace-target',
                mode: 'keep_synced',
                contentPolicy: policy,
                enabled: true,
                createdAtMs: 1,
                updatedAtMs: 2,
            },
        ]);
        const summaries = projectWorkspaceSyncRelationshipSummaries({
            relationships,
            workspaceRefs: [
                { id: 'workspace-source', serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo/', label: 'Source project', createdAtMs: 1 },
                { id: 'workspace-other-source', serverId: 'server-2', machineId: 'machine-other', rootPath: '/Users/tester/repo/', label: 'Other source', createdAtMs: 1 },
                { id: 'workspace-target', serverId: 'server-1', machineId: 'machine-target', rootPath: 'C:\\Repos\\Target\\', label: 'Destination project', createdAtMs: 1 },
            ],
            statuses: [],
        });

        expect(selectWorkspaceSyncRelationshipSummariesForHandoff(summaries, {
            source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo' },
            target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
        }).map((summary) => summary.relationshipId)).toEqual([
            'forward-one-way',
            'reverse-two-way',
        ]);

        expect(selectWorkspaceSyncRelationshipSummariesForHandoff(summaries, {
            source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo/packages/app' },
            target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
        }).map((summary) => summary.relationshipId)).toEqual([
            'forward-one-way',
            'reverse-two-way',
        ]);

        expect(selectWorkspaceSyncRelationshipSummariesForHandoff(summaries, {
            source: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'C:\\Repos\\Target\\packages\\app' },
            target: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo' },
        }).map((summary) => summary.relationshipId)).toEqual([
            'reverse-one-way',
            'reverse-two-way',
        ]);

        const nonMatchingScopes = [
            {
                source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repository' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
            },
            {
                source: { serverId: 'server-2', machineId: 'machine-source', rootPath: '/Users/tester/repo/packages/app' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
            },
            {
                source: { serverId: 'server-1', machineId: 'machine-other', rootPath: '/Users/tester/repo/packages/app' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
            },
            {
                source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
            },
            {
                source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo/packages/app' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target/nested' },
            },
        ];

        for (const scopes of nonMatchingScopes) {
            expect(selectWorkspaceSyncRelationshipSummariesForHandoff(summaries, scopes)).toEqual([]);
        }

        const allFilesPolicyFields = { ...policyFields, selection: 'all_files' as const };
        const allFilesSummaries = summaries.map((summary) => ({
            ...summary,
            relationship: {
                ...summary.relationship,
                contentPolicy: {
                    ...allFilesPolicyFields,
                    policyDigest: computeWorkspaceSyncPolicyDigest(allFilesPolicyFields),
                },
            },
        }));
        expect(selectWorkspaceSyncRelationshipSummariesForHandoff(allFilesSummaries, {
            source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo' },
            target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
        }).map((summary) => summary.relationshipId)).toEqual(['forward-one-way', 'reverse-two-way']);
        for (const scopes of [
            {
                source: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo/packages/app' },
                target: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'c:/repos/target' },
            },
            {
                source: { serverId: 'server-1', machineId: 'machine-target', rootPath: 'C:\\Repos\\Target\\packages\\app' },
                target: { serverId: 'server-1', machineId: 'machine-source', rootPath: '/Users/tester/repo' },
            },
        ]) {
            expect(selectWorkspaceSyncRelationshipSummariesForHandoff(allFilesSummaries, scopes)).toEqual([]);
        }
    });
});
