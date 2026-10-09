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
import { createProjectManifestActionClient } from '@/components/projects/projectSetup/projectManifestActionClient';
import * as React from 'react';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

// Component probes retain the real controller/Actions; only native rendering is substituted.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

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
    for (const actionId of ['projects.prepare', 'projects.script.run', 'projects.compute.exec'] as const) {
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
beforeEach(async () => {
    installDisconnectedServerSocketBoundary(configureRelay);
    await homes.reset(); await loadSyncSingletonForTests(); calls.length = 0; rpcResponses.clear(); consumeAcknowledgement = undefined;
    foreignDisclosure.mockReset().mockResolvedValue(true);
    requesterHomeId = await homes.addHome({ name: 'Finite requester', serverUrl, serverIdentityId: 'srv_finite_requester',
        accountId: 'requester', currentAccount: true, active: false, machinePoolsEnabled: true });
    const { resolveServerProfileScopeIdForIdentifier } = await import('@/sync/domains/server/serverProfiles');
    serverId = resolveServerProfileScopeIdForIdentifier(requesterHomeId);
    await homes.addHome({ name: 'Focused custodian', serverUrl: 'https://finite-custodian.test', accountId: 'custodian' });
    homes.answer(requesterHomeId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    answerOwnMachineActions(requesterHomeId, 'requester');
    const decodeHttpReply = Response.prototype.json;
    const replyDecoder = vi.spyOn(Response.prototype, 'json').mockImplementation(async function (this: Response) {
        const payload: unknown = await decodeHttpReply.call(this);
        // Native HTTP reply decoding is the real boundary. Abort only after a
        // complete Action ACK exists, not during issuance or discovery reads.
        if (ExternalActionResponseEnvelopeV1Schema.safeParse(payload).success) consumeAcknowledgement?.();
        return payload;
    });
    restoreHttpReplyDecoder = () => replyDecoder.mockRestore();
});
afterEach(async () => { restoreHttpReplyDecoder?.(); restoreHttpReplyDecoder = undefined; await homes.reset(); });

describe('Project finite delivery through the default UI Action host', () => {
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
        const screen = await renderScreen(React.createElement(ProjectScriptsBody, { workspace, presentation: 'widget', testID: 'scripts' }));
        try {
            await vi.waitFor(() => expect(screen.findAllByType(ProjectScriptRow)[0]?.props.defaultChoice).toEqual(enabled
                ? { kind: 'primary' } : { kind: 'workers', destination: { kind: 'machine', machineId: 'selected-worker' } }));
            expect(screen.findAllByType(ProjectScriptRow)[0]?.props.memoryDemand).toEqual(workspaceDemand);
        } finally { await act(async () => screen.unmount()); disposeExecutor(); }
    });

    it('retains an Ask-each-time Run intent, cancels without dispatch, and resumes with a chosen exact Machine', async () => {
        const { useProjectScriptsController } = await import('@/components/projects/projectSetup/useProjectScriptsController');
        const { useServerCredentialAccountScopeBindings } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
        const disposeExecutor = await installRealActionExecutorModuleLoader();
        const workspace = { serverId, workspaceId: 'source-workspace', machineId: 'source', rootPath: '/repo' };
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
            expect(ownFiniteRelayRequests('projects.script.run')).toEqual([expect.objectContaining({ input: expect.objectContaining({
                target: { kind: 'machine', machineId: 'selected-worker' }, input: { workspace, selection: { kind: 'named', name: 'check' }, choice: exact },
            }) })]);
            expect(hook.getCurrent().choiceRequired).toBeNull();
        } finally { await hook.unmount(); disposeExecutor(); }
    });

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
        homes.answer(exactHome, '/v1/machines', { body: managedWake ? [machine, controller] : [machine] });
        if (controllerChanged) foreignDisclosure.mockImplementation(async () => {
            homes.answer(exactHome, '/v1/machines', { body: [machine, { ...controller, installationId: 'replacement-controller-installation' }] });
            return true;
        });
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
            expect(foreignDisclosure).toHaveBeenCalledTimes(guestOwned ? 0 : 1);
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
                expect(foreignDisclosure).toHaveBeenCalledTimes(guestOwned ? 1 : 2);
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
            expect(foreignDisclosure).toHaveBeenCalledOnce();
            expect(mintedEnvelope).toBeDefined();
            expect(forwarded).toBe(0);
            expect(calls).toEqual([]);
            expect(result).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
            return;
        }
        expect(foreignDisclosure).toHaveBeenCalledTimes((guestOwned ? 0 : 1) + (managedWake ? 1 : 0));
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
        // Real localization renders words, not translation keys. The disclosure
        // must identify the actual target/custodian without exposing credentials.
        const disclosure = JSON.stringify(foreignDisclosure.mock.calls);
        if (!guestOwned) {
            expect(disclosure).toContain(machineId);
            expect(disclosure).toContain('Alice');
        }
        if (managedWake) {
            expect(disclosure).toContain(controller.id);
            expect(disclosure).toContain('Carol');
        }
        expect(disclosure).not.toContain(token);
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
            homes.answer(requesterHomeId, `${PROJECT_TRUST_ROUTE_V1}/read`, { body: { status: 'absent' } });
            homes.answer(requesterHomeId, `${PROJECT_TRUST_ROUTE_V1}/mutate`, { select: body => {
                expect(ProjectTrustMutationRequestV1Schema.parse(body)).toEqual({ project, expectedRevision: 'absent',
                    content: { t: 'plain', v: { project, reviewedEffectDigest, approvedAtMs: expect.any(Number) } },
                });
                return { body: { status: 'updated', revision: 1, cursor: 1 } };
            } });
            response = ProjectCommandActionOutputV1Schema.parse({ operation: {
                version: 1, operationId: 'remembered-setup', actionId: 'projects.prepare',
                scope: { accountId: 'requester', machineId: 'source' }, state: 'accepted', revision: 1, createdAt: 1,
                title: 'Prepare', cancellation: 'supported', domainRef: { kind: 'projectCommand', purpose: 'setup',
                    serverId, machineId: 'source', workspaceRefId: workspace.workspaceId, cwd: workspace.rootPath, sourceWorkspace: workspace },
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
            await act(async () => {
                await controller.getCurrent().prepare(reviewedEffectDigest, consentScope);
            });
            expect.soft(ownFiniteRelayRequests('projects.prepare')).toEqual([expect.objectContaining({ serverUrl, token: requesterToken,
                input: expect.objectContaining({ target: { kind: 'machine', machineId: 'source' }, input: { workspace, phase: 'setup',
                    expectedEffectDigest: reviewedEffectDigest, consentScope },
            }) })]);
            expect(calls).toEqual([]);
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
                    snapshot: expect.objectContaining({ operationId: 'remembered-setup', state: 'accepted', scope: { accountId: 'requester', machineId: 'source' } }),
                });
                const mutations = homes.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/mutate`);
                expect(mutations).toEqual([expect.objectContaining({ serverUrl, token: requesterToken })]);
                expect(homes.requestsFor(`${PROJECT_TRUST_ROUTE_V1}/read`)).toEqual([expect.objectContaining({ serverUrl, token: requesterToken, input: { project } })]);
                expect(homes.requests.indexOf(mutations[0]!)).toBeLessThan(homes.requests.indexOf(homes.requestsFor('/v1/actions/projects.prepare')[0]!));
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
        expect(calls).toEqual([]);
        expect(homes.requestsFor('/v1/machines/source')).toEqual([]);
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
