import axios from 'axios';
import nacl from 'tweetnacl';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { startDaemonControlServer } from '@/daemon/controlServer';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';
import { createInstalledMachineRpcDatabaseBoundary } from '@/daemon/testkit/installedMachineRpcRelay.testkit';
import { createAgentIsolationEffectsBoundary } from '@/daemon/agentIsolation/agentIsolationEffects.testkit';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerContext } from '@/api/rpc/types';
import { updateSettings } from '@/persistence';
import { registerDaemonMachineAgentIsolationRpcHandlers } from '@/rpc/handlers/daemonMachineAgentIsolation';
import { dispatchManagedMachineAgentIsolation } from '@/api/externalActionExecutionAuthorization';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { MachineAgentIsolationPreviewResultV1Schema } from '@happier-dev/protocol';
import { executeExternalAction } from './executeExternalAction';
import { ManagedMachineControllerError } from '@/machines/managed/controllerErrors';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createHostReviewedChildPortV1, type ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

const boundary = vi.hoisted(() => ({ control: null as Parameters<typeof startDaemonControlServer>[0] | null }));
// The control listener, Home transport and native OS are boundaries. The
// receiving requester, executor factory, Machine transport and handlers stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async (input: Parameters<typeof startDaemonControlServer>[0]) => {
    boundary.control = input;
    return { port: 43129, stop: async () => {} };
} }));

