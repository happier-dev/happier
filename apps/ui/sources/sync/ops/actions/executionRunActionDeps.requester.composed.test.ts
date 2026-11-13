import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema, projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainV2SessionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { answerExternalActionAccountForHome, createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { ExecutionRunGetResponseSchema } from '@happier-dev/protocol/execution/runs/responseSchemas';
import { flushHookEffects, renderHook } from '@/dev/testkit';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

const machineMethods: string[] = [];
const attachedReadBoundary: { code: string; result?: unknown; beforeReply?: () => Promise<void> } = { code: 'target_unavailable' };
// Only the external Socket.IO SDK transport is synthetic. Scoped Account,
// Machine setup/reachability, RPC envelopes and response correlation stay real.
installDisconnectedServerSocketBoundary(socket => {
    configureConnectedServerSocketBoundary(socket);
    socket.emitWithAck = vi.fn(async (event: string, payload: unknown) => {
        expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
        if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
            || !('params' in payload)) throw new Error('Missing Machine RPC wire request');
        machineMethods.push(payload.method);
        // The detached native host cannot prepare a launch from a plain RPC
        // without admitted requester custody (the READY55 failure boundary).
        if (payload.method === 'machine:execution.run.send' || payload.method === 'machine:execution.run.ensure') {
            const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
            return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
                ok: false, errorCode: 'plugin_exec_native_launch_unavailable', error: 'Native launch preparation unavailable',
            }, request.callId) };
        }
        if (payload.method.startsWith('retained-session:execution.run.')) {
            await attachedReadBoundary.beforeReply?.();
            if (attachedReadBoundary.result) {
                const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
                return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, attachedReadBoundary.result, request.callId) };
            }
            return { ok: false, errorCode: attachedReadBoundary.code, error: 'Session Run read refused' };
        }
        expect(payload.method).toBe('machine:capabilities.describe');
        const request = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, payload.params, payload.method);
        expect(request.params).toEqual({});
        return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, {
            protocolVersion: 1, capabilities: [{ id: 'tool.executionRuns', kind: 'tool', protocol: {
                version: 2, available: true, features: { detachedScope: true, startAndWait: true, runScopedAgentBindings: true, exactInputResults: true },
            } }], checklists: {},
        }, request.callId) };
    });
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { createFrontDoorActionExecute } = await import('./frontDoorRuntimeActionExecutor');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { createUiExecutionRunActionDeps } = await import('./executionRunActionDeps');
const { sessionExecutionRunGet, sessionExecutionRunList, sessionExecutionRunWait } = await import('../sessionExecutionRuns');

beforeEach(async () => { await homes.reset(); machineMethods.length = 0;
    attachedReadBoundary.code = 'target_unavailable'; attachedReadBoundary.result = undefined; attachedReadBoundary.beforeReply = undefined; });
afterEach(() => standardCleanup());

it.each([true, false])('admits attached Voice once through the signed Account front door: approval=%s', async canApproveRequests => {
    await loadSyncSingletonForTests();
    const serverId = await homes.addHome({ name: 'Voice admission', serverUrl: 'https://voice-admission.test',
        serverIdentityId: 'srv_voice_admission', accountId: 'requester', currentAccount: true });
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    homes.answer(serverId, 'GET /v2/account/settings', { body: { version: 1, content: { t: 'plain',
        v: { voice: { ...settingsDefaults.voice, canApproveRequests } } } } });
    const session = createPlainV2SessionRecordFixture({ id: 'voice-session', active: true,
        metadata: { machineId: 'machine', path: '/repo', host: 'voice.test', homeDir: '/home/test' } });
    homes.answer(serverId, '/v2/sessions/voice-session', { body: { session } });
    const invocation = { caller: { kind: 'host' as const }, surface: 'voice' as const,
        authority: canApproveRequests ? 'present_user' as const : 'account_automation' as const };
    const boundary = await answerExternalActionAccountForHome(homes, serverId, {
        machineId: 'machine', actionId: 'execution.run.start', tokenEpoch: 0,
        execute(input, context) {
            expect(input).toMatchObject({ sessionId: 'voice-session', intent: 'voice_agent' });
            expect(context.invocation).toMatchObject(invocation);
            return { runId: 'voice-run', callId: 'voice-call', sidechainId: 'voice-sidechain', actionInvocation: invocation };
        },
    });
    homes.answer(serverId, 'GET /v1/machines', { body: [boundary.machine] });
    const { DaemonVoiceAgentClient } = await import('@/voice/agent/daemonVoiceAgentClient');
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    const started = await new DaemonVoiceAgentClient({ serverId: resolveServerProfileScopeIdForIdentifier(serverId), accountId: 'requester' }).start({
        sessionId: 'voice-session', agentId: 'codex', permissionIntent: 'read-only', idleTtlSeconds: 300, initialContext: 'Hello',
    });
    expect(started).toMatchObject({ voiceAgentId: 'voice-run', actionInvocation: invocation });
    expect(machineMethods).not.toContain('voice-session:execution.run.ensureOrStart');
});

