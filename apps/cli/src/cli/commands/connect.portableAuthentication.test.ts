import { afterAll, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const boundary = vi.hoisted(() => ({
    credentials: null as import('@/persistence').StoredCredentials | null,
    readCredentials: vi.fn(),
    prompt: vi.fn(async () => ''),
    promptSecret: vi.fn(async (_prompt: string) => 'portable-manual-fixture-token'),
    nativeRpc: vi.fn(async () => { throw new Error('Portable command has no Machine transport'); }),
    daemonCatalog: vi.fn(async () => { throw new Error('Portable command has no daemon catalog'); }),
    socketFactory: null as ((...args: unknown[]) => unknown) | null,
}));
// Credentials, terminal input and network transports are genuine system boundaries.
// The command, catalog, client, admission, registration and settlement remain real.
vi.mock('@/persistence', async original => ({ ...await original<typeof import('@/persistence')>(),
    readStoredCredentials: async () => { boundary.readCredentials(); return boundary.credentials; },
}));
vi.mock('@/terminal/prompts/promptInput', () => ({ promptInput: boundary.prompt, promptSecretInput: boundary.promptSecret }));
vi.mock('@/session/transport/rpc/machineRpc', async original => ({ ...await original<typeof import('@/session/transport/rpc/machineRpc')>(),
    callMachineRpc: boundary.nativeRpc, callExactMachineRpc: boundary.nativeRpc,
}));
vi.mock('@/daemon/controlClient', async original => ({ ...await original<typeof import('@/daemon/controlClient')>(),
    readDaemonPluginCatalog: boundary.daemonCatalog,
}));
vi.mock('socket.io-client', async original => {
    const actual = await original<typeof import('socket.io-client')>();
    return { ...actual, io: (...args: Parameters<typeof actual.io>) => boundary.socketFactory?.(...args) ?? actual.io(...args) };
});

// Isolate the actual persistence/configuration owner before importing product code.
const taskDirectory = await mkdtemp(join(tmpdir(), 'happier-connect-portable-'));
vi.stubEnv('HAPPIER_HOME_DIR', taskDirectory);
const [{ handleConnectCommand }, { createPortableConnectedAccountAuthenticationHttpFixture },
    { runWithServerHttpBaseUrl }, { resolveExecutablePluginRuntimeRegistry },
    { createCliActionExecutorFromCredentials }, { ensureCliActionPolicySettings }] = await Promise.all([
    import('./connect'), import('@/testkit/connectedAccountAuthentication'), import('@/api/client/serverHttpBaseUrl'),
    import('@/plugins/runtime/resolveExecutablePluginRuntimeRegistry'), import('@/session/actions/createCliActionExecutorFromCredentials'),
    import('@/session/actions/ensureCliActionPolicySettings'),
]);
afterAll(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(taskDirectory, { recursive: true, force: true });
});

it('keeps help and conflicting arguments passive without acquiring Account credentials', async () => {
    boundary.credentials = null;
    boundary.readCredentials.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
        await handleConnectCommand(['help']);
        await expect(handleConnectCommand(['example', '--import', '--mode', 'manual'])).rejects.toThrow();
        expect(boundary.readCredentials).not.toHaveBeenCalled();
        expect(boundary.nativeRpc).not.toHaveBeenCalled();
        expect(boundary.daemonCatalog).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
});

