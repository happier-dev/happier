import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOCKET_RPC_EVENTS, type SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ProjectCommandActionOutputV1Schema } from '@happier-dev/protocol/actions/actionCompletion';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectDefinitionInspectOutputSchema } from '@happier-dev/protocol/actions/projectDefinitionActionFamily';
import { readProjectManifestDocument } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestDocument';
import { createDefaultWorkspaceExecutionSettingsV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createProjectAccountRowsFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { PROJECT_TRUST_ROUTE_V1, ProjectTrustMutationRequestV1Schema } from '@happier-dev/protocol/workspaces/projectSetup/projectTrustRowV1';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { act } from 'react-test-renderer';
import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionMachineBootstrapV1Schema, ExternalActionRequestEnvelopeV1Schema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { createProjectManifestActionClient } from '@/components/projects/projectSetup/projectManifestActionClient';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { encodeTerminalStreamBytes } from '@happier-dev/protocol/terminal/stream';

// Component probes retain the real controller/Actions; only native rendering is substituted.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
const clipboard = vi.hoisted(() => ({ write: vi.fn(async (_text: string) => {}) }));
// System clipboard only; Copy retains the real UI, Action policy, scope check and byte decoder.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.write }));

const foreignDisclosure = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: foreignDisclosure } }).module;
});

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

