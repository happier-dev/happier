import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { AccountSettingsV2UpdateRequestSchema, BUILT_IN_ROLES_V1, RoleActionOutputSchemasV1, readLegacyRolesV1 } from '@happier-dev/protocol';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const rpc = vi.hoisted(() => ({ machine: vi.fn(), session: vi.fn() }));
// Unused HTTP boundary: machine sign-in never requests recipient-envelope preparation.
vi.mock('@/sync/api/session/sessionDataKeyEnvelopesApi', () => {
    const unused = () => { throw new Error('Machine Actions unexpectedly reached the recipient-envelope API'); };
    return { createSessionDataKeyEnvelopeClient: unused, readSessionDataKeyEnvelopeCollectionPage: unused,
        prepareSessionDataKeyEnvelopesForScope: unused, prepareSessionDataKeyEnvelopesDetached: unused };
});
// The remote daemon transport is the boundary; registry adaptation, inventory
// selection, Action admission and daemon-fact projection execute unchanged.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: rpc.machine,
}));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: rpc.session,
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
// These imports must follow the harness's doMock boundary installation. Load
// once during collection so cold transforms do not consume each hook's budget.
const { storage } = await import('@/sync/domains/state/storage');
const { clearDaemonMergedProjectionCacheForTests } = await import('@/agents/backendCatalog/loadDaemonMergedProjectionInputs');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

const facts = {
    installed: false, version: null, latestVersion: null,
    update: { supported: false, command: null },
    signIn: { status: 'unknown', loginSupport: 'manual_only' },
    platform: { supported: false, reason: 'arch' },
    install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null },
    dependencies: [{ key: 'remote-adapter', installed: true, version: '1.0' }],
} as const;