it('signs in through the real command with piped stdin and no Machine', async () => {
    const origin = 'http://connect-command-portable.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    boundary.credentials = fixture.credentials;
    boundary.readCredentials.mockClear();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const approvalNotice = vi.spyOn(console, 'error').mockImplementation(() => {});
    const input = Object.assign(new PassThrough(), { isTTY: false });
    // Substitute the OS stdin boundary with a pipe; run the real secret prompt/readline.
    const stdin = vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin);
    const { promptSecretInput } = await vi.importActual<typeof import('@/terminal/prompts/promptInput')>('@/terminal/prompts/promptInput');
    boundary.promptSecret.mockImplementationOnce(async prompt => {
        return await promptSecretInput(prompt);
    });
    input.end('portable-manual-fixture-token\n');
    try {
        await runWithServerHttpBaseUrl(origin, () => handleConnectCommand([`${fixture.service.pluginId}/${fixture.service.localId}`]));
        expect(approvalNotice).toHaveBeenCalledWith(expect.stringContaining('happier actions invoke approval.request.list'));
        const stored = await fixture.readCredential({ service: fixture.service, accountId: 'example-account' });
        expect(stored).not.toBeNull();
        if (!stored) throw new Error('Command did not settle its credential');
        expect((await fixture.reopenCredential(stored)).values).toEqual({ token: 'portable-manual-fixture-token' });
        expect(fixture.promotedResourceCount).toBe(1);
        expect(fixture.directCredentialWrites).toBe(0);
        expect(fixture.machineRequests).toBe(0);
        expect(boundary.readCredentials).toHaveBeenCalledTimes(1);
        expect(boundary.nativeRpc).not.toHaveBeenCalled();
        expect(boundary.daemonCatalog).not.toHaveBeenCalled();
    } finally {
        stdin.mockRestore();
        input.destroy();
        approvalNotice.mockRestore();
        log.mockRestore();
        boundary.credentials = null;
        await fixture.close();
    }
});

it('keeps retained Account reconnect routing on captured Home A under an outer Home B', async () => {
    const origin = 'http://connect-captured-home-a.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin);
    boundary.credentials = fixture.credentials;
    let registry: Awaited<ReturnType<typeof resolveExecutablePluginRuntimeRegistry>> | undefined;
    try {
        await runWithServerHttpBaseUrl(origin, () => ensureCliActionPolicySettings(fixture.credentials, origin));
        registry = await resolveExecutablePluginRuntimeRegistry({ happyHomeDir: taskDirectory,
            accountExecution: { credentials: fixture.credentials, serverUrl: origin, isCurrent: () => true } });
        const host = registry.connectedAccountAuthenticationHost;
        if (!host) throw new Error('Missing retained Account authentication host');
        const executeLocal: Parameters<typeof host.executeAction>[3] = (actionId, input, context, boundHost) =>
            runWithServerHttpBaseUrl(origin, () => createCliActionExecutorFromCredentials({ credentials: fixture.credentials,
                connectedAccountAuthenticationHost: boundHost }).execute(actionId, input, context));
        const context = { surface: 'cli' as const };
        const begin = await host.executeAction('connectedServices.authentication.beginConnect',
            { service: fixture.service, modeId: 'manual' }, context, executeLocal);
        expect(begin).toMatchObject({ matched: true, result: { ok: true, result: { status: 'awaitingManual' } } });
        if (!begin.matched || !begin.result.ok || !begin.result.result || typeof begin.result.result !== 'object'
            || !('attemptId' in begin.result.result) || typeof begin.result.result.attemptId !== 'string') throw new Error('Missing begun attempt');
        expect(await host.executeAction('connectedServices.authentication.submitManual', {
            attemptId: begin.result.result.attemptId, fields: { token: 'portable-manual-fixture-token' },
        }, context, executeLocal)).toMatchObject({ matched: true, result: { ok: true, result: { status: 'connected' } } });
        // The fixture HTTP adapter accepts A only. A dynamic-default credential
        // lookup on B refuses before the real ordinary Action callback runs.
        const reconnect = await runWithServerHttpBaseUrl('http://connect-outer-home-b.test', () => host.executeAction(
            'connectedServices.authentication.beginReconnect', { account: { service: fixture.service, accountId: 'example-account' } },
            context, executeLocal));
        expect(reconnect).toMatchObject({ matched: true, result: { ok: true, result: { status: 'awaitingManual' } } });
        const selected = await registry.resolveAccountConnectedAccountRuntime?.(fixture.service);
        if (!selected || !registry.retirePluginConsumers) throw new Error('Missing actual Account retirement owner');
        const authentication = selected.authentication.acquire(() => { throw new Error('The Action journey must already own its runtime'); });
        await expect(authentication.attempts.read({ attemptId: begin.result.result.attemptId })).resolves.toMatchObject({ status: 'connected' });
        await registry.retirePluginConsumers([fixture.service.pluginId]);
        expect(selected.isCurrent()).toBe(false);
        await expect(authentication.attempts.read({ attemptId: begin.result.result.attemptId })).resolves.toMatchObject({ status: 'unavailable' });
        expect(fixture.machineRequests).toBe(0);
        expect(boundary.nativeRpc).not.toHaveBeenCalled();
    } finally {
        await registry?.dispose();
        boundary.credentials = null;
        await fixture.close();
    }
});