// Only Home HTTP, device credentials and the Socket.IO discovery/status relay are replaced.
// The default Action host, captured Account, policy and original-Account HTTP delivery stay real.
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const calls: Array<{ serverUrl: string | undefined; token: unknown; request: SocketRpcRequestPayload }> = [];
let response: unknown;
let consumeAcknowledgement: (() => void) | undefined;
let rejectOpenJson = false;
let restoreHttpReplyDecoder: (() => void) | undefined;
const rpcResponses = new Map<string, unknown>();
const configureRelay: NonNullable<Parameters<typeof installDisconnectedServerSocketBoundary>[0]> = (socket, serverUrl) => {
    socket.connected = true;
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, request: SocketRpcRequestPayload) => {
        if (event !== SOCKET_RPC_EVENTS.CALL) throw new Error(`Unexpected relay event: ${event}`);
        calls.push({ serverUrl, token: socket.auth && typeof socket.auth === 'object' ? Reflect.get(socket.auth, 'token') : undefined, request });
        return { ok: true, result: rpcResponses.get(request.method) ?? response };
    });
};
installDisconnectedServerSocketBoundary(configureRelay);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
// Load the real UI graph during collection; compilation is not a Script behavior deadline.
await import('@/components/projects/projectSetup/ProjectScriptsBody');
let serverId: string;
let requesterHomeId: string;
const serverUrl = 'https://finite-requester.test';
const requesterToken = createAccountTokenForTests('requester', { currentAccount: true });
function answerOwnMachineActions(homeId: string, accountId: string, serverIdentityId = 'srv_finite_requester'): void {
    const machines = ['source', 'selected-worker'].map(id => ExternalActionMachineBootstrapV1Schema.parse({
        id, kind: 'persistent', active: true, revokedAt: null, replacedByMachineId: null,
        installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
        access: { custodian: { accountId, displayName: accountId }, role: 'manage', resourceMode: 'plain', accessState: 'ready' },
    }));
    homes.answer(homeId, '/v1/machines', { body: machines });
    for (const machine of machines) homes.answer(homeId, `GET /v1/machines/${machine.id}`, { body: { machine } });
    for (const actionId of ['projects.open', 'projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const) {
        homes.answer(homeId, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            const machine = machines.find(candidate => candidate.id === request.machineId);
            if (!machine) throw new Error('Unknown own finite Machine');
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `own-finite-root-${actionId}`, binding: {
                accountId, authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId,
                machineId: machine.id, installationId: machine.installationId, custodianAccountId: accountId,
                accountEncryptionMode: 'plain', actionId, requestId: request.envelope.requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        homes.answer(homeId, `/v1/actions/${actionId}`, { select: body => {
            const admitted = ExternalActionExecutionAuthorizationRequestV1Schema.safeParse(body);
            const request = admitted.success ? admitted.data.envelope : ExternalActionRequestEnvelopeV1Schema.parse(body);
            return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId, requestId: request.requestId,
                execution: response && typeof response === 'object' && 'ok' in response
                    ? response : { ok: true, result: response },
            }) };
        } });
    }
}
function ownFiniteRelayRequests(actionId: keyof typeof PROJECT_FINITE_ACTION_RPC_METHODS_V1) {
    return homes.requestsFor(`/v1/actions/${actionId}`).map(record => {
        const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(record.input);
        expect(request.executionAuthorization).toBeDefined();
        expect(request.executionAuthorization?.binding).toMatchObject({ actionId, requestId: request.envelope.requestId,
            machineId: request.machineId, target: request.envelope.target,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) });
        expect(request.executionAuthorization?.binding.accountId).toBe(request.executionAuthorization?.binding.custodianAccountId);
        expect(request.executionAuthorization?.requesterAccountContext).toBeUndefined();
        expect(request.executionAuthorization?.managedFiniteWake).toBeUndefined();
        return { ...record, input: request.envelope };
    });
}
function answerExplicitScriptWorkerPlacement(): void {
    const inspectionMethod = getActionSpec('projects.inspect').bindings?.rpcMethod;
    const statusMethod = getActionSpec('projects.worker.status').bindings?.rpcMethod;
    if (!inspectionMethod || !statusMethod) throw new Error('Missing canonical project placement RPC binding');
    // Current SOURCE permission and worker eligibility are separate read replies,
    // not the finite Action's later setup-review or completion receipt.
    rpcResponses.set(`source:${inspectionMethod}`, ProjectDefinitionInspectOutputSchema.parse({
        definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
            version: 1, scripts: { check: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } } },
        })) },
        detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
    }));
    homes.answer(requesterHomeId, '/v1/projects/execution/config/read', { body: { status: 'present', revision: 1,
        content: { t: 'plain', v: createDefaultWorkspaceExecutionSettingsV1() },
    } });
    rpcResponses.set(`selected-worker:${statusMethod}`, {
        eligible: true, candidate: { serverId, machineId: 'selected-worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown',
    });
}
beforeEach(async () => {
    clipboard.write.mockClear();
    installDisconnectedServerSocketBoundary(configureRelay);
    await homes.reset(); await loadSyncSingletonForTests(); calls.length = 0; rpcResponses.clear(); consumeAcknowledgement = undefined;
    rejectOpenJson = false;
    foreignDisclosure.mockReset().mockResolvedValue(true);
    requesterHomeId = await homes.addHome({ name: 'Finite requester', serverUrl, serverIdentityId: 'srv_finite_requester',
        accountId: 'requester', currentAccount: true, active: false, machinePoolsEnabled: true });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    serverId = resolveServerProfileScopeIdForIdentifier(requesterHomeId);
    // Exact worker preflight now reads receiving eligibility through the canonical status Action.
    rpcResponses.set('selected-worker:projects.worker.status', { eligible: true,
        candidate: { serverId, machineId: 'selected-worker' }, load: { kind: 'unknown' }, explanation: 'eligible' });
    await homes.addHome({ name: 'Focused custodian', serverUrl: 'https://finite-custodian.test', accountId: 'custodian' });
    homes.answer(requesterHomeId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    answerOwnMachineActions(requesterHomeId, 'requester');
    const decodeHttpReply = Response.prototype.json;
    const replyDecoder = vi.spyOn(Response.prototype, 'json').mockImplementation(async function (this: Response) {
        const payload: unknown = await decodeHttpReply.call(this);
        if (rejectOpenJson && payload && typeof payload === 'object' && 'actionId' in payload && payload.actionId === 'projects.open') {
            throw new SyntaxError('Incomplete Action HTTP response');
        }
        // Native HTTP reply decoding is the real boundary. Abort only after a
        // complete Action ACK exists, not during issuance or discovery reads.
        if (ExternalActionResponseEnvelopeV1Schema.safeParse(payload).success) consumeAcknowledgement?.();
        return payload;
    });
    restoreHttpReplyDecoder = () => replyDecoder.mockRestore();
});
afterEach(async () => { restoreHttpReplyDecoder?.(); restoreHttpReplyDecoder = undefined; await homes.reset(); });

describe('Project finite delivery through the default UI Action host', () => {
    it.each(['invalid_json', 'mismatched', 'mismatched_refusal', 'outcome_unknown', 'pre_open_refusal'] as const)('keeps original Open custody after HTTP settlement: %s', async settlement => {
        const [{ createProjectOpenController }, { createSessionDraftRepository }, { createSessionDraftCipher },
            { captureLazyActionAccountContext }] = await Promise.all([
            import('@/components/projects/activation/projectOpenController'),
            import('@/sync/ops/sessionDrafts/sessionDraftRepository'),
            import('@/sync/encryption/sessionDraftEncryption'),
            import('./actionAccountContext'),
        ]);
        const account = await captureLazyActionAccountContext(serverId);
        const scope = { serverId, accountId: 'requester' };
        const storage = new Map<string, string>();
        const repository = createSessionDraftRepository({
            scope, syncEnabled: false,
            storage: { getString: key => storage.get(key), set: (key, value) => storage.set(key, value), delete: key => storage.delete(key) },
            cipher: createSessionDraftCipher({ accountMode: 'plain', accountCryptoMaterial: null,
                getSessionContext: () => { throw new Error('Open cannot create a Session'); }, randomBytes: size => new Uint8Array(size) }),
            transport: { read: async () => ({ status: 'absent' }), list: async () => ({ items: [] }),
                mutate: async () => { throw new Error('Local draft cannot issue a remote draft mutation'); } },
        });
        const input = { serverId, machineId: 'source', source: { kind: 'folder' as const, path: '/repo' }, materialization: { kind: 'attach' as const } };
        let effects = 0;
        rejectOpenJson = settlement === 'invalid_json';
        homes.answer(requesterHomeId, '/v1/actions/projects.open', { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            if (settlement === 'pre_open_refusal') return { status: 409,
                body: { error: 'invalid_request', code: 'target_unavailable', requestId: request.envelope.requestId } };
            effects += 1;
            if (settlement === 'mismatched_refusal') return { status: 409,
                body: { error: 'invalid_request', code: 'target_unavailable', requestId: 'another-open' } };
            return { body: { v: 1, actionId: 'projects.open',
                requestId: settlement === 'mismatched' ? 'another-open' : request.envelope.requestId,
                execution: { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: { operationId: 'original-open' } } } };
        } });
        const navigation: unknown[] = [];
        const controller = createProjectOpenController({ repository, scope, draftId: '00000000-0000-4000-8000-000000000081',
            initialDraft: input, captureLifetime: () => account.accountLifetime, executor: createDefaultActionExecutor(),
            onOpened: result => { navigation.push(result); } });
        try {
            await controller.submit();
            if (settlement === 'pre_open_refusal') {
                expect(controller.getSnapshot().uncertainInput).toBeNull();
                expect(controller.getSnapshot().result).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
            } else {
                expect(controller.getSnapshot()).toMatchObject({ uncertainInput: input, result: { kind: 'outcomeUnknown' },
                    canCheck: settlement === 'outcome_unknown' });
                if (settlement === 'outcome_unknown') expect(controller.getSnapshot().result).toEqual({ kind: 'outcomeUnknown', operationId: 'original-open' });
            }
            controller.setDraft({ ...input, source: { kind: 'folder', path: '/edited' } });
            await controller.submit();
            expect(homes.requestsFor('/v1/actions/projects.open')).toHaveLength(settlement === 'pre_open_refusal' ? 2 : 1);
            expect(effects).toBe(settlement === 'pre_open_refusal' ? 0 : 1);
            expect(navigation).toEqual([]);
        } finally { controller.dispose(); account.dispose(); }
    });

    it('copies retained output from the toolbar through the registered Action and actual execution target', async () => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const { ProjectCommandOutputPane } = await import('@/components/inbox/actionOperations/ProjectCommandOutputPane');
        const operation = ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: {
            version: 1, operationId: 'copy-output', revision: 1, actionId: 'projects.script.run', state: 'succeeded',
            scope: { accountId: 'requester', machineId: 'source' }, title: 'Check', createdAt: 1, startedAt: 1, settledAt: 2, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId, machineId: 'selected-worker',
                workspaceRefId: 'worker-copy', cwd: '/worker/repo', terminalId: 'retained-terminal' },
        } });
        if (operation.kind !== 'found') throw new Error('Expected retained operation');
        rpcResponses.set(`source:${ACTION_OPERATION_RPC_METHODS_V2.get}`, operation);
        const bytes = new TextEncoder().encode('checked ✓\n');
        rpcResponses.set(`selected-worker:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`, {
            ok: true, terminalId: 'retained-terminal', frames: [{ t: 'bytes', terminalId: 'retained-terminal', seq: 0,
                byteOffset: 0, byteLength: bytes.length, encoding: 'base64', data: encodeTerminalStreamBytes(bytes) }],
            nextByteOffset: bytes.length, availableByteOffset: bytes.length, droppedBeforeByteOffset: 0, done: true,
        });
        const screen = await renderScreen(React.createElement(ProjectCommandOutputPane, { operation: { serverId, snapshot: operation.operation,
            observation: 'available', isUnavailableProjection: false }, title: 'Check' }));
        try {
            expect(screen.findByTestId('project-command-output.copy')).not.toBeNull();
            await screen.pressByTestIdAsync('project-command-output.copy');
            await vi.waitFor(() => expect(clipboard.write).toHaveBeenCalledWith('checked ✓\n'));
            expect(calls.find(call => call.request.method === `source:${ACTION_OPERATION_RPC_METHODS_V2.get}`)?.request.params)
                .toMatchObject({ operationId: 'copy-output' });
            expect(calls.find(call => call.request.method === `selected-worker:${RPC_METHODS.DAEMON_TERMINAL_STREAM_READ_BYTES}`)?.request.params)
                .toMatchObject({ terminalId: 'retained-terminal', byteOffset: 0 });
            expect(calls.some(call => /terminal\.(ensure|close)/.test(call.request.method))).toBe(false);
        } finally { await screen.unmount(); disposeExecutor(); }
    });
    it.each([true, false])('projects the named override and effective declared demand into the Script row (workspace enabled: %s)', async enabled => {
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const { ProjectScriptsBody } = await import('@/components/projects/projectSetup/ProjectScriptsBody');
        const { ProjectScriptRow } = await import('@/components/projects/projectSetup/ProjectScriptRow');
        const workspace = { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
        const workspaceDemand = { bytes: 8 * 1024 ** 3, basis: { kind: 'declared' } };
        const scriptDemand = { bytes: 4 * 1024 ** 3, basis: { kind: 'declared' } };
        const inspectionMethod = getActionSpec('projects.inspect').bindings!.rpcMethod!;
        rpcResponses.set(`source:${inspectionMethod}`, ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
                version: 1, workspace: { memoryDemand: workspaceDemand }, scripts: {
                    check: { execution: 'portable', memoryDemand: scriptDemand, source: { kind: 'command', command: 'echo checked' } },
                },
            })) },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        homes.answer(requesterHomeId, '/v1/projects/execution/config/read', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { enabled, destination: { kind: 'machine', machineId: 'selected-worker' }, unavailable: 'ask',
                allowAdHoc: false, scriptOverrides: { check: enabled ? 'primary' : 'workers' }, services: {} } },
        } });
        const inspection = await createProjectManifestActionClient({ workspace, expectedAccountId: 'requester' }).inspect();
        expect(inspection.definition.document).toMatchObject({ status: 'valid', manifest: {
            workspace: { memoryDemand: workspaceDemand }, scripts: { check: { memoryDemand: scriptDemand } },
        } });
        const screen = await renderScreen(React.createElement(ProjectScriptsBody, { workspace, presentation: 'widget', testID: 'scripts' }));
        try {
            await vi.waitFor(() => expect(screen.findAllByType(ProjectScriptRow)[0]?.props.defaultChoice).toEqual(enabled
                ? { kind: 'primary' } : { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } }));
            await vi.waitFor(() => expect(screen.findAllByType(ProjectScriptRow)[0]?.props.memoryDemand).toEqual(workspaceDemand));
            if (!enabled) {
                rpcResponses.set('selected-worker:projects.worker.status', { eligible: false, candidate: null, explanation: 'memory_insufficient',
                    observedMemory: { totalBytes: 4 * 1024 ** 3, availableBytes: 1024 ** 3 },
                    load: { kind: 'known', running: 1, queued: 0, accepting: true, runAtMost: 1 } });
                await screen.pressByTestIdAsync('scripts.script:check.run');
                await vi.waitFor(() => expect(screen.findAllByType(ProjectScriptRow)[0]?.props.workerRefusal)
                    .toMatchObject({ reason: 'memory_insufficient' }));
                expect(calls.find(call => call.request.method === 'selected-worker:projects.worker.status')?.request.params)
                    .toMatchObject({ memoryDemand: workspaceDemand });
                expect(ownFiniteRelayRequests('projects.script.run')).toEqual([]);
            }
        } finally { await act(async () => screen.unmount()); disposeExecutor(); }
    });

    it('retains an Ask-each-time Run intent, cancels without dispatch, and resumes with a chosen exact Machine', async () => withPopoverWebGlobals(async () => {
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { ProjectScriptsBody } = await import('@/components/projects/projectSetup/ProjectScriptsBody');
        const { WorkerDestinationPicker } = await import('@/components/projects/workers/WorkerDestinationPicker');
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const workspace = { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
        answerExplicitScriptWorkerPlacement();
        const inspectionMethod = getActionSpec('projects.inspect').bindings!.rpcMethod!;
        rpcResponses.set(`source:${inspectionMethod}`, ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
                version: 1, scripts: { check: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } } },
            })) }, detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        homes.answer(requesterHomeId, '/v1/projects/execution/config/read', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { enabled: true, destination: { kind: 'pool', poolId: '10000000-0000-4000-8000-000000000001', selection: 'ask' },
                unavailable: 'ask', allowAdHoc: false, scriptOverrides: {}, services: {} } },
        } });
        homes.answer(requesterHomeId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } },
        } } } });
        const requestedHomes = [serverId];
        const hook = await renderHook(() => useProjectScriptsController(workspace, () => {},
            useServerCredentialAccountScopeBindings(requestedHomes).get(serverId) ?? null));
        try {
            await act(async () => { await hook.getCurrent().run('check', { kind: 'named', name: 'check' }); });
            expect(hook.getCurrent().choiceRequired).toMatchObject({ key: 'check', selection: { kind: 'named', name: 'check' } });
            expect(hook.getCurrent().failure).toBeNull();
            expect(ownFiniteRelayRequests('projects.script.run')).toEqual([]);
            await act(async () => { hook.getCurrent().dismissChoice(); });
            expect(ownFiniteRelayRequests('projects.script.run')).toEqual([]);
            await act(async () => { await hook.getCurrent().run('check', { kind: 'named', name: 'check' }); });
            response = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'exact-current-effect' };
            const exact = { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } as const;
            await act(async () => { await hook.getCurrent().chooseForRun(exact); });
            expect(hook.getCurrent().failure, JSON.stringify(hook.getCurrent().failure)).toBeNull();
            expect(ownFiniteRelayRequests('projects.script.run')).toEqual([expect.objectContaining({ input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'selected-worker' }, input: { workspace, selection: { kind: 'named', name: 'check' }, choice: exact },
            }) })]);
            expect(hook.getCurrent().choiceRequired).toBeNull();
        } finally { await hook.unmount(); }
        const screen = await renderScreen(React.createElement(ProjectScriptsBody, { workspace, presentation: 'widget', testID: 'scripts' }));
        try {
            await vi.waitFor(() => expect(screen.findAllByTestId('scripts.script:check.run').length).toBeGreaterThan(0));
            await screen.pressByTestIdAsync('scripts.script:check.run');
            await vi.waitFor(() => expect(screen.findAllByType(WorkerDestinationPicker)[0]?.props.open).toBe(true));
            expect(screen.findAllByType(WorkerDestinationPicker)[0]?.props.exactTargetOnly).toBe(true);
            expect(screen.findAllByType(WorkerDestinationPicker)[0]?.props.poolSelection).toBe('ask');
            const before = ownFiniteRelayRequests('projects.script.run').length;
            await act(async () => { screen.findAllByType(WorkerDestinationPicker)[0]?.props.onRequestClose(); });
            expect(screen.findAllByType(WorkerDestinationPicker)[0]?.props.open).toBe(false);
            expect(ownFiniteRelayRequests('projects.script.run')).toHaveLength(before);
            await screen.pressByTestIdAsync('scripts.script:check.run');
            await vi.waitFor(() => expect(screen.findAllByType(WorkerDestinationPicker)[0]?.props.open).toBe(true));
            const exact = { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } as const;
            await act(async () => { screen.findAllByType(WorkerDestinationPicker)[0]?.props.onChoose(exact); });
            await vi.waitFor(() => expect(ownFiniteRelayRequests('projects.script.run')).toHaveLength(before + 1));
            expect(ownFiniteRelayRequests('projects.script.run').at(-1)?.input).toMatchObject({
                target: { kind: 'machine', machineId: 'selected-worker' },
                input: { workspace, selection: { kind: 'named', name: 'check' }, choice: exact },
            });
        } finally { await act(async () => screen.unmount()); disposeExecutor(); }
    }));

    it.each([
        { actionId: 'projects.prepare', managedWake: false, guestOwned: false },
        { actionId: 'projects.inspect', managedWake: false, guestOwned: false },
        { actionId: 'projects.manifest.update', managedWake: false, guestOwned: false },
        { actionId: 'projects.open', managedWake: false, guestOwned: false },
        { actionId: 'machines.terminal.open', managedWake: false, guestOwned: false },
        { actionId: 'machines.terminal.restart', managedWake: false, guestOwned: false },
        { actionId: 'projects.prepare', managedWake: true, guestOwned: false },
        { actionId: 'projects.prepare', managedWake: true, guestOwned: true },
        { actionId: 'projects.prepare', managedWake: true, guestOwned: true, controllerChanged: true },
    ] as const)('uses the same private public Action root for $actionId (controller wake: $managedWake, own guest: $guestOwned, retired: $controllerChanged) without fabricating a Session', async scenario => {
        const { actionId, managedWake, guestOwned } = scenario;
        const controllerChanged = 'controllerChanged' in scenario && scenario.controllerChanged;
        const homeId = 'srv_foreign_project_requester';
        const homeUrl = 'https://foreign-project-requester.test';
        const exactHome = await homes.addHome({ name: 'Bob requester', serverUrl: homeUrl, serverIdentityId: homeId,
            accountId: 'bob', currentAccount: true, active: false });
        const { resolveServerProfileScopeIdForIdentifier, areServerProfileIdentifiersEquivalent } = await import('@/sync/domains/server/serverProfiles');
        const capturedServerId = resolveServerProfileScopeIdForIdentifier(exactHome);
        const token = createAccountTokenForTests('bob', { currentAccount: true });
        // The captured Account explicitly waives its local UI effect prompt.
        // This makes the real delivery port reachable; installed native policy
        // remains independent and still returns its original Ask receipt below.
        homes.answer(exactHome, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { [actionId]: ['ui'] } },
        } } } });
        const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(3));
        const machineId = 'alice-project-machine';
        const machine = { id: machineId, kind: 'persistent', active: true, installationId: 'alice-project-installation',
            installationPublicKey: encodeBase64(installation.publicKey), revokedAt: null, replacedByMachineId: null,
            dataEncryptionKey: null, runnerContentKeyBinding: null,
            access: { custodian: guestOwned ? { accountId: 'bob', displayName: 'Bob' } : { accountId: 'alice', displayName: 'Alice' },
                role: guestOwned ? 'manage' : 'use', resourceMode: 'plain', accessState: 'ready' } };
        const controllerInstallation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(5));
        const controller = { ...machine, id: 'carol-project-controller', installationId: 'carol-controller-installation',
            installationPublicKey: encodeBase64(controllerInstallation.publicKey),
            access: { custodian: { accountId: 'carol', displayName: 'Carol' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
        homes.answer(exactHome, `/v1/machines/${machineId}`, { body: { machine } });
        let machineReads = 0;
        homes.answer(exactHome, '/v1/machines', { select: () => {
            machineReads += 1;
            return { body: managedWake ? [machine, controllerChanged && machineReads > 2
                ? { ...controller, installationId: 'replacement-controller-installation' } : controller] : [machine] };
        } });
        foreignDisclosure.mockResolvedValue(false);
        homes.answer(exactHome, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const workspace = { serverId: capturedServerId, workspaceId: 'alice-workspace', machineId, rootPath: '/repo' };
        const input = actionId === 'projects.prepare' ? { workspace, phase: 'setup' }
            : actionId === 'projects.inspect' ? { workspace }
            : actionId === 'projects.manifest.update' ? { workspace, expectedBasis: { kind: 'absent' }, bytes: '{"version":1}' }
            : actionId === 'projects.open' ? { serverId: capturedServerId, machineId,
                source: { kind: 'folder', path: '/repo' }, materialization: { kind: 'attach' } }
            : { serverId: capturedServerId, machineId, workspace, terminalKey: 'bob-project-shell', cwd: '/repo' };
        const requestId = `foreign-original-${actionId}`;
        const wakeTarget = { homeId, managedId: 'alice-managed-project', enrolledMachineId: machineId,
            expectedIntentRevision: 0, controller: { machineId: controller.id, installationId: controller.installationId },
            origin: { kind: 'finite-command', actionRequestId: requestId }, reason: 'admitted-work' } as const;
        const approval = { kind: 'approval_request_created', artifactId: 'bob-installed-ask', actionId };
        let mintedEnvelope: unknown;
        let forwarded = 0;
        homes.answer(exactHome, `/v1/actions/${actionId}/execution-authorization`, { select: body => {
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(foreignDisclosure).not.toHaveBeenCalled();
            expect(request.machineId).toBe(machineId);
            expect(request.envelope).toMatchObject({ requestId, input, target: { kind: 'machine', machineId } });
            mintedEnvelope = request.envelope;
            return { body: ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-signed-project-root',
                ...(managedWake ? { managedFiniteWake: { target: wakeTarget,
                    installationPublicKey: encodeBase64(controllerInstallation.publicKey, 'base64url') } } : {}), binding: {
                accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 0 }, serverIdentityId: homeId,
                machineId, installationId: machine.installationId, custodianAccountId: machine.access.custodian.accountId, accountEncryptionMode: 'plain',
                actionId, requestId, target: request.envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope),
            } }) };
        } });
        homes.answer(exactHome, `/v1/actions/${actionId}`, { select: body => {
            forwarded += 1;
            // A direct own envelope must not silently bypass Home's managed-controller hint.
            expect(mintedEnvelope).toBeDefined();
            const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
            expect(request.envelope).toEqual(mintedEnvelope);
            expect(JSON.stringify(request)).not.toContain(token);
            expect(JSON.stringify(request)).not.toContain('sessionId');
            expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                purpose: { kind: 'external_action' }, machineId, installationId: machine.installationId,
                serverIdentityId: homeId, installationPrivateKey: installation.secretKey })).toEqual(guestOwned ? null : { token });
            if (managedWake) {
                expect(foreignDisclosure).not.toHaveBeenCalled();
                expect(request.executionAuthorization).toMatchObject({ token: 'home-signed-project-root',
                    binding: { machineId, installationId: machine.installationId, requestId,
                        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(request.envelope) },
                    managedFiniteWake: { target: wakeTarget,
                        requesterAccountContext: { kind: 'installation_sealed_v1', installationId: controller.installationId } } });
                expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'managed_finite_wake', target: wakeTarget }, machineId: controller.id,
                    installationId: controller.installationId, serverIdentityId: homeId,
                    installationPrivateKey: controllerInstallation.secretKey })).toEqual({ token });
                expect(openExternalActionRequesterAccountContextV1({ authorization: request.executionAuthorization,
                    purpose: { kind: 'managed_finite_wake', target: wakeTarget }, machineId: controller.id,
                    installationId: controller.installationId, serverIdentityId: homeId,
                    installationPrivateKey: installation.secretKey })).toBeNull();
            }
            return { body: { v: 1, actionId, requestId, execution: { ok: true, result: approval } } };
        } });
        response = actionId === 'projects.prepare' ? ProjectCommandActionOutputV1Schema.parse({ operation: { version: 1, operationId: 'unsealed-bypass', actionId,
            requestId, scope: { accountId: 'bob', machineId }, state: 'accepted', revision: 1, createdAt: 1,
            title: 'Prepare', cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
                serverId: capturedServerId, machineId, workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath } } })
            : actionId === 'projects.inspect' ? ProjectDefinitionInspectOutputSchema.parse({
                definition: { basis: { kind: 'absent' }, document: null },
                detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
            }) : actionId === 'projects.manifest.update' ? { status: 'refused', code: 'write_failed' }
            : actionId === 'projects.open' ? { kind: 'opened', workspace, directory: '/repo', setup: 'notRequired' }
            : { ok: true, terminalId: 'unsealed-bypass', reused: false };
        const result = await createDefaultActionExecutor().execute(actionId, input, { serverId: capturedServerId,
            expectedAccountId: 'bob', surface: 'ui', authority: 'present_user', actionRequestId: requestId });
        if (controllerChanged) {
            expect(foreignDisclosure).not.toHaveBeenCalled();
            expect(mintedEnvelope).toBeDefined();
            expect(forwarded).toBe(0);
            expect(calls).toEqual([]);
            expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            return;
        }
        expect(foreignDisclosure).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
        const privateRequests = homes.requests.filter(request => request.path.startsWith(`/v1/actions/${actionId}`));
        expect(privateRequests).toHaveLength(2);
        for (const request of privateRequests) {
            expect(request.serverUrl).toBe(homeUrl);
            expect(areServerProfileIdentifiersEquivalent(request.serverId, capturedServerId)).toBe(true);
            expect(request.token).toBe(token);
        }
        // Prove the real boxed front door was reached before judging receipt projection.
        expect(result).toEqual({ ok: true, result: approval });
    });

    it.each([
        { consentScope: 'thisTime', outcome: 'retains typed review without a grant' },
        { consentScope: 'untilChanged', outcome: 'remembers the human decision before admitted preparation' },
    ] as const)('$consentScope through the real U1 controller: $outcome', async ({ consentScope }) => {
        const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
        const { storage } = await import('@/sync/domains/state/storage');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const previousOperations = actionOperationStore.getSnapshot().operationsByKey;
        const previousProjectRows = storage.getState().projectAccountRows;
        const previousPinnedWorkspaceRefs = storage.getState().pinnedWorkspaceRefIds;
        const workspace = { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
        const reviewedEffectDigest = 'reviewed-setup-effect';
        // A real Account-owned ActionsSettings waiver admits the Action only.
        // The Action wire scope never grants trust. The mounted UntilChanged
        // human decision deliberately uses its separate approving-Account port.
        homes.answer(requesterHomeId, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.prepare': ['ui'] } },
        } } } });
        response = { ok: false, errorCode: 'project_setup_consent_required', error: 'project_setup_consent_required', details: {
            kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest,
            reviewedEffect: { commands: ['setup'] }, consentScope,
        } };
        const project = { serverId, projectId: 'accepted-project' };
        if (consentScope === 'untilChanged') {
            const scope = { serverId, accountId: 'requester' };
            storage.getState().activateProjectAccountRowsScope(scope);
            storage.getState().applyProjectAccountRowsForScope(scope, createProjectAccountRowsFixture(scope, { workspaceRefs: [{
                id: workspace.workspaceId, serverId, machineId: workspace.machineId, rootPath: workspace.rootPath,
                projectKey: project.projectId, createdAtMs: 1,
            }] }));
            const held = ProjectCommandActionOutputV1Schema.parse({ operation: {
                version: 1, operationId: 'remembered-setup', actionId: 'projects.prepare',
                scope: { accountId: 'requester', machineId: 'source' }, state: 'accepted', revision: 1, createdAt: 1,
                title: 'Prepare', cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
                    serverId, machineId: 'source', workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace },
                setupReview: { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest,
                    reviewedEffect: { commands: ['setup'] }, consentScope },
            } }).operation;
            let issued = held;
            const operationReadMethod = `source:${ACTION_OPERATION_RPC_METHODS_V2.get}`;
            homes.answer(requesterHomeId, '/v1/actions/projects.prepare', { select: body => {
                const request = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
                issued = { ...held, requestId: request.envelope.requestId };
                rpcResponses.set(operationReadMethod, ActionOperationGetV1ResponseSchema.parse({ kind: 'found', operation: issued }));
                return { body: ExternalActionResponseEnvelopeV1Schema.parse({ v: 1, actionId: 'projects.prepare',
                    requestId: request.envelope.requestId, execution: { ok: true, result: { operation: issued } },
                }) };
            } });
            homes.answer(requesterHomeId, `${PROJECT_TRUST_ROUTE_V1}/read`, { body: { status: 'absent' } });
            homes.answer(requesterHomeId, `${PROJECT_TRUST_ROUTE_V1}/mutate`, { select: body => {
                expect(ProjectTrustMutationRequestV1Schema.parse(body)).toEqual({ project, expectedRevision: 'absent',
                    content: { t: 'plain', v: { project, reviewedEffectDigest, approvedAtMs: expect.any(Number) } },
                });
                const { setupReview: _review, ...resumed } = issued;
                rpcResponses.set(operationReadMethod, ActionOperationGetV1ResponseSchema.parse({ kind: 'found',
                    operation: { ...resumed, revision: 2 },
                }));
                return { body: { status: 'updated', revision: 1, cursor: 1 } };
            } });
        }
        const onChanged = vi.fn();
        const requestedHomes = [serverId];
        const controller = await renderHook(() => {
            const binding = useServerCredentialAccountScopeBindings(requestedHomes).get(serverId) ?? null;
            return useProjectScriptsController(workspace, onChanged, binding);
        });
        try {
            await vi.waitFor(() => expect(controller.getCurrent().ready).toBe(true));
            if (consentScope === 'untilChanged') {
                await act(async () => { await controller.getCurrent().prepare(); });
                await vi.waitFor(() => expect(controller.getCurrent().consent?.operation?.snapshot)
                    .toMatchObject({ operationId: 'remembered-setup', setupReview: { reviewedEffectDigest } }));
                onChanged.mockClear();
            }
            await act(async () => {
                await controller.getCurrent().prepare(reviewedEffectDigest, consentScope);
            });
            expect.soft(ownFiniteRelayRequests('projects.prepare')).toEqual([expect.objectContaining({ serverUrl, token: requesterToken,
                input: expect.objectContaining({ target: { kind: 'machine', machineId: 'source' }, input: { workspace, phase: 'setup',
                    ...(consentScope === 'thisTime' ? { expectedEffectDigest: reviewedEffectDigest, consentScope } : {}) },
            }) })]);
            if (consentScope === 'thisTime') expect(calls).toEqual([]);
            expect(controller.getCurrent().failure, JSON.stringify(controller.getCurrent().failure)).toBeNull();
            expect(controller.getCurrent().pendingKey).toBeNull();
            if (consentScope === 'thisTime') {
                expect.soft(controller.getCurrent().consent).toMatchObject({ code: 'project_setup_consent_required', reviewedEffectDigest, consentScope });
                expect(onChanged).not.toHaveBeenCalled();
                expect(actionOperationStore.getSnapshot().operationsByKey).toBe(previousOperations);
                expect(homes.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/mutate`)).toEqual([]);
            } else {
                expect(controller.getCurrent().consent).toBeNull();
                expect(onChanged).toHaveBeenCalledOnce();
                expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toContainEqual({ serverId,
                    snapshot: expect.objectContaining({ operationId: 'remembered-setup', state: 'accepted', revision: 2,
                        requestId: ownFiniteRelayRequests('projects.prepare')[0]?.input.requestId,
                        scope: { accountId: 'requester', machineId: 'source' } }),
                });
                expect(controller.getCurrent().setupOperation?.snapshot.setupReview).toBeUndefined();
                expect(calls).toEqual([expect.objectContaining({ token: requesterToken, request: expect.objectContaining({
                    method: `source:${ACTION_OPERATION_RPC_METHODS_V2.get}`, params: { operationId: 'remembered-setup' },
                }) }), expect.objectContaining({ token: requesterToken, request: expect.objectContaining({
                    method: `source:${ACTION_OPERATION_RPC_METHODS_V2.get}`, params: { operationId: 'remembered-setup' },
                }) })]);
                const mutations = homes.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/mutate`);
                expect(mutations).toEqual([expect.objectContaining({ serverUrl, token: requesterToken })]);
                expect(homes.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/read`)).toEqual([expect.objectContaining({ serverUrl, token: requesterToken, input: { project } })]);
                expect(homes.requests.indexOf(homes.requestsFor('/v1/actions/projects.prepare')[0]!)).toBeLessThan(homes.requests.indexOf(mutations[0]!));
            }
        } finally {
            await controller.unmount();
            disposeExecutor();
            storage.setState({ projectAccountRows: previousProjectRows, pinnedWorkspaceRefIds: previousPinnedWorkspaceRefs });
            if (consentScope === 'untilChanged') actionOperationStore.reset();
        }
    });

    it.each([false, true])('retains the accepted receipt and original request identity at the input Home, including cancellation after ACK: %s', async cancelAfterAck => {
        const controller = new AbortController();
        const input = { workspace: { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' }, phase: 'setup' };
        response = ProjectCommandActionOutputV1Schema.parse({ operation: {
            version: 1, operationId: 'accepted-prepare', actionId: 'projects.prepare', requestId: 'original-prepare',
            scope: { accountId: 'requester', machineId: 'source' }, state: 'accepted', revision: 1, createdAt: 1,
            title: 'Prepare', progress: { kind: 'indeterminate' }, cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'setup', serverId, machineId: 'source', workspaceRefId: 'source-workspace', cwd: '/repo' },
        } });
        if (cancelAfterAck) consumeAcknowledgement = () => controller.abort();
        const result = await createDefaultActionExecutor().execute('projects.prepare', input, {
            surface: 'ui', authority: 'present_user', actionRequestId: 'original-prepare',
            signal: controller.signal,
            presentUserConfirmation: { actionId: 'projects.prepare' },
        });
        expect(result, JSON.stringify(result)).toEqual({ ok: true, result: response });
        expect(ownFiniteRelayRequests('projects.prepare')).toEqual([expect.objectContaining({ serverUrl, token: requesterToken,
            input: { v: 1, target: { kind: 'machine', machineId: 'source' }, input, requestId: 'original-prepare' },
        })]);
        expect(calls).toEqual([]);
        expect(homes.requestsFor('/v1/machines').map(row => ({ serverUrl: row.serverUrl, token: row.token })))
            .toEqual([{ serverUrl, token: requesterToken }]);
        expect(controller.signal.aborted).toBe(cancelAfterAck);
    });

    it('delivers a registered client-local Home alias as the captured canonical Home without changing Source checkout identity', async () => {
        const alias = await homes.addHome({ name: 'Portable requester', serverUrl: 'https://finite-portable-requester.test',
            serverIdentityId: 'srv_finite_portable_requester', accountId: 'portable-requester', currentAccount: true, active: false });
        const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
        const canonicalHome = resolveServerProfileScopeIdForIdentifier(alias);
        expect(canonicalHome).not.toBe(alias);
        homes.answer(alias, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        answerOwnMachineActions(alias, 'portable-requester', canonicalHome);
        const workspace = { serverId: alias, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
        response = ProjectCommandActionOutputV1Schema.parse({ operation: {
            version: 1, operationId: 'portable-prepare', actionId: 'projects.prepare', requestId: 'portable-request',
            scope: { accountId: 'portable-requester', machineId: 'source' }, state: 'accepted', revision: 1, createdAt: 1,
            title: 'Prepare', cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
                serverId: canonicalHome, machineId: 'source', workspaceRefId: 'source-workspace', cwd: '/repo',
                sourceWorkspace: { ...workspace, serverId: canonicalHome } },
        } });
        const result = await createDefaultActionExecutor().execute('projects.prepare', { workspace, phase: 'setup' }, {
            serverId: alias, expectedAccountId: 'portable-requester', surface: 'ui', authority: 'present_user',
            actionRequestId: 'portable-request', presentUserConfirmation: { actionId: 'projects.prepare' },
        });
        expect(result, JSON.stringify(result)).toEqual({ ok: true, result: response });
        expect(ownFiniteRelayRequests('projects.prepare')).toEqual([expect.objectContaining({ serverUrl: 'https://finite-portable-requester.test',
            token: createAccountTokenForTests('portable-requester', { currentAccount: true }),
            input: { v: 1, target: { kind: 'machine', machineId: 'source' }, requestId: 'portable-request',
                input: { workspace: { ...workspace, serverId: canonicalHome }, phase: 'setup' } } })]);
        expect(calls).toEqual([]);
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const { useProjectScriptRun } = await import('@/components/projects/projectSetup/projectScriptRuns');
        const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');
        const { actionOperationAddressKey } = await import('@/sync/domains/actionOperations/qualifiedActionOperation');
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const capturedHomes = [canonicalHome];
        const selection = { kind: 'named' as const, name: 'build' };
        response = ProjectCommandActionOutputV1Schema.parse({ operation: {
            version: 1, operationId: 'portable-script', actionId: 'projects.script.run', scope: { accountId: 'portable-requester', machineId: 'source' },
            state: 'accepted', revision: 1, createdAt: 2, title: 'Build', cancellation: 'supported',
            domainRef: { kind: 'projectCommand', purpose: 'script', serverId: canonicalHome, machineId: 'source',
                workspaceRefId: 'source-workspace', cwd: '/repo', sourceWorkspace: { ...workspace, serverId: canonicalHome },
                script: { name: 'build', source: { kind: 'command', command: 'build' } } },
        } });
        // Default placement reads SOURCE definitions and the captured Account's
        // preferences; neither read returns a finite execution receipt.
        const inspectionMethod = getActionSpec('projects.inspect').bindings?.rpcMethod;
        if (!inspectionMethod) throw new Error('Missing canonical project inspection RPC binding');
        rpcResponses.set(`source:${inspectionMethod}`, ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(JSON.stringify({
                version: 1, scripts: { build: { source: { kind: 'command', command: 'build' } } },
            })) },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        homes.answer(alias, '/v1/projects/execution/config/read', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: createDefaultWorkspaceExecutionSettingsV1() },
        } });
        // Admit the direct Run through real Account settings; the separate Ask-first case remains real.
        homes.answer(alias, '/v2/account/settings', { body: { version: 1, content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, approvalWaivedSurfaces: { 'projects.script.run': ['ui'] } },
        } } } });
        const controller = await renderHook(() => {
            const binding = useServerCredentialAccountScopeBindings(capturedHomes).get(canonicalHome) ?? null;
            const actions = useProjectScriptsController(workspace, () => {}, binding);
            return { actions, operation: useProjectScriptRun(workspace, selection, actions.accountId) };
        });
        try {
            await vi.waitFor(() => expect(controller.getCurrent().actions.ready).toBe(true));
            await act(async () => { await controller.getCurrent().actions.run('build', selection); });
            expect(controller.getCurrent().actions.failure, JSON.stringify(controller.getCurrent().actions.failure)).toBeNull();
            expect([...actionOperationStore.getSnapshot().operationsByKey]
                .filter(([, operation]) => operation.snapshot.operationId === 'portable-script').map(([key]) => key))
                .toEqual([actionOperationAddressKey({ serverId: canonicalHome, operationId: 'portable-script' })]);
            expect(controller.getCurrent().operation?.snapshot.operationId).toBe('portable-script');
            expect(homes.requestsFor('/v1/projects/execution/config/read').map(row => row.token))
                .toEqual([createAccountTokenForTests('portable-requester', { currentAccount: true })]);
        } finally {
            await controller.unmount(); disposeExecutor(); actionOperationStore.reset();
        }
    });

    it('preserves immutable SOURCE intent and exact worker routing while returning the actual strict D18 failure', async () => {
        answerExplicitScriptWorkerPlacement();
        const input = { workspace: { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' },
            selection: { kind: 'named', name: 'check' }, choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } };
        const details = { kind: 'pendingApproval', code: 'project_setup_effect_changed', reviewedEffectDigest: 'current-effect', reviewedEffect: { commands: ['setup'] } };
        response = { ok: false, errorCode: 'project_setup_effect_changed', error: 'project_setup_effect_changed', details };
        const executor = createDefaultActionExecutor();
        const client = createProjectManifestActionClient({ workspace: input.workspace, expectedAccountId: 'requester',
            execute: (id, value, context) => executor.execute(id, value, { ...context,
                actionRequestId: 'original-script', presentUserConfirmation: { actionId: 'projects.script.run' } }),
        });
        await expect(client.runScript({ kind: 'named', name: 'check' }, {
            kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' },
        })).rejects.toMatchObject({ code: 'project_setup_effect_changed', consent: details });
        expect(ownFiniteRelayRequests('projects.script.run')).toEqual([expect.objectContaining({ serverUrl, token: requesterToken,
            input: { v: 1, target: { kind: 'machine', machineId: 'selected-worker' }, input, requestId: 'original-script' },
        })]);
    });

    it('honors configured Ask first before any finite dispatch', async () => {
        await homes.requireUiApproval(requesterHomeId, 'projects.compute.exec');
        const result = await createDefaultActionExecutor().execute('projects.compute.exec', {
            workspace: { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' }, executable: '/bin/echo', argv: ['reviewed'], cwd: '/repo',
        }, { serverId, expectedAccountId: 'requester', surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } });
        expect(result, JSON.stringify({ result, requests: homes.requests.map(row => ({ serverId: row.serverId, path: row.path })) }))
            .toMatchObject({ ok: true, result: { kind: 'approval_request_created', actionId: 'projects.compute.exec' } });
        expect(calls).toEqual([]);
        expect(homes.requestsFor('/v1/actions/projects.compute.exec')).toEqual([]);
        expect(homes.requests.some(row => row.path.startsWith('/v1/machines/'))).toBe(false);
    });

    it('preserves immutable SOURCE input while enforcing an explicit external target restriction', async () => {
        answerExplicitScriptWorkerPlacement();
        const input = { workspace: { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' },
            selection: { kind: 'named', name: 'check' }, choice: { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } } };
        response = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'current-effect' };
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'requester', surface: 'ui' as const, authority: 'present_user' as const,
            actionRequestId: 'external-target-script', presentUserConfirmation: { actionId: 'projects.script.run' as const } };
        expect(await executor.execute('projects.script.run', input, { ...context,
            externalActionTarget: { kind: 'machine', machineId: 'source' } })).toMatchObject({ ok: false, errorCode: 'target_not_local' });
        expect(ownFiniteRelayRequests('projects.script.run')).toEqual([]);
        expect(await executor.execute('projects.script.run', input, { ...context,
            externalActionTarget: { kind: 'machine', machineId: 'selected-worker' } })).toEqual({ ok: true, result: response });
        expect(ownFiniteRelayRequests('projects.script.run')[0]?.input).toMatchObject({ input,
            target: { kind: 'machine', machineId: 'selected-worker' } });
    });

    it.each(['machine', 'pool'] as const)('uses the canonical saved %s placement rather than SOURCE or the first pool member', async kind => {
        const poolId = '10000000-0000-4000-8000-000000000001';
        const destination = kind === 'machine' ? { kind: 'machine', machineId: 'selected-worker' }
            : { kind: 'pool', poolId, selection: 'automatic' };
        const memoryDemand = { bytes: 8192, basis: { kind: 'declared' } };
        const bytes = JSON.stringify({ version: 1, workspace: { memoryDemand }, scripts: {
            check: { execution: 'portable', source: { kind: 'command', command: 'echo checked' } },
        } });
        const workspace = { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
        const inspectionMethod = getActionSpec('projects.inspect').bindings?.rpcMethod;
        const statusMethod = getActionSpec('projects.worker.status').bindings?.rpcMethod;
        if (!inspectionMethod || !statusMethod) throw new Error('Missing canonical project RPC binding');
        rpcResponses.set(`source:${inspectionMethod}`, ProjectDefinitionInspectOutputSchema.parse({
            definition: { basis: { kind: 'present', hash: 'a'.repeat(64) }, document: readProjectManifestDocument(bytes) },
            detection: { entries: [], environments: [], devcontainers: [], coverage: 'complete', diagnostics: [] }, importCandidates: [],
        }));
        homes.answer(requesterHomeId, '/v1/projects/execution/config/read', { body: { status: 'present', revision: 1,
            content: { t: 'plain', v: { enabled: true, destination, unavailable: 'fail', allowAdHoc: false, scriptOverrides: {}, services: {} } },
        } });
        homes.answer(requesterHomeId, '/v1/machines/pools/get', { body: {
            pool: { id: poolId, name: 'Workers', description: null, revision: 1, createdAt: 1, updatedAt: 1,
                members: [{ machineId: 'ineligible-first-member', priorityTier: 0, enabled: true, state: 'connected' },
                    { machineId: 'selected-worker', priorityTier: 0, enabled: true, state: 'connected' }] },
            availability: { state: 'known', connectedCount: 2, enabledCount: 2 },
        } });
        homes.answer(requesterHomeId, 'GET /v1/machines/ineligible-first-member', { body: { machine: {
            id: 'ineligible-first-member', kind: 'persistent', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        } } });
        rpcResponses.set(`ineligible-first-member:${statusMethod}`, {
            eligible: false, candidate: null, load: { kind: 'unknown' }, explanation: 'not_accepting',
        });
        rpcResponses.set(`selected-worker:${statusMethod}`, {
            eligible: true, candidate: { serverId, machineId: 'selected-worker' }, load: { kind: 'unknown' }, explanation: 'load_unknown',
        });
        response = { kind: 'pendingApproval', code: 'project_setup_consent_required', reviewedEffectDigest: 'current-effect' };
        const input = { workspace, selection: { kind: 'named', name: 'check' } };
        const executor = createDefaultActionExecutor();
        const client = createProjectManifestActionClient({ workspace, expectedAccountId: 'requester',
            execute: (id, value, context) => executor.execute(id, value, { ...context,
                actionRequestId: 'original-default-script', presentUserConfirmation: { actionId: 'projects.script.run' } }),
        });
        expect(await client.runScript({ kind: 'named', name: 'check' })).toEqual(response);
        expect(ownFiniteRelayRequests('projects.script.run'))
            .toEqual([expect.objectContaining({ serverUrl, token: requesterToken,
                input: { v: 1, target: { kind: 'machine', machineId: 'selected-worker' }, input, requestId: 'original-default-script' },
            })]);
        const candidateRequests = calls.filter(row => row.request.method.endsWith(`:${statusMethod}`));
        expect(candidateRequests.map(row => row.request.params)).toContainEqual({
            workspace: { serverId, refId: workspace.workspaceId }, destination: { kind: 'machine', machineId: 'selected-worker' },
            purpose: 'finite', memoryDemand,
        });
        expect(homes.requestsFor('/v1/projects/execution/config/read').map(row => row.token)).toEqual([requesterToken]);
        if (kind === 'pool') expect(homes.requestsFor('/v1/machines/pools/get').map(row => row.token)).toEqual([requesterToken]);
    });
});