it('settles a retained roster HTTP 409 without retrying until a real refresh trigger', async () => {
    await loadSyncSingletonForTests();
    const serverUrl = 'https://runlist-refusal.test';
    const homeId = 'srv_runlist_refusal';
    const serverId = await homes.addHome({ name: 'Run list refusal', serverUrl,
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
    const sessionId = 'retained-session';
    const session = createPlainV2SessionRecordFixture({ id: sessionId, active: false,
        metadata: { machineId: 'machine', path: '/repo', host: 'retained.test', homeDir: '/home/test' } });
    homes.answer(serverId, `/v2/sessions/${sessionId}`, { body: { session } });
    const actionId = 'execution.run.list';
    const actionPath = `/v1/actions/${actionId}`;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId: 'requester', machineId: 'machine', actionId, tokenEpoch: 0,
        execute: () => { throw new Error('A pre-dispatch HTTP refusal must not execute the list'); } });
    for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/machines/machine',
        `${actionPath}/execution-authorization`]) {
        homes.answer(serverId, path, { select: async input => {
            const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                : { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error('Unexpected Run list fixture path');
            return { status: response.status, body: await response.json() };
        } });
    }
    homes.answer(serverId, actionPath, { select: input => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(input);
        const refusal = projectExternalActionHttpError('target_unavailable', request.envelope.requestId);
        return { status: refusal.statusCode, body: refusal.payload };
    } });
    const { useSessionRunningExecutionRuns } = await import('@/hooks/session/useSessionRunningExecutionRuns');
    const { readRunningExecutionRunRosterSnapshot, refreshRunningExecutionRunRoster } = await import('@/sync/runtime/executionRuns/executionRunActivityBus');
    const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
    const address = { serverId, sessionId };
    const hook = await renderHook(() => useSessionRunningExecutionRuns({ ...address, enabled: true }));
    try {
        await vi.waitFor(() => expect(readRunningExecutionRunRosterSnapshot(address)).toMatchObject({ loading: false, failed: true }));
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
        expect(homes.requestsFor(`${actionPath}/execution-authorization`)).toHaveLength(1);
        expect(hook.getCurrent()).toEqual([]);
        const encryptionReads = () => ({
            mode: homes.requestsFor('/v1/account/encryption').length,
            currentness: homes.requestsFor('/v1/account/encryption/currentness').length,
        });
        const baselineEncryptionReads = encryptionReads();
        vi.useFakeTimers();
        await hook.rerender();
        for (let index = 0; index < 1_000; index++) {
            publishHomeAccountChange(serverId, [`unrelated-${index}`], { changeKinds: ['session'] });
        }
        await flushHookEffects({ advanceTimersMs: 60_000, cycles: 1 });
        expect(homes.requestsFor(actionPath)).toHaveLength(1);
        expect(homes.requestsFor(`${actionPath}/execution-authorization`)).toHaveLength(1);
        expect(encryptionReads()).toEqual(baselineEncryptionReads);
        vi.useRealTimers();
        refreshRunningExecutionRunRoster(address);
        await vi.waitFor(() => expect(homes.requestsFor(actionPath)).toHaveLength(2));
        await vi.waitFor(() => expect(readRunningExecutionRunRosterSnapshot(address)).toMatchObject({ loading: false, failed: true }));
        expect(homes.requestsFor(`${actionPath}/execution-authorization`)).toHaveLength(2);
        console.info('RUNLIST-409 request counts', { baseline: baselineEncryptionReads, afterExplicitRefresh: encryptionReads() });
    } finally {
        vi.useRealTimers();
        await hook.unmount();
    }
});

