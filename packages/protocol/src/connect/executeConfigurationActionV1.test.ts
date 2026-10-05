import { describe, expect, it } from 'vitest';
import { executeConnectedServiceConfigurationActionV1, type ConnectedServiceConfigurationActionHostV1 } from './executeConfigurationActionV1.js';
import { reorderConnectedServicePoolMembersV1 } from './configurationActionsV1.js';
import { buildAgentDefaultChoices } from './agentDefaultChoices.js';
import { resolveQualifiedConnectedAccountLabel } from './connectedServiceProfilePreferences.js';
import { accountSettingsParse } from '../account/settings/accountSettings.js';
import { QualifiedConnectedAccountGroupV4Schema, QualifiedConnectedAccountGroupMemberDeleteV4Schema, QualifiedConnectedAccountGroupMemberMutationV4Schema, QualifiedConnectedAccountGroupRefSchema } from './qualifiedConnectedAccountsV4.js';
import { parseQualifiedConnectedAccountV4StructuredQueryValue } from './qualifiedConnectedAccountsV4QueryCodec.js';
import { ConnectedServiceAuthGroupPolicyV1Schema } from './connectedServiceSchemas.js';
import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const agent = { agentId: 'codex', title: 'Codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' }, connectedAccounts: [{ purpose: 'model', service }] };
const target = { kind: 'group' as const, service, groupId: 'work' };

