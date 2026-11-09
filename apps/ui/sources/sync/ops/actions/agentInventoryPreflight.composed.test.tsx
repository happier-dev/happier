import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { AgentConfigOptionsProbeObservationSchema, AgentSessionModesProbeObservationSchema } from '@happier-dev/protocol/capabilities';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ConnectedServiceBindingsV1Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { renderHook, flushHookEffects } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { serverScopedRpcSocketPool } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool';
import { resetScopedMachineTransportCacheForTests } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool';
import { clearMachineRequestReachabilityForTest } from '@/sync/domains/machines/reachability/machineReachability';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';

const credential = vi.hoisted(() => ({ token: '' }));
// Only persisted device credentials are substituted; HTTP, Socket.IO, Action admission and resource logic are real.
vi.mock('@/auth/storage/tokenStorage', async importOriginal => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    const actual = await importOriginal<typeof import('@/auth/storage/tokenStorage')>();
    return createTokenStorageModuleMock({ importOriginal,
        subscribeHomeCredentialMutations: actual.subscribeHomeCredentialMutations,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: credential.token }) } });
});

const { invokeAgentInventoryProbeAction } = await import('./agentInventoryActionDeps');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { useNewSessionPreflightSessionModesState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightSessionModesState');
const { useNewSessionPreflightConfigOptionsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightConfigOptionsState');
const modeCache = await import('@/sync/domains/sessionModes/dynamicSessionModeProbeCache');
const configCache = await import('@/sync/domains/sessionControl/dynamicConfigOptionsProbeCache');
const modelCache = await import('@/sync/domains/models/dynamicModelProbeCache');
const { discoverMachineModels } = await import('@/sync/ops/modelDiscovery');
const { useNewSessionPreflightModelsState } = await import('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState');

afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    serverScopedRpcSocketPool.resetForTests();
    resetScopedMachineTransportCacheForTests();
    clearMachineRequestReachabilityForTest();
    resetServerFeaturesClientForTests();
    modeCache.resetDynamicSessionModeProbeCacheForTests();
    configCache.resetDynamicConfigOptionsProbeCacheForTests();
    modelCache.resetDynamicModelProbeCacheForTests();
});

type NativeReply = 'hold' | 'lost' | 'success' | 'unavailable' | 'absent' | 'preflight-refused';
async function preflightHome(options: Readonly<{ holdLost?: boolean; inventory?: 'config' }> = {}) {
    const issued: string[] = [];
    const cancelled: unknown[] = [];
    const mode = new Map<string, NativeReply>();
    const loseReplies: Array<() => void> = [];
    const observation = AgentSessionModesProbeObservationSchema.parse({ source: 'dynamic',
        availableModes: [{ id: 'project-review', name: 'Project review' }] });
    const configObservation = AgentConfigOptionsProbeObservationSchema.parse({ source: 'dynamic',
        configOptions: [{ id: 'sandbox', name: 'Sandbox', type: 'boolean', currentValue: 'true' }] });
    const http = createServer(async (request, response) => {
        response.setHeader('content-type', 'application/json');
        const path = request.url?.split('?')[0];
        if (path === '/health' || path === '/v1/auth/ping') response.end('{}');
        else if (path === '/v1/machines/read-batch' && request.method === 'POST') {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            const reply = createMachineReadBatchResponseFixture(Buffer.concat(chunks).toString('utf8'),
                id => createPlainMachineRowFixture({ id, accountId: 'inventory-account' }));
            response.end(await reply.text());
        }
        else if (path?.startsWith('/v1/machines/')) response.end(JSON.stringify({ machine: {
            id: path.slice('/v1/machines/'.length), dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } }));
        else if (path === '/v1/account/encryption') response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
        else if (path === '/v1/account/encryption/currentness') response.end(JSON.stringify(createPlainAccountEncryptionCurrentnessFixture()));
        else if (path === '/v1/features') response.end(JSON.stringify(createRootLayoutFeaturesResponse()));
        else if (path === '/v2/account/settings') response.end(JSON.stringify({ content: { t: 'plain', v: {} }, version: 0 }));
        else if (path === '/v1/account/entity-rows/profiles/transfer') response.end(JSON.stringify({ status: 'absent' }));
        else { response.statusCode = 404; response.end('{}'); }
    });
    const relay = new Server(http, { path: '/v1/updates/' });
    relay.on('connection', socket => {
        socket.on(SOCKET_RPC_EVENTS.CANCEL, packet => cancelled.push(packet));
        socket.on(SOCKET_RPC_EVENTS.CALL, async (packet: SocketRpcRequestPayload, ack: (reply: unknown) => void) => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, packet.params, packet.method);
            if (!packet.method.endsWith(`:${RPC_METHODS.CAPABILITIES_INVOKE}`)) {
                ack({ ok: false, error: 'not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND });
                return;
            }
            const machineId = packet.method.slice(0, packet.method.indexOf(':'));
            issued.push(machineId);
            const reply = mode.get(machineId) ?? 'hold';
            if (reply === 'hold') return;
            if (reply === 'lost') {
                if (options.holdLost) loseReplies.push(() => socket.disconnect(true));
                else socket.disconnect(true);
                return;
            }
            if (reply === 'absent') { ack({ ok: false, error: 'not found', errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }); return; }
            if (reply === 'preflight-refused') {
                ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                    ok: false, error: { code: 'connected-service-preflight-failed', message: 'Selected credential could not be prepared.' },
                }, decoded.callId) });
                return;
            }
            const result = options.inventory === 'config'
                ? (reply === 'unavailable' ? AgentConfigOptionsProbeObservationSchema.parse({ source: 'unavailable', configOptions: [] }) : configObservation)
                : (reply === 'unavailable' ? AgentSessionModesProbeObservationSchema.parse({ source: 'unavailable', availableModes: [] }) : observation);
            ack({ ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true, result }, decoded.callId) });
        });
    });
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('Missing HTTP listener');
    credential.token = `header.${Buffer.from(JSON.stringify({ sub: 'inventory-account' })).toString('base64url')}.signature`;
    const home = await upsertServerProfile({ name: 'Owned inventory', serverUrl: `http://127.0.0.1:${address.port}` });
    const params = (machineId: string) => ({ agentId: 'external.agent/reader', machineId, serverId: home.id,
        capabilityParams: { cwd: '/repo' } });
    const picker = (machineId: string) => ({ backendTarget: { kind: 'backend' as const, backendId: 'external.agent/reader' },
        runtimeCarrierAgentId: 'external.agent/reader', selectedMachineId: machineId, capabilityServerId: home.id, cwd: '/repo' });
    return { issued, cancelled, mode, home, params, picker, observation, configObservation, loseReplies,
        async dispose() { await serverScopedRpcSocketPool.stopAll(); await new Promise<void>(resolve => relay.close(() => resolve())); } };
}