it.each([
    { operation: 'get', scenario: 'recovered' }, { operation: 'list', scenario: 'recovered' },
    { operation: 'wait', scenario: 'recovered' }, { operation: 'get', scenario: 'voice' }, { operation: 'get', scenario: 'live' },
    { operation: 'get', scenario: 'denied' }, { operation: 'get', scenario: 'unknown' },
    { operation: 'get', scenario: 'retired' }, { operation: 'get', scenario: 'source-denied' },
] as const)('reads a retained Session Run through exact Account custody after Session RPC disappears: $operation/$scenario', async ({ operation, scenario }) => {
    const homeId = 'srv_retained_run_reader';
    const serverUrl = 'https://retained-run-reader.test';
    const serverId = await homes.addHome({ name: 'Retained Run reader', serverUrl,
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
    const sessionId = 'retained-session';
    const run = ExecutionRunGetResponseSchema.parse({ run: {
        runId: 'retained-run', callId: 'retained-call', sidechainId: 'retained-sidechain',
        intent: 'delegate', backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
        permissionMode: 'read_only', retentionPolicy: 'ephemeral', runClass: 'bounded',
        ioMode: 'request_response', status: 'succeeded', startedAtMs: 1, finishedAtMs: 2,
    } });
    const session = createPlainV2SessionRecordFixture({ id: sessionId, active: false,
        metadata: { machineId: 'machine', path: '/repo', host: 'retained.test', homeDir: '/home/test' } });
    homes.answer(serverId, `/v2/sessions/${sessionId}`, { select: () => scenario === 'source-denied'
        ? { status: 403, body: { error: 'forbidden' } } : { body: { session } } });
    if (scenario === 'denied') attachedReadBoundary.code = 'run_access_denied';
    if (scenario === 'unknown') attachedReadBoundary.code = 'unknown_read_failure';
    if (scenario === 'retired') attachedReadBoundary.beforeReply = async () => { await homes.switchAccount(serverId, 'replacement'); };
    const actionId = `execution.run.${operation}` as const;
    const body = operation === 'get' ? run : operation === 'list' ? { runs: [run.run] }
        : { ok: true, status: 'succeeded', result: run };
    if (scenario === 'live') attachedReadBoundary.result = body;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId: 'requester', machineId: 'machine', actionId, tokenEpoch: 0,
        execute(input, context) {
            expect(input).toMatchObject({ sessionId });
            expect(context.target).toEqual({ kind: 'machine', machineId: 'machine' });
            expect(context.invocation).toMatchObject({ surface: scenario === 'voice' ? 'voice' : 'ui',
                authority: scenario === 'voice' ? 'account_automation' : 'present_user', caller: { kind: 'host' } });
            return body;
        } });
    for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/machines/machine',
        `/v1/actions/${actionId}`, `/v1/actions/${actionId}/execution-authorization`]) {
        homes.answer(serverId, path, { select: async input => {
            const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                : { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error('Unexpected retained Run HTTP fixture path');
            return { body: await response.json() };
        } });
    }
    const options = { serverId };
    const result = scenario === 'voice'
        ? await createFrontDoorActionExecute(createDefaultActionExecutor())(actionId, { sessionId, runId: run.run.runId },
            { surface: 'voice', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId })
        : operation === 'get'
        ? await sessionExecutionRunGet(sessionId, { runId: run.run.runId, includeStructured: false }, options)
        : operation === 'list' ? await sessionExecutionRunList(sessionId, {}, options)
            : await sessionExecutionRunWait(sessionId, { runId: run.run.runId }, options);
    const recovered = scenario === 'recovered' || scenario === 'voice';
    if (recovered || scenario === 'live') expect(result).toEqual(scenario === 'voice' ? { ok: true, result: body } : body);
    else if (scenario === 'source-denied') expect(result).toMatchObject({ ok: false });
    else expect(result).toMatchObject({ ok: false, errorCode: scenario === 'retired' ? 'action_account_scope_changed' : attachedReadBoundary.code });
    expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(recovered ? 1 : 0);
    expect(machineMethods.filter(method => method === `${sessionId}:${actionId}`)).toHaveLength(scenario === 'source-denied' ? 0 : 1);
});

