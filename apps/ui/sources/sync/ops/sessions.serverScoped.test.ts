import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionModelSelectionV1Schema, SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

// Admit the network boundary before loading runtime consumers. Module transformation
// belongs to collection, outside the fixture hooks' runtime-operation budget.
const boundary = await installSessionOpsNetworkBoundary();
const storage = (await import('@/sync/domains/state/storage')).storage;
const fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
const machineFixtures = await import('@/dev/testkit/fixtures/machineFixtures');
const metadata = await import('@happier-dev/session-core/state');
const ops = await import('./sessions');

describe('session resume and fork routing through the Home and Account boundary', () => {
    let home: Awaited<ReturnType<SessionOpsNetworkBoundary['addHome']>>;
    let unarchiveStatus: number;
    let lifecycle: string[];
    let settingsHttp: ReturnType<typeof import('@/dev/testkit/harness/actionHomesHttpHarness').createAccountSettingsHttpBoundary> | null;
    let retireSettingsAfterRead: boolean;
    let unregisterSettingsPreparation: (() => void) | null;
    let censusMachineIds: Set<string>;
    let respondHttp: Parameters<SessionOpsNetworkBoundary['setHttpResponder']>[0];

    const providerModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1, updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_work', modelId: 'provider-model' },
    });
    const nativeModelSelection = SessionModelSelectionV1Schema.parse({
        v: 1, updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'native-model' },
    });
    const providerBinding = {
        v: 1, connectionId: 'pc_work', contributionKey: 'plugin/p', connectionRevision: 1,
        protocol: 'openai-responses', materialization: 'engineConfig', adapterBindingKey: 'p_pc_work',
        compatibilityFingerprint: 'compatibility:v1:work', bindingSecurityFingerprint: 'binding-security:v1:work',
        displaySnapshot: { providerName: 'Provider', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
    };

    beforeEach(async () => {
        storage.setState(storage.getInitialState(), true);
        boundary.resetRequests();
        home = await boundary.addHome('https://session-ops.example.test', 'session-ops-account');
        unarchiveStatus = 200;
        lifecycle = [];
        settingsHttp = null;
        retireSettingsAfterRead = false;
        unregisterSettingsPreparation = null;
        censusMachineIds = new Set();
        for (const sessionId of ['session-1', 'session-success', 'session-native', 'sess-parent']) setSession(sessionId);
        setMachine('machine-1');
        respondHttp = async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/machines') return Response.json([...censusMachineIds].map((id) => machineFixtures.createPlainMachineRowFixture({ id, accountId: home.accountId })));
            if (path === '/v1/machines/read-batch' && init?.method === 'POST') return machineFixtures.createMachineReadBatchResponseFixture(init.body,
                id => censusMachineIds.has(id) ? machineFixtures.createPlainMachineRowFixture({ id, accountId: home.accountId }) : null);
            if (path.startsWith('/v1/machines/')) {
                const id = decodeURIComponent(path.slice('/v1/machines/'.length));
                return censusMachineIds.has(id)
                    ? Response.json({ machine: machineFixtures.createPlainMachineRowFixture({ id, accountId: home.accountId }) })
                    : Response.json({ error: 'machine-not-found' }, { status: 404 });
            }
            const settingsResponse = settingsHttp?.handle(input, init);
            if (settingsResponse) {
                if (retireSettingsAfterRead && path === '/v2/account/settings' && (init?.method ?? 'GET') === 'GET') {
                    storage.setState({ settingsScope: { serverId: home.id, accountId: 'replacement-account' } });
                }
                return settingsResponse;
            }
            if (path.endsWith('/unarchive')) {
                lifecycle.push('unarchive');
                return unarchiveStatus === 200
                    ? Response.json({ success: true, archivedAt: null })
                    : new Response('Forbidden', { status: unarchiveStatus });
            }
            if (path.startsWith('/v2/sessions/')) {
                const id = decodeURIComponent(path.slice('/v2/sessions/'.length));
                const session = storage.getState().sessions[id];
                return Response.json({ session: fixtures.createPlainSessionCurrentProjectionRecordFixture({ id,
                    ...(session ? { active: session.active, seq: session.seq, archivedAt: session.archivedAt ?? null,
                        metadata: session.metadata } : {}) }) });
            }
            if (path.startsWith('/v1/sessions/') && path.endsWith('/turns')) {
                const sessionId = decodeURIComponent(path.slice('/v1/sessions/'.length, -'/turns'.length));
                return Response.json({ v: 1, sessionId, updatedAt: 1, turns: [] });
            }
            return null;
        };
        boundary.setHttpResponder(createSessionReadBatchFetchBoundary(respondHttp));
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        boundary.respond(RPC_METHODS.SESSION_FORK, { ok: true, childSessionId: 'sess-child' });
        vi.stubEnv('EXPO_PUBLIC_HAPPIER_SPAWN_SESSION_RPC_TIMEOUT_MS', '');
        // Only Date is frozen: the operation's ACK budget is observable without replacing network timers.
        vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
        unregisterSettingsPreparation?.();
        for (const sessionId of Object.keys(storage.getState().sessions)) storage.getState().clearSessionResuming(sessionId);
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllEnvs();
    });

    afterAll(() => boundary?.dispose());

    function setSession(id: string, overrides: Partial<Session> = {}) {
        storage.setState((state) => ({ sessions: {
            ...state.sessions,
            [id]: fixtures.createSessionFixture({ id, serverId: home.id,
                metadata: metadata.MetadataSchema.parse({ path: '/tmp', host: 'host.local', machineId: 'machine-1' }),
                ...overrides }),
        } }));
    }

    function setMachine(id: string, version = '0.0.0-test') {
        censusMachineIds.add(id);
        const machine = machineFixtures.createMachineFixture({ id, daemonState: { cliVersion: version } });
        storage.setState((state) => ({
            machines: { ...state.machines, [id]: machine },
            machineListByServerId: { ...state.machineListByServerId,
                [home.id]: [...(state.machineListByServerId[home.id] ?? []).filter((row) => row.id !== id), machine] },
        }));
    }

    function resumeOptions(overrides: Partial<Parameters<typeof ops.resumeSession>[0]> = {}) {
        return { sessionId: 'session-1', machineId: 'machine-1', directory: '/tmp',
            backendTarget: { kind: 'builtInAgent', agentId: 'claude' }, serverId: home.id,
            executionAuthority: 'present_user',
            ...overrides } satisfies Parameters<typeof ops.resumeSession>[0];
    }

    function resumeRequests() {
        return boundary.requests.filter((request) => request.method === RPC_METHODS.SPAWN_HAPPY_SESSION
            || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE);
    }

    function forkRequests() {
        return boundary.requests.filter((request) => request.method === RPC_METHODS.SESSION_FORK
            || request.method === RPC_METHODS.SESSION_FORK_PROVIDER_SAFE);
    }

    function rejectRpc(errorCode: string) {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'RPC method not available', errorCode }));
    }

    async function installSettingsPreparation() {
        const { createAccountSettingsHttpBoundary } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
        const { registerAccountSettingsDaemonSpawnPreparation } = await import('./accountSettingsDaemonSpawnPreparation');
        const { prepareAccountSettingsForDaemonSpawn } = await import('@/sync/engine/settings/prepareAccountSettingsForDaemonSpawn');
        const { syncSettings } = await import('@/sync/engine/settings/syncSettings');
        const settingsScope = { serverId: home.id, accountId: home.accountId };
        storage.setState({ settingsScope, settingsVersion: null });
        settingsHttp = createAccountSettingsHttpBoundary({ serverUrl: home.serverUrl,
            initialAccounts: [{ accountId: home.accountId, snapshot: { content: { t: 'plain', v: {} }, version: 23 } }] });
        // Compose the real preparation and Settings owners; only their Home HTTP peer is synthetic.
        unregisterSettingsPreparation = registerAccountSettingsDaemonSpawnPreparation(async () => await prepareAccountSettingsForDaemonSpawn({
            settingsScope, pendingSettings: {},
            getActiveSettingsScope: () => storage.getState().settingsScope,
            getCurrentSettingsVersion: () => storage.getState().settingsVersion,
            flushPendingServerSettings: async () => {
                await syncSettings({ credentials: { token: home.token }, encryption: null, settingsScope,
                    pendingSettings: {}, getPendingSettings: () => ({}), clearPendingSettings: () => {} });
            },
            clearPendingSettings: () => {},
        }));
    }

    it.each([false, true])('does not unarchive or start an archived pending-input consumer (active: %s)', async (active) => {
        setSession('session-1', { active, archivedAt: 123 });
        const { isAppliedActiveServerRuntimeAvailable, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const previousAvailability = isAppliedActiveServerRuntimeAvailable();
        publishAppliedActiveServerRuntimeAvailability(true);
        try {
            await expect(ops.ensureSessionRuntimeForPendingInput(resumeOptions())).resolves.toMatchObject({
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            });
            expect(storage.getState().sessions['session-1'].archivedAt).toBe(123);
            expect(storage.getState().sessions['session-1'].resumingAt).toBeFalsy();
            expect(boundary.requests).toEqual([]);
            expect(boundary.httpRequests).toEqual([]);
        } finally { publishAppliedActiveServerRuntimeAvailability(previousAvailability); }
    });

    it('restores an archived session before issuing its resume spawn', async () => {
        setSession('session-1', { archivedAt: 123 });
        boundary.setRpcResponder(async () => {
            lifecycle.push('resume');
            return { type: 'success', sessionId: 'session-1' };
        });
        await expect(ops.resumeSession(resumeOptions())).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(lifecycle).toEqual(['unarchive', 'resume']);
        expect(resumeRequests()).toEqual([expect.objectContaining({ serverUrl: home.serverUrl, token: home.token })]);
    });

    it('reports local Resume target validation as INVALID_REQUEST without issuing a spawn', async () => {
        const result = await ops.resumeSession(resumeOptions({
            backendTarget: { kind: 'backend', backendId: 'custom-acp', sourceKind: 'built_in' },
        }));
        expect(result).toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
        expect(result).toHaveProperty('errorMessage', expect.stringContaining('backendTarget must identify an executable Agent'));
        expect(result).not.toHaveProperty('rpcErrorCode');
        expect(resumeRequests()).toEqual([]);
        expect(storage.getState().sessions['session-1'].resumingAt).toBeFalsy();
    });

    it('does not issue a resume spawn when restoring an archived session fails', async () => {
        setSession('session-1', { archivedAt: 123 });
        unarchiveStatus = 403;
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({
            type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Forbidden',
        });
        expect(lifecycle).toEqual(['unarchive']);
        expect(resumeRequests()).toEqual([]);
    });

    it('does not unarchive an already-unarchived session before resuming it', async () => {
        await expect(ops.resumeSession(resumeOptions())).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(lifecycle).toEqual([]);
        expect(resumeRequests()).toHaveLength(1);
        expect(resumeRequests()[0]?.payload).toMatchObject({
            executionAuthorization: { provenance: 'user_request', requestId: expect.any(String) },
        });
    });

    it('preserves a disabled Agent launch refusal and resumes after it is re-enabled', async () => {
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'error', errorCode: 'SPAWN_FAILED',
            errorMessage: 'Plugin disabled', errorDetail: { kind: 'launch_error', code: 'plugin_disabled', message: 'Plugin disabled' } });
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({
            type: 'error', errorCode: 'plugin_disabled',
        });
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'session-1' });
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toHaveLength(2);
    });

    it('keeps automatic Pending wake distinct from explicit Resume intent', async () => {
        await expect(ops.ensureSessionRuntimeForPendingInput(resumeOptions()))
            .resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toHaveLength(1);
        expect(resumeRequests()[0]?.payload).not.toHaveProperty('executionAuthorization');
    });

    it.each([undefined, 'account_automation'] as const)('does not promote %s authority from an authored Resume marker', async executionAuthority => {
        await expect(ops.resumeSession(resumeOptions({ executionAuthority,
            executionAuthorization: { provenance: 'user_request', requestId: 'authored-person-marker' },
        }))).resolves.toMatchObject({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toHaveLength(1);
        expect(resumeRequests()[0]?.payload).not.toHaveProperty('executionAuthorization');
    });

    it.each(['present_user', 'account_automation'] as const)('retains %s authority through the real Resume Action executor', async authority => {
        const sessionId = 'c123456789012345678901234';
        setSession(sessionId, { active: false, metadata: metadata.MetadataSchema.parse({
            path: '/tmp', host: 'host.local', machineId: 'machine-1', flavor: 'claude', claudeSessionId: 'native-session',
        }) });
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId });
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, { type: 'success', sessionId });
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.open', {
            sessionId, serverId: home.id, intent: 'resume',
        }, { serverId: home.id, surface: 'ui', authority, actionRequestId: 'exact-resume-action', bypassApprovals: true });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'opened' } });
        expect(resumeRequests()).toHaveLength(1);
        if (authority === 'present_user') {
            expect(resumeRequests()[0]?.payload).toMatchObject({
                executionAuthorization: { provenance: 'user_request', requestId: 'exact-resume-action' },
            });
        } else {
            expect(resumeRequests()[0]?.payload).not.toHaveProperty('executionAuthorization');
        }
    });

    it('waits for nonce-correlated runtime readiness before completing a guarded resume', async () => {
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, {
            type: 'success', sessionId: 'session-1', spawnNonce: 'execution-run-host-op-1', sessionIdStatus: 'pending',
        });
        boundary.respond(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE, { status: 'success', sessionId: 'session-1' });
        await expect(ops.resumeSession(resumeOptions({ spawnNonce: 'execution-run-host-op-1', waitForReady: true })))
            .resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(boundary.requests).toEqual([
            expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION,
                payload: expect.objectContaining({ type: 'resume-session', sessionId: 'session-1', spawnNonce: 'execution-run-host-op-1' }) }),
            expect.objectContaining({ method: RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE,
                payload: { spawnNonce: 'execution-run-host-op-1' } }),
        ]);
    });

    it.each([RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND])(
        'keeps Provider resume refusal on the current-only RPC when the daemon returns %s', async (errorCode) => {
            rejectRpc(errorCode);
            await expect(ops.resumeSession(resumeOptions({ modelSelection: providerModelSelection }))).resolves.toMatchObject({
                type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE,
            });
            expect(storage.getState().sessions['session-1'].resumingAt).toBeNull();
            // METHOD_NOT_AVAILABLE proves no effect and admits the scoped RPC owner's one retry.
            expect(resumeRequests()).toEqual(Array.from({ length: errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE ? 2 : 1 }, () => expect.objectContaining({
                method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, serverUrl: home.serverUrl, token: home.token,
            })));
        },
    );

    it.each([
        ['no hydrated Session', null, undefined],
        ['a persisted Provider binding', { providerBindingV1: providerBinding }, undefined],
        ['a persisted Provider binding with explicit native selection', { providerBindingV1: providerBinding }, nativeModelSelection],
        ['malformed-but-present Provider binding', { providerBindingV1: { v: 1, connectionId: 'pc_work' } }, undefined],
    ] as const)('requires Provider-safe resume proof for %s', async (_label, ownerMetadata, modelSelection) => {
        const sessionId = 'session-provider';
        if (ownerMetadata) setSession(sessionId, { metadata: metadata.MetadataSchema.parse({ path: '/tmp', host: 'host.local', machineId: 'machine-1', ...ownerMetadata }) });
        rejectRpc(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        await expect(ops.resumeSession(resumeOptions({ sessionId, ...(modelSelection ? { modelSelection } : {}) })))
            .resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
        expect(resumeRequests()).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, serverUrl: home.serverUrl, token: home.token,
        })));
    });

    it('resumes a Provider-bound session through the atomic Provider-safe RPC', async () => {
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE, { type: 'success', sessionId: 'session-provider' });
        await expect(ops.resumeSession(resumeOptions({ sessionId: 'session-provider', modelSelection: providerModelSelection,
            preferScopedMachineRpc: true }))).resolves.toEqual({ type: 'success', sessionId: 'session-provider' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
            serverUrl: home.serverUrl, token: home.token, payload: expect.objectContaining({ modelSelection: providerModelSelection }) })]);
    });

    it.each([undefined, nativeModelSelection])('uses the legacy-compatible resume RPC for native intent (%j)', async (modelSelection) => {
        await expect(ops.resumeSession(resumeOptions({ ...(modelSelection ? { modelSelection } : {}) })))
            .resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION })]);
    });

    it('does not probe for an implicit persisted native model selection on resume', async () => {
        setSession('session-native', { metadata: metadata.MetadataSchema.parse({ path: '/tmp', host: 'host.local', machineId: 'machine-1',
            modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: nativeModelSelection.ref } }) });
        await expect(ops.resumeSession(resumeOptions({ sessionId: 'session-native' }))).resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION })]);
    });

    it.each([true, false])('projects pending-input runtime resume presentation only for inactive sessions (active: %s)', async (active) => {
        setSession('session-1', { active });
        await expect(ops.ensureSessionRuntimeForPendingInput(resumeOptions())).resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toHaveLength(1);
        if (active) expect(storage.getState().sessions['session-1'].resumingAt).toBeFalsy();
        else expect(storage.getState().sessions['session-1'].resumingAt).toEqual(expect.any(Number));
    });

    it('owns the resume marker across successful spawn and clears it on eager validation failure', async () => {
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'success' });
        expect(storage.getState().sessions['session-1'].resumingAt).toEqual(expect.any(Number));
        setSession('session-invalid', { metadata: metadata.MetadataSchema.parse({ path: '', host: 'host.local' }) });
        await expect(ops.resumeSession(resumeOptions({ sessionId: 'session-invalid', machineId: '', directory: '' })))
            .resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST });
        expect(storage.getState().sessions['session-invalid'].resumingAt).toBeNull();
        expect(resumeRequests()).toHaveLength(1);
    });

    it('fences an exact Account ensure after issuance and ignores the same-id ambient Session target', async () => {
        setSession('session-1', { metadata: metadata.MetadataSchema.parse({ path: '/ambient', host: 'host.local', machineId: 'machine-a' }) });
        setMachine('machine-a');
        setMachine('machine-b');
        const { captureLazyActionAccountContext } = await import('./actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.id);
        try {
            boundary.setRpcResponder(async () => {
                await boundary.setAccount(home.serverUrl, 'replacement-account');
                return { type: 'success', sessionId: 'session-1' };
            });
            await expect(ops.ensureSessionRuntimeForPendingInput(resumeOptions({ machineId: 'machine-b', directory: '/exact', accountLifetime: account.accountLifetime })))
                .resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
            expect(account.accountLifetime.isCurrent()).toBe(false);
            expect(resumeRequests()).toEqual([expect.objectContaining({ targetId: 'machine-b', serverUrl: home.serverUrl,
                token: home.token, payload: expect.objectContaining({ directory: '/exact' }) })]);
            expect(storage.getState().sessions['session-1'].resumingAt).toBeFalsy();
        } finally { account.dispose(); }
    });

    it('denies a captured Account resume before issuance after genuine credential replacement', async () => {
        const { captureLazyActionAccountContext } = await import('./actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.id);
        try {
            await boundary.setAccount(home.serverUrl, 'replacement-account');
            boundary.resetRequests();
            await expect(ops.ensureSessionRuntimeForPendingInput(resumeOptions({ accountLifetime: account.accountLifetime })))
                .rejects.toMatchObject({ code: 'session_account_scope_retired' });
            expect(account.accountLifetime.isCurrent()).toBe(false);
            expect(boundary.requests).toEqual([]);
            expect(boundary.httpRequests).toEqual([]);
        } finally { account.dispose(); }
    });

    it('rejects an exact Account control switch if the captured lifetime retires before issuance', async () => {
        const { captureLazyActionAccountContext } = await import('./actions/actionAccountContext');
        const account = await captureLazyActionAccountContext(home.id);
        try {
            boundary.setHttpResponder(createSessionReadBatchFetchBoundary(async (input) => {
                const path = new URL(String(input)).pathname;
                if (path === '/v2/sessions/session-1') {
                    await boundary.setAccount(home.serverUrl, 'replacement-account');
                    return Response.json({ session: fixtures.createPlainSessionCurrentProjectionRecordFixture() });
                }
                return null;
            }));
            await expect(ops.sessionSwitch('session-1', 'remote', { serverId: home.id, accountLifetime: account.accountLifetime }))
                .rejects.toThrow();
            expect(account.accountLifetime.isCurrent()).toBe(false);
            expect(boundary.requests).toEqual([]);
        } finally { account.dispose(); }
    });

    it('executes admitted control switching through the captured Home and existing switch RPC', async () => {
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
        const id = ActionIdSchema.parse('session.control.switch');
        const executor = createDefaultActionExecutor();
        boundary.respond('switch', true);
        const result = await executor.execute(id, { sessionId: 'session-1', to: 'remote' }, {
            surface: 'ui', authority: 'present_user', serverId: home.id,
        });
        expect(result).toEqual({ ok: true, result: { switched: true } });
        expect(boundary.requests.filter(request => request.method === 'switch')).toEqual([
            expect.objectContaining({ serverUrl: home.serverUrl, targetId: 'session-1', payload: { to: 'remote' } }),
        ]);
        boundary.respond('switch', false);
        expect(await executor.execute(id, { sessionId: 'session-1', to: 'local' }, {
            surface: 'ui', authority: 'present_user', serverId: home.id,
        })).toMatchObject({ ok: false, errorCode: 'session_control_unavailable' });
    });

    it('preserves resume authoring options at the actual daemon request boundary', async () => {
        const connectedServices = { v: 1, bindingsByServiceId: { anthropic: { source: 'connected', profileId: 'profile-1' } } } as const;
        await expect(ops.resumeSession(resumeOptions({ transcriptStorage: 'direct', attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
            connectedServices, connectedServicesUpdatedAt: 3456, accountSettingsVersionHint: 23, preferScopedMachineRpc: true })))
            .resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ targetId: 'machine-1', serverUrl: home.serverUrl, token: home.token,
            method: RPC_METHODS.SPAWN_HAPPY_SESSION, payload: expect.objectContaining({ type: 'resume-session', sessionId: 'session-1',
                transcriptStorage: 'direct', attachMetadataIdentityPolicy: 'replace_with_runtime_identity', connectedServices,
                connectedServicesUpdatedAt: 3456, accountSettingsVersionHint: 23 }) })]);
    });

    it('includes the Settings server acknowledged version in the resume request', async () => {
        await installSettingsPreparation();
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'success' });
        expect(storage.getState().settingsVersion).toBe(23);
        expect(boundary.httpRequests).toContainEqual(expect.objectContaining({ url: home.serverUrl + '/v2/account/settings' }));
        expect(resumeRequests()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ accountSettingsVersionHint: 23 }) })]);
    });

    it('does not issue resume when the Settings Account changes during its real HTTP refresh', async () => {
        await installSettingsPreparation();
        retireSettingsAfterRead = true;
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.ACCOUNT_SCOPE_CHANGED });
        expect(storage.getState().settingsScope?.accountId).toBe('replacement-account');
        expect(resumeRequests()).toEqual([]);
    });

    it('omits null connected Services from the daemon resume request', async () => {
        await expect(ops.resumeSession(resumeOptions({ connectedServices: null }))).resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toHaveLength(1);
        expect(resumeRequests()[0].payload).not.toHaveProperty('connectedServices');
    });

    it('passes the canonical Agent target through resumeSession', async () => {
        const agentTarget = { kind: 'agent', identity: { pluginId: 'example.external', localId: 'reviewer' } } as const;
        await expect(ops.resumeSession(resumeOptions({ agentTarget, backendTarget: undefined }))).resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ agentTarget }) })]);
    });

    it('passes configured ACP backend targets through resumeSession', async () => {
        const backendTarget = { kind: 'backend', backendId: 'custom-kiro', configuredBackendId: 'custom-kiro', sourceKind: 'configured' } as const;
        await expect(ops.resumeSession(resumeOptions({ backendTarget }))).resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ payload: expect.objectContaining({ backendTarget }) })]);
    });

    it.each([false, true])('selects the reachable Session target unless explicitly overridden (requested: %s)', async (preferRequestedMachineTarget) => {
        setSession('session-1', { metadata: metadata.MetadataSchema.parse({ path: '/base', host: 'host.local', machineId: 'reachable-machine' }) });
        setMachine('reachable-machine');
        setMachine('requested-machine');
        await expect(ops.resumeSession(resumeOptions({ machineId: 'requested-machine', directory: '/requested-path', preferRequestedMachineTarget })))
            .resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ targetId: preferRequestedMachineTarget ? 'requested-machine' : 'reachable-machine',
            serverUrl: home.serverUrl, payload: expect.objectContaining({ directory: preferRequestedMachineTarget ? '/requested-path' : '/base' }) })]);
    });

    it('preserves issued Resume uncertainty at the Session owner without another spawn', async () => {
        boundary.setRpcResponder(async () => { throw new Error('socket has been disconnected'); });
        const result = await ops.resumeSession(resumeOptions());
        expect(resumeRequests()).toHaveLength(1);
        expect(result).toMatchObject({ type: 'error', rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
    });

    it('preserves issued Resume uncertainty through the real Action executor without another spawn', async () => {
        const sessionId = 'c123456789012345678901234';
        setSession(sessionId, { active: false, metadata: metadata.MetadataSchema.parse({
            path: '/tmp', host: 'host.local', machineId: 'machine-1', flavor: 'claude', claudeSessionId: 'native-session',
        }) });
        boundary.setRpcAckResponder(async request => {
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION || request.method === RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE) {
                throw new Error('socket has been disconnected');
            }
            return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
        });
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.open', {
            sessionId, serverId: home.id, intent: 'resume',
        }, { serverId: home.id, surface: 'ui', authority: 'present_user', actionRequestId: 'uncertain-resume', bypassApprovals: true });
        expect(resumeRequests(), JSON.stringify({ result, methods: boundary.requests.map(request => request.method),
            paths: boundary.httpRequests.map(request => new URL(request.url).pathname) })).toHaveLength(1);
        expect(result).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
    });

    it('preserves a proven pre-dispatch Resume refusal as a real failure', async () => {
        boundary.setRpcAckResponder(async () => ({ ok: false, error: 'Not allowed', errorCode: RPC_ERROR_CODES.FORBIDDEN }));
        const result = await ops.resumeSession(resumeOptions());
        expect(result).toMatchObject({ type: 'error', rpcErrorCode: RPC_ERROR_CODES.FORBIDDEN });
        expect(result).not.toMatchObject({ errorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN });
        expect(resumeRequests()).toHaveLength(1);
    });

    it('keeps an issued acknowledgement timeout uncertain rather than claiming Resume failed', async () => {
        boundary.setRpcResponder(async () => { throw new Error('operation has timed out'); });
        const result = await ops.resumeSession(resumeOptions());
        expect(result, JSON.stringify(result)).toMatchObject({ type: 'error', rpcErrorCode: RPC_ERROR_CODES.OUTCOME_UNKNOWN,
            errorMessage: expect.any(String) });
        if (result.type !== 'error') throw new Error('Expected resume failure');
        expect(result.errorMessage.length).toBeGreaterThan(0);
        expect(resumeRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION,
            serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1',
            payload: expect.objectContaining({ type: 'resume-session', sessionId: 'session-1' }) })]);
    });

    it('maps an unavailable native resume RPC to DAEMON_RPC_UNAVAILABLE', async () => {
        rejectRpc(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
        expect(resumeRequests()).toEqual(Array.from({ length: 2 }, () => expect.objectContaining({
            method: RPC_METHODS.SPAWN_HAPPY_SESSION, serverUrl: home.serverUrl, token: home.token,
        })));
    });

    it('preserves the Agent-owned Codex runtime descriptor in the legacy-compatible resume RPC', async () => {
        const runtimeDescriptorV1 = { v: 1, agentId: 'codex', agent: { backendMode: 'appServer' } } as const;
        await expect(ops.resumeSession(resumeOptions({ backendTarget: { kind: 'builtInAgent', agentId: 'codex' }, runtimeDescriptorV1 })))
            .resolves.toEqual({ type: 'success', sessionId: 'session-1' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1',
            method: RPC_METHODS.SPAWN_HAPPY_SESSION, payload: { type: 'resume-session', sessionId: 'session-1', directory: '/tmp',
                backendTarget: { kind: 'backend', backendId: 'codex', sourceKind: 'built_in' }, runtimeDescriptorV1,
                executionAuthorization: { provenance: 'user_request', requestId: expect.any(String) } } })]);
    });

    it('keeps the shared spawn operation budget through the resume RPC transport', async () => {
        const { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } = await import('@happier-dev/protocol');
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
        await expect(ops.resumeSession(resumeOptions())).resolves.toMatchObject({ type: 'success' });
        expect(resumeRequests()).toEqual([expect.objectContaining({ timeoutMs: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS + DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS })]);
    });

    it('routes fork options and the shared operation budget through the requested Home', async () => {
        const replaySummaryRunner = { v: 1, modelSelection: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'default' }, permissionMode: 'no_tools' } as const;
        const { DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS } = await import('@happier-dev/protocol');
        const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
        await expect(ops.forkSession({ machineId: 'machine-1', parentSessionId: 'sess-parent', forkPoint: { type: 'seq', upToSeqInclusive: 12 },
            replaySummaryRunner, replayMaxSeedChars: 55_000, serverId: home.id })).resolves.toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(forkRequests()).toEqual([expect.objectContaining({ serverUrl: home.serverUrl, token: home.token, targetId: 'machine-1',
            method: RPC_METHODS.SESSION_FORK, timeoutMs: DEFAULT_SESSION_SPAWN_OPERATION_TIMEOUT_MS + DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS,
            payload: expect.objectContaining({ parentSessionId: 'sess-parent', forkPoint: { type: 'seq', upToSeqInclusive: 12 }, replaySummaryRunner, replayMaxSeedChars: 55_000 }) })]);
    });

    it('omits fork requestId for older daemons and preserves it for the first supporting daemon', async () => {
        const options = { machineId: 'machine-1', parentSessionId: 'sess-parent', forkPoint: { type: 'latest' }, serverId: home.id, requestId: 'retryable-replay-attempt' } as const;
        setMachine('machine-1', '0.2.0');
        await expect(ops.forkSession(options)).resolves.toMatchObject({ ok: true });
        expect(forkRequests()[0].payload).not.toHaveProperty('requestId');
        setMachine('machine-1', '0.2.10-dev.41');
        await expect(ops.forkSession(options)).resolves.toMatchObject({ ok: true });
        expect(forkRequests()[1].payload).toHaveProperty('requestId', 'retryable-replay-attempt');
    });

    it.each([
        ['binding', { providerBindingV1: providerBinding }, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE],
        ['model selection', { modelSelectionIntentV1: { v: 1, updatedAt: 1, selection: providerModelSelection.ref } }, RPC_ERROR_CODES.METHOD_NOT_FOUND],
    ] as const)('refuses a fork from persisted Provider %s when the current-only method is absent', async (_label, ownerMetadata, errorCode) => {
        setSession('sess-parent-provider', { metadata: metadata.MetadataSchema.parse({ path: '/tmp', host: 'host.local', machineId: 'machine-1', ...ownerMetadata }) });
        rejectRpc(errorCode);
        await expect(ops.forkSession({ machineId: 'machine-1', parentSessionId: 'sess-parent-provider', forkPoint: { type: 'latest' }, serverId: home.id }))
            .resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
        expect(forkRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SESSION_FORK_PROVIDER_SAFE, serverUrl: home.serverUrl, token: home.token })]);
    });

    it('prefers the reachable parent Session target for forkSession', async () => {
        setSession('sess-parent', { metadata: metadata.MetadataSchema.parse({ path: '/base', host: 'host.local', machineId: 'reachable-machine' }) });
        setMachine('reachable-machine');
        await expect(ops.forkSession({ machineId: 'stale-machine', parentSessionId: 'sess-parent', forkPoint: { type: 'latest' }, serverId: home.id }))
            .resolves.toEqual({ ok: true, childSessionId: 'sess-child' });
        expect(forkRequests()).toEqual([expect.objectContaining({ targetId: 'reachable-machine', method: RPC_METHODS.SESSION_FORK, serverUrl: home.serverUrl })]);
    });

    it('maps an unavailable native fork RPC to DAEMON_RPC_UNAVAILABLE', async () => {
        rejectRpc(RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
        await expect(ops.forkSession({ machineId: 'machine-1', parentSessionId: 'sess-parent', forkPoint: { type: 'latest' }, serverId: home.id }))
            .resolves.toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE });
        expect(forkRequests()).toEqual([expect.objectContaining({ method: RPC_METHODS.SESSION_FORK })]);
    });

    it.each(['describe', 'fork'] as const)('preserves a pre-issuance disconnect through the real scoped %s consumer', async kind => {
        vi.useRealTimers();
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        await serverScopedRpcSocketPool.stopAll();
        let physicalSocket: { connected: boolean } | undefined;
        boundary.setSocketConfigurator(({ socket }) => { physicalSocket = socket; });
        let releaseRow!: () => void;
        const row = new Promise<void>(resolve => { releaseRow = resolve; });
        boundary.setHttpResponder(createSessionReadBatchFetchBoundary(async (input, init) => {
            const path = new URL(String(input)).pathname;
            if (path !== '/v1/machines/machine-1' && path !== '/v1/machines/read-batch') return respondHttp(input, init);
            await row;
            if (path === '/v1/machines/read-batch') return machineFixtures.createMachineReadBatchResponseFixture(init?.body,
                id => id === 'machine-1' ? machineFixtures.createPlainMachineRowFixture({ id, accountId: home.accountId }) : null);
            return Response.json({ machine: machineFixtures.createPlainMachineRowFixture({ id: 'machine-1', accountId: home.accountId }) });
        }));
        const { machineCapabilitiesDescribe } = await import('./capabilities');
        const pending = kind === 'describe'
            ? machineCapabilitiesDescribe('machine-1', { serverId: home.id })
            : ops.forkSession({ machineId: 'machine-1', parentSessionId: 'sess-parent', forkPoint: { type: 'latest' }, serverId: home.id });
        try {
            await vi.waitFor(() => expect(physicalSocket?.connected).toBe(true));
            // Mis-wiring case: a retained pool holder must expose physical readiness at emission.
            physicalSocket!.connected = false;
        } finally { releaseRow(); }
        const result = await pending;
        if (kind === 'describe') {
            expect(result).toEqual({ supported: false, reason: 'error', error: {
                name: 'RpcError', rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            } });
        } else {
            const { SessionForkRpcResultSchema } = await import('@happier-dev/protocol/sessions/fork');
            expect(SessionForkRpcResultSchema.parse(result)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE });
        }
        expect(boundary.requests).toEqual([]);
    });

    it('keeps a fork disconnect after issuance uncertain', async () => {
        boundary.setRpcResponder(async () => { throw new Error('socket has been disconnected'); });
        const result = await ops.forkSession({ machineId: 'machine-1', parentSessionId: 'sess-parent',
            forkPoint: { type: 'latest' }, serverId: home.id });
        const { classifySessionForkRpcOutcome } = await import('@/sync/domains/sessionFork/sessionForkStrategy');
        expect(classifySessionForkRpcOutcome(result)).toMatchObject({ type: 'unknown', errorCode: 'UNEXPECTED' });
        expect(forkRequests()).toHaveLength(1);
    });

    it('routes checkpoint code rollback through the exact Session and Home', async () => {
        boundary.respond('session.checkpointCodeRollback', { status: 'applied', changedPaths: ['tracked.txt'], skippedPaths: [], receipts: ['checkpoint.rollback_applied'], diagnostics: [] });
        const request = { v: 1, sessionId: 'sess-parent', turnId: 'turn-1', cwd: '/repo', codeMode: 'conversation_and_code_without_stash',
            backupMode: 'happier_checkpoint_only', expectedStartRef: 'refs/happier/checkpoints/c2Vzcy1wYXJlbnQ/turn-start/turn-1',
            expectedFinalRef: 'refs/happier/checkpoints/c2Vzcy1wYXJlbnQ/turn-final/turn-1' } as const;
        await expect(ops.rollbackSessionCheckpointCode({ request, serverId: home.id })).resolves.toMatchObject({ status: 'applied', changedPaths: ['tracked.txt'] });
        expect(boundary.requests).toEqual([expect.objectContaining({ targetId: 'sess-parent', serverUrl: home.serverUrl, token: home.token,
            method: 'session.checkpointCodeRollback', payload: request })]);
    });

    function setInactiveRollbackSession() {
        setSession('sess-inactive-grok', { active: false, seq: 9, metadata: metadata.MetadataSchema.parse({ path: '/tmp/project', host: 'host.local',
            machineId: 'machine-1', flavor: 'grok', grokSessionId: 'grok-session-1' }) });
        boundary.respond(RPC_METHODS.SPAWN_HAPPY_SESSION, { type: 'success', sessionId: 'sess-inactive-grok' });
    }

    it('resumes an inactive Session and retries only unregistered rollback RPCs until registration', async () => {
        setInactiveRollbackSession();
        let rollbackAttempts = 0;
        boundary.setRpcAckResponder(async (request) => {
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) return { ok: true, result: { type: 'success', sessionId: 'sess-inactive-grok' } };
            if (request.method !== 'session.rollback') return { ok: false, error: 'RPC method not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND };
            rollbackAttempts += 1;
            if (rollbackAttempts === 1) return { ok: false, error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE };
            if (rollbackAttempts === 2) return { ok: true, result: { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, errorMessage: 'Runtime rollback facet is still starting' } };
            return { ok: true, result: { ok: true, target: { type: 'before_user_message', userMessageSeq: 7 } } };
        });
        const target = { type: 'before_user_message', userMessageSeq: 7 } as const;
        await expect(ops.rollbackSessionConversation({ sessionId: 'sess-inactive-grok', serverId: home.id, target })).resolves.toEqual({ ok: true, target });
        expect(resumeRequests()).toEqual([expect.objectContaining({ targetId: 'machine-1', serverUrl: home.serverUrl,
            payload: expect.objectContaining({ type: 'resume-session', sessionId: 'sess-inactive-grok', directory: '/tmp/project',
                backendTarget: { kind: 'backend', backendId: 'grok', sourceKind: 'built_in' }, resume: 'grok-session-1', initialTranscriptAfterSeq: 9 }) })]);
        expect(boundary.requests.filter((request) => request.method === 'session.rollback')).toEqual(
            Array.from({ length: 3 }, () => expect.objectContaining({ targetId: 'sess-inactive-grok', serverUrl: home.serverUrl, payload: { v: 1, target } })),
        );
    });

    it.each(['transport', 'runtime'] as const)('does not retry exact rollback after an ambiguous or non-method %s failure', async (failure) => {
        setInactiveRollbackSession();
        boundary.setRpcResponder(async (request) => {
            if (request.method === RPC_METHODS.SPAWN_HAPPY_SESSION) return { type: 'success', sessionId: 'sess-inactive-grok' };
            if (request.method !== 'session.rollback') return {};
            if (failure === 'transport') {
                const error = new Error('Rollback acknowledgement timed out after dispatch');
                error.name = 'ServerFetchWriteTimeoutError';
                throw error;
            }
            return { ok: false, errorCode: 'provider_runtime_failure', errorMessage: 'Provider rejected rollback' };
        });
        await expect(ops.rollbackSessionConversation({ sessionId: 'sess-inactive-grok', serverId: home.id,
            target: { type: 'before_user_message', userMessageSeq: 7 } })).resolves.toEqual(failure === 'transport'
            ? { ok: false, errorCode: 'UNEXPECTED', errorMessage: 'Rollback acknowledgement timed out after dispatch' }
            : { ok: false, errorCode: 'provider_runtime_failure', errorMessage: 'Provider rejected rollback' });
        expect(boundary.requests.filter((request) => request.method === 'session.rollback')).toHaveLength(1);
    });
});