it('retains the capability refusal through the real Action, bridge and New Session model resource', async () => {
    const f = await preflightHome();
    f.mode.set('refused-machine', 'preflight-refused');
    try {
        const result = await createDefaultActionExecutor().execute('agents.models.list', {
            agentId: 'external.agent/reader', machineId: 'refused-machine', probe: { cwd: '/repo' },
        }, { surface: 'ui', serverId: f.home.id });
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ errorCode: 'connected-service-preflight-failed' });
        expect(await discoverMachineModels({ cacheKey: 'typed-preflight-refusal', agentType: 'external.agent/reader',
            machineId: 'refused-machine', serverId: f.home.id, capabilityParams: { cwd: '/repo' }, bypassCache: true,
        })).toMatchObject({ kind: 'error', reason: 'error', errorCode: 'connected-service-preflight-failed' });
        const picker = await renderHook(useNewSessionPreflightModelsState, { initialProps: f.picker('refused-machine') });
        try {
            await vi.waitFor(() => expect(picker.getCurrent().probe).toMatchObject({ failed: true,
                errorCode: 'connected-service-preflight-failed' }));
        } finally { await picker.unmount(); }
    } finally { await f.dispose(); }
});

it('retains a typed refusal in mode and config resources, including cached remounts', async () => {
    const f = await preflightHome();
    f.mode.set('refused-modes', 'preflight-refused');
    f.mode.set('refused-config', 'preflight-refused');
    const usePickers = () => ({
        modes: useNewSessionPreflightSessionModesState(f.picker('refused-modes')),
        config: useNewSessionPreflightConfigOptionsState(f.picker('refused-config')),
    });
    try {
        for (let occurrence = 0; occurrence < 2; occurrence += 1) {
            const picker = await renderHook(usePickers);
            try {
                await vi.waitFor(() => {
                    expect(picker.getCurrent().modes.probe).toMatchObject({ reason: 'error', errorCode: 'connected-service-preflight-failed' });
                    expect(picker.getCurrent().config.probe).toMatchObject({ reason: 'error', errorCode: 'connected-service-preflight-failed' });
                });
            } finally { await picker.unmount(); }
        }
    } finally { await f.dispose(); }
});