it.each(['accepted', 'refused', 'foreign-root', 'uncertain'] as const)('FIX81 carries direct detached start through original requester Action admission: %s', async scenario => {
    const homeId = 'srv_detached_requester';
    const serverId = await homes.addHome({ name: 'Detached requester', serverUrl: 'https://detached-requester.test',
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
    const machineId = 'machine';
    const onTransportIssued = vi.fn();
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const machine = { ...createPlainMachineRowFixture({ id: machineId, accountId: 'requester' }),
        installationId: 'installation', installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
    homes.answer(serverId, '/v1/actions/execution.run.start', { select: body => {
        if (scenario === 'uncertain') return { status: 502 };
        const envelope = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
        const request = envelope.success ? envelope.data.envelope : body;
        if (!request || typeof request !== 'object' || !('input' in request) || !('requestId' in request)) throw new Error('Missing original Action envelope');
        expect(getActionSpec('execution.run.start').inputSchema.parse(request.input)).toMatchObject({ sessionId: null, cwd: '/repo' });
        expect(request).toMatchObject({ target: { kind: 'machine', machineId } });
        if (!envelope.success) throw new Error('The direct start must use the admitted requester carrier');
        expect(openExternalActionRequesterAccountContextV1({ authorization: envelope.data.executionAuthorization,
            purpose: { kind: 'external_action' }, machineId, installationId: 'installation', serverIdentityId: homeId,
            installationPrivateKey: installation.secretKey, includeInvocation: true })).toMatchObject({
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
            });
        return { body: { v: 1, actionId: 'execution.run.start', requestId: request.requestId,
            execution: scenario === 'accepted' ? { ok: true, result: { runId: 'detached-run', callId: 'call', sidechainId: 'sidechain' } }
                : { ok: false, errorCode: 'project_requester_credentials_unavailable', error: 'Retired requester',
                    details: { executionRunStart: { v: 1, runCreation: 'noRunCreated' } } } } };
    } });
    homes.answer(serverId, '/v1/actions/execution.run.start/execution-authorization', { select: body => {
        const mint = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
        return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-root', binding: {
            accountId: scenario === 'foreign-root' ? 'another-account' : 'requester', custodianAccountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
            accountEncryptionMode: 'plain', serverIdentityId: homeId, machineId, installationId: 'installation',
            actionId: 'execution.run.start', requestId: mint.envelope.requestId, target: mint.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(mint.envelope),
        } }) };
    } });
    const result = await createFrontDoorActionExecute(createDefaultActionExecutor())('execution.run.start', {
        sessionId: null, intent: 'agent', backendTarget: { kind: 'builtInAgent', agentId: 'kilo' },
        cwd: '/repo', instructions: 'Inspect the Project.', permissionMode: 'read_only',
        retentionPolicy: 'resumable', runClass: 'long_lived', ioMode: 'request_response',
        connectedServices: { v: 2, bindingsByServiceId: {} },
    }, { surface: 'ui', serverId, expectedAccountId: 'requester', executionRunTargetMachineId: machineId, onTransportIssued });
    expect(homes.requestsFor('/v1/actions/execution.run.start'), JSON.stringify(result)).toHaveLength(scenario === 'foreign-root' ? 0 : 1);
    if (scenario === 'accepted') expect(result).toMatchObject({ ok: true, result: { runId: 'detached-run' } });
    else if (scenario === 'foreign-root') expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    else if (scenario === 'uncertain') expect(result).toMatchObject({ ok: false, errorCode: 'outcome_unknown',
        details: { executionRunStart: { runCreation: 'outcomeUnknown' } } });
    else expect(result).toMatchObject({ ok: false, errorCode: 'project_requester_credentials_unavailable',
        details: { executionRunStart: { runCreation: 'noRunCreated' } } });
    expect(machineMethods).toEqual(['machine:capabilities.describe']);
    expect(onTransportIssued).toHaveBeenCalledTimes(scenario === 'foreign-root' ? 0 : 1);
});