it.each([true, false])('preserves Home Manage and retained enrollment policy for first isolation set (enabled=%s)', async enabled => {
    onTestFinished(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); boundary.control = null; });
    const homeId = 'srv_managed_isolation', serverId = 'managed-isolation-home', serverUrl = 'https://session-home.test';
    const h = await createInstalledProjectAgentDaemonFixture(() => boundary.control, undefined, true, undefined, undefined, {
        ordinaryAccountSession: true,
        externalActionAccountId: 'requester', serverId, homeServerIdentityId: homeId,
        machineAccess: { custodianAccountId: 'requester', role: 'manage' },
        resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: homeId, machineId: 'machine' }),
    });
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers, [serverId]: {
        ...settings.servers?.[serverId], id: serverId, name: 'Managed Home', serverUrl, webappUrl: serverUrl,
        createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact',
        homeConnectionDescriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: serverUrl, revision: 1,
            endpoints: [{ kind: 'https', url: serverUrl }] },
    } } }));
    const owner = h.daemon.externalActionIngressOwner;
    if (!owner) throw new Error('Missing installed external Action ingress');
    const manager: unknown = Reflect.get(h.machine, 'rpcHandlerManager');
    if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed native Machine receiver');
    Reflect.set(h.machine, 'socket', createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
        if (event !== 'machine-update-metadata') return resolveApiSessionSocketDefaultAck(event, payload);
        if (!payload || typeof payload !== 'object' || !('expectedVersion' in payload)
            || typeof payload.expectedVersion !== 'number' || !('metadata' in payload)) throw new Error('Invalid Machine metadata write');
        return { result: 'success', version: payload.expectedVersion + 1, metadata: payload.metadata };
    } }));
    await h.machine.updateMachineMetadata(() => ({ host: 'guest', platform: 'linux', homeDir: h.f.directory,
        happyHomeDir: h.f.directory, happyCliVersion: 'test' }));
    const native = createAgentIsolationEffectsBoundary({ installationId: h.f.installation.installationId,
        installedCli: '/opt/happier/cli/current/happier', readRoots: () => [], readSessionsToReplace: () => 0,
        publishStatus: async () => {} });
    registerDaemonMachineAgentIsolationRpcHandlers(manager, {
        target: () => ({ serverId, machineId: 'machine', installationId: h.f.installation.installationId, custodianAccountId: 'requester' }),
        read: () => h.machine.getAgentIsolationSnapshot(), readCanonicalHomeServerIdentityId: () => homeId,
        effects: native.effects, runActionOperation: request => h.machine.runActionOperation(request),
        captureMetadataPort: () => ({ read: async () => h.machine.getMachineMetadataSnapshot(),
            compareAndSwap: request => h.machine.compareAndSwapMachineMetadata(request) }),
    });
    const facts = createInstalledMachineRpcDatabaseBoundary({ machineId: 'machine', ownerAccountId: 'requester', installation: h.f.installation,
        members: [{ accountId: 'member-use', accessLevel: 'view' }] });
    const accessPath = '../../../../server/sources/app/machines/machineAccess';
    const { resolveMachineAdmissionInTx }: Readonly<{ resolveMachineAdmissionInTx(tx: unknown, request: Readonly<{
        actorAccountId: string; machineId: string; actionId: string }>): Promise<
        { kind: 'admitted' } & NonNullable<RpcHandlerContext['machineAdmission']> | { kind: 'denied'; code: string }> }> = await import(accessPath);
    const actionId = 'machines.agentIsolation.set';
    for (const actorAccountId of ['member-use', 'foreign-account']) {
        expect(await resolveMachineAdmissionInTx(facts.db, { actorAccountId, machineId: 'machine', actionId }))
            .toMatchObject({ kind: 'denied' });
    }
    const admission = await resolveMachineAdmissionInTx(facts.db, { actorAccountId: 'requester', machineId: 'machine', actionId });
    if (admission.kind !== 'admitted') throw new Error(`Home refused owner: ${admission.code}`);
    const preview = MachineAgentIsolationPreviewResultV1Schema.parse(await manager.invokeLocal('machines.agentIsolation.preview', {
        serverId: homeId, machineId: 'machine', enabled: true,
    }, { rpcContext: { machineAdmission: admission, verifyMachineAdmissionCurrent: async () => true } }));
    if (preview.kind !== 'ready') throw new Error(`Expected fresh native plan: ${JSON.stringify(preview)}`);
    const childInput = { serverId: homeId, machineId: 'machine', enabled,
        expectedMetadataVersion: preview.metadataVersion, expectedPolicy: preview.policy, expectedPlanDigest: preview.plan.planDigest };
    const input = ManagedAcquireInputV1Schema.parse({
        enrollmentIdentity: { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' },
        selection: { kind: 'one-off', homeId, controller: { machineId: 'controller', installationId: 'controller-installation' },
            launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
    });
    const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId, custodianAccountId: 'requester',
        launch: { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
        enrollmentIdentity: input.enrollmentIdentity, controller: { machineId: 'controller', installationId: 'controller-installation' },
        allocation: 'bound', resource: { contributionRef: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'guest' } },
        creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0, enrolledMachineId: 'machine',
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false });
    const writeHome = vi.mocked(axios.post).getMockImplementation();
    if (!writeHome) throw new Error('Missing Home boundary');
    const readHome = vi.mocked(axios.get).getMockImplementation();
    if (!readHome) throw new Error('Missing Home read boundary');
    vi.mocked(axios.get).mockImplementation(async (...args) => String(args[0]).endsWith('/v1/machines/controller')
        ? { status: 200, data: { machine: { id: 'controller', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
            access: { custodian: { accountId: 'requester', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } } } }
        : readHome(...args));
    vi.mocked(axios.post).mockImplementation(async (...args) => {
        const url = String(args[0]);
        if (url.endsWith('/v1/machines/managed/controller/context')) return { status: 200, data: { requestId: 'creation',
            enrollmentInstallation: { machineId: 'machine', installationId: h.f.installation.installationId, installationPublicKey: h.f.installation.publicKey } } };
        if (url.endsWith('/verify')) return { status: 200, data: { ok: true } };
        if (url.endsWith('/v1/machines/managed/actions/get')) return { status: 200, data: managed };
        if (url.endsWith(`/v1/actions/${actionId}`)) {
            const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse(args[1]);
            const childAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'guest-home-proof', binding: {
                ...controllerAuthorization.binding, actionId, machineId: 'machine', installationId: h.f.installation.installationId,
                admittedMachineRole: admission.role,
                target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(body.envelope),
                managedContinuation: { ...body.managedContinuation, controller: managed.controller, acquireRequestEnvelopeDigest: controllerAuthorization.binding.requestEnvelopeDigest },
            } });
            const result = await executeExternalAction({ ...owner, actionId, envelope: body.envelope,
                executionAuthorization: childAuthorization,
                principal: { accountId: 'requester', authority: 'present_user', authentication: { kind: 'account', tokenEpoch: 0 } },
                currentMachineId: 'machine', currentAccountId: 'requester', currentInstallationId: h.f.installation.installationId,
                externalActionMachineRequestPrivateKey: Buffer.from(h.f.installation.privateKey, 'base64url'),
                verifyExecutionAuthorization: async () => true, machineAdmission: admission,
            });
            if (result.kind !== 'response') throw new Error(`Child ingress refused: ${result.errorCode}`);
            return { status: 200, data: result.response };
        }
        return writeHome(...args);
    });
    // The Home boundary models the signed UI Acquire parent on a different
    // controller installation; the enrolled guest receives its own admission.
    const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(41));
    const controllerAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'controller-home-proof', binding: {
        serverIdentityId: homeId, accountId: 'requester', custodianAccountId: 'requester',
        authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
        actionId: 'machines.managed.acquire', requestId: 'creation', machineId: 'controller',
        installationId: 'controller-installation', target: { kind: 'machine', machineId: 'controller' }, requestEnvelopeDigest: 'a'.repeat(43),
    } });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'requester', externalActionExecutionAuthorization: controllerAuthorization,
        externalActionTarget: controllerAuthorization.binding.target, signal: new AbortController().signal };
    const declaration = getActionSpec('machines.managed.acquire').hostReviewedChildren;
    const children = typeof declaration === 'function' ? declaration(input) : declaration ?? [];
    const reviewed = createHostReviewedChildPortV1({ actionId: 'machines.managed.acquire', input, context, reviewAdmitted: true,
        plan: { children }, policies: children.map(child => ({ action: child.action, role: child.role, surface: 'ui' })),
        execute: async (_input, context) => dispatchManagedMachineAgentIsolation({ actionId, input: childInput, serverId, context,
            authorization: controllerAuthorization, authority: 'present_user', installationId: 'controller-installation', privateKey: controllerKeys.secretKey,
            serverHttpBaseUrl: serverUrl, continuation: { managedId: 'managed', creationRequestId: 'creation', expectedIntentRevision: 0 },
        }) });
    const childResult = await reviewed.invoke({ action: actionId, role: actionId, input: normalizeStrictJsonValue(childInput) });
    if (!enabled) {
        expect(childResult).toMatchObject({ ok: false, errorCode: 'managed_enrollment_policy_unverified' });
        expect(native.mutations).toHaveLength(0);
        if (childResult.ok) throw new Error('Retained policy must refuse the child');
        const operations = createHostActionOperationRuntime({ machineId: 'controller',
            resolveAccountId: async () => 'requester', generateOperationId: () => 'first-set-refusal' });
        await expect(operations.observeExecution({ actionId: 'machines.managed.acquire', input,
            actionRequestId: 'creation', execute: async () => {
                throw ManagedMachineControllerError.fromActionFailure(childResult, actionId);
            } })).rejects.toMatchObject({ code: 'managed_enrollment_policy_unverified' });
        expect(await operations.handlers.getV2({ operationId: 'first-set-refusal', waitForTerminal: true }))
            .toMatchObject({ kind: 'found', operation: { state: 'failed',
                error: { errorCode: 'managed_enrollment_policy_unverified' } } });
        return;
    }
    expect(childResult, JSON.stringify(childResult)).toMatchObject({ ok: true, result: { kind: 'accepted' } });
    expect(h.machine.getMachineMetadataSnapshot()).toMatchObject({ status: 'ready', metadata: {
        agentIsolation: { enabled: true },
    } });
    expect(native.mutations.length).toBeGreaterThan(0);
}, 120_000);
