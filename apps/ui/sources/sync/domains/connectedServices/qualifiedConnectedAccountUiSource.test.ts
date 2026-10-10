import { beforeEach, describe, expect, it, vi } from 'vitest';

const network = vi.hoisted(() => ({ responses: [] as unknown[], requests: [] as Array<{ path: string; method: string; body?: unknown }> }));
// HTTP is the genuine boundary; API parsing, Action admission and pool ownership stay real.
vi.mock('@/sync/http/client', () => ({ serverFetch: async (path: string, init?: RequestInit) => {
    network.requests.push({ path, method: init?.method ?? 'GET',
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}) });
    if (!network.responses.length) throw new Error('unexpected_http');
    return new Response(JSON.stringify(network.responses.shift()), { status: 200, headers: { 'Content-Type': 'application/json' } });
} }));

import { serverFetch } from '@/sync/http/client';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from '@happier-dev/protocol/connect/execute-configuration-action';
import { getQualifiedConnectedAccountGroupV4 } from '@/sync/api/account/apiQualifiedConnectedAccountsV4';
import { buildQualifiedConnectedAccountGroupMutationRequestV4 } from '@happier-dev/protocol/connect/qualifiedConnectedAccountGroupRequestsV4';
import type { ConnectedServiceConfigurationActionIdV1 } from '@happier-dev/protocol/connect/configurationActionsV1';

import {
    createQualifiedConnectedAccountGroupsClient,
    MEMBER_PRIORITY_STEP,
    nextMemberPriority,
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
const host: ConnectedServiceConfigurationActionHostV1 = {
    assertCurrent() {}, async resolveAgent() { return null; }, async resetQuota() {},
    async mutatePurposeBindings() { throw new Error('unexpected_purpose_write'); },
    async request({ path, method, body }) { return await (await serverFetch(path, { method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })).json(); },
};
const executor = createActionExecutor({ connectedServiceAction: ({ actionId, input }) =>
    executeConnectedServiceConfigurationActionV1(host, actionId, input) } as unknown as ActionExecutorDeps);
const mutation = {
    async execute(actionId: ConnectedServiceConfigurationActionIdV1, input: unknown) {
        const result = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user', serverId: 'home', runtimeAccountId: 'account' });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return result.result;
    },
    async readGroup(group: Parameters<typeof getQualifiedConnectedAccountGroupV4>[1]['group']) {
        return (await getQualifiedConnectedAccountGroupV4(credentials, { group, request: serverFetch })).group;
    },
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
        network.responses.length = 0;
        network.requests.length = 0;
    });

    it('exposes active-since only when it belongs to the listed active account', async () => {
        network.responses.push({ groups: [{
            ...qualifiedGroup,
            state: { activeSince: { accountId: 'account-a', atMs: 123 } },
        }] });
        network.responses.push({ groups: [{
            ...qualifiedGroup,
            state: { activeSince: { accountId: 'old-account', atMs: 12 } },
        }] });
        network.responses.push({ groups: [qualifiedGroup] });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
        });
        const matching = (await client.list())[0];
        expect(matching?.activeSince).toEqual({ accountId: 'account-a', atMs: 123 });
        const stale = (await client.list())[0];
        expect(stale?.activeSince).toBeNull();
        expect(stale?.state.activeSince).toBeNull();
        expect((await client.list())[0]?.activeSince).toBeNull();
    });

    it('retains exact qualified refs and threads only V4 revision semantics', async () => {
        network.responses.push({ groups: [qualifiedGroup] });
        network.responses.push({
            group: {
                ...qualifiedGroup,
                policy: { ...policy, autoSwitch: true },
                runtimeStateRevision: 8,
            },
        });
        const switched = {
            group: {
                ...qualifiedGroup,
                activeConnectedAccountId: 'account-a',
                generation: 5,
                runtimeStateRevision: 9,
            },
        };
        network.responses.push(switched, switched);
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
            mutation,
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

        expect(network.requests[1]).toEqual(buildQualifiedConnectedAccountGroupMutationRequestV4('patch', {
            service,
            groupId: 'team',
            policy: { ...policy, autoSwitch: true },
            expectedGeneration: 4,
            expectedIncarnation: 'qualified-group-row-team',
            expectedRuntimeStateRevision: 7,
        }));
        expect(network.requests[2]).toEqual({ method: 'POST', path: '/v4/connect/qualified/group/active-account', body: {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-a',
            expectedGeneration: 4,
            expectedIncarnation: 'qualified-group-row-team',
            expectedRuntimeStateRevision: 7,
            overrideRuntimeCooldown: true,
        } });
    });

    it('keeps admitted V4 create/member CRUD on exact qualified refs and runtime revisions', async () => {
        network.responses.push(...Array.from({ length: 4 }, () => ({ group: qualifiedGroup })));
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
            mutation,
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
        expect(network.requests[0]).toEqual(buildQualifiedConnectedAccountGroupMutationRequestV4('create', {
            service,
            group: { groupId: 'team', displayName: 'Team' },
        }));
        expect(network.requests[1]).toEqual(buildQualifiedConnectedAccountGroupMutationRequestV4('addMember', {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            priority: 200,
            enabled: true,
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        }));
        expect(network.requests[2]).toEqual(buildQualifiedConnectedAccountGroupMutationRequestV4('patchMember', {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            enabled: false,
            priority: 200,
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        }));
        expect(network.requests[3]).toEqual(buildQualifiedConnectedAccountGroupMutationRequestV4('removeMember', {
            group: { service, groupId: 'team' },
            connectedAccountId: 'account-b',
            expectedGeneration: 4,
            expectedIncarnation: qualifiedGroup.incarnation,
            expectedRuntimeStateRevision: 7,
        }));
    });

    it('rejects a mutation response bound to another group id', async () => {
        network.responses.push({
            group: {
                ...qualifiedGroup,
                ref: { service, groupId: 'other-team' },
            },
        });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
            mutation,
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
        network.responses.push({
            group: {
                ...qualifiedGroup,
                ref: { service, groupId: 'other-team' },
            },
        });
        const client = createQualifiedConnectedAccountGroupsClient({
            credentials,
            service,
            source: { protocol: 'v4' },
            mutation,
        });

        await expect(client.create({ groupId: 'team', displayName: 'Team' }))
            .rejects.toMatchObject({
                code: 'qualified_connected_accounts_inconsistent_peer',
            });
    });

});
