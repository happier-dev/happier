import { beforeEach, describe, expect, it, vi } from 'vitest';

const listV4Mock = vi.hoisted(() => vi.fn());
const createV4Mock = vi.hoisted(() => vi.fn());
const patchV4Mock = vi.hoisted(() => vi.fn());
const deleteV4Mock = vi.hoisted(() => vi.fn());
const addMemberV4Mock = vi.hoisted(() => vi.fn());
const patchMemberV4Mock = vi.hoisted(() => vi.fn());
const removeMemberV4Mock = vi.hoisted(() => vi.fn());
const activeV4Mock = vi.hoisted(() => vi.fn());
const generatedLegacyCompatibility = vi.hoisted(() => ({
    github: {
        service: {
            pluginId: 'happier.scm.forge.github',
            localId: 'github-account',
        },
        peerOperations: {
            exactV0_2_1: [],
            revisionedV2V3: [
                'account_list',
                'credential_read',
                'credential_write',
                'credential_delete',
                'quota_read',
                'quota_refresh',
            ],
        },
    },
    'openai-codex': {
        service: {
            pluginId: 'happier.agent.codex',
            localId: 'openai-codex',
        },
        peerOperations: {
            exactV0_2_1: [
                'account_list',
                'credential_read',
                'one_shot_materialization',
            ],
            revisionedV2V3: [
                'account_list',
                'credential_read',
                'credential_write',
                'credential_delete',
                'quota_read',
                'quota_refresh',
            ],
        },
    },
    bitbucket: {
        service: {
            pluginId: 'happier.scm.forge.bitbucket',
            localId: 'bitbucket-account',
        },
        peerOperations: {
            exactV0_2_1: [],
            revisionedV2V3: [],
        },
    },
}));

vi.mock('@/sync/api/account/apiQualifiedConnectedAccountsV4', () => ({
    addQualifiedConnectedAccountGroupMemberV4: addMemberV4Mock,
    createQualifiedConnectedAccountGroupV4: createV4Mock,
    deleteQualifiedConnectedAccountGroupV4: deleteV4Mock,
    listQualifiedConnectedAccountGroupsV4: listV4Mock,
    patchQualifiedConnectedAccountGroupMemberV4: patchMemberV4Mock,
    patchQualifiedConnectedAccountGroupV4: patchV4Mock,
    removeQualifiedConnectedAccountGroupMemberV4: removeMemberV4Mock,
    setQualifiedConnectedAccountGroupActiveAccountV4: activeV4Mock,
}));
vi.mock('@happier-dev/protocol', async (importOriginal) => ({
    ...await importOriginal<typeof import('@happier-dev/protocol')>(),
    BUNDLED_LEGACY_CONNECTED_ACCOUNT_COMPATIBILITY_BY_SERVICE_ID:
        generatedLegacyCompatibility,
}));

import {
    createQualifiedConnectedAccountGroupsClient,
    MEMBER_PRIORITY_STEP,
    nextMemberPriority,
    QualifiedConnectedAccountUiSourceError,
} from './qualifiedConnectedAccountUiSource';

describe('nextMemberPriority', () => {
    it('starts the ladder at one step for the first member', () => {
        expect(nextMemberPriority([])).toBe(MEMBER_PRIORITY_STEP);
    });

    it('appends one full step past the highest existing priority', () => {
        expect(nextMemberPriority([{ priority: 100 }, { priority: 300 }])).toBe(300 + MEMBER_PRIORITY_STEP);
    });
});