it('preserves a lost real ACK through the inventory Action failure and bridge', async () => {
    const f = await preflightHome();
    try {
        f.mode.set('lost-machine', 'lost');
        const result = await createDefaultActionExecutor().execute('agents.session_modes.list', {
            agentId: 'external.agent/reader', machineId: 'lost-machine', probe: { cwd: '/repo' },
        }, { surface: 'ui', serverId: f.home.id });
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
            details: { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' } });
        expect(await invokeAgentInventoryProbeAction(f.params('lost-machine'), 'probeModes')).toEqual({
            supported: false, reason: 'outcomeUnknown', errorCode: 'action_outcome_unknown', requestDisposition: 'outcomeUnknown' });
        f.mode.set('unavailable-machine', 'unavailable');
        expect(await invokeAgentInventoryProbeAction(f.params('unavailable-machine'), 'probeModes')).toMatchObject({
            supported: true, response: { ok: true, result: { source: 'unavailable', availableModes: [] } } });
        f.mode.set('absent-machine', 'absent');
        expect(await invokeAgentInventoryProbeAction(f.params('absent-machine'), 'probeModes')).toMatchObject({
            supported: false, reason: 'not-supported' });
    } finally { await f.dispose(); }
});

it.each([
    ['agents.models.list', true], ['agents.config_options.list', true], ['agents.models.list', false],
] as const)('keeps uncertainty in the neighboring inventory Action %s (preflight input: %s)', async (actionId, preflight) => {
    const f = await preflightHome();
    f.mode.set('lost-machine', 'lost');
    try {
        const result = await createDefaultActionExecutor().execute(actionId, {
            agentId: 'external.agent/reader', machineId: 'lost-machine', ...(preflight ? { probe: { cwd: '/repo' } } : {}),
        }, { surface: 'ui', serverId: f.home.id });
        expect(ActionExecuteFailureSchema.parse(result)).toMatchObject({ ok: false, errorCode: 'action_outcome_unknown',
            details: { reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' } });
        expect(f.issued).toEqual(['lost-machine']);
    } finally { await f.dispose(); }
});

it('settles and cancels the neighboring passive voice preflight when its caller departs', async () => {
    const f = await preflightHome();
    const controller = new AbortController();
    const { inspectVoiceProviderReadiness } = await import('@/voice/settings/voiceProviderReadinessInspection');
    publishAppliedActiveServerSnapshot({ serverId: f.home.id, serverUrl: f.home.serverUrl, generation: 1 });
    const pending = inspectVoiceProviderReadiness({ machineId: 'voice-machine',
        passiveSetup: { capabilityId: 'cli.external.agent/reader' },
        connectedServices: ConnectedServiceBindingsV1Schema.parse({ v: 1, bindingsByServiceId: {} }),
        rawTargets: [], signal: controller.signal, isCurrent: () => !controller.signal.aborted });
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['voice-machine']));
        controller.abort();
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
        expect(await pending).toEqual({ passive: null, raw: [] });
    } finally { controller.abort(); await f.dispose(); }
});

it('binds Action cancellation to the supplied caller signal, not a neighboring signal', async () => {
    const f = await preflightHome();
    const owner = new AbortController();
    const neighbor = new AbortController();
    const pending = invokeAgentInventoryProbeAction({ ...f.params('pending-machine'), signal: owner.signal }, 'probeModes')
        .then(value => value, (error: unknown) => error);
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-machine']));
        neighbor.abort();
        await flushHookEffects();
        expect(f.cancelled).toHaveLength(0);
        owner.abort();
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
        expect(await pending).toBeInstanceOf(Error);
    } finally { owner.abort(); await f.dispose(); }
});

it.each(['unmount', 'machine-change'] as const)('releases a pending picker occurrence on %s through Action and Machine', async departure => {
    const f = await preflightHome();
    f.mode.set('next-machine', 'success');
    const picker = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('pending-machine') });
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-machine']));
        if (departure === 'unmount') await picker.unmount();
        else await picker.rerender(f.picker('next-machine'));
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
        if (departure === 'machine-change') {
            await vi.waitFor(() => expect(picker.getCurrent().preflightModes?.availableModes).toEqual(f.observation.availableModes));
        }
        // A remount of the abandoned scope must start a fresh occurrence.
        f.mode.set('pending-machine', 'success');
        const next = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('pending-machine') });
        try {
            await vi.waitFor(() => expect(next.getCurrent().preflightModes?.availableModes).toEqual(f.observation.availableModes));
            expect(f.issued.filter(machine => machine === 'pending-machine')).toHaveLength(2);
        } finally { await next.unmount(); }
    } finally { if (departure !== 'unmount') await picker.unmount(); await f.dispose(); }
});