it.each(['terminal', 'yes', 'decline', 'exhausted', 'remote'] as const)('settles CLI Connect with %s approval input', async approvalSurface => {
    const [{ createApiSessionSocketStub }, { SOCKET_RPC_EVENTS }, { createCliApprovalsArtifactStore },
        { createActionExecutor }, { createBlockingApprovalCoordinator }, { replayLiveCliApprovalOrigin },
        { ActionsSettingsV1Schema, ArtifactJsonCreateHttpInputV1Schema, decodePlainArtifactStoredContent }, { ApprovalRequestV2Schema },
        { createConnectedAccountDaemonClient }, { default: axios }] = await Promise.all([
        import('@/testkit/backends/apiSessionSocketHarness'), import('@happier-dev/protocol/socketRpc'),
        import('@/session/actions/approvals/artifactStore'), import('@happier-dev/protocol/actions/actionExecutor'),
        import('@happier-dev/protocol/actions/blockingApprovalCoordinator'), import('@/session/actions/approvals/replayLiveOrigin'),
        import('@happier-dev/protocol'), import('@happier-dev/protocol/approvals/approvalRequestV1'),
        import('./connect/connectedAccountDaemonClient'), import('axios'),
    ]);
    const origin = 'http://connect-approved-portable.test';
    const fixture = await createPortableConnectedAccountAuthenticationHttpFixture(origin, { accountId: `portable-approval-owner-${approvalSurface}` });
    // Approval currentness uses fetch rather than the fixture's Axios adapter.
    // Preserve the authenticated Home projection at this network boundary.
    const fetch = globalThis.fetch;
    const features = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input) === `${origin}/v1/features/authenticated`) {
            expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${fixture.credentials.token}`);
            return Response.json(fixture.features);
        }
        return fetch(input, init);
    });
    const actionId = 'connectedServices.authentication.beginConnect';
    fixture.settings.actionsSettingsV1 = ActionsSettingsV1Schema.parse({ ...fixture.settings.actionsSettingsV1,
        actions: { ...fixture.settings.actionsSettingsV1?.actions, [actionId]: { approvalRequiredSurfaces: ['cli'] } },
        approvalWaivedSurfaces: { ...fixture.settings.actionsSettingsV1?.approvalWaivedSurfaces, [actionId]: [] },
    });
    if (approvalSurface !== 'remote') fixture.settings.actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1 });
    // The credential-reader boundary attests this terminal's stored login.
    // A raw Account bearer deliberately cannot make a present-person decision.
    boundary.credentials = { ...fixture.credentials, credentialProvenance: 'stored_session' };
    boundary.prompt.mockClear();
    const input = Object.assign(new PassThrough(), { isTTY: false });
    // Substitute the OS stdin boundary with an exhausted pipe for the real prompt.
    const stdin = approvalSurface === 'exhausted' ? vi.spyOn(process, 'stdin', 'get').mockReturnValue(input as unknown as typeof process.stdin) : null;
    const { promptInput } = await vi.importActual<typeof import('@/terminal/prompts/promptInput')>('@/terminal/prompts/promptInput');
    boundary.prompt.mockImplementation(async (_message?: string, options?: { signal?: AbortSignal }) => {
        if (approvalSurface === 'terminal') return 'yes';
        if (approvalSurface === 'decline') return '';
        if (approvalSurface === 'yes') throw new Error('--yes must not read terminal confirmation');
        if (approvalSurface === 'exhausted') {
            const answer = promptInput(_message ?? '', options);
            input.end();
            return await answer;
        }
        return await new Promise<string>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
        });
    });
    const controller = new AbortController();
    const origins = new Map<string, ReturnType<typeof createApiSessionSocketStub>>();
    // The network boundary stamps authenticated caller authority, just as the
    // Home relay does. The production codec, RPC manager and continuation run.
    boundary.socketFactory = () => createApiSessionSocketStub({
        emit: (event, args, socket) => {
            if (event !== SOCKET_RPC_EVENTS.REGISTER) return;
            const packet = args[0];
            if (!packet || typeof packet !== 'object' || !('method' in packet) || typeof packet.method !== 'string') throw new Error('invalid registration');
            origins.set(packet.method, socket);
            queueMicrotask(() => socket.trigger(SOCKET_RPC_EVENTS.REGISTERED, packet));
        },
        emitWithAck: async (event, payload) => {
            if (event !== SOCKET_RPC_EVENTS.CALL || !payload || typeof payload !== 'object'
                || !('method' in payload) || typeof payload.method !== 'string') throw new Error('unexpected socket call');
            const receiver = origins.get(payload.method);
            if (!receiver) throw new Error('origin not registered');
            const result = await new Promise<unknown>(resolve => receiver.trigger(SOCKET_RPC_EVENTS.REQUEST,
                { ...payload, callerAuthority: 'present_user' }, resolve));
            return { ok: true, result };
        },
    });
    let created!: (artifactId: string) => void;
    const approvalCreated = new Promise<string>(resolve => { created = resolve; });
    const post = axios.post.bind(axios);
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (...args) => {
        const result = await post(...args);
        if (new URL(String(args[0])).pathname === '/v1/artifacts') {
            const request = ArtifactJsonCreateHttpInputV1Schema.parse(args[1]);
            const body = decodePlainArtifactStoredContent(request.body);
            const parsed = body && typeof body === 'object' && 'body' in body && typeof body.body === 'string'
                ? ApprovalRequestV2Schema.safeParse(JSON.parse(body.body)) : null;
            if (parsed?.success && parsed.data.actionId === actionId) created(request.id);
        }
        return result;
    });
    const remoteCoordinator = createBlockingApprovalCoordinator();
    const approvalNotice = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const client = runWithServerHttpBaseUrl(origin, () => createConnectedAccountDaemonClient({ credentials: boundary.credentials!,
        signal: controller.signal, onApprovalRequested: (_artifactId, _signal, decide) => decide('approve') }));
    let pending: Promise<void> | undefined;
    try {
        pending = runWithServerHttpBaseUrl(origin, () => handleConnectCommand([
            `${fixture.service.pluginId}/${fixture.service.localId}`, ...(approvalSurface === 'yes' ? ['--yes'] : []),
        ], controller.signal));
        void pending.catch(() => {});
        const artifactId = await Promise.race([approvalCreated, pending.then(() => { throw new Error('Begin settled without waiting for approval'); })]);
        if (approvalSurface === 'decline' || approvalSurface === 'exhausted') {
            await expect(pending).rejects.toMatchObject({ code: 'approval_rejected' });
            expect(fixture.promotedResourceCount).toBe(0);
            const store = createCliApprovalsArtifactStore({ credentials: fixture.credentials, serverHttpBaseUrl: origin });
            expect(await runWithServerHttpBaseUrl(origin, () => store.approvalsGet({ artifactId }))).toMatchObject({ status: 'rejected' });
            return;
        }
        if (approvalSurface === 'terminal' || approvalSurface === 'yes') {
            // The real command must release its initial Action in this terminal;
            // the prior implementation only waited for another client forever.
            await Promise.race([pending, vi.waitFor(() => expect(fixture.promotedResourceCount).toBe(1))]);
            await pending;
            expect(boundary.prompt).toHaveBeenCalledTimes(approvalSurface === 'yes' ? 0 : 1);
            const stored = await fixture.readCredential({ service: fixture.service, accountId: 'example-account' });
            expect(stored).not.toBeNull();
            if (!stored) throw new Error('Approved command did not settle its credential');
            expect((await fixture.reopenCredential(stored)).values).toEqual({ token: 'portable-manual-fixture-token' });
            // The same retained client must begin, read and complete the exact
            // approved reconnect attempt, rather than create it on a decider's host.
            const reconnected = await client.authenticate({ operation: 'beginReconnect',
                account: { service: fixture.service, accountId: 'example-account' } });
            expect(reconnected).toMatchObject({ status: 'awaitingManual' });
            if (reconnected.status !== 'awaitingManual') throw new Error('Reconnect did not request manual fields');
            expect(await client.authenticate({ operation: 'read', attemptId: reconnected.attemptId }))
                .toMatchObject({ status: 'awaitingManual', attemptId: reconnected.attemptId });
            const completed = await client.authenticate({ operation: 'submitManual', attemptId: reconnected.attemptId,
                fields: { token: 'reconnected-manual-fixture-token' } });
            expect(completed.status, JSON.stringify(completed)).toBe('connected');
            expect(completed).toMatchObject({ attemptId: reconnected.attemptId });
            expect(fixture.promotedResourceCount).toBe(1);
            const refreshed = await fixture.readCredential({ service: fixture.service, accountId: 'example-account' });
            if (!refreshed) throw new Error('Reconnect did not settle its credential');
            expect((await fixture.reopenCredential(refreshed)).values).toEqual({ token: 'reconnected-manual-fixture-token' });
            expect(fixture.machineRequests).toBe(0);
            return;
        }
        // A headless caller must learn how to release the wait before token entry.
        await vi.waitFor(() => expect(approvalNotice).toHaveBeenCalledWith(expect.stringContaining(artifactId)));
        const store = createCliApprovalsArtifactStore({ credentials: fixture.credentials, serverHttpBaseUrl: origin });
        const request = await runWithServerHttpBaseUrl(origin, () => store.approvalsGet({ artifactId }));
        if (!request || 'kind' in request || request.v !== 2) throw new Error('missing CLI approval');
        expect(request.status).toBe('open');
        expect(fixture.promotedResourceCount).toBe(0);
        // Observe the Account owner, without asking for the unrelated native
        // Machine pending list (the fixture intentionally has no Machine RPC).
        expect(await client.control({ operation: 'listPendingAttempts', service: fixture.service }))
            .toMatchObject({ status: 'pendingAttempts', attempts: [] });
        // A separate process has its own coordinator. It must deliver consent
        // over the live-origin transport, not claim the requester's local waiter.
        const decider = createActionExecutor({ ...store,
            approvalsResolveBlockingDecision: args => remoteCoordinator.resolveBlockingDecision(args),
            approvalRequestApprovedReplay: args => replayLiveCliApprovalOrigin(args, {
                token: fixture.credentials.token, serverUrl: origin,
            }),
        });
        const decision = await runWithServerHttpBaseUrl(origin, () => decider.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
            surface: 'cli', authority: 'present_user', runtimeAccountId: request.executionOriginV1.accountId,
            serverId: request.executionOriginV1.serverId, serverIdentityId: request.executionOriginV1.serverIdentityId,
            actionCaller: { kind: 'host' },
        }));
        expect(decision).toMatchObject({ ok: true, result: { status: 'approved' } });
        await pending;
        const stored = await fixture.readCredential({ service: fixture.service, accountId: 'example-account' });
        expect(stored).not.toBeNull();
        if (!stored) throw new Error('Approved command did not settle its credential');
        expect((await fixture.reopenCredential(stored)).values).toEqual({ token: 'portable-manual-fixture-token' });
        expect(await runWithServerHttpBaseUrl(origin, () => store.approvalsGet({ artifactId })))
            .toMatchObject({ status: 'executed', execution: { ok: true } });
        expect(fixture.machineRequests).toBe(0);
        expect(boundary.nativeRpc).not.toHaveBeenCalled();
    } finally {
        stdin?.mockRestore();
        input.destroy();
        controller.abort();
        await pending?.catch(() => {});
        await client.dispose();
        remoteCoordinator.dispose();
        writes.mockRestore();
        features.mockRestore();
        approvalNotice.mockRestore();
        log.mockRestore();
        boundary.socketFactory = null;
        boundary.credentials = null;
        boundary.prompt.mockImplementation(async () => '');
        await fixture.close();
    }
});
