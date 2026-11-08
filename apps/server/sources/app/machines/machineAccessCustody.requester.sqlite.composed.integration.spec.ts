import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import * as filesystem from 'node:fs/promises';
import { join } from 'node:path';
import axios from 'axios';
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import tweetnacl from 'tweetnacl';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent, MachineServicesListResultV1Schema } from '@happier-dev/protocol';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, parseAccountStoredContentCompatibilitySocketAuthV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { db } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createAccountTokenForTests, createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { eventRouter } from '@/app/events/connectionEventRouter';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { createSocketRoomDiscoveryHarness } from '@/app/api/testkit/socketHarness';
import { forwardRpcCall } from '@/app/api/socket/rpc/forwardRpcCall';
import { commitMachineRecipientKeyEnvelopesInTx, readMachineRecipientCensusInTx, removeMachineAccessGrantInTx, resolveEffectiveMachineRoleInTx, resolveMachineAdmission } from './machineAccess';
import { setEligibleMachineAccessGrantInTx as setMachineAccessGrantInTx } from '@/testkit/machineAccessGrant.testkit';
import { dispatchMachineAccessLossCustody, recoverMachineAccessLossCustody } from './machineAccessCustody';
import { MachineAccessLossCustodyRequestV1Schema, MachineAdmissionVerifyResponseV1Schema, SocketRpcMachineAdmissionContextV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { RpcHandlerManager } from '../../../../cli/src/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '../../../../cli/src/api/machine/machineRpcAuthorization';
import { registerMachineAccessLossReceiver } from '../../../../cli/src/daemon/externalActions/registerMachineAccessLossReceiver';
import { readProcessIdentityByPid } from '../../../../cli/src/daemon/processIdentity';
import type { TrackedSession } from '../../../../cli/src/daemon/types';
import { createAdmittedPluginRuntimeFixture } from '../../../../cli/src/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '../../../../cli/src/plugins/runtime/reload/singleton';
import { authorizeResolvedProjectExecLaunchForHost, createProjectNativeToolchainIoForHost } from '../../../../cli/src/plugins/runtime/invocation/services/exec';
import { ApiMachineClient } from '../../../../cli/src/api/apiMachine';
import { createWorkspaceSyncTargetContent } from '../../../../cli/src/api/rpc/workspaceSyncTargetContent';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { WorkspaceSyncCommittedCopyTargetV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncCommittedCopyV1';
import { createRequesterSessionControlRuntimeFixture } from '../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { readOrCreateInstallationIdentity } from '../../../../cli/src/daemon/identity/store';
import { writeStoredCredentialsForServerId } from '../../../../cli/src/persistence';
import { createRequesterCurrentnessSocketHarness } from '../../../../cli/src/testkit/backends/requesterCurrentnessSocketHarness';
import { HomeConnectionDescriptorV1Schema } from '@happier-dev/protocol/auth/accountDirectory';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionExecutionAuthorizationVerifyResponseV1Schema,
    type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { logger } from '../../../../cli/src/ui/logger';
import { adoptServerProfileHomeConnectionDescriptor, resolveServerProfileHomeIdentityId } from '../../../../cli/src/server/serverProfiles';
import { tryAcquireAuthoritativePluginRuntimeRegistryLease } from '../../../../cli/src/plugins/runtime/reload/runtimeLease';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { createAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { machinesRoutes } from '@/app/api/routes/machines/machinesRoutes';
import { registerExternalActionRoutes } from '@/app/api/routes/actions/registerExternalActionRoutes';
import { registerProjectAccountRowRoutes } from '@/app/api/routes/projects/registerProjectAccountRowRoutes';
import { createExternalActionDaemonDispatcher, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1 } from '@/app/api/socket/externalActionDispatcher';
import { resolveExternalActionExecutionMachineAdmissionInTx } from '@/app/auth/externalActionExecutionAuthorization';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { registerMachineTerminalRpcHandlers } from '../../../../cli/src/api/machine/rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '../../../../cli/src/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '../../../../cli/src/terminal/pty/config';
import { createAgentIsolationMemberPreparationBoundary, runAgentIsolationMemberReadinessBoundary } from '../../../../cli/src/daemon/agentIsolation/agentIsolationEffects.testkit';
import { buildAgentIsolationProvisioningSteps, deriveAgentIsolationMemberIdentity } from '../../../../cli/src/daemon/agentIsolation/provisioning';
import { writeAgentIsolationMemberBinding } from '../../../../cli/src/daemon/agentIsolation/memberBindings';
import { createRequesterWorkspaceSyncFixture } from '../../../../cli/src/daemon/startup/createRequesterWorkspaceSyncFixture.testkit';
import { workspaceCheckoutNativeBoundary as syncNative } from '../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit';
import { encodeStoredCredentials } from '../../../../cli/src/persistence';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { readMachineDevcontainerWorkspaceSyncEndpointInTx } from '@/app/machines/managed/managedRows';
import { WorkspaceSyncSourceWriterTargetRoutingV1Schema } from '@happier-dev/protocol/socketRpc';
import type { Socket } from 'socket.io';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ExternalActionMachineRpcExecutionV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createAuthenticatedFakeSocket, triggerSocketHandler } from '@/app/api/testkit/socketHarness';
import { registerSocketRpcHandlers } from '@/app/api/socket/rpc/registerSocketRpcHandlers';
import { MachineInstallationProofPayloadV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { computeWorkspaceSyncPolicyDigest, WorkspaceSyncRelationshipCreateRpcRequestV1Schema } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1, buildProjectAccountRowPhysicalKeyV1, ProjectAccountRelationshipGraphV1Schema,
    type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { callExactMachineRpc } from '../../../../cli/src/session/transport/rpc/machineRpc';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createExternalMcpServer } from '../../../../cli/src/mcp/createExternalMcpServer';
import { runWithServerHttpBaseUrl } from '../../../../cli/src/api/client/serverHttpBaseUrl';
import { buildActionExecutorContextForRpc } from '../../../../cli/src/rpc/handlers/_actionDispatchAdapter';
import { workspaceSyncMaterializationReceiptPath } from '../../../../cli/src/workspaces/sync/workspaceSyncTargetBootstrap';
import { createCliActionExecutorFromCredentials } from '../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { ProjectWorkerCopyInspectResultV1Schema } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { createCliApprovalsArtifactStore } from '../../../../cli/src/session/actions/approvals/artifactStore';
import { createExternalActionAuthorizedRequestHeaders } from '../../../../cli/src/api/externalActionExecutionAuthorization';
import { configuration as cliConfiguration } from '../../../../cli/src/configuration';
import { readStoredCredentialsForServerId, writeCredentialsTokenOnlyForServerId } from '../../../../cli/src/persistence';

const shellNativeHome = vi.hoisted(() => ({ value: undefined as Readonly<{ path: string; backing: string; uid: number }> | undefined }));
const syncSocketIo = vi.hoisted(() => vi.fn());
const syncNativeActive = vi.hoisted(() => ({ value: false }));
vi.mock('socket.io-client', async original => {
    const actual = await original<typeof import('socket.io-client')>();
    return { ...actual, io: (...args: Parameters<typeof actual.io>) => syncNativeActive.value ? syncSocketIo(...args) : actual.io(...args) };
});
// The server integration runner imports Node ESM namespaces directly. Replace
// only native ownership/path facts, leaving actual filesystem I/O elsewhere.
vi.mock('node:fs/promises', async original => {
    const actual = await original<typeof import('node:fs/promises')>();
    const { workspaceCheckoutFilesystemBoundary } = await import('../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit');
    const boundary = workspaceCheckoutFilesystemBoundary(actual);
    return { ...boundary,
        async lstat(...args: Parameters<typeof actual.lstat>) {
            const home = shellNativeHome.value;
            return home && String(args[0]) === home.path
                ? Object.assign(await actual.lstat(home.backing), { uid: home.uid, gid: home.uid, mode: 0o40700 }) : boundary.lstat(...args);
        },
        async realpath(...args: Parameters<typeof actual.realpath>) {
            const home = shellNativeHome.value;
            return home && String(args[0]) === home.path ? home.path : boundary.realpath(...args);
        },
    };
});
vi.mock('node:fs', async original => {
    const actual = await original<typeof import('node:fs')>();
    const { requesterWorkspaceSyncInstallationFilesystemBoundary } = await import('../../../../cli/src/daemon/startup/requesterWorkspaceSyncFilesystem.testkit');
    return requesterWorkspaceSyncInstallationFilesystemBoundary(actual);
});
vi.mock('../../../../../packages/cli-common/src/process/execFileWithDeadline', async original => {
    const actual = await original<typeof import('../../../../../packages/cli-common/src/process/execFileWithDeadline')>();
    const { workspaceCheckoutNativeBoundary: native } = await import('../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit');
    return { ...actual, execFileWithDeadline: async (...args: Parameters<typeof actual.execFileWithDeadline>) => {
        if (!syncNativeActive.value) return actual.execFileWithDeadline(...args);
        if (args[0] === 'getent') {
            const observed = native.accountLookups.get(JSON.stringify(args[1]));
            if (observed !== undefined) return { stdout: observed, stderr: '' };
        }
        const home = native.mounts[0];
        const readiness = await runAgentIsolationMemberReadinessBoundary({ request: args,
            ...(home ? { nativeHome: { path: home.path, uid: home.uid } } : {}) });
        return readiness ?? actual.execFileWithDeadline(...args);
    } };
});
vi.mock('node:child_process', async original => {
    const actual = await original<typeof import('node:child_process')>();
    const { spawnWorkspaceCheckoutNativeBoundary } = await import('../../../../cli/src/workspaces/activation/workspaceCheckoutNative.testkit');
    return { ...actual, spawn: (command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) => {
        if (syncNativeActive.value && command === 'sudo' && args.at(-1) === 'agent-launch') return spawnWorkspaceCheckoutNativeBoundary();
        if (syncNativeActive.value && args.includes('synchronizer')) return actual.spawn('/bin/cat', [], options);
        return actual.spawn(command, args, options);
    } };
});

describe('Machine grant withdrawal through requester runtime custody', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-requester-custody-', initAuth: true, initEncrypt: false, initFiles: false,
            env: { HAPPIER_SERVER_IDENTITY_ID: 'srv_filesystem_held_owner', AUTH_REQUIRED_LOGIN_PROVIDERS: '' } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });

    it.skipIf(process.platform !== 'linux')('roots a real Manage grant Shell in its requester root while retaining foreign terminal refusal', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const installation = tweetnacl.sign.keyPair();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), installationPublicKey: installation.publicKey, active: true,
            metadata: encodePlainMachineStoredContent({ host: 'shared-shell', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
            principal: { kind: 'account', accountId: member.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        const home = await getOrCreateServerIdentityId();
        const requesterIdentity = { kind: 'isolated' as const, separationRequired: true, homeServerIdentityId: home, requester: { serverId: home,
            accountId: member.id, machineId: machine.id, installationId: machine.installationId! } };
        const identity = deriveAgentIsolationMemberIdentity(requesterIdentity);
        const activeServerDir = join(harness.baseDir, `shell-${machine.id}`);
        await filesystem.mkdir(activeServerDir);
        const preparation = createAgentIsolationMemberPreparationBoundary({ activeServerDir, requesterIdentity,
            custodianAccountId: custodian.id, encryptionMode: 'plain', uid: 2401 });
        for (const step of buildAgentIsolationProvisioningSteps({ requesterIdentity, daemonUsername: 'happier',
            daemonPrimaryGroup: 'happier', binaryPath: '/opt/happier/cli/current/happier' })) preparation.installed.add(step.id);
        await writeAgentIsolationMemberBinding(activeServerDir, { ...identity, agentUid: 2401, agentGid: 2401 });
        // Substitute only native uid/home filesystem facts. The actual member
        // operations read and qualify the persisted requester binding.
        shellNativeHome.value = { path: identity.home, backing: activeServerDir, uid: 2401 };
        onTestFinished(() => { shellNativeHome.value = undefined; vi.restoreAllMocks(); });
        const app = createAuthenticatedTestApp();
        machinesRoutes(app);
        const events = new EventEmitter();
        const writes: string[] = [];
        const sessions = createTerminalPtySessionManager({ config: readDaemonTerminalPtyConfig({}).sessionManager,
            env: {}, platform: 'linux', ptyProvider: { spawn: () => ({ pid: 0, write(data) { writes.push(data); }, resize() {}, kill() {},
                onData(listener) { events.on('data', listener); return { dispose: () => { events.off('data', listener); } }; },
                onExit(listener) { events.on('exit', listener); return { dispose: () => { events.off('exit', listener); } }; } }) } });
        const rpc = new RpcHandlerManager({ scopePrefix: machine.id, localMachineId: machine.id, encryptionMode: 'plain', logger: () => {},
            authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, { machineId: machine.id,
                resolveCustodianAccountId: async () => custodian.id, resolveInstallationId: () => machine.installationId,
                resolveHomeServerIdentityId: async () => home,
                verifyMachineAdmission: async ({ context, method }) => {
                    const proof = signMachineInstallationProof({ payload: { version: 1, machineId: machine.id,
                        installationId: machine.installationId!, accountId: custodian.id, rpcAdmission: { context, method } },
                        privateKey: installation.secretKey });
                    const response = await app.inject({ method: 'POST', url: `/v1/machines/${machine.id}/admission/verify`,
                        headers: { authorization: 'Bearer authenticated-test', 'x-test-user-id': custodian.id },
                        payload: { v: 1, context, method, proof } });
                    return response.statusCode === 200;
                } }, source) });
        const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc, deps: { serverId: home,
            resolveHostHomeServerIdentityId: async () => home, env: {}, platform: 'linux', workingDirectory: '/home/custodian',
            accessPolicy: { kind: 'osUser' }, sessionManager: sessions,
            agentIsolation: { managedHappierBinaryPath: '/opt/happier/cli/current/happier', read: () => ({ enabled: true,
                memberProvisioning: 'linuxUsersV1', status: { kind: 'effective', platform: 'linux', agentUser: 'happier-agent' },
                workspaceRoots: [identity.workspaceRoot] }), readMember: input => preparation.members.read(input) } } });
        const receiver = { id: 'shared-shell-daemon', data: { clientType: 'machine-scoped', userId: custodian.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
            accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
                accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            })) }, timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => rpc.handleRequest(request) }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === receiver.id || room.startsWith(`rpc:${custodian.id}:`)
            ? [receiver] : []);
        const invoke = async (actorAccountId: string, method: string, callParams: unknown) => {
            const admitted = await resolveMachineAdmission({ actorAccountId, machineId: machine.id, rpcMethod: method, requireOnline: true });
            expect(admitted).toMatchObject({ kind: 'admitted' });
            if (admitted.kind !== 'admitted') throw new Error('Expected real Machine admission');
            return forwardRpcCall({ io, targetUserId: custodian.id, method: `${machine.id}:${method}`, callParams,
                callerAuthority: 'present_user', machineAdmission: { actorAccountId, custodianAccountId: custodian.id,
                    machineId: machine.id, installationId: admitted.installationId!, role: admitted.role, encryptionMode: 'plain' } });
        };
        try {
            expect(await invoke(member.id, RPC_METHODS.DAEMON_TERMINAL_LIST, { machineShell: true })).toMatchObject({ ok: true,
                result: { ok: true, machineShell: { ok: true, cwd: identity.workspaceRoot } } });
            expect(await invoke(member.id, RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'member-shell' }))
                .toMatchObject({ ok: true, result: { ok: true } });
            const own = sessions.list().find(terminal => terminal.terminalKey === 'member-shell');
            expect(own).toMatchObject({ cwd: identity.workspaceRoot });
            expect(sessions.getCustody(own!.terminalId)).toMatchObject({ kind: 'machine', requesterAccountId: member.id, rootPath: identity.workspaceRoot });
            expect(sessions.getNativeExecutionIdentity?.(own!.terminalId)).toBeNull();
            expect(await invoke(custodian.id, RPC_METHODS.DAEMON_TERMINAL_ENSURE, { terminalKey: 'custodian-shell' }))
                .toMatchObject({ ok: true, result: { ok: true } });
            const foreign = sessions.list().find(terminal => terminal.terminalKey === 'custodian-shell');
            expect(await invoke(member.id, RPC_METHODS.DAEMON_TERMINAL_STREAM_INPUT,
                { terminalId: foreign!.terminalId, event: { t: 'text', text: 'must-not-run' } }))
                .toMatchObject({ ok: true, result: { ok: false, code: 'terminal_forbidden' } });
            expect(writes).toEqual([]);
        } finally {
            events.emit('exit', { exitCode: 0 }); registration.dispose(); sessions.dispose();
            await app.close(); vi.restoreAllMocks();
        }
    });

    it.skipIf(process.platform !== 'linux')('syncs a real Use grant into its member root through signed Home admission and refuses foreign roots', async () => {
        const custodian = await db.account.create({ data: { id: 'requester', encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { id: 'member-a', encryptionMode: 'plain' } });
        const custodianToken = await createAccountTokenForTests(custodian.id, { kind: 'account', authority: 'present_user' });
        const memberToken = await createAccountTokenForTests(member.id, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        machinesRoutes(app);
        registerExternalActionRoutes(app);
        let homeVerifications = 0;
        const homeVerificationResults: { status: number; data: unknown }[] = [];
        const homeRootVerificationResults: { status: number; data: unknown }[] = [];
        syncNativeActive.value = true;
        onTestFinished(async () => { syncNativeActive.value = false; syncNative.reset(); await app.close(); });
        const setup = await createRequesterWorkspaceSyncFixture({ role: 'use', socketIo: syncSocketIo,
            readHomePost: async (url, body, config) => {
                if (url.endsWith('/v1/machines/machine/admission/verify')) {
                    const response = await app.inject({ method: 'POST', url: '/v1/machines/machine/admission/verify',
                        headers: { authorization: `Bearer ${custodianToken}` }, payload: body });
                    homeVerifications++;
                    homeVerificationResults.push({ status: response.statusCode, data: response.json() });
                    return { status: response.statusCode, data: response.json() };
                }
                if (!url.endsWith('/execution-authorization/verify')) return undefined;
                const headers = Object.fromEntries(Object.entries(config?.headers ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
                const response = await app.inject({ method: 'POST', url: new URL(url).pathname,
                    headers, payload: body });
                homeRootVerificationResults.push({ status: response.statusCode, data: response.json() });
                return { status: response.statusCode, data: response.json() };
            } });
        const { installed } = setup;
        const machine = await db.machine.create({ data: { id: installed.machineId, accountId: custodian.id,
            installationId: installed.installation.installationId,
            installationPublicKey: decodeBase64(installed.installation.publicKey, 'base64url'), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'shared-sync', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: installed.machineId,
            principal: { kind: 'account', accountId: member.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        const rpcMethod = RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE;
        const receiver = { id: 'shared-sync-daemon', data: { clientType: 'machine-scoped', userId: custodian.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
            accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
                accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            })) }, timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => setup.rpc.handleRequest(request) }) };
        const io = createSocketRoomDiscoveryHarness(async room => room === receiver.id || room.startsWith(`rpc:${custodian.id}:`) ? [receiver] : []);
        const invoke = async (rawRequest: typeof setup.request) => {
            const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(rawRequest);
            const admission = await resolveMachineAdmission({ actorAccountId: member.id, machineId: installed.machineId, rpcMethod, requireOnline: true });
            expect(admission).toMatchObject({ kind: 'admitted', actorAccountId: member.id, custodianAccountId: custodian.id, role: 'use' });
            if (admission.kind !== 'admitted') throw new Error('Expected real Use Sync admission');
            const envelope = { v: 1 as const, requestId: request.operationId,
                target: { kind: 'machine' as const, machineId: machine.id }, input: request.actionInput };
            expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: member.id,
                machineId: machine.id, actionId: 'workspace.sync.relationship.create', envelope,
                callerAuthority: 'present_user' })).toMatchObject({ kind: 'admitted', role: 'use' });
            const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('workspace.sync.relationship.create'),
                headers: { authorization: `Bearer ${memberToken}` },
                payload: { v: 1, machineId: machine.id, envelope } });
            expect(issued.statusCode, issued.body).toBe(200);
            const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
            const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
                purpose: { kind: 'machine_rpc', method: rpcMethod, params: request }, credentials: encodeStoredCredentials(setup.credentials),
                installationPublicKey: decodeBase64(installed.installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes });
            const result = await forwardRpcCall({ io, targetUserId: custodian.id, method: `${installed.machineId}:${rpcMethod}`, callParams: request,
                callerAuthority: 'present_user', createCallerInputAuthorization: async () => authorization, originalActionEnvelope: envelope,
                machineAdmission: { actorAccountId: member.id, custodianAccountId: custodian.id, machineId: installed.machineId,
                    installationId: admission.installationId!, role: admission.role, encryptionMode: 'plain' } });
            expect(homeVerificationResults).toEqual(expect.arrayContaining([{ status: 200, data: { v: 1, ok: true } }]));
            expect(homeRootVerificationResults, JSON.stringify({ result, diagnostics: setup.rpcDiagnostics,
                homeRootVerificationResults })).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200 })]));
            return result;
        };
        const rowsBeforeForeignRequests = structuredClone(setup.rows);
        await expect(filesystem.readFile(join(setup.targetPath, 'payload.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await invoke({ ...setup.request, operationId: 'foreign-source', actionInput: {
            ...setup.request.actionInput, sourceWorkspaceRefId: setup.custodianRef.id } }))
            .toMatchObject({ ok: true, result: { errorCode: 'workspace_ref_not_ready' } });
        const foreignTarget = await invoke({ ...setup.request, operationId: 'foreign-target', actionInput: {
            ...setup.request.actionInput, targetPath: setup.custodianRef.rootPath } });
        expect(foreignTarget, JSON.stringify(setup.rpcDiagnostics))
            .toMatchObject({ ok: true, result: { errorCode: 'workspace_private_checkout_review_required' } });
        expect(setup.rows).toEqual(rowsBeforeForeignRequests);
        expect(setup.custodianRows).toEqual(setup.custodianBefore);
        await expect(filesystem.stat(setup.custodianRef.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(filesystem.readFile(join(setup.targetPath, 'payload.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await invoke(setup.request)).toMatchObject({ ok: true, result: { v: 1, created: true,
            sourceWorkspaceRefId: setup.sourceRef.id, targetWorkspaceRefId: setup.targetRef.id } });
        expect(homeVerifications).toBeGreaterThan(0);
        expect(setup.rows.some(row => row.key.kind === 'relationship-graph')).toBe(true);
        expect(setup.custodianRows).toEqual(setup.custodianBefore);
        expect(setup.sourcePath.startsWith(`${setup.member.workspaceRoot}/`)).toBe(true);
        expect(setup.targetPath.startsWith(`${setup.member.workspaceRoot}/`)).toBe(true);
        expect(await syncNative.identity.run('member', () => filesystem.readFile(join(setup.sourcePath, 'payload.txt'), 'utf8'))).toBe('before quiesce');
        expect(await syncNative.identity.run('member', () => filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8'))).toBe('before quiesce');
    });

    it.skipIf(process.platform !== 'linux').each([false, true])('previews and retires the retained requester copy through MCP, CLI approval and real Home after a cross-Account native create (foreign SOURCE=%s)', async foreignSource => {
        await db.machine.deleteMany({ where: { id: { in: ['machine', 'target-parent'] } } });
        await db.account.deleteMany({ where: { id: { in: ['requester', 'member-a'] } } });
        const requester = await db.account.create({ data: { id: 'member-a', publicKey: null, encryptionMode: 'plain' } });
        const custodian = await db.account.create({ data: { id: 'requester', publicKey: null, encryptionMode: 'plain' } });
        const requesterToken = await createAccountTokenForTests(requester.id, { kind: 'account', authority: 'present_user' });
        const custodianToken = await createAccountTokenForTests(custodian.id, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        machinesRoutes(app);
        registerProjectAccountRowRoutes(app);
        let projectRowsAtHome = false;
        let actionDaemon: ReturnType<typeof createAuthenticatedFakeSocket> | undefined;
        const actionIo = createSocketRoomDiscoveryHarness(async room => actionDaemon && (room === actionDaemon.id
            || room === `rpc:${actionDaemon.data?.userId}:${actionDaemon.data?.machineId}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`) ? [actionDaemon] : []);
        registerExternalActionRoutes(app, { dispatch: createExternalActionDaemonDispatcher({ io: actionIo }) });
        syncNativeActive.value = true;
        onTestFinished(async () => { syncNativeActive.value = false; syncNative.reset(); await app.close(); });
        const forwarded: SocketRpcRequestPayload[] = [];
        let targetMaterializationDirectory: string | undefined;
        let sourceTransportAdmission: unknown;
        let retirementReadAuthorization: ExternalActionExecutionAuthorizationV1 | undefined;
        let inspectApprovedCopyAttack: ((packet: SocketRpcRequestPayload, send: (packet: SocketRpcRequestPayload) => Promise<unknown>) => Promise<void>) | undefined;
        let approvedCopyAttackForwarded = false;
        let approvedCopyAttackOutcome: Readonly<{ errorCode?: unknown; forwarded: number; bytesPreserved: boolean }> | undefined;
        const httpPosts: string[] = [];
        const homeVerifications: { path: string; status: number; method?: string; writerPhase?: string; errorCode?: string; code?: string;
            effectAction?: string; rowKey?: unknown; rootAction?: string; approvalDecision?: string }[] = [];
        const compatibility = evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
            accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        }));
        const installedToken = await createAccountTokenForTests(foreignSource ? custodian.id : requester.id,
            { kind: 'terminal', authority: 'account_automation' });
        const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo: syncSocketIo,
            installedCredentials: { token: installedToken, encryption: null },
            requesterCredentials: { token: requesterToken, encryption: null },
            sourceCustodianAccountId: foreignSource ? custodian.id : requester.id, targetCustodianAccountId: custodian.id,
            remoteTarget: true, workerCleanCopy: true, remoteSeed: true,
            prepareActiveServerDirectory: async activeServerDir => {
                if (activeServerDir.includes('/target-parent/')) targetMaterializationDirectory = join(activeServerDir, 'workspace-sync', 'materialization');
            },
            forwardHomeRpc: async function forwardHomeRpc(payload, receive, authenticatedToken) {
                if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') {
                    throw new Error('Missing physical Machine RPC');
                }
                const params = 'params' in payload ? payload.params : undefined;
                const signed = 'externalActionExecution' in payload
                    ? ExternalActionMachineRpcExecutionV1Schema.safeParse(payload.externalActionExecution) : null;
                if (signed?.success && signed.data.authorization.binding.actionId === 'approval.request.decide') {
                    retirementReadAuthorization = signed.data.authorization;
                }
                if (signed?.success && payload.method === `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`
                    && inspectApprovedCopyAttack) {
                    const attack = inspectApprovedCopyAttack;
                    inspectApprovedCopyAttack = undefined;
                    await attack(payload, packet => forwardHomeRpc(packet, receive, authenticatedToken));
                }
                const authorization = params && typeof params === 'object' && 'executionAuthorization' in params
                    ? ExternalActionExecutionAuthorizationV1Schema.safeParse(params.executionAuthorization) : undefined;
                if (authorization?.success && authorization.data.binding.actionId === 'approval.request.decide') {
                    retirementReadAuthorization = authorization.data;
                }
                const isTarget = payload.method.startsWith('target-parent:');
                const destination = isTarget ? target : source;
                const daemon = createAuthenticatedFakeSocket({ id: `preview-${destination.id}`, data: {
                    clientType: 'machine-scoped', userId: destination.accountId, machineId: destination.id,
                    verifiedMachineInstallationId: destination.installationId, accountStoredContentCompatibility: compatibility,
                }, timeout: () => ({ emitWithAck: async (_event: string, packet: SocketRpcRequestPayload) => {
                    forwarded.push(packet); return receive(packet);
                } }) });
                const io = createSocketRoomDiscoveryHarness(async room => room === daemon.id
                    || room === `rpc:${destination.accountId}:${payload.method}` ? [daemon] : []);
                const actor = authenticatedToken ? authenticatedToken === custodianToken ? custodian : requester
                    : source.accountId === custodian.id ? custodian : requester;
                const callerToken = actor === custodian ? custodianToken : requesterToken;
                const caller = Object.assign(createAuthenticatedFakeSocket({ id: 'preview-source', data: {
                    clientType: authenticatedToken ? 'user-scoped' : 'machine-scoped', userId: actor.id,
                    ...(!authenticatedToken ? { machineId: source.id, verifiedMachineInstallationId: source.installationId } : {}),
                    authTokenKind: 'account', authAuthority: 'present_user',
                    accountStoredContentCompatibility: compatibility,
                } }), { handshake: { auth: { token: callerToken } } });
                registerSocketRpcHandlers({ userId: actor.id, socket: caller as unknown as Socket, io });
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, payload, callback);
                const result: unknown = callback.mock.calls[0]?.[0];
                return result;
            },
            readHomePost: async (url, body, config) => {
                const path = new URL(url).pathname;
                httpPosts.push(path);
                if (!path.endsWith('/admission/verify') && !path.startsWith('/v1/actions/')
                    && !(projectRowsAtHome && path.startsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/`))) return undefined;
                const headers = path.endsWith('/admission/verify')
                    ? { authorization: `Bearer ${path.includes('/target-parent/') || foreignSource ? custodianToken : requesterToken}` }
                    : Object.fromEntries(Object.entries(config?.headers ?? {})
                        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
                const response = await app.inject({ method: 'POST', url: path, headers, payload: body });
                const data: unknown = response.json();
                let signedReadBinding;
                const authorizationToken = config?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER];
                if (path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read` && typeof authorizationToken === 'string') {
                    const { auth } = await import('@/app/auth/auth');
                    signedReadBinding = await auth.verifyExternalActionExecutionAuthorization(authorizationToken);
                    if (signedReadBinding) retirementReadAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
                        v: 1, token: authorizationToken, binding: signedReadBinding,
                    });
                }
                const routing = body && typeof body === 'object' && 'workspaceSyncSourceWriterTargetRouting' in body
                    ? WorkspaceSyncSourceWriterTargetRoutingV1Schema.safeParse(body.workspaceSyncSourceWriterTargetRouting) : null;
                if (response.statusCode === 200 && path.includes('/machine/') && routing?.success && routing.data.target.phase === 'inspect'
                    && body && typeof body === 'object' && 'context' in body) sourceTransportAdmission = body.context;
                homeVerifications.push({ path, status: response.statusCode,
                    ...(signedReadBinding ? { rootAction: signedReadBinding.actionId,
                        approvalDecision: signedReadBinding.approvalDecisionAdmission?.decision } : {}),
                    ...(typeof config?.headers?.[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] === 'string'
                        ? { effectAction: config.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER] } : {}),
                    ...(path.startsWith(`${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/`) && body && typeof body === 'object' && 'key' in body
                        ? { rowKey: body.key } : {}),
                    ...(body && typeof body === 'object' && 'method' in body && typeof body.method === 'string' ? { method: body.method } : {}),
                    ...(routing?.success ? { writerPhase: routing.data.target.phase } : {}),
                    ...(data && typeof data === 'object' && 'code' in data && typeof data.code === 'string' ? { code: data.code } : {}),
                    ...(data && typeof data === 'object' && 'errorCode' in data && typeof data.errorCode === 'string'
                        ? { errorCode: data.errorCode } : data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
                            ? { errorCode: data.error } : {}) });
                return { status: response.statusCode, data };
            } });
        // The installed none-credential codec reads its own saved credential,
        // as a real daemon does; requester keys are never supplied to SOURCE.
        await writeStoredCredentialsForServerId(setup.installed.serverId, setup.installed.bootstrap.credentials);
        const machineData = { active: true, metadata: encodePlainMachineStoredContent({ host: 'preview', platform: 'linux',
            homeDir: '/home/fixture', happyHomeDir: '/home/fixture/.happier', happyCliVersion: 'test' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilitiesRevision: 1, operationProtocolCapabilities: {
                externalActionExecutionAuthorization: { protocolVersions: [1] }, requesterExecutionIsolation: { protocolVersions: [1] } } };
        const source = await db.machine.create({ data: { ...machineData, id: setup.installed.machineId,
            accountId: foreignSource ? custodian.id : requester.id, installationId: setup.installed.installation.installationId,
            installationPublicKey: decodeBase64(setup.installed.installation.publicKey, 'base64url') } });
        const target = await db.machine.create({ data: { ...machineData, id: 'target-parent', accountId: custodian.id,
            installationId: setup.targetInstallation.installationId,
            installationPublicKey: decodeBase64(setup.targetInstallation.publicKey, 'base64url') } });
        // Only the socket transport is substituted: Home's real dispatcher and
        // forwarder mint and stamp the packet received by the SOURCE owner.
        actionDaemon = createAuthenticatedFakeSocket({ id: 'preview-action-source', data: {
            clientType: 'machine-scoped', userId: source.accountId, machineId: source.id,
            verifiedMachineInstallationId: source.installationId, accountStoredContentCompatibility: compatibility,
        }, timeout: () => ({ emitWithAck: async (_event: string, packet: SocketRpcRequestPayload) => {
            forwarded.push(packet);
            return setup.installed.rpcHandlerManager.handleRequest(packet, undefined, 'authenticated_home_socket');
        } }) });
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        if (foreignSource) expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: source.id,
            principal: { kind: 'account', accountId: requester.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        // This scenario creates a new owned copy. The general Sync fixture
        // starts with an existing empty destination, which has no copy receipt.
        await filesystem.rmdir(setup.targetPath);
        const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(setup.request);
        const prepared = await setup.prepareInvocation(request);
        const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('workspace.sync.relationship.create'),
            headers: { authorization: `Bearer ${requesterToken}` }, payload: { v: 1, machineId: source.id, envelope: prepared.envelope } });
        expect(issued.statusCode, issued.body).toBe(200);
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        const admitted = await setup.prepareInvocation(request, { envelope: prepared.envelope, authorization });
        expect(await setup.executeRelationshipAction(admitted)).toMatchObject({ ok: true, result: { created: true } });
        expect(await filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
        const graphRow = setup.rows.find(row => row.key.kind === 'relationship-graph');
        if (!graphRow || graphRow.content.t !== 'plain') throw new Error('Missing committed requester relationship');
        const graph = ProjectAccountRelationshipGraphV1Schema.parse(graphRow.content.v.value);
        if (!graph.relationships[0]) throw new Error('Missing committed relationship');
        if (!targetMaterializationDirectory) throw new Error('Missing actual WORKER materialization directory');
        const receiptPath = workspaceSyncMaterializationReceiptPath(targetMaterializationDirectory,
            graph.relationships[0].relationshipId, graph.relationships[0].alphaWorkspaceRefId === setup.targetRef.id ? 'alpha' : 'beta');
        const receiptBefore = await filesystem.readFile(receiptPath, 'utf8');
        const receiptEvidence: unknown = JSON.parse(receiptBefore);
        expect(Boolean(receiptEvidence && typeof receiptEvidence === 'object' && 'committed' in receiptEvidence
            && receiptEvidence.committed && 'promotedTargetIdentity' in receiptEvidence && receiptEvidence.promotedTargetIdentity)).toBe(true);
        const preview = { kind: 'preview', workspace: { serverId: setup.installed.homeServerIdentityId, refId: setup.sourceRef.id },
            machineId: source.id, targetMachineId: target.id, targetWorkspaceRefId: setup.targetRef.id,
            expectedRelationship: graph.relationships[0] };
        const requesterCredentials = { token: requesterToken, encryption: null };
        const inspect = async (input: unknown, credentials = requesterCredentials) => await callExactMachineRpc({ machineId: source.id,
            credentials, serverUrl: setup.installed.serverHttpBaseUrl,
            method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT, request: input });
        const foreignCopy = setup.targetAccountRows.find(row => row.key.kind === 'workspace-ref');
        if (!foreignCopy || foreignCopy.key.kind !== 'workspace-ref') throw new Error('Missing foreign WORKER copy ref');
        if (!foreignSource) {
            expect(await inspect({ ...preview, targetWorkspaceRefId: foreignCopy.key.id })).not.toMatchObject({ ok: true });
            expect(await inspect({ ...preview, expectedRelationship: { ...graph.relationships[0], relationshipId: 'other-copy' } }))
                .not.toMatchObject({ ok: true });
            await expect(inspect(preview, { token: custodianToken, encryption: null }))
                .rejects.toMatchObject({ rpcErrorCode: 'RPC_FORBIDDEN' });
        }
        const beforePositive = forwarded.length;
        const executePreviewViaMcp = async (): Promise<unknown> => {
            const { mcp } = runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () => createExternalMcpServer({
                credentials: requesterCredentials, machineId: source.id, daemonControlTarget: null,
                serverFeaturesSnapshot: { status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: setup.installed.homeServerIdentityId } } }) },
            }));
            const client = new Client({ name: 'requester-copy-preview', version: '1' });
            const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
            await mcp.connect(serverTransport);
            try {
                await client.connect(clientTransport);
                const reply = CallToolResultSchema.parse(await client.callTool({ name: 'action_execute', arguments: {
                    actionId: 'projects.worker.copy.inspect', input: preview,
                } }));
                const content = reply.content.find(entry => entry.type === 'text');
                if (content?.type !== 'text') throw new Error('Missing MCP copy preview result');
                return JSON.parse(content.text);
            } finally { await client.close(); await mcp.close(); }
        };
        const result = await executePreviewViaMcp();
        expect(result).toMatchObject({ ok: true, preview: { targetMachineId: target.id, workspaceRefId: setup.targetRef.id } });
        expect(forwarded.slice(beforePositive).map(packet => packet.method)).toEqual([
            `${source.id}:${EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1}`,
            `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
        ]);
        const workerPreview = forwarded.at(-1);
        if (!workerPreview) throw new Error('Missing retained-copy WORKER receipt');
        const writerRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(workerPreview.workspaceSyncSourceWriterTargetRouting);
        const senderAdmission = SocketRpcMachineAdmissionContextV1Schema.parse(sourceTransportAdmission);
        expect(senderAdmission).toMatchObject({ actorAccountId: source.accountId, custodianAccountId: source.accountId,
            machineId: source.id, installationId: source.installationId, role: 'manage' });
        const rowsBeforeAttacks = JSON.stringify(setup.rows);
        const targetRowsBeforeAttacks = JSON.stringify(setup.targetAccountRows);
        // Replay at the genuine installed SOURCE network boundary: Home still
        // authenticates that installation, while WORKER owns retained-copy scope.
        const replay = (request: typeof preview, routing: typeof writerRouting) => runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl,
            () => setup.installed.machine.callWorkspaceSyncTargetPhase({
            machineId: target.id, method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT,
            request, routing: routing.target, credentials: setup.installed.bootstrap.credentials,
            context: buildActionExecutorContextForRpc({ signal: new AbortController().signal, callerAuthority: 'present_user',
                machineAdmission: senderAdmission, workspaceSyncSourceWriterTargetRouting: routing, serverId: setup.installed.serverId }),
        }));
        const beforeAttacks = forwarded.length;
        await expect(replay(preview, { ...writerRouting, source: { ...writerRouting.source, sourceContext: {
            ...writerRouting.source.sourceContext, machineAdmission: { ...writerRouting.source.sourceContext.machineAdmission,
                actorAccountId: custodian.id },
        } } })).rejects.toMatchObject({ rpcErrorCode: 'forbidden', failureCause: { phase: 'rpc.handler' } });
        expect(forwarded.slice(beforeAttacks).map(packet => packet.method)).toEqual([
            `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
        ]);
        await expect(replay({ ...preview, expectedRelationship: { ...preview.expectedRelationship, relationshipId: 'other-copy' } }, {
            ...writerRouting, source: { ...writerRouting.source, operationId: 'other-copy' },
            target: { ...writerRouting.target, operationId: 'other-copy' },
        })).rejects.toMatchObject({ rpcErrorCode: 'forbidden' });
        expect(forwarded.slice(beforeAttacks).map(packet => packet.method)).toEqual([
            `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
            `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`,
        ]);
        expect(await filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
        expect(JSON.stringify(setup.rows)).toBe(rowsBeforeAttacks);
        expect(JSON.stringify(setup.targetAccountRows)).toBe(targetRowsBeforeAttacks);
        expect(await filesystem.readFile(receiptPath, 'utf8')).toBe(receiptBefore);
        // A separate legitimate read verifies the same materialization receipt
        // remains usable, including its root fingerprint and measured contents.
        if (!foreignSource) expect(await inspect(preview)).toEqual(result);
        // Move the committed rows across the genuine storage boundary. From
        // here every Project row read/mutation uses Home's real authenticator
        // and disposable SQLite store, including the signed approval replay.
        const seedRows = async (token: string, rows: readonly ProjectAccountRowV1[]) => {
            const unique = [...new Map(rows.map(row => [buildProjectAccountRowPhysicalKeyV1(row.key), row])).values()];
            if (!unique.some(row => row.key.kind === 'relationship-graph')) unique.push({ key: { kind: 'relationship-graph' },
                revision: 0, content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } } } });
            const response = await app.inject({ method: 'POST', url: `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`,
                headers: { authorization: `Bearer ${token}` }, payload: {
                    topologyChange: true, expectedRefs: [], mutations: unique.map(row => ({
                        key: row.key, expectedRevision: 'absent', content: row.content,
                    })),
                } });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toMatchObject({ status: 'updated' });
        };
        await seedRows(requesterToken, setup.rows);
        await seedRows(custodianToken, [...(foreignSource ? setup.custodianRows : []), ...setup.targetAccountRows]);
        const readRows = async (token: string) => {
            const response = await app.inject({ method: 'POST', url: `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`,
                headers: { authorization: `Bearer ${token}` }, payload: {} });
            expect(response.statusCode).toBe(200);
            return response.json();
        };
        const foreignRowsBeforeRetirement: unknown = await readRows(custodianToken);
        projectRowsAtHome = true;
        const inspected = ProjectWorkerCopyInspectResultV1Schema.parse(result);
        if (!inspected.ok) throw new Error('Missing reviewed retained copy');
        const features = FeaturesResponseSchema.parse({ features: {},
            capabilities: { serverIdentity: { serverIdentityId: setup.installed.homeServerIdentityId } } });
        const cleanup = runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () => createExternalMcpServer({
            credentials: requesterCredentials, machineId: source.id, daemonControlTarget: null,
            serverFeaturesSnapshot: { status: 'ready', features },
        }));
        const cleanupClient = new Client({ name: 'requester-copy-retirement', version: '1' });
        const [cleanupServer, cleanupTransport] = InMemoryTransport.createLinkedPair();
        await cleanup.mcp.connect(cleanupServer);
        try {
            await runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, async () => {
            await cleanupClient.connect(cleanupTransport);
            // A retained preparation loan is read custody, never permission to
            // fabricate an approved retirement or delete before its graph CAS.
            const forgedRemoval = { actionReceiptId: 'unissued-copy-retirement', actionInput: {
                workspace: preview.workspace, machineId: source.id, expectedRelationship: preview.expectedRelationship,
                removeTargetCopy: { workspaceRefId: setup.targetRef.id, rootFingerprint: inspected.preview.rootFingerprint },
            } };
            const removalRouting = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ ...writerRouting,
                target: { ...writerRouting.target, phase: 'remove' } });
            await expect(setup.installed.machine.callWorkspaceSyncTargetPhase({ machineId: target.id,
                method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_REMOVE, request: forgedRemoval,
                routing: removalRouting.target, credentials: setup.installed.bootstrap.credentials,
                context: buildActionExecutorContextForRpc({ signal: new AbortController().signal, callerAuthority: 'present_user',
                    machineAdmission: senderAdmission, workspaceSyncSourceWriterTargetRouting: removalRouting,
                    serverId: setup.installed.serverId }),
            })).rejects.toMatchObject({ code: 'peer_unavailable' });
            expect(await filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
            const reply = CallToolResultSchema.parse(await cleanupClient.callTool({ name: 'action_execute', arguments: {
                actionId: 'projects.worker.copy.retire', input: { workspace: preview.workspace, machineId: source.id,
                    expectedRelationship: preview.expectedRelationship,
                    removeTargetCopy: { workspaceRefId: setup.targetRef.id, rootFingerprint: inspected.preview.rootFingerprint } },
            } }));
            const content = reply.content.find(entry => entry.type === 'text');
            const proposal: unknown = content?.type === 'text' ? JSON.parse(content.text) : null;
            expect(proposal).toMatchObject({ kind: 'approval_request_created', artifactId: expect.any(String) });
            if (!proposal || typeof proposal !== 'object' || !('artifactId' in proposal) || typeof proposal.artifactId !== 'string') {
                throw new Error('Missing actual MCP retirement approval');
            }
            // The real approving root is observed at the outbound network
            // boundary. A freshly SOURCE-signed changed body must still fail
            // the retained WORKER copy owner without changing its bytes.
            inspectApprovedCopyAttack = async (packet, send) => {
                const execution = ExternalActionMachineRpcExecutionV1Schema.parse(packet.externalActionExecution);
                const before = forwarded.filter(packet => packet.method === `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`).length;
                const changed = WorkspaceSyncCommittedCopyTargetV1Schema.parse({ ...forgedRemoval, actionReceiptId: proposal.artifactId, actionInput: {
                    ...forgedRemoval.actionInput, removeTargetCopy: { ...forgedRemoval.actionInput.removeTargetCopy,
                        rootFingerprint: '0'.repeat(64) },
                } });
                const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse(packet.workspaceSyncSourceWriterTargetRouting);
                const content = createWorkspaceSyncTargetContent({ destination: { machineId: target.id,
                    installationId: setup.targetInstallation.installationId,
                    installationPublicKey: setup.targetInstallation.publicKey }, method: packet.method, routing });
                const callId = randomUUID().replaceAll('-', '');
                const encodedParams = await socketRpcCodec.encodeParams(content, changed, { method: packet.method, callId });
                if (typeof packet.requestId !== 'string') throw new Error('Missing signed retirement RPC request identity');
                // Mutate and sign at the network/installation boundary, keeping
                // the genuine current approving root and its original capsule.
                const result = await send({ ...packet, params: encodedParams, externalActionExecution: { ...execution,
                    machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: execution.authorization.token,
                        requesterAccountContext: execution.authorization.requesterAccountContext,
                        effectActionId: execution.effectActionId, target: execution.target, installationId: execution.installationId,
                        event: SOCKET_RPC_EVENTS.CALL, method: packet.method, requestId: packet.requestId, params: encodedParams,
                        workspaceSyncSourceWriterTargetRouting: packet.workspaceSyncSourceWriterTargetRouting,
                        privateKey: setup.installed.installation.privateKey }),
                } });
                const returned = await socketRpcCodec.decodeResult(content, result, callId);
                approvedCopyAttackOutcome = { errorCode: returned && typeof returned === 'object' && 'errorCode' in returned
                    ? returned.errorCode : undefined,
                    forwarded: forwarded.filter(packet => packet.method === `target-parent:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_COMMITTED_COPY_INSPECT}`).length - before,
                    bytesPreserved: await filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8') === 'before quiesce' };
                approvedCopyAttackForwarded = true;
            };
            // Public CLI authority comes from its credential reader, rather
            // than the Account bearer used by the MCP host above.
            const requesterCliToken = await createAccountTokenForTests(requester.id,
                { kind: 'terminal', authority: 'account_automation' });
            const sourceServersDir = cliConfiguration.serversDir;
            let cliCredentials;
            try {
                Object.assign(cliConfiguration, { serversDir: join(setup.installed.directory, 'approval-cli-profiles') });
                await writeCredentialsTokenOnlyForServerId(setup.installed.serverId, { token: requesterCliToken });
                cliCredentials = await readStoredCredentialsForServerId(setup.installed.serverId);
            } finally { Object.assign(cliConfiguration, { serversDir: sourceServersDir }); }
            expect(cliCredentials).toMatchObject({ encryption: null, credentialProvenance: 'stored_session' });
            if (!cliCredentials) throw new Error('Missing signed-in requester CLI credentials');
            const cli = createCliActionExecutorFromCredentials({ credentials: cliCredentials,
                serverId: setup.installed.serverId, serverApiUrl: setup.installed.serverHttpBaseUrl, machineId: source.id,
                resolveServerFeaturesSnapshot: () => ({ status: 'ready', features, provenance: 'authenticated' }),
                // The person approves the existing foreign SOURCE approval
                // decision disclosure; Home and both receivers remain real.
                onRequesterSessionCredentialDisclosure: () => true,
            });
            const approvalStore = createCliApprovalsArtifactStore({ credentials: requesterCredentials,
                serverId: setup.installed.serverId, serverHttpBaseUrl: setup.installed.serverHttpBaseUrl });
            const beforeDecision = await approvalStore.approvalsGet({ artifactId: proposal.artifactId });
            const rawApproval = setup.approvalArtifacts.get(proposal.artifactId);
            expect(beforeDecision, JSON.stringify({ stored: Boolean(rawApproval),
                storedKeys: rawApproval ? Object.keys(rawApproval) : [], owner: rawApproval?.ownerAccountId,
                posts: httpPosts.slice(-8) })).toMatchObject({ status: 'open' });
            const beforeReplay = homeVerifications.length;
            const decision = await runWithServerHttpBaseUrl(setup.installed.serverHttpBaseUrl, () => cli.execute('approval.request.decide', { artifactId: proposal.artifactId, decision: 'approve' }, {
                surface: 'cli', authority: 'present_user', serverId: setup.installed.serverId,
                actionCaller: { kind: 'host' }, actionRequestId: `approve-real-home-retire-${foreignSource}`,
            }));
            const afterDecision = await approvalStore.approvalsGet({ artifactId: proposal.artifactId });
            expect(decision, JSON.stringify({ errorCode: 'errorCode' in decision ? decision.errorCode : undefined,
                artifactStatus: afterDecision?.status, artifactExecutionCode: afterDecision?.execution?.errorCode,
                artifactFailureCause: afterDecision?.execution && 'failureCause' in afterDecision.execution ? afterDecision.execution.failureCause : undefined,
                approvedCopyAttackOutcome })).toMatchObject({ ok: true,
                result: { status: 'executed', execution: { ok: true, result: { status: 'retired' } } } });
            expect(homeVerifications.slice(beforeReplay).filter(row => row.path === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/read`)).toEqual([]);
            if (!retirementReadAuthorization) throw new Error('Missing genuine approved replay authorization');
            expect(retirementReadAuthorization.binding.actionId).toBe('approval.request.decide');
            expect(retirementReadAuthorization.binding.approvalDecisionAdmission).toEqual({
                artifactId: proposal.artifactId, decision: 'approve',
            });
            const mutationPath = `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/mutate`;
            const mutation = { topologyChange: true, expectedRefs: [], mutations: [{
                key: { kind: 'workspace-ref', serverId: setup.installed.homeServerIdentityId, id: setup.sourceRef.id },
                expectedRevision: 1, content: null,
            }] };
            const deniedMutation = await app.inject({ method: 'POST', url: mutationPath, payload: mutation,
                headers: createExternalActionAuthorizedRequestHeaders({ authorization: retirementReadAuthorization,
                    effectActionId: retirementReadAuthorization.binding.actionId,
                    target: retirementReadAuthorization.binding.target, installationId: setup.installed.installation.installationId,
                    method: 'POST', path: mutationPath, body: mutation, privateKey: setup.installed.installation.privateKey }),
            });
            expect(deniedMutation.statusCode).toBe(401);
            expect(approvedCopyAttackForwarded).toBe(true);
            expect(approvedCopyAttackOutcome).toEqual({ errorCode: 'root_changed', forwarded: 1, bytesPreserved: true });
            await expect(filesystem.stat(setup.targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
            const requesterRows = await readRows(requesterToken);
            expect(requesterRows).toMatchObject({ status: 'listed', rows: expect.arrayContaining([
                expect.objectContaining({ key: { kind: 'relationship-graph' }, content: {
                    t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } },
                } }),
            ]) });
            expect((await setup.fixture.parent.workspaceSync.controller.list())
                .filter(status => status.relationshipId === preview.expectedRelationship.relationshipId && status.state === 'watching')).toEqual([]);
            expect(await readRows(custodianToken)).toEqual(foreignRowsBeforeRetirement);
            });
        } finally { await cleanupClient.close(); await cleanup.mcp.close(); }
        if (foreignSource) {
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: source.id,
                principal: { kind: 'account', accountId: requester.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
            const beforeFreshRead = forwarded.length;
            const beforeFreshAdmission = homeVerifications.length;
            expect(await executePreviewViaMcp()).toMatchObject({ errorCode: 'target_unavailable' });
            expect(forwarded.slice(beforeFreshRead)).toEqual([]);
            expect(homeVerifications.slice(beforeFreshAdmission)).toContainEqual(expect.objectContaining({
                path: '/v1/actions/projects.worker.copy.inspect/execution-authorization', status: 409, code: 'target_unavailable',
            }));
        }
    });

    it.skipIf(process.platform !== 'linux')('copies through a real two-Account Home grant and prepared encrypted shared TARGET from the source Action', async () => {
        // These fixed IDs belong only to the preceding disposable native fixture.
        await db.machine.deleteMany({ where: { id: { in: ['machine', 'target-parent'] } } });
        await db.account.deleteMany({ where: { id: { in: ['requester', 'member-a'] } } });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        machinesRoutes(app); registerExternalActionRoutes(app);
        let custodianToken = '';
        const homeCalls: { method: unknown; status: number; error?: unknown; responseValid: boolean;
            destinationMachineMatches?: boolean; destinationInstallationMatches?: boolean }[] = [];
        syncNativeActive.value = true;
        onTestFinished(async () => { syncNativeActive.value = false; syncNative.reset(); await app.close(); });
        const setup = await createRequesterWorkspaceSyncFixture({ role: 'manage', socketIo: syncSocketIo,
            remoteTarget: true, accountMode: 'e2ee', targetResourceMode: 'e2ee',
            targetCustodianAccountId: 'requester', workerCleanCopy: true,
            forwardHomeRpc: async (payload, receive) => {
                if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') {
                    throw new Error('The installed source did not send a Machine RPC packet');
                }
                const compatibility = evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
                    accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                }));
                const daemon = createAuthenticatedFakeSocket({ id: 'encrypted-sync-target', data: { clientType: 'machine-scoped',
                    userId: custodian.id, machineId: target.id, verifiedMachineInstallationId: target.installationId,
                    accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck: async (_event: string, packet: SocketRpcRequestPayload) => receive(packet) }) });
                const method = payload.method;
                const io = createSocketRoomDiscoveryHarness(async room => room === daemon.id || room === `rpc:${custodian.id}:${method}` ? [daemon] : []);
                const caller = Object.assign(createAuthenticatedFakeSocket({ id: 'encrypted-sync-source', data: {
                    clientType: 'machine-scoped', userId: custodian.id, machineId: source.id,
                    verifiedMachineInstallationId: source.installationId, authTokenKind: 'account', authAuthority: 'present_user',
                    accountStoredContentCompatibility: compatibility,
                } }), { handshake: { auth: { token: custodianToken } } });
                registerSocketRpcHandlers({ userId: custodian.id, socket: caller as unknown as Socket, io });
                const callback = vi.fn();
                await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, payload, callback);
                expect(callback).toHaveBeenCalledTimes(1);
                return callback.mock.calls[0]?.[0];
            },
            readHomePost: async (url, body, config) => {
                const path = new URL(url).pathname;
                if (path.endsWith('/admission/verify')) {
                    const response = await app.inject({ method: 'POST', url: path,
                        headers: { authorization: `Bearer ${custodianToken}` }, payload: body });
                    const data: unknown = response.json();
                    const parsed = MachineAdmissionVerifyResponseV1Schema.safeParse(data);
                    homeCalls.push({ method: body && typeof body === 'object' && 'method' in body ? body.method : undefined,
                        status: response.statusCode, responseValid: parsed.success,
                        ...(parsed.success ? { destinationMachineMatches: parsed.data.destinationInstallation?.machineId === target.id,
                            destinationInstallationMatches: parsed.data.destinationInstallation?.installationId === target.installationId } : {}),
                        ...(data && typeof data === 'object' && 'error' in data ? { error: data.error } : {}) });
                    return { status: response.statusCode, data };
                }
                if (!path.endsWith('/execution-authorization/verify')) return undefined;
                const headers = Object.fromEntries(Object.entries(config?.headers ?? {})
                    .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
                const response = await app.inject({ method: 'POST', url: path, headers, payload: body });
                return { status: response.statusCode, data: response.json() };
            } });
        const resource = setup.targetResource;
        const sourceResource = setup.sourceResource;
        if (!resource || !sourceResource) throw new Error('The encrypted Machines did not produce their recipient material');
        expect(sourceResource.ownerPublicKey).toEqual(resource.ownerPublicKey);
        expect(sourceResource.requesterPublicKey).toEqual(resource.requesterPublicKey);
        const custodian = await db.account.create({ data: { id: 'requester', encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(resource.ownerPublicKey) } });
        const member = await db.account.create({ data: { id: 'member-a', encryptionMode: 'e2ee',
            ...createSignedAccountContentBinding(resource.requesterPublicKey) } });
        custodianToken = await createAccountTokenForTests(custodian.id, { kind: 'account', authority: 'present_user' });
        const memberToken = await createAccountTokenForTests(member.id, { kind: 'account', authority: 'present_user' });
        const source = await db.machine.create({ data: { id: setup.installed.machineId, accountId: custodian.id,
            installationId: setup.installed.installation.installationId,
            installationPublicKey: decodeBase64(setup.installed.installation.publicKey, 'base64url'), active: true,
            metadata: sourceResource.metadata, dataEncryptionKey: decodeBase64(sourceResource.ownerDataEncryptionKey),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] },
                externalActionExecutionAuthorization: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1 } });
        const target = await db.machine.create({ data: { id: 'target-parent', accountId: custodian.id,
            installationId: setup.targetInstallation.installationId,
            installationPublicKey: decodeBase64(setup.targetInstallation.publicKey, 'base64url'), active: true,
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] },
                externalActionExecutionAuthorization: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1,
            metadata: resource.metadata, dataEncryptionKey: decodeBase64(resource.ownerDataEncryptionKey) } });
        for (const machine of [source, target]) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: member.id }, level: 'admin' })))
            .toMatchObject({ kind: 'saved' });
        for (const [machine, material] of [[source, sourceResource], [target, resource]] as const) {
            const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: custodian.id, machineId: machine.id }));
            if ('kind' in census) throw new Error(census.code);
            expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!, expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
                expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
                recipientKeyEnvelopes: [{ recipientAccountId: member.id,
                    recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(material.requesterPublicKey),
                    encryptedDataKey: material.requesterDataEncryptionKey }] })))
                .toMatchObject({ appliedRecipientAccountIds: [member.id] });
        }
        expect(await resolveMachineAdmission({ actorAccountId: member.id, machineId: target.id,
            rpcMethod: RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT, requireOnline: true }))
            .toMatchObject({ kind: 'admitted', role: 'manage', encryptionMode: 'e2ee' });
        expect(await readMachineDevcontainerWorkspaceSyncEndpointInTx(db, { accountServerId: await getOrCreateServerIdentityId(),
            machineId: target.id, rootPath: setup.targetPath, operation: { actorAccountId: member.id,
                callerAuthority: 'present_user', rpcMethod: RPC_METHODS.DAEMON_DIRECT_TRANSFER_IMPORT_PREPARE } }))
            .toMatchObject({ machineId: target.id, installationId: target.installationId });
        const request = WorkspaceSyncRelationshipCreateRpcRequestV1Schema.parse(setup.request);
        const prepared = await setup.prepareInvocation(request);
        expect(prepared.envelope.v).toBe(2);
        const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('workspace.sync.relationship.create'),
            headers: { authorization: `Bearer ${memberToken}` },
            payload: { v: 1, machineId: source.id, envelope: prepared.envelope } });
        expect(issued.statusCode, issued.body).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        const authorization = sealExternalActionRequesterAccountContextV1({ authorization: root,
            purpose: { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_WORKSPACE_SYNC_RELATIONSHIP_CREATE, params: request },
            credentials: encodeStoredCredentials(setup.credentials),
            installationPublicKey: decodeBase64(setup.installed.installation.publicKey, 'base64url'), randomBytes: tweetnacl.randomBytes });
        const rowsBeforeRefusal = structuredClone(setup.rows);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: member.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        const refused = await setup.executeRelationshipAction({ request, envelope: prepared.envelope, authorization });
        expect(refused).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        expect(homeCalls).toEqual(expect.arrayContaining([expect.objectContaining({
            method: `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`,
            status: 403, error: 'access_denied' })]));
        expect(setup.rows).toEqual(rowsBeforeRefusal);
        expect(setup.custodianRows).toEqual(setup.custodianBefore);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: member.id }, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        await expect(filesystem.readFile(join(setup.targetPath, 'payload.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
        const result = await setup.executeRelationshipAction({ request, envelope: prepared.envelope, authorization });
        expect(result).toMatchObject({ ok: true, result: { created: true } });
        expect(homeCalls).toEqual(expect.arrayContaining([expect.objectContaining({
            method: `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`, status: 200 })]));
        expect(await filesystem.readFile(join(setup.targetPath, 'payload.txt'), 'utf8')).toBe('before quiesce');
        expect(setup.rows.every(row => row.content?.t === 'encrypted')).toBe(true);
        expect(setup.custodianRows).toEqual(setup.custodianBefore);
    });

    it.each([1, 2] as const)('binds a normal Sync writer to its real shared Manage TARGET with an opaque V%s Home root', async version => {
        const custodianKeys = tweetnacl.box.keyPair();
        const custodian = await db.account.create({ data: version === 1 ? { encryptionMode: 'plain' }
            : { encryptionMode: 'e2ee', ...createSignedAccountContentBinding(custodianKeys.publicKey) } });
        const material = { type: 'dataKey' as const, machineKey: tweetnacl.randomBytes(32) };
        const contentPublicKey = tweetnacl.box.keyPair.fromSecretKey(material.machineKey).publicKey;
        const actor = await db.account.create({ data: version === 1 ? { encryptionMode: 'plain' } : {
            encryptionMode: 'e2ee', ...createSignedAccountContentBinding(contentPublicKey) } });
        const sourceKeys = tweetnacl.sign.keyPair(), targetKeys = tweetnacl.sign.keyPair();
        const machineKey = tweetnacl.randomBytes(32);
        const createMachine = (keys: typeof sourceKeys) => db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), installationPublicKey: keys.publicKey, active: true,
            metadata: version === 2 ? 'opaque-metadata' : encodePlainMachineStoredContent({ host: 'sync-host', platform: 'linux', happyCliVersion: 'test',
                homeDir: '/home/custodian', happyHomeDir: '/home/custodian/.happier' }),
            daemonState: version === 2 ? 'opaque-daemon-state' : encodePlainMachineStoredContent({ status: 'running' }),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] }, externalActionExecutionAuthorization: { protocolVersions: [1] } },
            operationProtocolCapabilitiesRevision: 1, dataEncryptionKey: version === 1 ? new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64'))
                : new Uint8Array(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey, recipientPublicKey: custodianKeys.publicKey, randomBytes: tweetnacl.randomBytes })) } });
        const source = await createMachine(sourceKeys), target = await createMachine(targetKeys);
        for (const machine of [source, target]) expect(await inTx(tx => setMachineAccessGrantInTx(tx, {
            actorAccountId: custodian.id, machineId: machine.id, principal: { kind: 'account', accountId: actor.id }, level: 'admin' })))
            .toMatchObject({ kind: 'saved' });
        if (version === 2) for (const machine of [source, target]) {
            const census = await inTx(tx => readMachineRecipientCensusInTx(tx, { actorAccountId: custodian.id, machineId: machine.id }));
            if ('kind' in census) throw new Error(census.code);
            expect(await inTx(tx => commitMachineRecipientKeyEnvelopesInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                expectedMachineOwnerEnvelopeFingerprint: census.machineOwnerEnvelopeFingerprint!, expectedCallerDataEncryptionKey: census.callerDataEncryptionKey!,
                expectedMetadataVersion: census.content.metadataVersion, expectedDaemonStateVersion: census.content.daemonStateVersion,
                recipientKeyEnvelopes: [{ recipientAccountId: actor.id, recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey),
                    encryptedDataKey: Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey, recipientPublicKey: contentPublicKey, randomBytes: tweetnacl.randomBytes })).toString('base64') }] })))
                .toMatchObject({ appliedRecipientAccountIds: [actor.id] });
        }
        const admitted = await resolveMachineAdmission({ actorAccountId: actor.id, machineId: source.id, requiredRole: 'manage' });
        if (admitted.kind !== 'admitted') throw new Error('Shared source Manage admission missing');
        const { kind: _kind, ...sourceAdmission } = admitted;
        const actorToken = await createAccountTokenForTests(actor.id, { kind: 'account', authority: 'present_user' });
        const custodianToken = await createAccountTokenForTests(custodian.id, { kind: 'account', authority: 'present_user' });
        const app = createAuthenticatedTestApp({ authentication: 'real' });
        machinesRoutes(app); registerExternalActionRoutes(app); onTestFinished(() => app.close());
        const targetAdmission = await resolveMachineAdmission({ actorAccountId: actor.id, machineId: target.id, requiredRole: 'manage' });
        if (targetAdmission.kind !== 'admitted') throw new Error('Shared TARGET Manage admission missing');
        const { kind: _targetKind, ...targetContext } = targetAdmission;
        const directAdmission = { context: targetContext, method: `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}` };
        const directProof = MachineInstallationProofPayloadV1Schema.parse({ version: 1, accountId: custodian.id,
            machineId: target.id, installationId: target.installationId, rpcAdmission: directAdmission });
        const preflight = await app.inject({ method: 'POST', url: `/v1/machines/${target.id}/admission/verify`,
            headers: { authorization: `Bearer ${custodianToken}` }, payload: { v: 1, ...directAdmission,
                proof: signMachineInstallationProof({ payload: directProof, privateKey: targetKeys.secretKey }) } });
        expect(preflight.statusCode, preflight.body).toBe(200);
        const homeId = await getOrCreateServerIdentityId();
        const requestId = randomUUID();
        const selectedTarget = { kind: 'machine' as const, machineId: source.id };
        const content = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
        const input = { v: 1, sourceWorkspaceRefId: 'requester-source', targetMachineId: target.id, targetPath: '/requester/target',
            mode: 'mirror_exactly', purpose: 'worker_clean_copy', destinationIntent: 'materialize_from_source_workspace',
            contentPolicy: { ...content, policyDigest: computeWorkspaceSyncPolicyDigest(content) } };
        const envelope = version === 1 ? { v: 1 as const, requestId, target: selectedTarget, input }
            : sealExternalActionRequestV2({ binding: { serverIdentityId: homeId, accountId: actor.id,
                actionId: 'workspace.sync.relationship.create', requestId, target: selectedTarget,
                authentication: { kind: 'account', tokenEpoch: actor.tokenEpoch } }, input, material, randomBytes: tweetnacl.randomBytes,
                projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1 });
        expect(await resolveExternalActionExecutionMachineAdmissionInTx(db, { actorAccountId: actor.id,
            machineId: source.id, actionId: 'workspace.sync.relationship.create', envelope,
            callerAuthority: 'present_user' })).toMatchObject({ kind: 'admitted', role: 'manage' });
        const issued = await app.inject({ method: 'POST', url: bindExternalActionExecutionAuthorizationHttpPathV1('workspace.sync.relationship.create'),
            headers: { authorization: `Bearer ${actorToken}` }, payload: { v: 1, machineId: source.id, envelope } });
        expect(issued.statusCode, issued.body).toBe(200);
        const root = ExternalActionExecutionAuthorizationV1Schema.parse(issued.json());
        const routing = WorkspaceSyncSourceWriterTargetRoutingV1Schema.parse({ v: 1,
            source: { v: 1, phase: 'prepare', operationId: requestId, accountServerId: homeId,
                sourceMachineId: source.id, sourceRootPath: '/requester/source', originalActionEnvelope: envelope,
                sourceContext: { machineAdmission: sourceAdmission, callerAuthority: 'present_user' } },
            sourceWriter: { machineId: source.id, installationId: source.installationId },
            target: { v: 1, phase: 'preflight', operationId: requestId, accountServerId: homeId,
                targetMachineId: target.id, targetRootPath: input.targetPath } });
        const verify = (selected = routing, authorization = root, privateKey = sourceKeys.secretKey) => {
            const method = `${selected.target.targetMachineId}:${selected.target.phase === 'preflight'
                ? RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT : RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_BOOTSTRAP_PREPARE}`;
            const rpcAdmission = { context: sourceAdmission, method, workspaceSyncSourceWriterTargetRouting: selected, callerInputAuthorization: authorization };
            const payload = MachineInstallationProofPayloadV1Schema.parse({ version: 1, accountId: custodian.id,
                machineId: source.id, installationId: source.installationId, rpcAdmission });
            return app.inject({ method: 'POST', url: `/v1/machines/${source.id}/admission/verify`,
                headers: { authorization: `Bearer ${custodianToken}` }, payload: { v: 1, ...rpcAdmission,
                    proof: signMachineInstallationProof({ payload, privateKey }) } });
        };
        expect((await verify(routing, { ...root, token: 'forged-root' })).statusCode).toBe(403);
        expect((await verify(routing, root, targetKeys.secretKey)).statusCode).toBe(403);
        expect((await verify({ ...routing, source: { ...routing.source, operationId: randomUUID() } })).statusCode).toBe(403);
        expect((await verify({ ...routing, source: { ...routing.source, originalActionEnvelope: { ...envelope, requestId: randomUUID() } } })).statusCode).toBe(403);
        expect((await verify({ ...routing, target: { ...routing.target, targetMachineId: randomUUID() } })).statusCode).toBe(403);
        if (version === 1) expect((await verify({ ...routing, target: { ...routing.target, targetRootPath: '/custodian/private' } })).statusCode).toBe(403);
        for (const selected of [routing, { ...routing, target: { ...routing.target, phase: 'prepare' as const } }]) {
            const result = await verify(selected);
            expect(result.statusCode, result.body).toBe(200);
            expect(result.json()).toMatchObject({ v: 1, ok: true, destinationInstallation: { machineId: target.id,
                installationId: target.installationId, installationPublicKey: Buffer.from(targetKeys.publicKey).toString('base64url') } });
        }
        const method = `${target.id}:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_TARGET_REPLACEMENT_PREFLIGHT}`;
        const compatibility = evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
            accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
        }));
        const forwarded: SocketRpcRequestPayload[] = [];
        const daemon = createAuthenticatedFakeSocket({ id: `sync-target-${version}`, data: { clientType: 'machine-scoped',
            userId: custodian.id, machineId: target.id, verifiedMachineInstallationId: target.installationId,
            accountStoredContentCompatibility: compatibility }, timeout: () => ({ emitWithAck: async (_event, packet: SocketRpcRequestPayload) => {
                forwarded.push(packet); return { v: 1, kind: 'empty' };
            } }) });
        const io = createSocketRoomDiscoveryHarness(async room => room === daemon.id || room === `rpc:${custodian.id}:${method}` ? [daemon] : []);
        const caller = Object.assign(createAuthenticatedFakeSocket({ id: `sync-source-${version}`, data: {
            clientType: 'machine-scoped', userId: custodian.id, machineId: source.id,
            verifiedMachineInstallationId: source.installationId, authTokenKind: 'account', authAuthority: 'present_user',
            accountStoredContentCompatibility: compatibility,
        } }), { handshake: { auth: { token: custodianToken } } });
        registerSocketRpcHandlers({ userId: custodian.id, socket: caller as unknown as Socket, io });
        const params = { v: 1, operationId: requestId, serverId: homeId, machineId: target.id, targetPath: input.targetPath };
        const callId = randomUUID();
        const execution = ExternalActionMachineRpcExecutionV1Schema.parse({ v: 1, authorization: root,
            effectActionId: root.binding.actionId, target: root.binding.target, installationId: source.installationId,
            machineSignature: signExternalActionMachineRpcRequestV1({ authorizationToken: root.token,
                effectActionId: root.binding.actionId, target: root.binding.target, installationId: source.installationId!,
                event: SOCKET_RPC_EVENTS.CALL, method, requestId: callId, params,
                workspaceSyncSourceWriterTargetRouting: routing, privateKey: sourceKeys.secretKey }) });
        const callback = vi.fn();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, { method, params, requestId: callId,
            externalActionExecution: execution, workspaceSyncSourceWriterTargetRouting: routing }, callback);
        expect(callback).toHaveBeenCalledWith({ ok: true, result: { v: 1, kind: 'empty' } });
        expect(forwarded).toHaveLength(1);
        expect(forwarded[0]?.callerInputAuthorization?.binding).toEqual(root.binding);
        expect(forwarded[0]?.callerInputAuthorization?.token === root.token).toBe(true);
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: actor.id }, level: 'view' }))).toMatchObject({ kind: 'saved' });
        const useTarget = await verify();
        expect(useTarget.statusCode, useTarget.body).toBe(403);
        expect(useTarget.json()).toMatchObject({ error: 'access_denied' });
        await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: target.id,
            principal: { kind: 'account', accountId: actor.id } }));
        expect((await verify()).statusCode).toBe(403);
    });

    it.each(['use', 'removed'] as const)('dispatches grantee Manage→%s through existing access-loss custody', async remaining => {
        const owner = await db.account.create({ data: {} });
        const member = await db.account.create({ data: {} });
        const installationId = randomUUID();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            active: true, metadata: 'encrypted-metadata', installationId } });
        const grant = { actorAccountId: owner.id, machineId: machine.id,
            principal: { kind: 'account' as const, accountId: member.id } };
        expect(await inTx(tx => setMachineAccessGrantInTx(tx, { ...grant, level: 'admin' }))).toMatchObject({ kind: 'saved' });
        const calls: unknown[] = [];
        const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const target = { id: 'downgrade-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId },
            timeout: () => ({ emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => {
                const params = MachineAccessLossCustodyRequestV1Schema.parse(request.params);
                if ('kind' in params) return { kind: 'requesters', accountIds: [member.id, owner.id], coverage: 'complete' };
                calls.push(params);
                return { kind: 'settled' };
            } }) };
        const io = createSocketRoomDiscoveryHarness(async room =>
            room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : []);
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        try {
            if (remaining === 'use') {
                expect(await inTx(tx => setMachineAccessGrantInTx(tx, { ...grant, level: 'view' }))).toMatchObject({ kind: 'saved' });
            } else {
                expect(await inTx(tx => removeMachineAccessGrantInTx(tx, grant))).toMatchObject({ kind: 'removed' });
            }
            await vi.waitFor(() => expect(calls).toEqual([{ v: 1, subjectAccountId: member.id,
                ...(remaining === 'use' ? { remainingRole: 'use' } : {}) }]));
            const firstCleanup = calls[0];
            await recoverMachineAccessLossCustody({ machineId: machine.id,
                expectedCustodianAccountId: owner.id, expectedInstallationId: installationId });
            // Reconnect uses that same current-role projection, not an old full-loss
            // assumption. The custodian census subject gets no cleanup at all.
            expect(calls).toEqual([firstCleanup, firstCleanup]);
        } finally { eventRouter.clearIo(); }
    });

    it.each([
        ['admission', 'admission_refused:machine_unavailable'],
        ['installation', 'installation_mismatch'],
        ['target-installation', 'installation_mismatch'],
        ['missing-target', 'target_not_found'],
        ['missing-forwarder', 'forwarder_unavailable'],
        ['disconnected-target', `forward_failed:${RPC_ERROR_CODES.OUTCOME_UNKNOWN}`],
        ['uncoded-transport', 'forward_failed:unknown'],
        ['failed-discovery', `forward_failed:${RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE}`],
        ['invalid-response', 'response_invalid'],
        ['daemon-refusal', `forward_failed:${RPC_ERROR_CODES.FORBIDDEN}`],
        ['incomplete-response', 'cleanup_incomplete'],
    ] as const)('retains the content-free custody reason for %s', async (scenario, reason) => {
        const owner = await db.account.create({ data: {} });
        const requester = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            active: scenario !== 'admission', metadata: 'encrypted-metadata', installationId: randomUUID() } });
        const input = { machineId: machine.id, subjectAccountId: requester.id, expectedCustodianAccountId: owner.id,
            expectedInstallationId: scenario === 'installation' ? randomUUID() : machine.installationId! };
        const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const target = { id: 'diagnostic-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: scenario === 'target-installation' ? randomUUID() : machine.installationId },
            timeout: () => ({ emitWithAck: async () => {
                if (scenario === 'disconnected-target') throw Object.assign(new Error('private transport detail'), { code: 'SOCKET_DISCONNECTED' });
                if (scenario === 'uncoded-transport') throw new Error('private transport detail');
                if (scenario === 'invalid-response') return { kind: 'settled', privateData: 'must not escape' };
                if (scenario === 'daemon-refusal') return { error: 'private refusal detail', errorCode: RPC_ERROR_CODES.FORBIDDEN };
                return { kind: scenario === 'incomplete-response' ? 'incomplete' : 'settled' };
            } }) };
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (scenario === 'failed-discovery') throw new Error('private discovery detail');
            return scenario !== 'missing-target' && (room === target.id || room === `rpc:${owner.id}:${method}`) ? [target] : [];
        });
        eventRouter.setIo(io, scenario === 'missing-forwarder' ? {} : { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        try {
            expect(await dispatchMachineAccessLossCustody(input)).toEqual({ kind: 'incomplete', reason });
        } finally { eventRouter.clearIo(); }
    });

    it('finishes an admitted custody dispatch without repeating its Home admission snapshot', async () => {
        const owner = await db.account.create({ data: {} });
        const requester = await db.account.create({ data: {} });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
            active: true, metadata: 'encrypted-metadata', installationId: randomUUID() } });
        const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
        const target = { id: 'admitted-daemon', data: { clientType: 'machine-scoped', userId: owner.id,
            machineId: machine.id, verifiedMachineInstallationId: machine.installationId },
            timeout: () => ({ emitWithAck: async () => ({ kind: 'settled' }) }) };
        const io = createSocketRoomDiscoveryHarness(async room => {
            if (room === target.id) await db.machine.update({ where: { id: machine.id }, data: { active: false } });
            return room === target.id || room === `rpc:${owner.id}:${method}` ? [target] : [];
        });
        eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
        try {
            expect(await dispatchMachineAccessLossCustody({ machineId: machine.id, subjectAccountId: requester.id,
                expectedCustodianAccountId: owner.id, expectedInstallationId: machine.installationId! })).toEqual({ kind: 'settled' });
        } finally { eventRouter.clearIo(); }
    });

    it('lets the Machine custodian see and stop a removed member running Service without widening Manage visibility', async () => {
        const custodian = await db.account.create({ data: { encryptionMode: 'plain' } });
        const member = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manager = await db.account.create({ data: { encryptionMode: 'plain' } });
        let machine = await db.machine.create({ data: { id: randomUUID(), accountId: custodian.id,
            installationId: randomUUID(), active: true,
            metadata: encodePlainMachineStoredContent({ host: 'service-host', platform: process.platform, happyCliVersion: 'test',
                homeDir: '/fixture', happyHomeDir: '/fixture/.happier' }),
            daemonState: encodePlainMachineStoredContent({ status: 'running' }),
            operationProtocolCapabilities: { requesterExecutionIsolation: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1,
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        for (const [accountId, level] of [[member.id, 'view'], [manager.id, 'admin']] as const) {
            expect(await inTx(tx => setMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId }, level }))).toMatchObject({ kind: 'saved' });
        }
        const directory = join(harness.baseDir, `service-owner-${machine.id}`);
        const homeId = 'srv_requester_service_custody';
        const endpoint = 'https://requester-service-custody.test';
        const token = (accountId: string, terminal = false) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
            provenance: { v: 1, kind: terminal ? 'terminal' : 'account',
                authority: terminal ? 'account_automation' : 'present_user' } })).toString('base64url')}.signature`;
        // Installed daemon sign-in uses its terminal credential. Each incoming
        // present-person Action still seals that actor's separate Account token.
        const credentials = { token: token(custodian.id, true), encryption: null };
        // This fixture exercises Service custody, with the custodian's deliberate
        // UI Stop preference served by the real Account-settings reader.
        const custodianSettings = { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1, actions: {},
            approvalWaivedSurfaces: { 'localServices.actions.stopManaged': ['ui'] } }) };
        const channel = await createRequesterCurrentnessSocketHarness();
        onTestFinished(async () => { await channel.close(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
        type ServiceAction = 'machines.services.list' | 'localServices.actions.stopManaged';
        const authorizations = new Map<string, ExternalActionExecutionAuthorizationV1>();
        const homeRequests: Array<Readonly<{ method: 'GET' | 'POST'; path: string }>> = [];
        // Substitute authenticated Home HTTP only. Membership and each fresh
        // authorization decision use the real server's database-backed owner.
        vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
            const path = new URL(String(url)).pathname;
            homeRequests.push({ method: 'GET', path });
            if (path === '/v1/account/profile') {
                const account = [custodian, member, manager].find(candidate =>
                    options?.headers?.Authorization === `Bearer ${token(candidate.id)}`
                    || candidate.id === custodian.id && options?.headers?.Authorization === `Bearer ${credentials.token}`);
                if (!account) throw new Error('Unexpected Account credentials');
                return { status: 200, data: { id: account.id } };
            }
            if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
                signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
                recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
            if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain',
                v: options?.headers?.Authorization === `Bearer ${token(custodian.id)}` ? custodianSettings : {} }, version: 1 } };
            throw new Error(`Unexpected Home read: ${path}`);
        });
        vi.spyOn(axios, 'post').mockImplementation(async (url, _body, options) => {
            const path = new URL(String(url)).pathname;
            homeRequests.push({ method: 'POST', path });
            if (!path.endsWith('/execution-authorization/verify')) throw new Error(`Unexpected Home write: ${path}`);
            const authorization = authorizations.get(String(options?.headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]));
            if (!authorization) throw new Error('Unexpected execution authorization');
            const admission = await resolveMachineAdmission({ actorAccountId: authorization.binding.accountId,
                machineId: authorization.binding.machineId, actionId: authorization.binding.actionId, requireOnline: true });
            return { status: admission.kind === 'admitted' ? 200 : 403,
                data: admission.kind === 'admitted' ? ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true })
                    : { error: 'access_denied' } };
        });
        vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (url, options) => {
            const path = new URL(String(url)).pathname;
            homeRequests.push({ method: 'GET', path });
            if (path === '/v1/account/profile') {
                const authorization = new Headers(options?.headers).get('Authorization');
                const account = [custodian, member, manager].find(candidate => authorization === `Bearer ${token(candidate.id)}`
                    || candidate.id === custodian.id && authorization === `Bearer ${credentials.token}`);
                if (!account) throw new Error('Unexpected Account credentials');
                return Response.json({ id: account.id });
            }
            if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({
                features: { localServices: { enabled: true, inventory: { enabled: true },
                    managed: { enabled: true }, actions: { enabled: true } } },
                capabilities: { serverIdentity: { serverIdentityId: homeId } } });
            throw new Error(`Unexpected Home fetch: ${path}`);
        }));
        let apiMachine!: ApiMachineClient;
        const host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
            activeServerDir: join(directory, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: custodian.id, credentials,
            connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
            trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
            getApiMachineForSessions: () => apiMachine,
            beforeStartup: async () => {
                await writeStoredCredentialsForServerId(homeId, credentials);
                const installation = await readOrCreateInstallationIdentity();
                machine = await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId } });
                await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: homeId, createIfMissing: true,
                    suggestedName: 'Service Home', webappUrl: endpoint, observation: 'exact',
                    descriptor: HomeConnectionDescriptorV1Schema.parse({ v: 1, homeServerIdentityId: homeId,
                        canonicalServerUrl: endpoint, revision: 1, endpoints: [{ kind: 'https', url: endpoint }] }) });
                expect(await resolveServerProfileHomeIdentityId(homeId)).toBe(homeId);
                apiMachine = new ApiMachineClient(credentials.token, { id: machine.id, installationId: installation.installationId,
                    encryptionMode: 'plain', metadata: { host: 'service-host', platform: process.platform,
                        happyCliVersion: 'test', homeDir: directory, happyHomeDir: directory },
                    metadataVersion: 1, daemonState: null, daemonStateVersion: 0 });
            }, startup: { pluginRuntimeController: pluginReloadController,
                resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: machine.id, serverIdentityId: homeId }) },
        });
        onTestFinished(() => host.dispose());
        onTestFinished(() => apiMachine.shutdown());
        const installation = host.installation!;
        const ingress = host.runtime.externalActionIngressOwner!;
        apiMachine.setRPCHandlers({ spawnSession: async () => { throw new Error('No Session launch expected'); },
            stopSession: async () => false, requestShutdown() {} }, { externalActionIngressOwner: ingress });
        const fixture = await createAdmittedPluginRuntimeFixture({ happyHomeDir: directory,
            controller: pluginReloadController, runtimeOptions: { pluginIds: [] } });
        onTestFinished(() => fixture.dispose());
        const serviceOwner = fixture.registry.projectManagedServices;
        const target = { serverId: homeId, machineId: machine.id };
        const phaseLog = vi.spyOn(logger, 'warnLocalFile');
        const failureDiagnostic = (phase: string, result: unknown) => JSON.stringify({ phase,
            errorCode: result && typeof result === 'object' ? Reflect.get(result, 'errorCode') : undefined,
            runtimeReason: result && typeof result === 'object' && Reflect.get(result, 'errorCode') === 'runtime_action_disabled'
                && typeof Reflect.get(result, 'error') === 'string'
                && Reflect.get(result, 'error').startsWith('runtime_action_disabled:localServices:')
                ? Reflect.get(result, 'error') : undefined,
            failures: phaseLog.mock.calls.flatMap(([name, detail]) => name === '[external-action-phase]'
                && detail !== null && typeof detail === 'object' ? [{ phase: Reflect.get(detail, 'phase'),
                    errorClass: Reflect.get(detail, 'errorClass'), refusalBranch: Reflect.get(detail, 'refusalBranch'),
                    httpStatus: Reflect.get(detail, 'httpStatus') }] : []), homeRequests });
        const invoke = async (actor: string, actionId: ServiceAction, input: unknown) => {
            const requestId = randomUUID();
            const envelope = { v: 1 as const, requestId, target: { kind: 'machine' as const, machineId: machine.id }, input };
            const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: `service-custody-${requestId}`, binding: {
                accountId: actor, custodianAccountId: custodian.id, authentication: { kind: 'account', tokenEpoch: 0 },
                accountEncryptionMode: 'plain', machineId: machine.id, installationId: installation.installationId,
                serverIdentityId: homeId, actionId, requestId, target: envelope.target,
                requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
            authorizations.set(authorization.token, authorization);
            const boxed = sealExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
                invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user' },
                installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), credentials: { token: token(actor) },
                randomBytes: length => new Uint8Array(randomBytes(length)) });
            const prepared = await ingress.prepareRequesterAccountContext!({ authorization: boxed });
            if (!prepared) return { ok: false as const, errorCode: 'requester_account_context_unavailable' };
            try {
                return await prepared.authorization.requesterAccountExecutor!.execute(actionId, input, {
                    surface: 'ui', authority: 'present_user', externalActionTarget: envelope.target,
                    externalActionExecutionAuthorization: prepared.authorization });
            } finally { await prepared.dispose(); }
        };
        const root = process.cwd();
        const workspace = { id: randomUUID(), ...target, rootPath: root, createdAtMs: 1 };
        const declaration = { workspaceRefId: workspace.id, selection: { kind: 'manifest' as const, name: 'member-worker' } };
        const serviceId = `project:${workspace.id}:manifest:member-worker`;
        const reviewedEffectDigest = 'admitted-member-worker';
        let stopSeededService: (() => Promise<void>) | undefined;
        try {
            // Seed already admitted work through its real process/supervisor owner.
            // This test's authority boundary is grant withdrawal and the next owner request.
            const service = await serviceOwner.superviseProject({ kind: 'workspace', workspace, declaration, cwd: root, serviceId,
                requester: { ...target, accountId: member.id, installationId: machine.installationId! },
                specIdentity: reviewedEffectDigest, isCurrent: () => true,
                processSpec: { mode: { kind: 'managedSpawn', endpointNone: true } },
                authorizeLaunch: ({ signal }) => authorizeResolvedProjectExecLaunchForHost({ signal, assertCurrent() {},
                    projectLaunch: { status: 'ready', reviewedEffectDigest, toolchain: { selection: { kind: 'host' }, root,
                        platform: process.platform, io: createProjectNativeToolchainIoForHost({ resolveTool: async () => null }) } },
                    launch: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: root, env: {}, release() {} } }),
            });
            stopSeededService = async () => { await service.stop(); };
            const rpc = new RpcHandlerManager({ scopePrefix: machine.id, encryptionMode: 'plain', logger: () => {},
                authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, { machineId: machine.id,
                    resolveCustodianAccountId: async () => custodian.id, resolveInstallationId: () => machine.installationId,
                    verifyMachineAdmission: async input => {
                        const current = await resolveMachineAdmission({ actorAccountId: input.context.actorAccountId, machineId: machine.id,
                            rpcMethod: RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, requireOnline: true });
                        return current.kind === 'admitted' && current.installationId === input.context.installationId;
                    } }) });
            registerMachineAccessLossReceiver(rpc, { ...target, resolveInstallationId: () => machine.installationId });
            let settle!: (result: unknown) => void;
            const settled = new Promise<unknown>(resolve => { settle = resolve; });
            const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
            const receiver = { id: 'service-custody-daemon', data: { clientType: 'machine-scoped', userId: custodian.id,
                machineId: machine.id, verifiedMachineInstallationId: machine.installationId,
                accountStoredContentCompatibility: evaluateAccountStoredContentCompatibility(parseAccountStoredContentCompatibilitySocketAuthV1({
                    accountStoredContentCompatibility: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                })) }, timeout: () => ({
                    emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => rpc.handleRequest(request),
                }) };
            const io = createSocketRoomDiscoveryHarness(async room =>
                room === receiver.id || room === `rpc:${custodian.id}:${method}` ? [receiver] : []);
            eventRouter.setIo(io, { forwardRpc: async request => {
                const result = await forwardRpcCall({ io, ...request });
                // Observe the actual forward outcome too, so a refused network
                // fixture fails here instead of waiting for an impossible ACK.
                settle(result);
                return result;
            } });
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: custodian.id, machineId: machine.id,
                principal: { kind: 'account', accountId: member.id } }))).toMatchObject({ kind: 'removed' });
            expect(await settled).toMatchObject({ ok: true, result: { kind: 'settled' } });
            expect(service.snapshot().state).toBe('running');
            expect(await resolveMachineAdmission({ actorAccountId: member.id, machineId: machine.id,
                actionId: 'localServices.actions.stopManaged', requireOnline: true })).toEqual({ kind: 'denied', code: 'access_denied' });
            expect(service.snapshot().state).toBe('running');

            const manageAdmission = await resolveMachineAdmission({ actorAccountId: manager.id, machineId: machine.id,
                requiredRole: 'manage', requireOnline: true });
            expect(manageAdmission).toMatchObject({ kind: 'admitted', actorAccountId: manager.id, custodianAccountId: custodian.id, role: 'manage' });
            if (manageAdmission.kind !== 'admitted') throw new Error('Manage grantee admission missing');
            const manageResult = await invoke(manager.id, 'machines.services.list', target);
            // The current Home route is custodian-only. A generic Manage grant
            // admits placement, without disclosing another requester's Service.
            expect(manageResult, failureDiagnostic('manage_list', manageResult)).toEqual({ ok: false,
                errorCode: 'requester_account_context_unavailable' });

            const ownerAdmission = await resolveMachineAdmission({ actorAccountId: custodian.id, machineId: machine.id,
                actionId: 'localServices.actions.stopManaged', requireOnline: true });
            expect(ownerAdmission).toMatchObject({ kind: 'admitted', actorAccountId: custodian.id, custodianAccountId: custodian.id });
            if (ownerAdmission.kind !== 'admitted') throw new Error('Machine custodian admission missing');
            const ownerResult = await invoke(custodian.id, 'machines.services.list', target);
            expect(ownerResult, failureDiagnostic('owner_list', ownerResult)).toMatchObject({ ok: true });
            const ownerList = MachineServicesListResultV1Schema.parse('result' in ownerResult ? ownerResult.result : undefined);
            let unavailableBasis: Readonly<{ reason: string; metadataStatus: string; exactHome: boolean;
                nativeOwnerMatches: boolean }> | undefined;
            if (ownerList.kind === 'unavailable') {
                const lease = tryAcquireAuthoritativePluginRuntimeRegistryLease();
                try {
                    unavailableBasis = { reason: ownerList.reason, metadataStatus: apiMachine.getMachineMetadataSnapshot().status,
                        exactHome: await resolveServerProfileHomeIdentityId(homeId) === homeId,
                        nativeOwnerMatches: lease?.registry.projectManagedServices === serviceOwner };
                } finally { await lease?.release(); }
            }
            expect(ownerList, JSON.stringify({ phase: 'owner_service_projection', unavailableBasis }))
                .toMatchObject({ kind: 'snapshot', services: [{ serviceId, generation: service.instanceId, state: 'running' }] });

            // A signed wire root copied without its receiver-certified custody
            // cannot turn a caller-selected Account id into owner disclosure.
            const ownerWire = [...authorizations.values()].find(authorization =>
                authorization.binding.accountId === custodian.id && authorization.binding.actionId === 'machines.services.list');
            if (!ownerWire) throw new Error('Expected the verified owner list root');
            expect(await apiMachine.executeMachineServiceAction({ actionId: 'machines.services.list', input: target,
                requesterAccountId: custodian.id, context: { surface: 'ui', authority: 'present_user',
                    externalActionExecutionAuthorization: ownerWire } })).toEqual({ kind: 'snapshot', services: [] });

            // Consume the incumbent Workspace Stop Action owner, not a captured member handle.
            const stop = { requestId: randomUUID(), action: 'stop_managed' as const, force: false,
                target: { kind: 'managed_service' as const, machineId: machine.id, managedServiceId: service.instanceId,
                    workspaceId: workspace.id, cwd: root, declaration } };
            const confirmedStop = { ...stop, confirmationNonce: createLocalServiceActionConfirmationNonceV1(stop) };
            expect(await invoke(member.id, 'localServices.actions.stopManaged', confirmedStop)).toMatchObject({ ok: false });
            expect(service.snapshot().state).toBe('running');
            const ownerStop = await invoke(custodian.id, 'localServices.actions.stopManaged', confirmedStop);
            expect(ownerStop, failureDiagnostic('owner_stop', ownerStop)).toMatchObject({ ok: true,
                result: { status: 'succeeded' } });
            expect(service.snapshot().state).toBe('stopped');
            expect(serviceOwner.listProjectServices()).toEqual([]);
        } finally {
            eventRouter.clearIo();
            await stopSeededService?.();
        }
    });

    it('preserves already admitted requester, owner and entitled recipient runners after withdrawal', async () => {
        const accounts = await Promise.all(Array.from({ length: 3 }, () => db.account.create({ data: {} })));
        const [owner, requester, survivor] = accounts;
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner!.id,
            active: true, metadata: 'encrypted-metadata', installationId: randomUUID(),
            installationPublicKey: tweetnacl.sign.keyPair().publicKey,
            dataEncryptionKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: randomBytes(32),
                recipientPublicKey: tweetnacl.box.keyPair().publicKey, randomBytes }) } });
        for (const account of [requester!, survivor!]) await db.machineAccountGrant.create({ data: {
            machineId: machine.id, accountId: account.id, accessLevel: 'view', createdByAccountId: owner!.id,
        } });
        expect(await db.accessKey.count({ where: { machineId: machine.id } })).toBe(0);
        const children = accounts.map(() => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']));
        const tracked = new Map<number, TrackedSession>();
        try {
            await Promise.all(children.map(child => once(child, 'spawn')));
            for (const [index, child] of children.entries()) {
                if (!child.pid) throw new Error('Missing child PID');
                const identity = await readProcessIdentityByPid(child.pid);
                if (!identity?.processStartTimeMs) throw new Error('Missing process identity');
                tracked.set(child.pid, { pid: child.pid, childProcess: child, startedBy: 'daemon',
                    happySessionId: randomUUID(), processStartTimeMs: identity.processStartTimeMs,
                    requesterWorkAttributionV1: { serverId: 'home', accountId: accounts[index]!.id,
                        machineId: machine.id, installationId: machine.installationId! } });
            }
            let verificationRequests = 0;
            const rpc = new RpcHandlerManager({ scopePrefix: machine.id, encryptionMode: 'e2ee', encryptionVariant: 'dataKey',
                encryptionKey: randomBytes(32), logger: () => {},
                authorizeRequest: (request, source) => authorizeMachineRpcRequest(request, { machineId: machine.id,
                    resolveCustodianAccountId: async () => owner!.id, resolveInstallationId: () => machine.installationId,
                    // Substitute only the signed Home network call with its real admission owners.
                    verifyMachineAdmission: async input => {
                        verificationRequests++;
                        const admission = await resolveMachineAdmission({ actorAccountId: owner!.id, machineId: machine.id,
                            rpcMethod: RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS, requireOnline: true });
                        return admission.kind === 'admitted' && admission.installationId === input.context.installationId
                            && !!input.custodySubjectAccountId && await inTx(async tx =>
                                await resolveEffectiveMachineRoleInTx(tx, { actorAccountId: input.custodySubjectAccountId!, machineId: machine.id }) === null);
                    },
                }, source) });
            registerMachineAccessLossReceiver(rpc, { serverId: 'home', machineId: machine.id,
                resolveInstallationId: () => machine.installationId });
            let settle!: (result: unknown) => void;
            const settled = new Promise<unknown>(resolve => { settle = resolve; });
            const method = `${machine.id}:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`;
            const target = { id: 'installed-daemon', data: { clientType: 'machine-scoped', userId: owner!.id,
                machineId: machine.id, verifiedMachineInstallationId: machine.installationId }, timeout: () => ({
                    emitWithAck: async (_event: string, request: SocketRpcRequestPayload) => {
                        // This boundary is the authenticated Home socket, whose
                        // ApiMachine listener supplies this exact provenance.
                        const result = await rpc.handleRequest(request, undefined, 'authenticated_home_socket');
                        settle(result);
                        return result;
                    },
                }) };
            const io = createSocketRoomDiscoveryHarness(async room =>
                room === target.id || room === `rpc:${owner!.id}:${method}` ? [target] : []);
            eventRouter.setIo(io, { forwardRpc: request => forwardRpcCall({ io, ...request }) });
            expect(await inTx(tx => removeMachineAccessGrantInTx(tx, { actorAccountId: owner!.id,
                machineId: machine.id, principal: { kind: 'account', accountId: requester!.id } }))).toMatchObject({ kind: 'removed' });
            expect(await settled).toEqual({ kind: 'settled' });
            expect(verificationRequests).toBe(0);
            for (const index of [0, 1, 2]) {
                expect(children[index]!.exitCode).toBeNull();
                expect(children[index]!.signalCode).toBeNull();
                expect(tracked.has(children[index]!.pid!)).toBe(true);
            }
        } finally {
            eventRouter.clearIo();
            for (const child of children) if (child.exitCode === null && child.signalCode === null) {
                child.kill();
                await once(child, 'exit');
            }
        }
    });
});