it('keeps a shared pending occurrence until its final picker consumer leaves', async () => {
    const f = await preflightHome();
    const first = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('pending-machine') });
    const second = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('pending-machine') });
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-machine']));
        await first.unmount();
        await flushHookEffects();
        expect(f.cancelled).toHaveLength(0);
        expect(second.getCurrent().probe.phase).toBe('loading');
        await second.unmount();
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
    } finally { await first.unmount(); await second.unmount(); await f.dispose(); }
});

it.each([false, true])('does not automatically retry a lost ACK through Action and picker (retained modes: %s)', async retain => {
    const f = await preflightHome({ holdLost: true });
    f.mode.set('mode-machine', retain ? 'success' : 'lost');
    const picker = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('mode-machine') });
    try {
        if (retain) {
            await vi.waitFor(() => expect(picker.getCurrent().preflightModes?.availableModes).toEqual(f.observation.availableModes));
            f.mode.set('mode-machine', 'lost');
            await act(async () => picker.getCurrent().probe.onRefresh?.());
        }
        await vi.waitFor(() => expect(f.loseReplies).toHaveLength(1));
        // Fake the resource clock before settlement creates its retry timer;
        // real Socket.IO delivery and the shared cancellation owner stay active.
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        await act(async () => { f.loseReplies[0]!(); });
        await vi.waitFor(() => expect(picker.getCurrent().probe.phase).toBe('idle'));
        expect(picker.getCurrent().probe).toMatchObject({ reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown' });
        const count = retain ? 2 : 1;
        expect(f.issued).toHaveLength(count);
        if (retain) expect(picker.getCurrent().preflightModes?.availableModes).toEqual(f.observation.availableModes);
        await act(async () => vi.advanceTimersByTimeAsync(modeCache.DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS * 2));
        expect(f.issued).toHaveLength(count);
        // Expiring the ordinary retry clock must not turn remount into an automatic resubmission either.
        await picker.unmount();
        const next = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('mode-machine') });
        try { expect(f.issued).toHaveLength(count); } finally { await next.unmount(); }
    } finally { vi.useRealTimers(); await picker.unmount(); await f.dispose(); }
});

it('keeps definite native unavailability on the ordinary resource retry policy', async () => {
    const f = await preflightHome();
    f.mode.set('mode-machine', 'unavailable');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const picker = await renderHook(useNewSessionPreflightSessionModesState, { initialProps: f.picker('mode-machine') });
    try {
        await vi.waitFor(() => expect(picker.getCurrent().preflightModes?.unavailable).toBe(true));
        expect(picker.getCurrent().probe).not.toHaveProperty('reason', 'outcomeUnknown');
        f.mode.set('mode-machine', 'success');
        await act(async () => vi.advanceTimersByTimeAsync(modeCache.DYNAMIC_SESSION_MODE_PROBE_ERROR_BACKOFF_MS + 1));
        await vi.waitFor(() => expect(picker.getCurrent().preflightModes?.availableModes).toEqual(f.observation.availableModes));
        expect(f.issued).toEqual(['mode-machine', 'mode-machine']);
    } finally { vi.useRealTimers(); await picker.unmount(); await f.dispose(); }
});

it.each(['unmount', 'machine-change'] as const)('releases the config picker occurrence on %s through Action and Machine', async departure => {
    const f = await preflightHome({ inventory: 'config' });
    f.mode.set('next-machine', 'success');
    const picker = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('pending-config') });
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-config']));
        if (departure === 'unmount') await picker.unmount();
        else await picker.rerender(f.picker('next-machine'));
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
        if (departure === 'machine-change') {
            await vi.waitFor(() => expect(picker.getCurrent().configOptions).toEqual(f.configObservation.configOptions));
        }
        f.mode.set('pending-config', 'success');
        const next = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('pending-config') });
        try {
            await vi.waitFor(() => expect(next.getCurrent().configOptions).toEqual(f.configObservation.configOptions));
            expect(f.issued.filter(machine => machine === 'pending-config')).toHaveLength(2);
        } finally { await next.unmount(); }
    } finally { await picker.unmount(); await f.dispose(); }
});

it('keeps the config occurrence until its final picker consumer leaves', async () => {
    const f = await preflightHome({ inventory: 'config' });
    const first = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('pending-config') });
    const second = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('pending-config') });
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-config']));
        await first.unmount();
        await flushHookEffects();
        expect(f.cancelled).toHaveLength(0);
        expect(second.getCurrent().probe.phase).toBe('loading');
        await second.unmount();
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
    } finally { await first.unmount(); await second.unmount(); await f.dispose(); }
});