it.each((['send', 'ensure'] as const).flatMap(operation =>
    (['accepted', 'active', 'foreign-root', 'refused', 'uncertain'] as const).map(scenario => ({ operation, scenario }))))
('resumes a detached Run through admitted requester custody: $operation/$scenario', async ({ operation, scenario }) => {
    const homeId = 'srv_detached_resume';
    const serverUrl = 'https://detached-resume.test';
    const serverId = await homes.addHome({ name: 'Detached resume', serverUrl,
        serverIdentityId: homeId, accountId: 'requester', currentAccount: true });
    const actionId = `execution.run.${operation}` as const;
    const boundary = await createExternalActionAccountHttpBoundary({ serverUrl, serverIdentityId: homeId,
        accountId: 'requester', machineId: 'machine', actionId, tokenEpoch: 0,
        failure: () => scenario === 'refused' ? {
            errorCode: 'project_requester_credentials_unavailable', error: 'Requester custody unavailable',
        } : null,
        execute(input, context) {
            expect(getActionSpec(actionId).inputSchema.parse(input)).toMatchObject({ sessionId: null, runId: 'retained-native-run' });
            if (scenario === 'active') expect(input).not.toHaveProperty('resume');
            else expect(input).toMatchObject({ resume: true });
            if (operation === 'send') expect(input).toMatchObject({ message: 'Continue the native Run.',
                localInputId: 'next-turn', delivery: 'prompt' });
            expect(context.target).toEqual({ kind: 'machine', machineId: 'machine' });
            expect(context.invocation).toMatchObject({ caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' });
            return { ok: true };
        } });
    for (const path of ['/v1/machines', '/v1/machines/read-batch', '/v1/machines/machine',
        `/v1/actions/${actionId}`, `/v1/actions/${actionId}/execution-authorization`]) {
        homes.answer(serverId, path, { select: async input => {
            if (scenario === 'uncertain' && path === `/v1/actions/${actionId}`) return { status: 502 };
            const response = await boundary.handle(new URL(path, serverUrl), input === undefined ? undefined
                : { method: 'POST', body: JSON.stringify(input) });
            if (!response) throw new Error('Unexpected detached resume HTTP path');
            const body = await response.json();
            if (scenario === 'foreign-root' && path.endsWith('/execution-authorization')) {
                const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(body);
                return { body: { ...authorization, binding: { ...authorization.binding, accountId: 'another-account' } } };
            }
            return { body };
        } });
    }
    const result = await createFrontDoorActionExecute(createDefaultActionExecutor())(actionId, {
        sessionId: null, runId: 'retained-native-run', resume: scenario !== 'active',
        ...(operation === 'send' ? { message: 'Continue the native Run.', localInputId: 'next-turn', delivery: 'prompt' } : {}),
    }, { surface: 'ui', serverId, expectedAccountId: 'requester', executionRunTargetMachineId: 'machine' });
    if (scenario === 'accepted' || scenario === 'active') expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true } });
    else expect(result).toMatchObject({ ok: false, errorCode: scenario === 'foreign-root' ? 'admission_unavailable'
        : scenario === 'uncertain' ? 'outcome_unknown' : 'project_requester_credentials_unavailable' });
    expect(homes.requestsFor(`/v1/actions/${actionId}`)).toHaveLength(scenario === 'foreign-root' ? 0 : 1);
    expect(machineMethods).toEqual(['machine:capabilities.describe']);
});