const credentials = {
    token: 'token',
    secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
const service = {
    pluginId: 'happier.scm.forge.github',
    localId: 'github-account',
};
const policy = {
    v: 1 as const,
    strategy: 'least_limited' as const,
    autoSwitch: false,
    switchOn: {
        usageLimit: true,
        authExpired: true,
        accountChanged: true,
        refreshFailure: false,
    },
    cooldownMs: 30_000,
    honorProviderResetsAt: true,
    autoRestorePrimaryWhenReset: false,
    maxSwitchesPerTurn: 1,
    maxSwitchesPerSessionHour: 3,
    softSwitchRemainingPercent: 15,
    probeIfSnapshotOlderThanMs: 300_000,
    preTurnProbeMode: 'when_stale' as const,
    preTurnProbeOrder: 'current_first_then_candidates' as const,
    recoveryMode: 'switch_or_wait' as const,
    resumePromptMode: 'standard' as const,
};
const qualifiedGroup = {
    v: 1 as const,
    ref: { service, groupId: 'team' },
    displayName: 'Team',
    policy,
    activeConnectedAccountId: 'account-a',
    incarnation: 'qualified-group-row-team',
    generation: 4,
    runtimeStateRevision: 7,
    state: {},
    createdAt: 1,
    updatedAt: 1,
    members: [{
        v: 1 as const,
        connectedAccountId: 'account-a',
        priority: 100,
        enabled: true,
        state: {},
        createdAt: 1,
        updatedAt: 1,
    }],
};
describe('createQualifiedConnectedAccountGroupsClient', () => {
    beforeEach(() => {
        listV4Mock.mockReset();
        createV4Mock.mockReset();
        patchV4Mock.mockReset();
        deleteV4Mock.mockReset();
        addMemberV4Mock.mockReset();
        patchMemberV4Mock.mockReset();
        removeMemberV4Mock.mockReset();
        activeV4Mock.mockReset();
    });

    it('retains exact qualified refs and threads only V4 revision semantics', async () => {
        listV4Mock.mockResolvedValueOnce({ groups: [qualifiedGroup] });
        patchV4Mock.mockResolvedValueOnce({
            group: {
                ...qualifiedGroup,
                policy: { ...policy, autoSwitch: true },
                runtimeStateRevision: 8,
            },
        });
        activeV4Mock.mockResolvedValueOnce({
            group: {
                ...qualifiedGroup,
                activeConnectedAccountId: 'account-a',
                generation: 5,
                runtimeStateRevision: 9,
            },
        });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
        });

        const [group] = await client.list();
        expect(group).toEqual(expect.objectContaining({
            ref: { service, groupId: 'team' },
            revision: {
                protocol: 'v4',
                incarnation: 'qualified-group-row-team',
                generation: 4,
                runtimeStateRevision: 7,
            },
            members: [expect.objectContaining({
                ref: { service, accountId: 'account-a' },
            })],
        }));
        await client.patch({
            group: group!,
            policy: { autoSwitch: true },
        });
        await client.setActiveAccount({
            group: group!,
            account: { service, accountId: 'account-a' },
            overrideRuntimeCooldown: true,
        });

        expect(patchV4Mock).toHaveBeenCalledWith(credentials, {
            service,
            groupId: 'team',
            policy: { ...policy, autoSwitch: true },
            expectedGeneration: 4,
            expectedIncarnation: 'qualified-group-row-team',
            expectedRuntimeStateRevision: 7,
        });
        expect(activeV4Mock).toHaveBeenCalledWith(credentials, {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-a',
            expectedGeneration: 4,
            expectedIncarnation: 'qualified-group-row-team',
            expectedRuntimeStateRevision: 7,
            overrideRuntimeCooldown: true,
        });
    });

    it('keeps V4 create/delete/member CRUD on exact qualified refs and runtime revisions', async () => {
        createV4Mock.mockResolvedValueOnce({ group: qualifiedGroup });
        deleteV4Mock.mockResolvedValueOnce(true);
        addMemberV4Mock.mockResolvedValueOnce({ group: qualifiedGroup });
        patchMemberV4Mock.mockResolvedValueOnce({ group: qualifiedGroup });
        removeMemberV4Mock.mockResolvedValueOnce({ group: qualifiedGroup });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
        });
        const group = {
            ref: qualifiedGroup.ref,
            displayName: qualifiedGroup.displayName,
            policy: qualifiedGroup.policy,
            activeAccountId: qualifiedGroup.activeConnectedAccountId,
            revision: {
                protocol: 'v4' as const,
                incarnation: qualifiedGroup.incarnation,
                generation: qualifiedGroup.generation,
                runtimeStateRevision:
                    qualifiedGroup.runtimeStateRevision,
            },
            state: qualifiedGroup.state,
            members: qualifiedGroup.members.map((member) => ({
                ref: {
                    service,
                    accountId: member.connectedAccountId,
                },
                priority: member.priority,
                enabled: member.enabled,
                state: member.state,
            })),
        };
        const account = { service, accountId: 'account-b' };

        await client.create({ groupId: 'team', displayName: 'Team' });
        await client.addMember({ group, account });
        await client.patchMember({
            group,
            account,
            enabled: false,
            priority: 200,
        });
        await client.removeMember({ group, account });
        await client.delete(group);

        expect(createV4Mock).toHaveBeenCalledWith(credentials, {
            service,
            group: { groupId: 'team', displayName: 'Team' },
        });
        expect(addMemberV4Mock).toHaveBeenCalledWith(credentials, {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            priority: 200,
            enabled: true,
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        });
        expect(patchMemberV4Mock).toHaveBeenCalledWith(credentials, {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            enabled: false,
            priority: 200,
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        });
        expect(removeMemberV4Mock).toHaveBeenCalledWith(credentials, {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        });
        expect(deleteV4Mock).toHaveBeenCalledWith(credentials, {
            group: { service, groupId: 'team' },
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        });
    });

    it('rejects a mutation response bound to another group id', async () => {
        patchV4Mock.mockResolvedValueOnce({
            group: {
                ...qualifiedGroup,
                ref: { service, groupId: 'other-team' },
            },
        });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
        });
        const group = {
            ref: qualifiedGroup.ref,
            displayName: qualifiedGroup.displayName,
            policy: qualifiedGroup.policy,
            activeAccountId: qualifiedGroup.activeConnectedAccountId,
            revision: {
                protocol: 'v4' as const,
                incarnation: qualifiedGroup.incarnation,
                generation: qualifiedGroup.generation,
                runtimeStateRevision: qualifiedGroup.runtimeStateRevision,
            },
            state: qualifiedGroup.state,
            members: [],
        };

        await expect(client.patch({ group, displayName: 'Renamed' }))
            .rejects.toMatchObject({
                code: 'qualified_connected_accounts_inconsistent_peer',
            });
    });

    it('rejects a create response bound to another group id', async () => {
        createV4Mock.mockResolvedValueOnce({
            group: {
                ...qualifiedGroup,
                ref: { service, groupId: 'other-team' },
            },
        });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
        });

        await expect(client.create({ groupId: 'team', displayName: 'Team' }))
            .rejects.toMatchObject({
                code: 'qualified_connected_accounts_inconsistent_peer',
            });
    });

});