describe('connected-service configuration Action owner', () => {
    it('preserves transport dispositions through the canonical Action executor', async () => {
        let code = 'outcome_unknown';
        // HTTP is the boundary; connected-service parsing and executor settlement remain real.
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {},
            async request() { throw Object.assign(new Error('transport disposition'), { code }); },
            async mutateSettings() { throw new Error('unexpected_settings'); },
            async resolveAgent() { throw new Error('unexpected_catalog'); },
            async resetQuota() { throw new Error('unexpected_reset'); },
        };
        const connectedServiceAction: NonNullable<ActionExecutorDeps['connectedServiceAction']> = ({ actionId, input }) =>
            executeConnectedServiceConfigurationActionV1(host, actionId, input);
        const executor = createActionExecutor({ connectedServiceAction } as unknown as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        for (const [transportCode, errorCode] of [
            ['outcome_unknown', 'outcome_unknown'],
            ['cancelled', 'cancelled'],
            ['ECONNREFUSED', 'server_unreachable'],
            ['unknown_transport_code', 'action_failed'],
        ] as const) {
            code = transportCode;
            expect(await executor.execute('connectedServices.pools.create', { service, group: { groupId: 'work' } }, context))
                .toMatchObject({ ok: false, errorCode });
        }
    });
    it('sets account defaults and applies pool CRUD and member edits through the existing fenced endpoints', async () => {
        let settings: Record<string, unknown> = { other: 'retained' };
        const pool = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'pool-life', displayName: 'Team',
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 0, updatedAt: 0, members: [],
        });
        const requests: Array<{ method: string; path: string; body?: unknown }> = [];
        let deletionAcknowledged = true;
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {}, async request(request) {
                requests.push(request);
                if (request.method === 'GET') throw Object.assign(new Error('connect_group_not_found'), { code: 'connect_group_not_found' });
                return request.method === 'DELETE' && request.path.startsWith('/v4/connect/qualified/group?') ? { success: deletionAcknowledged } : { group: pool };
            },
            async mutateSettings(mutate) { settings = mutate(settings); }, async resolveAgent() { return agent; }, async resetQuota() { throw new Error('unexpected_reset'); },
        };
        const executor = createActionExecutor({ connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input) } as unknown as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        const accountTarget = { kind: 'account' as const, account: { service, accountId: 'personal' } };
        expect(await executor.execute('connectedServices.accounts.default.set', { account: accountTarget.account, agentId: 'codex', makeDefault: true }, context)).toEqual({ ok: true, result: { applied: true } });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target: accountTarget })[0]?.isDefault).toBe(true);
        expect(await executor.execute('connectedServices.accounts.default.set', { account: accountTarget.account, agentId: 'codex', makeDefault: false }, context)).toEqual({ ok: true, result: { applied: true } });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target: accountTarget })[0]?.isDefault).toBe(false);
        const revision = { expectedGeneration: 1, expectedIncarnation: 'pool-life', expectedRuntimeStateRevision: 0 };
        const cases = [
            ['connectedServices.pools.create', { service, group: { groupId: 'work', displayName: 'Team' } }, 'POST', '/v4/connect/qualified/groups'],
            ['connectedServices.pools.patch', { service, groupId: 'work', displayName: 'Renamed', policy: { ...pool.policy, autoSwitch: true }, ...revision }, 'PATCH', '/v4/connect/qualified/group'],
            ['connectedServices.pools.members.add', { group: pool.ref, connectedAccountId: 'personal', priority: 100, enabled: true, ...revision }, 'POST', '/v4/connect/qualified/group/members'],
            ['connectedServices.pools.members.patch', { group: pool.ref, connectedAccountId: 'personal', enabled: false, ...revision }, 'PATCH', '/v4/connect/qualified/group/member'],
            ['connectedServices.pools.members.remove', { group: pool.ref, connectedAccountId: 'personal', ...revision }, 'DELETE', '/v4/connect/qualified/group/member'],
        ] as const;
        for (const [id, input, method, path] of cases) {
            expect(await executor.execute(id, input, context)).toEqual({ ok: true, result: { group: pool } });
            const request = requests.at(-1)!;
            if (method === 'DELETE') {
                const url = new URL(request.path, 'https://home.test');
                expect({ method: request.method, path: url.pathname, body: request.body }).toEqual({ method, path, body: undefined });
                expect(parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupMemberDeleteV4Schema, url.searchParams.get('mutation')!)).toEqual(input);
            } else expect(request).toEqual({ method, path, body: id === 'connectedServices.pools.create' ? { ...input, group: { groupId: 'work', displayName: 'Team', state: {} } } : input });
        }
        await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.default.set', { group: pool.ref, agentId: 'codex', makeDefault: true });
        deletionAcknowledged = false;
        const beforeRejectedDelete = settings;
        expect(await executor.execute('connectedServices.pools.delete', { group: pool.ref, ...revision }, context)).toMatchObject({ ok: false });
        expect(settings).toBe(beforeRejectedDelete);
        deletionAcknowledged = true;
        expect(await executor.execute('connectedServices.pools.delete', { group: pool.ref, ...revision }, context)).toEqual({ ok: true, result: { applied: true } });
        const deletion = new URL(requests.findLast((request) => request.method === 'DELETE')!.path, 'https://home.test');
        expect(parseQualifiedConnectedAccountV4StructuredQueryValue(QualifiedConnectedAccountGroupRefSchema, deletion.searchParams.get('group')!)).toEqual(pool.ref);
        expect(deletion.searchParams.get('expectedIncarnation')).toBe('pool-life');
        expect(deletion.searchParams.get('expectedGeneration')).toBe('1');
        expect(deletion.searchParams.get('expectedRuntimeStateRevision')).toBe('0');
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target })[0]?.isDefault).toBe(false);
        expect(settings.other).toBe('retained');
    });
    it('preserves a recreated pool default when the old deletion acknowledgement arrives late', async () => {
        let settings: Record<string, unknown> = {};
        const replacement = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' }, incarnation: 'replacement-life', displayName: 'Replacement',
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 1, updatedAt: 1, members: [],
        });
        let acknowledge: (value: unknown) => void = () => { throw new Error('delete_not_started'); };
        const acknowledgement = new Promise<unknown>((resolve) => { acknowledge = resolve; });
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {}, async request(request) {
                return request.method === 'DELETE' ? acknowledgement : { group: replacement };
            },
            async mutateSettings(mutate) { settings = mutate(settings); }, async resolveAgent() { return agent; }, async resetQuota() { throw new Error('unexpected_reset'); },
        };
        const pending = executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.delete', {
            group: replacement.ref, expectedGeneration: 1, expectedIncarnation: 'original-life', expectedRuntimeStateRevision: 0,
        });
        // The old DELETE has committed, but its HTTP acknowledgement is held while the
        // same id is recreated and the user explicitly selects that replacement.
        await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.default.set', { group: replacement.ref, agentId: 'codex', makeDefault: true });
        acknowledge({ success: true });
        await expect(pending).resolves.toEqual({ applied: true });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target })[0]?.isDefault).toBe(true);
        const unreadableHost: ConnectedServiceConfigurationActionHostV1 = {
            ...host,
            async request(request) {
                if (request.method === 'DELETE') return { success: true };
                throw Object.assign(new Error('transport_unavailable'), { code: 'transport_unavailable' });
            },
        };
        await expect(executeConnectedServiceConfigurationActionV1(unreadableHost, 'connectedServices.pools.delete', {
            group: replacement.ref, expectedGeneration: 1, expectedIncarnation: replacement.incarnation,
        })).rejects.toMatchObject({ code: 'transport_unavailable' });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target })[0]?.isDefault).toBe(true);
    });
    it('lets an agent refresh the exact qualified account and rejects an unacknowledged refresh', async () => {
        const account = { service, accountId: 'work-account' };
        const requests: unknown[] = [];
        let response: unknown = { success: true };
        const describedAdmission = { status: 'described', service,
            descriptor: { id: 'openai-codex', title: 'Codex', authentication: { defaultModeId: 'oauth', modes: [{ id: 'oauth', kind: 'oauthAuthorizationCode', pkce: 'required', outcomeReconciliation: 'none' }] } },
            occurrenceId: 'occurrence-1', sourceCustody: { kind: 'bundled_first_party', packagedRuntime: { kind: 'cli_version_root', versionRootId: 'cli-1' } },
            accounts: [], operationTransport: { kind: 'v4' },
        };
        let admission: unknown = describedAdmission;
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {},
            async request(request) { requests.push(request); return response; },
            async mutateSettings() { throw new Error('unexpected_settings'); },
            async resolveAgent() { throw new Error('unexpected_catalog'); },
            async resetQuota() { throw new Error('unexpected_reset'); },
            async controlCommand(machineId, command) { requests.push({ machineId, command }); return admission; },
        };
        // HTTP is substituted; Action admission, input parsing and execution remain real.
        const executor = createActionExecutor({ connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input) } as unknown as ActionExecutorDeps);
        const context = { surface: 'agent' as const, authority: 'account_automation' as const, actionCaller: { kind: 'host' as const } };
        const actionId = 'connectedServices.quota.refresh';
        const input = { account, machineId: 'machine-work' };
        expect(await executor.execute(actionId, input, context)).toEqual({ ok: true, result: { applied: true } });
        expect(requests).toEqual([{ machineId: 'machine-work', command: { operation: 'describeService', service, requiredOperation: 'quota_refresh' } },
            { method: 'POST', path: '/v4/connect/qualified/quotas/refresh', body: { ref: account } }]);
        response = { success: false };
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false });
        admission = { status: 'unavailable', code: 'quota_refresh_unavailable' };
        response = { success: true };
        expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'quota_refresh_unavailable' });
        for (const invalidAdmission of [
            { ...describedAdmission, service: { ...service, pluginId: 'other.plugin' } },
            { ...describedAdmission, operationTransport: { kind: 'legacy', peerClass: 'revisioned_v2_v3', serviceId: 'openai-codex' } },
            { ...describedAdmission, operationTransport: undefined },
        ]) {
            admission = invalidAdmission;
            expect(await executor.execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'connected_account_v4_operation_unsupported' });
        }
        expect(requests.filter((request) => typeof request === 'object' && request !== null && 'method' in request)).toHaveLength(2);
        const beforeInvalid = requests.length;
        expect(await executor.execute(actionId, { ...input, accountId: 'foreign' }, context)).toMatchObject({ ok: false });
        expect(requests).toHaveLength(beforeInvalid);
    });
    it('refuses a switch response for another pool rather than reporting success', async () => {
        const group = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'foreign' }, incarnation: 'life', displayName: null,
            policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}), activeConnectedAccountId: null, generation: 1, runtimeStateRevision: 0,
            state: {}, createdAt: 0, updatedAt: 0, members: [],
        });
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {}, async request() { return { group }; },
            async mutateSettings() { throw new Error('unexpected_settings'); }, async resolveAgent() { return null; }, async resetQuota() { throw new Error('unexpected_reset'); },
        };
        await expect(executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.switchNow', {
            group: { service, groupId: 'work' }, connectedAccountId: 'personal', expectedGeneration: 1,
        })).rejects.toMatchObject({ code: 'qualified_connected_accounts_inconsistent_peer' });
    });
    it('renames predecessor labels without changing unrelated settings, writes defaults through purpose bindings, and keeps privacy local', async () => {
        let settings: Record<string, unknown> = { other: { retained: true }, connectedServicesProfileLabelByKey: { 'openai-codex/personal': 'Old' } };
        let hidden = false;
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {},
            async request() { throw new Error('unexpected_network'); },
            async mutateSettings(mutate) { settings = mutate(settings); },
            async resolveAgent() { return agent; },
            async resetQuota() { throw new Error('unexpected_reset'); },
            setIdentityPrivacy(value) { hidden = value; },
        };
        // The settings/network/device boundary is injected; admission, schema parsing and domain writers remain real.
        const executor = createActionExecutor({ connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input) } as unknown as ActionExecutorDeps);
        const context = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        expect(await executor.execute('connectedServices.accounts.rename', { account: { service, accountId: 'personal' }, label: ' Team ' }, context)).toEqual({ ok: true, result: { applied: true } });
        const labels = settings.connectedServicesProfileLabelByKey as Record<string, string>;
        expect(resolveQualifiedConnectedAccountLabel({ service, legacyServiceId: 'openai-codex', accountId: 'personal', labelsByKey: labels })).toBe('Team');
        expect(labels['openai-codex/personal']).toBeUndefined();
        expect(settings.other).toEqual({ retained: true });
        await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.default.set', { group: { service, groupId: 'work' }, agentId: 'codex', makeDefault: true });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target })[0]?.isDefault).toBe(true);
        await executeConnectedServiceConfigurationActionV1(host, 'connectedServices.pools.default.set', { group: { service, groupId: 'work' }, agentId: 'codex', makeDefault: false });
        expect(buildAgentDefaultChoices({ agents: [agent], settings: accountSettingsParse(settings), target })[0]?.isDefault).toBe(false);
        const beforePrivacy = settings;
        expect(await executor.execute('connectedServices.identityPrivacy.set', { hidden: true }, context)).toEqual({ ok: true, result: { applied: true } });
        expect(hidden).toBe(true);
        expect(settings).toBe(beforePrivacy);
    });

    it('rejects incomplete or duplicate member orders before writes, chains current revision responses, and stops on rejection', async () => {
        const group = { generation: 1, members: [{ accountId: 'a', priority: 100 }, { accountId: 'b', priority: 200 }] };
        const writes: number[] = [];
        const members = (current: typeof group) => current.members;
        const patch = async (current: typeof group, accountId: string, priority: number) => {
            writes.push(current.generation);
            return { generation: current.generation + 1, members: current.members.map((member) => member.accountId === accountId ? { accountId, priority } : member) };
        };
        for (const accountIds of [['a'], ['a', 'a'], ['a', 'foreign']]) {
            await expect(reorderConnectedServicePoolMembersV1({ group, accountIds, members, patch })).rejects.toMatchObject({ code: 'invalid_pool_member_order' });
        }
        expect(writes).toEqual([]);
        const updated = await reorderConnectedServicePoolMembersV1({ group, accountIds: ['b', 'a'], members, patch });
        expect(writes).toEqual([1, 2]);
        expect(updated?.members).toEqual([{ accountId: 'a', priority: 200 }, { accountId: 'b', priority: 100 }]);
        await expect(reorderConnectedServicePoolMembersV1({ group, accountIds: ['b', 'a'], members, patch: async () => null })).resolves.toBeNull();
    });

    it('accepts a semantic member move against current pool membership and preserves revision fences', async () => {
        const pool = QualifiedConnectedAccountGroupV4Schema.parse({ v: 1, ref: { service, groupId: 'work' },
            incarnation: 'pool-life', displayName: 'Work', policy: ConnectedServiceAuthGroupPolicyV1Schema.parse({}),
            activeConnectedAccountId: null, generation: 7, runtimeStateRevision: 2, state: {}, createdAt: 0, updatedAt: 0,
            members: ['a', 'new', 'b'].map((connectedAccountId, index) => ({ v: 1, connectedAccountId, priority: (index + 1) * 100, enabled: true, createdAt: 0, updatedAt: 0 })),
        });
        let current = pool;
        const writes: unknown[] = [];
        const host: ConnectedServiceConfigurationActionHostV1 = {
            assertCurrent() {},
            async request(request) {
                if (request.method === 'GET') return { group: current };
                writes.push(request.body);
                const body = QualifiedConnectedAccountGroupMemberMutationV4Schema.parse(request.body);
                expect(body.expectedGeneration).toBe(current.generation);
                current = { ...current, generation: current.generation + 1, members: current.members.map(member => member.connectedAccountId === body.connectedAccountId ? { ...member, priority: body.priority! } : member) };
                return { group: current };
            },
            async mutateSettings() { throw new Error('unexpected_settings'); }, async resolveAgent() { return agent; }, async resetQuota() { throw new Error('unexpected_reset'); },
        };
        const executor = createActionExecutor({ connectedServiceAction: ({ actionId, input }) => executeConnectedServiceConfigurationActionV1(host, actionId, input) } as unknown as ActionExecutorDeps);
        const result = await executor.execute('connectedServices.pools.reorder', {
            group: pool.ref, move: { accountId: 'b', position: { anchorId: 'a', placement: 'before' } },
        }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result).toEqual({ ok: true, result: { applied: true } });
        expect([...current.members].sort((a, b) => a.priority - b.priority).map(member => member.connectedAccountId)).toEqual(['b', 'a', 'new']);
        expect(writes).toHaveLength(3);
    });

});
