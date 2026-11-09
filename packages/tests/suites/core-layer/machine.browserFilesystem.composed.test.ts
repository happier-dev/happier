import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { bindExternalActionExecutionAuthorizationHttpPathV1, ExternalActionExecutionAuthorizationV1Schema,
    ExternalActionResponseEnvelopeV1Schema, EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
} from '@happier-dev/protocol/actions/externalActionApi';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { buildAccountStoredContentCompatibilitySocketAuthV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    type MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { AUTHORITY_CEILING_HEADER_V1 } from '@happier-dev/protocol/actions/invocationAuthority';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { callSocketRpc } from '@happier-dev/sync-client';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RPC_ERROR_CODES, readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { ApiMachineClient } from '../../../../apps/cli/src/api/apiMachine';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { RpcHandlerManager } from '../../../../apps/cli/src/api/rpc/RpcHandlerManager';
import { readOrCreateInstallationIdentity } from '../../../../apps/cli/src/daemon/identity/store';
import { withConfiguredDaemonTestHome } from '../../../../apps/cli/src/daemon/testkit/fakeDaemonLifecycle.testkit';
import { writeStoredCredentialsForServerId } from '../../../../apps/cli/src/persistence';
import { runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../apps/cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../../../../apps/cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { logger } from '../../../../apps/cli/src/ui/logger';
import { createDirectTransferServerLifecycle } from '../../../../apps/cli/src/machines/transfer/directTransferServerLifecycle';
import { prepareWorkspaceFileExport } from '../../../../apps/cli/src/machines/transfer/prepareWorkspaceFileExport';
import { fetchServerFeaturesSnapshot } from '../../../../apps/cli/src/features/serverFeaturesClient';
import { resolveQualifiedConnectedAccountAtomicV4Negotiation } from '../../../../apps/cli/src/api/client/qualifiedConnectedAccountApi';
import { createCliApprovalsArtifactStore } from '../../../../apps/cli/src/session/actions/approvals/artifactStore';

interface BrowserMachineHome {
    baseUrl: string; homeId: string; ownerAccountId: string; memberAccountId: string;
    ownerToken: string; installedToken: string; memberToken: string;
    readReceiverAdmission(): { connected: boolean; installationVerified: boolean; externalRegistered: boolean };
    readOwnerMintPrerequisites(): Promise<Readonly<{ credentialVerified: boolean; credentialKind?: string;
        credentialAuthority?: string; signedEpochCurrent: boolean; physicalMachineCurrent: boolean }>>;
    setProtectedSupport(supported: boolean): Promise<void>;
    close(): Promise<void>;
}

// Keep server compilation and its @/* aliases behind its owner-exported testkit.
const serverTestkitPath = '../../../../apps/server/sources/testkit/browserMachineActionServer.testkit';

it('preserves browser owner identity through Home HTTP Action forwarding and the installed filesystem effect', async () => {
    const serverId = 'browser-filesystem-home';
    await withConfiguredDaemonTestHome({ prefix: 'browser-machine-filesystem-',
        env: { HAPPIER_ACTIVE_SERVER_ID: serverId, HAPPIER_SERVER_URL: undefined } }, async ({ homeDir: directory }) => {
        const installation = await readOrCreateInstallationIdentity();
        const { startBrowserMachineActionServer } = await import(serverTestkitPath) as {
            startBrowserMachineActionServer(input: { machineId: string; installation: MachineInstallationIdentityV1; happyHomeDir: string }): Promise<BrowserMachineHome>;
        };
        const machineId = 'browser-filesystem-machine';
        const home = await startBrowserMachineActionServer({ machineId, installation, happyHomeDir: directory });
        let machine: ApiMachineClient | undefined;
        let daemon: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
        const browsers: ReturnType<typeof io>[] = [];
        const filesystemWarnings = vi.spyOn(logger, 'warnLocalFile');
        const transfers = createDirectTransferServerLifecycle({ bindPort: 0, listenerClasses: ['loopback_http'] });
        try {
            await runWithServerHttpBaseUrl(home.baseUrl, async () => {
                const homeFeatures = await fetchServerFeaturesSnapshot({ serverUrl: home.baseUrl, token: home.installedToken });
                expect(homeFeatures.status).toBe('ready');
                daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
                    activeServerDir: join(directory, 'servers', serverId), serverId, serverHttpBaseUrl: home.baseUrl,
                    machineId, custodianAccountId: home.ownerAccountId, credentials: { token: home.installedToken, encryption: null },
                    connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
                    trackedSessions: new Map(), getRequester: () => null,
                    resolveQualifiedConnectedAccountV4Support: () => resolveQualifiedConnectedAccountAtomicV4Negotiation(homeFeatures),
                    getApiMachineForSessions: () => machine ?? null,
                    beforeStartup: () => writeStoredCredentialsForServerId(serverId, { token: home.installedToken, encryption: null }),
                    startup: { resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: home.homeId, machineId }) },
                });
                expect(daemon.installation?.installationId === installation.installationId).toBe(true);
                expect(daemon.installation?.publicKey === installation.publicKey).toBe(true);
                const api = await ApiClient.create({ token: home.installedToken, encryption: null });
                const snapshot = await api.getMachine(machineId);
                if (!snapshot) throw new Error('Missing real Home Machine content projection');
                machine = api.machineSyncClient(snapshot, { runtimeId: randomUUID(), startupSource: 'manual', serviceManaged: false },
                    { resolveCurrentServerIdentityId: () => home.homeId, directPeerServerLifecycle: transfers });
                const owner = daemon.runtime.externalActionIngressOwner;
                if (!owner) throw new Error('Missing actual daemon external Action owner');
                expect(owner.externalActionMachineRequestPrivateKey !== undefined).toBe(true);
                machine.setRPCHandlers({ spawnSession: async () => { throw new Error('Unexpected Session spawn'); },
                    stopSession: async () => true, requestShutdown() { throw new Error('Unexpected daemon shutdown'); },
                    directTransferExport: { prepareExportSession: async (request, filesystemScope) => {
                        if (request.t !== 'workspace_file_download_v1' || !filesystemScope) throw new Error('Missing actual prepared filesystem custody');
                        return prepareWorkspaceFileExport({ lifecycle: transfers, request, filesystemScope, accessPolicy: { kind: 'osUser' } });
                    } } },
                    { externalActionIngressOwner: owner });
                const installed = machine;
                await new Promise<void>((resolve, reject) => installed.connect({ onConnect: resolve,
                    onOwnershipConflict: () => reject(new Error('Fixture Machine ownership conflict')) }));
                const manager: unknown = Reflect.get(installed, 'rpcHandlerManager');
                if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing installed Machine RPC receiver');
                expect(manager.hasHandler(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)).toBe(true);
                // ApiMachine owns a 10s initial registration phase followed by
                // its 10s replay phase; the harness must let that lifecycle run.
                const readiness = await manager.waitForRegisteredHandlers([EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, RPC_METHODS.LIST_DIRECTORY], { timeoutMs: 20_000 });
                expect(readiness, JSON.stringify(home.readReceiverAdmission())).toEqual({ status: 'ready' });
                const browser = async (token: string, authority?: 'account_automation') => {
                    const socket = io(home.baseUrl, { path: '/v1/updates', transports: ['websocket'], autoConnect: false,
                        reconnection: false, auth: { token, ...(authority ? { authorityCeiling: authority } : {}),
                            ...buildAccountStoredContentCompatibilitySocketAuthV1(
                            CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) } });
                    browsers.push(socket);
                    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); socket.connect(); });
                    return socket;
                };
                const ownerBrowser = await browser(home.ownerToken);
                const memberBrowser = await browser(home.memberToken);
                const automationBrowser = await browser(home.installedToken, 'account_automation');
                const path = join(directory, 'ordinary.txt');
                await writeFile(path, 'owner-browser-file');
                const raw = (socket: ReturnType<typeof io>, method: string, params: unknown) => callSocketRpc({ socket,
                    target: { kind: 'machine', id: machineId }, method, params, content: { mode: 'plain' }, timeoutMs: 10_000 });
                // Browser metadata uses ordinary raw Socket RPC, with no requester stamp.
                expect(await raw(ownerBrowser, RPC_METHODS.LIST_DIRECTORY, { rootPath: directory, path: '.' }))
                    .toMatchObject({ success: true, entries: expect.arrayContaining([expect.objectContaining({ name: 'ordinary.txt', type: 'file' })]) });
                const action = async (token: string, actionId: string, input: unknown,
                    authority: 'present_user' | 'account_automation' = 'present_user'):
                    Promise<ReturnType<typeof ExternalActionResponseEnvelopeV1Schema.parse>['execution']> => {
                    const envelope = { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId }, input };
                    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
                        ...(authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: authority } : {}) };
                    // Exact UI sequence: mint current Home authority, seal the requester
                    // invocation to the installation, submit through HTTP. No admission
                    // receipt, requester identity, or currentness callback is injected.
                    const mint = await fetch(`${home.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1(actionId)}`,
                        { method: 'POST', headers, body: JSON.stringify({ v: 1, machineId, envelope }) });
                    const minted: unknown = await mint.json();
                    if (mint.status !== 200 && actionId === 'approval.request.decide') {
                        const control = await action(home.ownerToken, 'daemon.filesystem.readFile', { rootPath: directory, path });
                        console.info(JSON.stringify({ gate: 'approval-decision-mint', status: mint.status,
                            ownerRead: control.ok ? 'ok' : control.errorCode, prerequisites: await home.readOwnerMintPrerequisites() }));
                    }
                    const safeMint = minted && typeof minted === 'object' ? Object.fromEntries(['code', 'errorCode']
                        .flatMap(key => typeof Reflect.get(minted, key) === 'string' ? [[key, Reflect.get(minted, key)]] : [])) : {};
                    expect(mint.status, JSON.stringify(safeMint)).toBe(200);
                    const parsedAuthorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(minted);
                    expect(parsedAuthorization.success).toBe(true);
                    if (!parsedAuthorization.success) throw new Error('invalid_execution_authorization_response');
                    const authorization = parsedAuthorization.data;
                    const executionAuthorization = 'authentication' in authorization.binding ? sealExternalActionRequesterAccountContextV1({ authorization,
                        credentials: { token, encryption: null }, purpose: { kind: 'external_action' },
                        installationPublicKey: Buffer.from(installation.publicKey, 'base64url'), randomBytes,
                        invocation: { caller: { kind: 'host' }, surface: 'ui', authority } }) : authorization;
                    const response = await fetch(`${home.baseUrl}/v1/actions/${actionId}`, { method: 'POST', headers,
                        body: JSON.stringify({ v: 1, machineId, envelope, executionAuthorization }) });
                    const result: unknown = await response.json();
                    const safeResponse = result && typeof result === 'object' ? Object.fromEntries(['code', 'errorCode']
                        .flatMap(key => typeof Reflect.get(result, key) === 'string' ? [[key, Reflect.get(result, key)]] : [])) : {};
                    expect(response.status, JSON.stringify(safeResponse)).toBe(200);
                    const execution = ExternalActionResponseEnvelopeV1Schema.parse(result).execution;
                    if (!execution.ok) console.info(JSON.stringify({ gate: 'browser-machine-action', actionId,
                        authority, ok: false, errorCode: execution.errorCode }));
                    return execution;
                };
                const read = await action(home.ownerToken, 'daemon.filesystem.readFile', { rootPath: directory, path });
                const safeFailure = (value: unknown) => {
                    if (!value || typeof value !== 'object') return {};
                    return Object.fromEntries(['errorCode', 'code', 'phase', 'reason', 'failedPhase', 'causeCode'].flatMap(key => {
                        const field: unknown = Reflect.get(value, key);
                        return typeof field === 'string' ? [[key, field]] : [];
                    }));
                };
                expect(read, JSON.stringify({ execution: safeFailure(read),
                    filesystem: filesystemWarnings.mock.calls.filter(([message]) => message === '[Filesystem] Effect admission refused')
                        .map(([, details]) => safeFailure(details)) })).toMatchObject({ ok: true, result: { success: true,
                    content: Buffer.from('owner-browser-file').toString('base64') } });
                await expect(action(home.ownerToken, 'daemon.filesystem.writeFile', { rootPath: directory, path,
                    content: Buffer.from('owner-browser-edit').toString('base64') })).resolves.toMatchObject({ ok: true, result: { success: true } });
                expect(await readFile(path, 'utf8')).toBe('owner-browser-edit');
                await expect(action(home.ownerToken, 'daemon.filesystem.listDirectory', { rootPath: directory, path: '.' }))
                    .resolves.toMatchObject({ ok: true, result: { success: true,
                        entries: expect.arrayContaining([expect.objectContaining({ name: 'ordinary.txt', type: 'file' })]) } });
                await expect(action(home.installedToken, 'daemon.filesystem.readFile', { rootPath: directory, path }, 'account_automation'))
                    .resolves.toMatchObject({ ok: true, result: { success: true, content: Buffer.from('owner-browser-edit').toString('base64') } });
                await expect(raw(automationBrowser, RPC_METHODS.READ_FILE, { rootPath: directory, path }))
                    .resolves.toMatchObject({ success: true, content: Buffer.from('owner-browser-edit').toString('base64') });
                const mutation = { path, content: Buffer.from('owner-raw-edit').toString('base64') };
                const automationWrite = await raw(automationBrowser, RPC_METHODS.WRITE_FILE, mutation)
                    .catch(error => ({ ok: false, errorCode: readRpcErrorCode(error) }));
                expect(automationWrite).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect(await readFile(path, 'utf8')).toBe('owner-browser-edit');
                await expect(raw(ownerBrowser, RPC_METHODS.WRITE_FILE, mutation)).resolves.toMatchObject({ success: true });
                expect(await readFile(path, 'utf8')).toBe('owner-raw-edit');
                await expect.soft(raw(ownerBrowser, RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, { rootPath: directory, query: 'owner-raw-edit' }))
                    .resolves.toMatchObject({ ok: true, files: expect.arrayContaining([expect.objectContaining({ path: 'ordinary.txt' })]) });
                const exportRequest = { t: 'workspace_file_download_v1', workingDirectory: directory, path, asZip: false };
                await expect.soft(raw(ownerBrowser, RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, exportRequest))
                    .resolves.toMatchObject({ success: true, name: 'ordinary.txt', sizeBytes: Buffer.byteLength('owner-raw-edit') });
                expect.soft(transfers.getState().publishedTransferCount).toBe(1);
                const capabilityRoot = join(directory, 'owner-capability');
                await expect.soft(raw(ownerBrowser, RPC_METHODS.CAPABILITIES_INVOKE, { id: 'tool.plugins', method: 'create', params: {
                    targetDir: capabilityRoot, pluginId: 'review.fixture', displayName: 'Browser capability fixture' } }))
                    .resolves.toMatchObject({ ok: true });
                const scaffold = await readFile(join(capabilityRoot, 'package.json'), 'utf8').then(value => JSON.parse(value), () => null);
                expect.soft(scaffold).toMatchObject({ name: 'happier-plugin-review-fixture' });
                await expect.soft(raw(ownerBrowser, RPC_METHODS.DAEMON_TERMINAL_LIST, {})).resolves.toMatchObject({ ok: true, terminals: [] });

                // Connect withdraws retained protection; publish this test's
                // supported leaf only after the real receiver is registered.
                await home.setProtectedSupport(true);
                await expect(action(home.memberToken, 'action.spec.get', { id: 'daemon.filesystem.readFile' }))
                    .resolves.toMatchObject({ ok: true, result: { actionSpec: { id: 'daemon.filesystem.readFile' } } });
                await expect(action(home.memberToken, 'daemon.filesystem.readFile', { rootPath: directory, path }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
                await expect(action(home.memberToken, 'daemon.filesystem.writeFile', { rootPath: directory, path,
                    content: Buffer.from('forbidden-member-edit').toString('base64') }))
                    .resolves.toMatchObject({ ok: false, errorCode: 'filesystem_identity_custody_unavailable' });
                for (const [method, params] of [
                    [RPC_METHODS.READ_FILE, { rootPath: directory, path }],
                    [RPC_METHODS.LIST_DIRECTORY, { rootPath: directory, path: '.' }],
                    [RPC_METHODS.DAEMON_WORKSPACE_FILES_SEARCH, { rootPath: directory, query: 'owner-raw-edit' }],
                    [RPC_METHODS.DAEMON_DIRECT_TRANSFER_EXPORT_PREPARE, exportRequest],
                ] as const) {
                    const denied = await raw(memberBrowser, method, params).catch(error => ({ errorCode: readRpcErrorCode(error) }));
                    expect.soft(denied).not.toMatchObject({ success: true });
                    expect.soft(denied).not.toMatchObject({ ok: true });
                    expect.soft(denied).not.toHaveProperty('content');
                    expect.soft(denied).not.toHaveProperty('files');
                    expect.soft(denied).not.toHaveProperty('entries');
                }
                expect.soft(transfers.getState().publishedTransferCount).toBe(1);
                const memberTerminals = await raw(memberBrowser, RPC_METHODS.DAEMON_TERMINAL_LIST, {});
                expect.soft(memberTerminals).toMatchObject({ errorCode: 'agent_isolation_unavailable' });
                expect.soft(memberTerminals).not.toHaveProperty('terminals');
                const memberCapabilityRoot = join(directory, 'member-capability');
                const capabilityRefusal = await raw(memberBrowser, RPC_METHODS.CAPABILITIES_INVOKE, { id: 'tool.plugins', method: 'create', params: {
                    targetDir: memberCapabilityRoot, pluginId: 'review.member', displayName: 'Refused member fixture' } })
                    .catch(error => ({ errorCode: readRpcErrorCode(error) }));
                expect.soft(capabilityRefusal).not.toMatchObject({ ok: true });
                expect.soft(await stat(memberCapabilityRoot).then(() => true, () => false)).toBe(false);
                const forged = await memberBrowser.emitWithAck(SOCKET_RPC_EVENTS.CALL, { method: `${machineId}:${RPC_METHODS.READ_FILE}`,
                    params: { rootPath: directory, path }, machineAdmission: { actorAccountId: home.ownerAccountId,
                        custodianAccountId: home.ownerAccountId, machineId, installationId: installation.installationId,
                        role: 'manage', encryptionMode: 'plain' } });
                expect(forged).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
                expect(await readFile(path, 'utf8')).toBe('owner-raw-edit');

                await home.setProtectedSupport(false);
                await expect(action(home.ownerToken, 'daemon.filesystem.readFile', { rootPath: directory, path }))
                    .resolves.toMatchObject({ ok: true, result: { success: true } });
                await expect(action(home.memberToken, 'action.spec.get', { id: 'daemon.filesystem.readFile' }))
                    .resolves.toMatchObject({ ok: true, result: { actionSpec: { id: 'daemon.filesystem.readFile' } } });
                const legacyMember = await fetch(`${home.baseUrl}${bindExternalActionExecutionAuthorizationHttpPathV1('daemon.filesystem.readFile')}`,
                    { method: 'POST', headers: { Authorization: `Bearer ${home.memberToken}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ v: 1, machineId, envelope: { v: 1, requestId: randomUUID(), target: { kind: 'machine', machineId },
                            input: { rootPath: directory, path } } }) });
                expect(legacyMember.status).toBe(409);
                expect(await legacyMember.json()).toMatchObject({ error: 'invalid_request', code: 'target_unavailable' });
                expect(await readFile(path, 'utf8')).toBe('owner-raw-edit');

                const approvedPath = join(directory, 'approved-automation.txt');
                await writeFile(approvedPath, 'before-approval');
                const asked = await action(home.installedToken, 'daemon.filesystem.writeFile', {
                    rootPath: directory, path: approvedPath, content: Buffer.from('approved-automation-effect').toString('base64'),
                }, 'account_automation');
                expect(asked, JSON.stringify(safeFailure(asked))).toMatchObject({ ok: true });
                if (!asked.ok) throw new Error('automation_write_approval_not_created');
                const approval = ActionApprovalRequestCreatedResultSchema.parse(asked.result);
                expect(approval.actionId).toBe('daemon.filesystem.writeFile');
                expect(await readFile(approvedPath, 'utf8')).toBe('before-approval');
                const approvalStore = createCliApprovalsArtifactStore({ credentials: { token: home.ownerToken, encryption: null },
                    serverId, serverHttpBaseUrl: home.baseUrl });
                const original = await approvalStore.approvalsGet({ artifactId: approval.artifactId });
                expect({ status: original?.status, actionId: original && 'actionId' in original ? original.actionId : undefined })
                    .toEqual({ status: 'open', actionId: 'daemon.filesystem.writeFile' });
                const decision = await action(home.ownerToken, 'approval.request.decide', {
                    artifactId: approval.artifactId, decision: 'approve', serverIdentityId: home.homeId,
                });
                expect(decision, JSON.stringify(safeFailure(decision))).toMatchObject({ ok: true });
                const settled = await approvalStore.approvalsGet({ artifactId: approval.artifactId });
                const execution = settled && 'execution' in settled ? settled.execution : undefined;
                expect(settled?.status, JSON.stringify({ originalStatus: original?.status, currentStatus: settled?.status,
                    execution: safeFailure(execution) })).toBe('executed');
                expect(await readFile(approvedPath, 'utf8')).toBe('approved-automation-effect');

                // Home permits different-effect umbrella resolution for PAT
                // roots only. An Account/terminal root must not borrow approval
                // to expand its effect family, even for the physical custodian.
                const umbrellaPath = join(directory, 'approved-umbrella.txt');
                await writeFile(umbrellaPath, 'before-umbrella');
                const umbrella = await action(home.installedToken, 'approval.request.create', {
                    actionId: 'daemon.filesystem.writeFile', summary: 'Request a filesystem write', createdBy: { surface: 'system' },
                    actionArgs: { rootPath: directory, path: umbrellaPath,
                        content: Buffer.from('approved-umbrella-effect').toString('base64') },
                }, 'account_automation');
                expect(umbrella, JSON.stringify(safeFailure(umbrella))).toMatchObject({ ok: true });
                if (!umbrella.ok || !umbrella.result || typeof umbrella.result !== 'object'
                    || !('artifactId' in umbrella.result) || typeof umbrella.result.artifactId !== 'string') {
                    throw new Error('umbrella_approval_not_created');
                }
                const umbrellaId = umbrella.result.artifactId;
                expect(await readFile(umbrellaPath, 'utf8')).toBe('before-umbrella');
                const patPath = join(directory, 'approved-pat-umbrella.txt');
                await writeFile(patPath, 'before-pat-approval');
                // The Home helper initialized this existing canonical issuer;
                // no test token producer or private admission is substituted.
                // This genuine cross-app module boundary follows the Home
                // helper's nonliteral import, keeping Server's @ alias local.
                const serverAuthPath = '../../../../apps/server/sources/app/auth/auth';
                const { auth }: { auth: {
                    verifyTokenForRoute(token: string): Promise<unknown>;
                    createApiToken(input: Readonly<{ accountId: string; tokenId: string; label: string }>): Promise<Readonly<{ token: string }>>;
                } } = await import(serverAuthPath);
                expect(await auth.verifyTokenForRoute(home.ownerToken) !== null).toBe(true);
                const { token: ownerPatToken } = await auth.createApiToken({ accountId: home.ownerAccountId,
                    tokenId: randomUUID(), label: 'Browser approval fixture' });
                const patProposal = await action(ownerPatToken, 'approval.request.create', {
                    actionId: 'daemon.filesystem.writeFile', summary: 'Request a PAT filesystem write', createdBy: { surface: 'system' },
                    actionArgs: { rootPath: directory, path: patPath, content: Buffer.from('approved-pat-effect').toString('base64') },
                }, 'account_automation');
                expect(patProposal.ok, JSON.stringify(safeFailure(patProposal))).toBe(true);
                const patArtifactId = patProposal.ok && patProposal.result && typeof patProposal.result === 'object'
                    && 'artifactId' in patProposal.result && typeof patProposal.result.artifactId === 'string'
                    ? patProposal.result.artifactId : null;
                expect(patArtifactId !== null).toBe(true);
                if (!patArtifactId) throw new Error('pat_approval_artifact_unavailable');
                expect(await readFile(patPath, 'utf8')).toBe('before-pat-approval');
                const patDecision = await action(home.ownerToken, 'approval.request.decide', {
                    artifactId: patArtifactId, decision: 'approve', serverIdentityId: home.homeId,
                });
                expect(patDecision.ok, JSON.stringify(safeFailure(patDecision))).toBe(true);
                const patSettled = await approvalStore.approvalsGet({ artifactId: patArtifactId });
                const patExecution = patSettled && 'execution' in patSettled ? patSettled.execution : undefined;
                expect(patSettled?.status, JSON.stringify({ currentStatus: patSettled?.status,
                    execution: safeFailure(patExecution) })).toBe('executed');
                expect(await readFile(patPath, 'utf8')).toBe('approved-pat-effect');
                const umbrellaDecision = await action(home.ownerToken, 'approval.request.decide', {
                    artifactId: umbrellaId, decision: 'approve', serverIdentityId: home.homeId,
                });
                expect(umbrellaDecision, JSON.stringify(safeFailure(umbrellaDecision))).toMatchObject({ ok: true });
                const umbrellaSettled = await approvalStore.approvalsGet({ artifactId: umbrellaId });
                const umbrellaExecution = umbrellaSettled && 'execution' in umbrellaSettled ? umbrellaSettled.execution : undefined;
                expect(umbrellaSettled?.status, JSON.stringify({ currentStatus: umbrellaSettled?.status,
                    execution: safeFailure(umbrellaExecution) })).toBe('failed');
                expect(safeFailure(umbrellaExecution)).toMatchObject({ errorCode: 'approval_stale' });
                expect(await readFile(umbrellaPath, 'utf8')).toBe('before-umbrella');
            });
        } finally {
            filesystemWarnings.mockRestore();
            for (const socket of browsers) socket.disconnect();
            await transfers.stop();
            await machine?.shutdown();
            await daemon?.dispose();
            await home.close();
        }
    });
});