it('refuses non-JSON detached input before issuing an Action and reports no Run created', async () => {
    const serverId = await homes.addHome({ name: 'Invalid detached input', serverUrl: 'https://invalid-detached.test',
        serverIdentityId: 'srv_invalid_detached', accountId: 'requester', currentAccount: true });
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(12));
    const machine = { ...createPlainMachineRowFixture({ id: 'machine', accountId: 'requester' }), installationId: 'installation',
        installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
        dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId: 'requester', displayName: 'Requester' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    homes.answer(serverId, '/v1/machines/machine', { body: { machine } });
    const account = await captureLazyActionAccountContext(serverId);
    const onTransportIssued = vi.fn();
    try {
        const result = await createUiExecutionRunActionDeps(account.accountLifetime.scope, account).executionRunStart(null, {
            intent: 'agent', instructions: 'Inspect.', connectedServices: new Map(),
        }, { serverId: account.serverId, runtimeAccountId: account.accountId, exactMachineId: 'machine',
            surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, onTransportIssued });
        expect(result).toMatchObject({ ok: false, errorCode: 'invalid_parameters',
            details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(homes.requestsFor('/v1/actions/execution.run.start')).toEqual([]);
        expect(homes.requestsFor('/v1/actions/execution.run.start/execution-authorization')).toEqual([]);
        expect(onTransportIssued).not.toHaveBeenCalled();
    } finally { account.dispose(); }
});

it.each((['start', 'send', 'ensure'] as const).flatMap(operation =>
    (['mismatched', 'retired'] as const).map(scenario => ({ operation, scenario }))))
('refuses $scenario requester custody before detached $operation dispatch', async ({ operation, scenario }) => {
    const serverId = await homes.addHome({ name: 'Retained requester', serverUrl: 'https://retained-requester.test',
        serverIdentityId: 'srv_retained_requester', accountId: 'requester', currentAccount: true });
    const account = await captureLazyActionAccountContext(serverId);
    try {
        if (scenario === 'retired') await homes.switchAccount(serverId, 'replacement');
        const deps = createUiExecutionRunActionDeps(account.accountLifetime.scope, account);
        const opts = { serverId: account.serverId, runtimeAccountId: scenario === 'mismatched' ? 'another-account' : account.accountId,
            exactMachineId: 'machine', surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        const result = operation === 'start' ? await deps.executionRunStart(null, {
            intent: 'agent', instructions: 'Inspect the Project.',
        }, opts) : operation === 'send' ? await deps.detachedExecutionRunSend!(null, {
            runId: 'retained-native-run', message: 'Continue.', resume: true,
        }, opts) : await deps.executionRunEnsure!(null, { runId: 'retained-native-run', resume: true }, opts);
        expect(result).toMatchObject({ ok: false, errorCode: 'content_unavailable' });
        if (operation === 'start') expect(result).toMatchObject({ details: { executionRunStart: { runCreation: 'noRunCreated' } } });
        expect(homes.requestsFor(`/v1/actions/execution.run.${operation}`)).toHaveLength(0);
        expect(machineMethods).toEqual([]);
    } finally { account.dispose(); }
});

it.each(['send', 'ensure'] as const)('refuses detached %s without an admitted requester', async operation => {
    const deps = createUiExecutionRunActionDeps();
    const opts = { exactMachineId: 'machine', surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
    const result = operation === 'send' ? await deps.detachedExecutionRunSend!(null, {
        runId: 'retained-native-run', message: 'Continue.', resume: true,
    }, opts) : await deps.executionRunEnsure!(null, { runId: 'retained-native-run', resume: true }, opts);
    expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
    expect(machineMethods).toEqual([]);
});