describe('UI machine Agent inventory Action transport', () => {
    beforeEach(async () => {
        await harness.reset();
        rpc.machine.mockReset();
        rpc.session.mockReset();
        clearDaemonMergedProjectionCacheForTests();
    });
    afterEach(() => standardCleanup());

    it('searches file content in the addressed Home through the real transport adapter', async () => {
        const serverId = await harness.addHome({ name: 'Search Home', serverUrl: 'https://search.test', accountId: 'alice' });
        const signal = new AbortController().signal;
        const page = { ok: true, files: [], hasMore: false, coverage: 'partial' };
        rpc.machine.mockResolvedValueOnce(page);
        expect(await createDefaultActionExecutor().execute('workspace.files.search', {
            machineId: 'machine', rootPath: '/project', query: 'needle', regex: false,
        }, { surface: 'ui', serverId, signal })).toEqual({ ok: true, result: page });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, machineId: 'machine',
            method: RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, payload: { rootPath: '/project', query: 'needle', regex: false }, signal }));
    });

    it('lists and mutates Account roles through the ordinary UI executor without a running Session', async () => {
        const serverId = await harness.addHome({ name: 'Roles Home', serverUrl: 'https://roles.test', accountId: 'alice' });
        let raw: Record<string, unknown> = {};
        let version = 0;
        // The genuine Settings HTTP boundary persists its CAS winner; all
        // migration, normalization and rebase logic above it remains real.
        harness.answer(serverId, '/v2/account/settings', { select: (input) => {
            if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (request.expectedVersion !== version) return { body: { success: false, error: 'version-mismatch', currentVersion: version,
                currentContent: { t: 'plain', v: raw } } };
            if (!request.content || request.content.t !== 'plain') throw new Error('Expected Plain Account settings');
            raw = request.content.v;
            version += 1;
            return { body: { success: true, version } };
        } });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        const execute = createDefaultActionExecutor().execute;
        const list = await execute('roles.list', {}, context);
        expect(list.ok).toBe(true);
        if (!list.ok) throw new Error(list.error);
        expect(RoleActionOutputSchemasV1['roles.list'].parse(list.result).items).toContainEqual({
            roleId: 'builder', role: BUILT_IN_ROLES_V1.builder, shared: false, viewOnly: false, migratedFromV0_2: false,
        });
        expect(await execute('roles.create', { roleId: 'my-role', role: BUILT_IN_ROLES_V1.builder }, context))
            .toEqual({ ok: true, result: { roleId: 'my-role', revision: { headerVersion: 1, bodyVersion: 1 } } });
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody('my-role')!)).toEqual(BUILT_IN_ROLES_V1.builder);
        expect(await execute('roles.update', { roleId: 'my-role', expectedRevision: { headerVersion: 1, bodyVersion: 0 },
            role: BUILT_IN_ROLES_V1.reviewer }, context)).toMatchObject({ ok: false, errorCode: 'currentness_conflict' });
        expect(await execute('roles.update', { roleId: 'my-role', expectedRevision: { headerVersion: 1, bodyVersion: 1 },
            role: BUILT_IN_ROLES_V1.reviewer }, context))
            .toEqual({ ok: true, result: { roleId: 'my-role', revision: { headerVersion: 2, bodyVersion: 2 } } });
        expect(JSON.parse(harness.artifacts(serverId).readPlainBody('my-role')!)).toEqual(BUILT_IN_ROLES_V1.reviewer);
        expect(await execute('roles.delete', { roleId: 'builder', expectedRevision: { headerVersion: 0, bodyVersion: 0 } }, context))
            .toMatchObject({ ok: false, errorCode: 'role_read_only' });
        expect(await execute('roles.override.set', { roleId: 'builder', instructionsOverride: 'Account instructions' }, context))
            .toEqual({ ok: true, result: { updated: true } });
        expect(raw.rolesV1).toMatchObject({ overrides: { builder: { instructionsOverride: 'Account instructions' } } });
        expect(await execute('roles.override.reset', { roleId: 'builder' }, context)).toEqual({ ok: true, result: { updated: true } });
        expect(raw.rolesV1).toEqual({ overrides: {} });
        expect(await execute('roles.delete', { roleId: 'my-role', expectedRevision: { headerVersion: 2, bodyVersion: 2 } }, context))
            .toEqual({ ok: true, result: { deleted: true } });
        expect(harness.artifacts(serverId).read('my-role')).toBeNull();
    });

    it('retains predecessor guidance Artifacts before the first Account role override cuts off read-through', async () => {
        const serverId = await harness.addHome({ name: 'Migrating Roles Home', serverUrl: 'https://migrating-roles.test', accountId: 'alice' });
        let raw: Record<string, unknown> = { executionRunsGuidanceEntries: [{ id: 'legacy-review', title: 'Review', description: 'Review carefully.' }] };
        const legacy = readLegacyRolesV1(raw, 'alice')[0];
        let version = 0;
        harness.answer(serverId, '/v2/account/settings', { select: (input) => {
            if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            expect(harness.artifacts(serverId).readPlainBody(legacy.artifactId)).toBe(JSON.stringify(legacy.role));
            if (!request.content || request.content.t !== 'plain') throw new Error('Expected Plain Account settings');
            raw = request.content.v;
            version += 1;
            return { body: { success: true, version } };
        } });
        expect(await createDefaultActionExecutor().execute('roles.override.set', { roleId: 'builder', workspaceWrites: 'deny' },
            { surface: 'ui', authority: 'present_user', serverId })).toEqual({ ok: true, result: { updated: true } });
        expect(raw.rolesV1).toMatchObject({ overrides: { builder: { workspaceWrites: 'deny' } } });
        expect(readLegacyRolesV1(raw, 'alice')).toEqual([]);
    });

    it('sends session notes and role writes to the exact Home Session owner and preserves refusals', async () => {
        const serverId = await harness.addHome({ name: 'Session Roles Home', serverUrl: 'https://session-roles.test', accountId: 'alice' });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        rpc.session.mockImplementation(async (request: { method: string }) => request.method === 'session.notes.set'
            ? { updated: true } : { ok: false, errorCode: 'role_policy_unenforceable', error: 'role_policy_unenforceable' });
        const execute = createDefaultActionExecutor().execute;
        expect(await execute('session.notes.set', { sessionId: 'child', notes: 'Retained notes' }, context))
            .toEqual({ ok: true, result: { updated: true } });
        expect(await execute('session.role.set', { sessionId: 'child', roleId: 'orchestrator' }, context))
            .toMatchObject({ ok: false, errorCode: 'role_policy_unenforceable' });
        expect(rpc.session.mock.calls.map(([request]) => request)).toEqual([
            expect.objectContaining({ serverId, sessionId: 'child', method: 'session.notes.set', payload: { sessionId: 'child', notes: 'Retained notes' } }),
            expect.objectContaining({ serverId, sessionId: 'child', method: 'session.role.set', payload: { sessionId: 'child', roleId: 'orchestrator' } }),
        ]);
    });

    it('does not complete a role read for a replaced Home Account', async () => {
        const serverId = await harness.addHome({ name: 'Retiring Roles Home', serverUrl: 'https://retiring-roles.test', accountId: 'alice' });
        let release!: () => void;
        let dispatched!: () => void;
        const pendingResponse = new Promise<void>((resolve) => { release = resolve; });
        const reachedTransport = new Promise<void>((resolve) => { dispatched = resolve; });
        harness.answer(serverId, 'GET /v1/artifacts', { select: () => {
            dispatched();
            return { body: { artifacts: [] }, respondAfter: pendingResponse };
        } });
        const pending = createDefaultActionExecutor().execute('roles.list', {}, { surface: 'ui', serverId, expectedAccountId: 'alice' });
        await reachedTransport;
        await harness.switchAccount(serverId, 'bob');
        release();
        expect(await pending).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    });

    it('keeps built-in role reads available when the serving daemon cannot supply a projection', async () => {
        const serverId = await harness.addHome({ name: 'Offline Plugin Home', serverUrl: 'https://offline-plugin.test', accountId: 'alice' });
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ activeAt: Date.now() })] } });
        rpc.machine.mockRejectedValue(new Error('Daemon transport unavailable'));
        const result = await createDefaultActionExecutor().execute('roles.list', {}, { surface: 'ui', serverId });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(RoleActionOutputSchemasV1['roles.list'].parse(result.result).items.map((entry) => entry.roleId))
            .toContain('builder');
    });

    it('includes plugin roles from the current daemon projection as overridable read-only sources', async () => {
        const serverId = await harness.addHome({ name: 'Plugin Roles Home', serverUrl: 'https://plugin-roles.test', accountId: 'alice' });
        let raw: Record<string, unknown> = {};
        let version = 0;
        harness.answer(serverId, '/v2/account/settings', { select: (input) => {
            if (input === undefined || input === null) return { body: { content: { t: 'plain', v: raw }, version } };
            const request = AccountSettingsV2UpdateRequestSchema.parse(input);
            if (!request.content || request.content.t !== 'plain') throw new Error('Expected Plain Account settings');
            raw = request.content.v;
            version += 1;
            return { body: { success: true, version } };
        } });
        storage.setState({ machineListByServerId: { [serverId]: [createMachineFixture({ activeAt: Date.now() })] } });
        rpc.machine.mockResolvedValue({ protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: {},
            installedPackagesById: { acme: { id: 'acme', displayName: 'Roles plugin', version: '1.0.0', enabled: true,
                source: { kind: 'path', locator: '/plugins/acme' }, occurrenceId: 'roles-plugin-occurrence' } }, familiesById: {
            roles: { family: 'roles', entriesById: {
                'acme/reviewer': { id: 'acme/reviewer', pluginId: 'acme', definition: { id: 'reviewer', ...BUILT_IN_ROLES_V1.reviewer } },
                'withdrawn/reviewer': { id: 'withdrawn/reviewer', pluginId: 'withdrawn', definition: { id: 'reviewer', ...BUILT_IN_ROLES_V1.reviewer } },
            } },
        } } });
        const execute = createDefaultActionExecutor().execute;
        const context = { surface: 'ui' as const, serverId };
        const result = await execute('roles.list', {}, context);
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.error);
        expect(RoleActionOutputSchemasV1['roles.list'].parse(result.result).items).toContainEqual({
            roleId: 'plugin:acme/reviewer', role: BUILT_IN_ROLES_V1.reviewer, shared: false, viewOnly: true, migratedFromV0_2: false,
        });
        expect(RoleActionOutputSchemasV1['roles.list'].parse(result.result).items.some((entry) => entry.roleId === 'plugin:withdrawn/reviewer')).toBe(false);
        expect(await execute('roles.override.set', { roleId: 'plugin:acme/reviewer', instructionsOverride: 'Account plugin override' }, context))
            .toEqual({ ok: true, result: { updated: true } });
        expect(raw.rolesV1).toMatchObject({ overrides: { 'plugin:acme/reviewer': { instructionsOverride: 'Account plugin override' } } });
        expect(await execute('roles.delete', { roleId: 'plugin:acme/reviewer', expectedRevision: { headerVersion: 1, bodyVersion: 1 } }, context))
            .toMatchObject({ ok: false, errorCode: 'role_read_only' });
        expect(await execute('roles.override.reset', { roleId: 'plugin:acme/reviewer' }, context))
            .toEqual({ ok: true, result: { updated: true } });
        expect(raw.rolesV1).toEqual({ overrides: {} });
    });

    it('uses the target daemon roster and returns daemon facts on the exact Home and machine', async () => {
        const serverId = await harness.addHome({ name: 'Inventory Home', serverUrl: 'https://inventory.test', accountId: 'alice' });
        rpc.machine.mockImplementation(async (request: { method: string }) => {
            if (request.method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
                return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {}, agentsById: {
                    'acme/helper': { id: 'helper', title: 'Remote Helper', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } },
                    'acme/viewer': { id: 'viewer', title: 'Viewer', capabilities: { surfaces: [] } },
                } } };
            }
            return { protocolVersion: 1, results: {
                'cli.acme/helper': { ok: true, checkedAt: 1, data: { ...facts, available: true, resolvedPath: '/private/path' } },
            } };
        });
        const result = await createDefaultActionExecutor().execute('machines.agents.list', {
            machineId: 'machine-1', serverId, refresh: true,
        }, { surface: 'ui', authority: 'present_user', serverId });
        expect(result).toEqual({ ok: true, result: { items: [{ agentId: 'acme/helper', title: 'Remote Helper', ...facts }] } });
        expect(rpc.machine.mock.calls.map(([request]) => request)).toEqual([
            expect.objectContaining({ machineId: 'machine-1', serverId, method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE }),
            expect.objectContaining({ machineId: 'machine-1', serverId, method: RPC_METHODS.CAPABILITIES_DETECT,
                payload: { requests: [{ id: 'cli.acme/helper', params: { includeLoginStatus: true, includeLatestVersion: true } }], bypassCache: true },
            }),
        ]);
    });

    it.each(['install', 'update'] as const)('starts a %s job on the captured Home with explicit vendor consent', async (intent) => {
        const serverId = await harness.addHome({ name: 'Setup Home', serverUrl: 'https://setup.test', accountId: 'alice' });
        const signal = new AbortController().signal;
        rpc.machine.mockResolvedValueOnce({ ok: true, jobId: 'job-1' });
        const result = await createDefaultActionExecutor().execute('machines.agents.install', {
            machineId: 'machine-1', agentId: 'acme/helper', intent,
            ...(intent === 'update' ? { consent: { vendorRecipe: true }, force: true } : {}),
        }, { surface: 'ui', authority: 'present_user', serverId, signal });
        expect(result).toEqual({ ok: true, result: { ok: true, jobId: 'job-1' } });
        expect(rpc.machine).toHaveBeenLastCalledWith({
            machineId: 'machine-1', serverId, signal, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_START,
            payload: { agentId: 'acme/helper', intent, consent: { vendorRecipe: intent === 'update' },
                ...(intent === 'update' ? { force: true } : {}),
            },
        });
    });

    it('preserves current job progress at a consumed cursor and exposes cancellation failure', async () => {
        const serverId = await harness.addHome({ name: 'Setup Home', serverUrl: 'https://setup.test', accountId: 'alice' });
        const signal = new AbortController().signal;
        const progress = [{ stepId: 'cli', bytesDone: 128, bytesTotal: 256 }];
        const snapshot = { ok: true, steps: [{ stepId: 'cli', label: 'Install CLI', state: 'running' }],
            progress, events: [], nextCursor: 4, done: false, outcome: null };
        rpc.machine.mockResolvedValueOnce(snapshot)
            .mockResolvedValueOnce({ ok: false, errorCode: 'job_not_found', error: 'No job' });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, signal };
        expect(await executor.execute('machines.agents.install.status', {
            machineId: 'machine-1', jobId: 'job-1', cursor: 4,
        }, context)).toEqual({ ok: true, result: snapshot });
        expect(await executor.execute('machines.agents.install.cancel', {
            machineId: 'machine-1', jobId: 'job-1',
        }, context)).toMatchObject({ ok: false, errorCode: 'job_not_found' });
        expect(rpc.machine.mock.calls.map(([request]) => request)).toEqual([
            { machineId: 'machine-1', serverId, signal, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_READ,
                payload: { jobId: 'job-1', cursor: 4 } },
            { machineId: 'machine-1', serverId, signal, method: RPC_METHODS.DAEMON_AGENTS_INSTALL_CANCEL,
                payload: { jobId: 'job-1' } },
        ]);
    });

    it('launches native sign-in through the terminal owner and reads the daemon status', async () => {
        const serverId = await harness.addHome({ name: 'Sign-in Home', serverUrl: 'https://signin.test', accountId: 'alice' });
        const signal = new AbortController().signal;
        const status = { status: 'signedIn', accountLabel: 'alice@example.invalid', checkedAt: 5,
            nativeLogin: 'login_terminal', connectedServices: [] };
        rpc.machine.mockResolvedValueOnce({ method: 'native', launch: { kind: 'agent_login', agentId: 'acme/helper' } })
            .mockResolvedValueOnce({ ok: true, terminalId: 'login-terminal', reused: false })
            .mockResolvedValueOnce(status);
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, signal };
        expect(await executor.execute('machines.agents.signIn.start', {
            machineId: 'machine-1', agentId: 'acme/helper', method: 'native',
        }, context)).toEqual({ ok: true, result: { terminalKey: 'provider-login:machine-1:acme/helper', terminalId: 'login-terminal' } });
        expect(await executor.execute('machines.agents.signIn.status', {
            machineId: 'machine-1', agentId: 'acme/helper',
        }, context)).toEqual({ ok: true, result: status });
        expect(rpc.machine.mock.calls.map(([request]) => request)).toEqual([
            { machineId: 'machine-1', serverId, signal: expect.any(AbortSignal), method: 'daemon.agents.signIn.prepare',
                payload: { agentId: 'acme/helper', method: 'native' } },
            { machineId: 'machine-1', serverId, timeoutMs: undefined, method: 'daemon.terminal.ensure',
                payload: { terminalKey: 'provider-login:machine-1:acme/helper', launch: { kind: 'agent_login', agentId: 'acme/helper' } } },
            { machineId: 'machine-1', serverId, signal, method: 'daemon.agents.signIn.status',
                payload: { agentId: 'acme/helper' } },
        ]);
    });

    it.each(['ui', 'agent'] as const)('preserves %s connected sign-in admission before the shared daemon owner', async (surface) => {
        const serverId = await harness.addHome({ name: 'Sign-in Home', serverUrl: 'https://signin.test', accountId: 'alice' });
        const signal = new AbortController().signal;
        const command = { operation: 'beginConnect', service: { pluginId: 'happier.agent.gemini', localId: 'gemini-account' }, modeId: 'api-key' };
        const unavailable = { status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' };
        rpc.machine.mockResolvedValueOnce({ method: 'connected', command }).mockResolvedValueOnce(unavailable);
        const result = await createDefaultActionExecutor().execute('machines.agents.signIn.start', {
            machineId: 'machine-1', agentId: 'gemini', method: 'connected', serviceId: 'gemini-account',
        }, { surface, authority: 'present_user', serverId, signal });
        if (surface === 'agent') {
            // An Agent cannot bypass the existing present-user approval gate.
            expect(result).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
            expect(rpc.machine).not.toHaveBeenCalled();
            return;
        }
        expect(result).toEqual({ ok: true, result: unavailable });
        expect(rpc.machine.mock.calls.map(([request]) => request)).toEqual([
            { machineId: 'machine-1', serverId, signal, method: 'daemon.agents.signIn.prepare',
                payload: { agentId: 'gemini', method: 'connected', serviceId: 'gemini-account' } },
            { machineId: 'machine-1', serverId, signal, method: 'daemon.connectedAccounts.authentication.command',
                payload: { v: 1, machineId: 'machine-1', command } },
        ]);
    });

    it('restarts and cancels the acquired native-login process through the UI Action owner', async () => {
        const serverId = await harness.addHome({ name: 'Lifecycle Home', serverUrl: 'https://lifecycle.test', accountId: 'alice' });
        let terminalId = 'first-login';
        const closed: string[] = [];
        rpc.machine.mockImplementation(async ({ method, payload }: { method: string; payload: { terminalId?: string } }) => {
            if (method === 'daemon.agents.signIn.prepare') return { method: 'native', launch: { kind: 'agent_login', agentId: 'codex' } };
            if (method === 'daemon.terminal.ensure') return { ok: true, terminalId, reused: false };
            if (method === 'daemon.terminal.list') return { ok: true, terminals: [{ terminalId, terminalKey: 'provider-login:machine-1:codex', cwd: '/fixture', ended: false, exit: null }] };
            if (method === 'daemon.terminal.close') { closed.push(payload.terminalId!); terminalId = 'second-login'; return { ok: true }; }
            throw new Error(method);
        });
        const executor = createDefaultActionExecutor();
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId };
        expect(await executor.execute('machines.agents.signIn.start', { machineId: 'machine-1', agentId: 'codex', method: 'native' }, context))
            .toMatchObject({ ok: true, result: { terminalId: 'first-login' } });
        expect(await executor.execute('machines.agents.signIn.restart', { machineId: 'machine-1', agentId: 'codex', terminalId: 'first-login' }, context))
            .toMatchObject({ ok: true, result: { terminalId: 'second-login' } });
        expect(await executor.execute('machines.agents.signIn.cancel', { machineId: 'machine-1', agentId: 'codex', terminalId: 'first-login' }, context))
            .toMatchObject({ ok: false, errorCode: 'sign_in_terminal_changed' });
        expect(closed).toEqual(['first-login']);
        expect(await executor.execute('machines.agents.signIn.cancel', { machineId: 'machine-1', agentId: 'codex', terminalId: 'second-login' }, context))
            .toEqual({ ok: true, result: { ok: true } });
        expect(closed).toEqual(['first-login', 'second-login']);
    });
});