it('binds config resource cancellation to its consumer through Action and Machine, not a neighboring signal', async () => {
    const f = await preflightHome({ inventory: 'config' });
    const owner = new AbortController();
    const neighbor = new AbortController();
    const pending = configCache.runDynamicConfigOptionsProbeDedupe('owned-config', signal =>
        invokeAgentInventoryProbeAction({ ...f.params('pending-config'), signal }, 'probeConfigOptions'), owner.signal)
        .then(value => value, (error: unknown) => error);
    try {
        await vi.waitFor(() => expect(f.issued).toEqual(['pending-config']));
        neighbor.abort();
        await flushHookEffects();
        expect(f.cancelled).toHaveLength(0);
        owner.abort();
        await vi.waitFor(() => expect(f.cancelled).toHaveLength(1));
        expect(await pending).toBeInstanceOf(Error);
    } finally { owner.abort(); await f.dispose(); }
});

it.each([false, true])('retains config unknown without automatic resubmission and permits explicit Refresh (last good: %s)', async retain => {
    const f = await preflightHome({ inventory: 'config', holdLost: true });
    f.mode.set('config-machine', retain ? 'success' : 'lost');
    const picker = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('config-machine') });
    let lastGoodAt: number | null = null;
    try {
        if (retain) {
            await vi.waitFor(() => expect(picker.getCurrent().configOptions).toEqual(f.configObservation.configOptions));
            lastGoodAt = picker.getCurrent().probe.refreshedAt;
            f.mode.set('config-machine', 'lost');
            await act(async () => picker.getCurrent().probe.onRefresh());
        }
        await vi.waitFor(() => expect(f.loseReplies).toHaveLength(1));
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        await act(async () => {
            // Separate the failure's observation time from the successful data age.
            vi.advanceTimersByTime(1_000);
            f.loseReplies[0]!();
        });
        await vi.waitFor(() => expect(picker.getCurrent().probe.phase).toBe('idle'));
        expect(picker.getCurrent().probe).toMatchObject({ reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown', refreshedAt: lastGoodAt });
        expect(picker.getCurrent().configOptions).toEqual(retain ? f.configObservation.configOptions : null);
        const count = retain ? 2 : 1;
        await act(async () => vi.advanceTimersByTimeAsync(configCache.DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS * 2));
        expect(f.issued).toHaveLength(count);
        await picker.unmount();
        const next = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('config-machine') });
        try {
            await flushHookEffects();
            expect(f.issued).toHaveLength(count);
            expect(next.getCurrent().probe).toMatchObject({ reason: 'outcomeUnknown', requestDisposition: 'outcomeUnknown', refreshedAt: lastGoodAt });
            expect(next.getCurrent().configOptions).toEqual(retain ? f.configObservation.configOptions : null);
            f.mode.set('config-machine', 'success');
            await act(async () => next.getCurrent().probe.onRefresh());
            await vi.waitFor(() => expect(next.getCurrent().configOptions).toEqual(f.configObservation.configOptions));
            await vi.waitFor(() => expect(next.getCurrent().probe.phase).toBe('idle'));
            expect(next.getCurrent().probe).not.toHaveProperty('reason', 'outcomeUnknown');
            expect(next.getCurrent().probe.refreshedAt).toBeGreaterThan(lastGoodAt ?? 0);
            expect(f.issued).toHaveLength(count + 1);
        } finally { await next.unmount(); }
    } finally { vi.useRealTimers(); await picker.unmount(); await f.dispose(); }
});

it('keeps definite config unavailability on the ordinary recovery policy', async () => {
    const f = await preflightHome({ inventory: 'config' });
    f.mode.set('config-machine', 'unavailable');
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const picker = await renderHook(useNewSessionPreflightConfigOptionsState, { initialProps: f.picker('config-machine') });
    try {
        await vi.waitFor(() => expect(picker.getCurrent().unavailable).toBe(true));
        expect(picker.getCurrent().probe).not.toHaveProperty('reason', 'outcomeUnknown');
        f.mode.set('config-machine', 'success');
        await act(async () => vi.advanceTimersByTimeAsync(configCache.DYNAMIC_CONFIG_OPTIONS_PROBE_ERROR_BACKOFF_MS + 1));
        await vi.waitFor(() => expect(picker.getCurrent().configOptions).toEqual(f.configObservation.configOptions));
        expect(picker.getCurrent().unavailable).toBe(false);
        expect(f.issued).toEqual(['config-machine', 'config-machine']);
    } finally { vi.useRealTimers(); await picker.unmount(); await f.dispose(); }
});
