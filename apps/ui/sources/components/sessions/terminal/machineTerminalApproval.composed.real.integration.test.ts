import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { createActionExecutor} from '@happier-dev/protocol/actions/actionExecutor';
import { getActionSpec} from '@happier-dev/protocol/actions/actionSpecs';
import { type ApprovalRequest,
    ApprovalRequestSchema} from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { DaemonTerminalEnsureResponseSchema, DaemonTerminalListResponseV1Schema, DaemonTerminalCloseResponseSchema } from '@happier-dev/protocol/daemon/terminal';
import { OpenProjectResultV1Schema } from '@happier-dev/protocol/projects/openProjectV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { setServerProfileIdentityForUrl } from '@/sync/domains/server/serverProfiles';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { isApprovalExecutionOriginCurrentForAccountContext } from '@/sync/ops/actions/defaultActionExecutor';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { createActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';
import { inspectMachineTerminalMemberApproval } from './machineTerminalApproval';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { resolveSessionTerminalIdentity } from './sessionTerminalMode';
import { createLightSqliteHarness, type LightSqliteHarness } from '../../../../../server/sources/testkit/lightSqliteHarness';
import { createAuthenticatedTestApp } from '../../../../../server/sources/app/api/testkit/sqliteFastify';
import { db } from '../../../../../server/sources/storage/db';
import { artifactsRoutes } from '../../../../../server/sources/app/api/routes/artifacts/artifactsRoutes';
import { createCliActionDeps } from '../../../../../cli/src/session/actions/createCliActionDeps';
import { RpcHandlerManager } from '../../../../../cli/src/api/rpc/RpcHandlerManager';
import { registerMachineTerminalRpcHandlers } from '../../../../../cli/src/api/machine/rpcHandlers.terminal';
import { createTerminalPtySessionManager } from '../../../../../cli/src/terminal/pty/sessions';
import { readDaemonTerminalPtyConfig } from '../../../../../cli/src/terminal/pty/config';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '../../../../../cli/src/terminal/pty/provider';
import * as ptyOsBoundary from '../../../../../cli/src/terminal/pty/provider';
import * as processTreeOsBoundary from '../../../../../cli/src/processes/terminate/terminateProcessTree';
import * as processGroupOsBoundary from '@happier-dev/cli-common/process';
import { join } from 'node:path';
import Fastify from 'fastify';
import type { Fastify as AppFastify } from '../../../../../server/sources/app/api/types';
import { decodeBase64} from '@happier-dev/protocol/crypto/base64';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { ApiClient } from '../../../../../cli/src/api/api';
import { writeStoredCredentialsForServerId, readStoredCredentialsForServerId } from '../../../../../cli/src/persistence';
import { createMachineContentCodec } from '../../../../../cli/src/api/machine/machineStoredContent';
import { createCliActionExecutorFromCredentials } from '../../../../../cli/src/session/actions/createCliActionExecutorFromCredentials';
import { addServerProfile, refreshServerProfileHomeConnectionDescriptor } from '../../../../../cli/src/server/serverProfiles';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeMachineOwnerEnvelopeFingerprintV1 } from '@happier-dev/protocol/machines/machineOwnerEnvelopeFingerprintV1';
import { createSessionOwnerMetadataV1, projectSessionSharedMetadataV1,
    sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createWorkspaceState } from '@/components/appShell/workspace/workspaceState';
import { WorkspaceProvider } from '@/components/appShell/workspace/WorkspaceProvider';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { DestinationInstanceHost } from '@/components/appShell/workspace/DestinationInstanceHost';
import type { WorkspaceNavigationContextValue } from '@/components/appShell/workspace/WorkspaceNavigationContext';
import { resolveCompactAppDestinations } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { createUiProjectAccountRowsClient } from '@/sync/api/projects/projectAccountRowsClient';
import { getStorage } from '@/sync/domains/state/storage';
import { buildProjectPaneScopeId } from '@/components/projects/detail/projectPaneScope';
import { buildProjectTerminalKey } from '@/components/projects/detail/projectTerminalScope';
import { EMPTY_TERMINAL_WORKSPACE } from './sessionTerminalWorkspace';
import { dispatchSessionTerminalWorkspaceCommand } from './sessionTerminalWorkspaceRuntime';
import type { ApiMachineClient, ApiMachineClientLifecycleDependencies } from '../../../../../cli/src/api/apiMachine';
import { runWithServerHttpBaseUrl } from '../../../../../cli/src/api/client/serverHttpBaseUrl';
import { createRequesterSessionControlRuntimeFixture } from '../../../../../cli/src/daemon/testkit/requesterSessionControlRuntimeFixture';
import { createCurrentMachineExecutionOriginContextResolver } from '../../../../../cli/src/api/machine/resolveCurrentMachineExecutionOriginContext';
import { ConnectedServiceRuntimeRegistry } from '../../../../../cli/src/daemon/connectedServices/runtimeRegistry/registry';
import { enableSchemaValidation } from '../../../../../server/sources/app/api/utils/enableSchemaValidation';
import { enableErrorHandlers } from '../../../../../server/sources/app/api/utils/enableErrorHandlers';
import { enableAuthentication } from '../../../../../server/sources/app/api/utils/enableAuthentication';
import { enableMonitoring } from '../../../../../server/sources/app/api/utils/enableMonitoring';
import { enableOptionalStatics } from '../../../../../server/sources/app/api/utils/enableOptionalStatics';
import { registerAuthPingRoute } from '../../../../../server/sources/app/api/routes/auth/registerAuthPingRoute';
import { registerAccountApiTokenManagementRoutes } from '../../../../../server/sources/app/api/routes/auth/registerAccountApiTokenManagementRoutes';
import { auth } from '../../../../../server/sources/app/auth/auth';
import { initializeServerIdentityCache } from '../../../../../server/sources/app/serverIdentity/serverIdentity';
import { accountRoutes } from '../../../../../server/sources/app/api/routes/account/accountRoutes';
import { sessionRoutes } from '../../../../../server/sources/app/api/routes/session/sessionRoutes';
import { machinesRoutes } from '../../../../../server/sources/app/api/routes/machines/machinesRoutes';
import { featuresRoutes } from '../../../../../server/sources/app/api/routes/features/featuresRoutes';
import { createFileHomeConnectionDescriptorContinuityStore } from '../../../../../server/sources/app/features/homeConnectionDescriptorContinuity';
import { registerExternalActionRoutes } from '../../../../../server/sources/app/api/routes/actions/registerExternalActionRoutes';
import { startSocket } from '../../../../../server/sources/app/api/socket';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { removeServerProfile } from '@/sync/domains/server/serverProfiles';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import * as React from 'react';
import { act, renderHook } from '@/dev/testkit/hooks/renderHook';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { initializeSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';
import { readSessionTerminalWorkspace } from './sessionTerminalWorkspace';
import { useMachineTerminalActionAdmission } from '@/hooks/machine/useMachineTerminalActionAdmission';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { publishAppliedActiveServerSnapshot } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import nacl from 'tweetnacl';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { createSignedAccountContentBinding } from '../../../../../server/sources/testkit/accountEncryption';
import { readSessionTerminalWorkspaceForScope } from './sessionTerminalWorkspaceRuntime';
import { createProjectNativeIo } from '../../../../../cli/src/workspaces/projectSetup/projectNativeIo';
import { createProjectWorkerAdmission } from '../../../../../cli/src/workspaces/execution/projectWorkerAdmission';
import { createDaemonAdmissionDrain } from '../../../../../cli/src/daemon/lifecycle/admissionDrain';
import { machineTerminalList } from '@/sync/ops/machineTerminal';
import { ProjectAccountRowListResponseV1Schema } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { buildMachineTerminalSessionRequest } from '@/hooks/machine/machineTerminalSessionRequest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { dispatchOriginalAccountAction } from '../../../../../cli/src/api/externalActionExecutionAuthorization';
import { router as expoRouter } from 'expo-router';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { createMachineRpcTerminalStreamCarrier } from '@/sync/domains/terminal/stream/carrier';
import { parseWorkspaceLayout, serializeWorkspaceLayout, workspaceLayoutScopeKey } from '@/components/appShell/workspace/workspacePersistence';
import { useRegisterSessionPaneDriver } from '@/components/sessions/panes/useRegisterSessionPaneDriver';
import { useSessionEmbeddedTerminalPaneModel } from './useSessionEmbeddedTerminalPaneModel';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { MetadataSchema } from '@happier-dev/session-core/state';

const navigationBoundary = vi.hoisted(() => ({ pathname: '/', params: {} as Record<string, string> }));
// Expo/native URL transport is the external boundary; pane ownership,
// persistence, destination routing and terminal admission remain real.
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const navigate = (href: unknown) => {
        const url = new URL(String(href), 'http://r56-navigation.test');
        navigationBoundary.pathname = url.pathname;
        navigationBoundary.params = Object.fromEntries(url.searchParams);
    };
    return createExpoRouterMock({ pathname: () => navigationBoundary.pathname,
        params: () => navigationBoundary.params, router: { push: navigate, replace: navigate } }).module;
});

// Only the OS PTY process is replaced. The installed local RPC manager,
// registered terminal handlers, PTY manager, Action family and Artifact receipt stay real.

describe('Machine terminal approval receipt across Home aliases (real SQLite)', () => {
    let database: LightSqliteHarness;
    beforeAll(async () => {
        database = await createLightSqliteHarness({ tempDirPrefix: 'happier-r35-terminal-approval-', initAuth: true, initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
    }, 180_000);
    afterAll(async () => { if (database) await database.close(); });

    it.each(['browser-profile', 'portable-home', 'foreign-home', 'foreign-target'] as const)(
        'continues %s only for the original member and verified Home', async targetKind => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const machineId = crypto.randomUUID();
        const app = createAuthenticatedTestApp();
        artifactsRoutes(app);
        await app.ready();
        const portableHome = `srv_r35_terminal_${owner.id}`;
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: `https://${owner.id}.r35-terminal-approval.test`, accountId: owner.id,
            currentAccount: true }],
            route: async request => {
                const response = await app.inject({ method: request.method, url: request.url.pathname + request.url.search,
                    headers: { 'x-test-user-id': request.accountId ?? '', 'x-happier-account-stored-content-protocol': '4' },
                    ...(request.body === undefined ? {} : { payload: request.body }) });
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        const home = homes.homes.home!;
        await setServerProfileIdentityForUrl(home.serverUrl, portableHome);
        const account = await captureLazyActionAccountContext(home.id);
        const creatorProfile = 'daemon-local-terminal-profile';
        const actionId = 'machines.terminal.open' as const;
        const member = { id: 'embedded', target: { kind: 'workspace_shell' as const } };
        const identity = resolveSessionTerminalIdentity({ sessionId: 'own-session',
            scopeId: createSessionPaneScopeId('own-session', home.id, 'original-pane'), terminal: member });
        const request = { terminalKey: identity.terminalKey, cwd: database.baseDir, sessionId: 'own-session' };
        const input = getActionSpec(actionId).inputSchema.parse({ ...request, machineId,
            serverId: targetKind === 'foreign-target' ? 'srv_foreign_terminal_home' : creatorProfile });
        // No reusable OS PTY fixture exists in the CLI testkit. Both the PTY
        // and process-tree adapters below are OS boundaries; no real PID is signaled.
        const processes = new Map<number, PtyProcess>();
        const spawn = vi.fn<PtyProvider['spawn']>(() => {
            const outputListeners = new Set<(data: Buffer | string) => void>();
            const exitListeners = new Set<(event: PtyExitEvent) => void>();
            const pid = 4321 + processes.size;
            const process = {
                pid, ownedProcessGroupId: pid,
                write: data => { for (const listener of outputListeners) listener(Buffer.from(data)); },
                resize: () => {},
                kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
                onData: () => ({ dispose: () => {} }),
                onDataBytes: listener => {
                    outputListeners.add(listener);
                    return { dispose: () => { outputListeners.delete(listener); } };
                },
                onExit: listener => {
                    exitListeners.add(listener);
                    return { dispose: () => { exitListeners.delete(listener); } };
                },
            } satisfies PtyProcess;
            processes.set(pid, process);
            return process;
        });
        const env = { NODE_ENV: 'test' as const, HAPPIER_DAEMON_TERMINAL_ENABLED: '1', SHELL: '/bin/sh' };
        const terminals = createTerminalPtySessionManager({ ptyProvider: { spawn }, env, platform: 'linux',
            config: readDaemonTerminalPtyConfig(env).sessionManager,
            probeProcessGroup: () => 'absent',
            stopProcessTree: async root => {
                const process = processes.get(root.pid);
                if (!process) throw new Error('Unexpected OS process-tree target');
                process.kill();
            },
        });
        const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain' });
        // This focused producer contract uses the incumbent restricted Session
        // receiver; original shared-Account socket admission is a separate composed gate.
        const registration = registerMachineTerminalRpcHandlers({ rpcHandlerManager: rpc, deps: {
            serverId: creatorProfile, env, platform: 'linux', workingDirectory: database.baseDir,
            requiredSessionId: 'own-session', sessionManager: terminals,
        } });
        const cliDeps = createCliActionDeps({ token: account.credentials.token, sessionId: 'own-session', serverId: creatorProfile,
            mode: 'plain', ctx: null, machineActionDirectTargetTransport: {
                machineId, invoke: (method: string, payload: unknown, options?: Parameters<RpcHandlerManager['invokeLocal']>[2]) => rpc.invokeLocal(method, payload, options),
            } });
        const policy = ActionsSettingsV1Schema.parse({ v: 1 });
        const producer = createActionExecutor({
            ...cliDeps,
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, policy, context),
            approvalsCreate: async ({ request: approval }) => ({ artifactId: await account.createArtifact(
                buildApprovalRequestArtifactHeaderV1(approval), JSON.stringify(ApprovalRequestSchema.parse(approval))) }),
            approvalsGet: async ({ artifactId }) => {
                const artifact = await account.fetchArtifact(artifactId);
                return typeof artifact?.body === 'string' ? ApprovalRequestSchema.parse(JSON.parse(artifact.body)) : null;
            },
            approvalsUpdate: async ({ artifactId, request: approval }) => {
                await account.updateArtifact(artifactId, buildApprovalRequestArtifactHeaderV1(approval), JSON.stringify(approval));
                return { ok: true };
            },
            isApprovalExecutionOriginCurrent: async ({ origin }) => {
                account.assertCurrent();
                return isApprovalExecutionOriginCurrentForAccountContext({ origin, accountServerId: account.serverId, accountId: account.accountId });
            },
        });
        try {
            const proposed = await producer.execute(actionId, input, { surface: 'cli', authority: 'account_automation',
                serverId: creatorProfile, serverIdentityId: targetKind === 'foreign-home' ? 'srv_foreign_terminal_home' : portableHome,
                runtimeAccountId: owner.id, defaultSessionMachineId: machineId,
                actionRequestId: 'terminal-original-request', actionCaller: { kind: 'host' } });
            expect(proposed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
            if (!proposed.ok || !proposed.result || typeof proposed.result !== 'object' || !('artifactId' in proposed.result)
                || typeof proposed.result.artifactId !== 'string') throw new Error('Approval was not created');
            const pending = { artifactId: proposed.result.artifactId, actionId, scope: {
                serverId: targetKind === 'portable-home' ? portableHome : home.id, accountId: owner.id } };
            const original = await account.fetchArtifact(pending.artifactId);
            if (!original) throw new Error('Missing original Artifact');
            const inspected = inspectMachineTerminalMemberApproval({ artifact: original, pending, machineId, request });
            if (targetKind === 'foreign-home' || targetKind === 'foreign-target') {
                expect(inspected).toBeNull();
                const refused = await producer.execute('approval.request.decide',
                    { artifactId: pending.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: creatorProfile });
                expect(refused).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false,
                    errorCode: targetKind === 'foreign-home' ? 'approval_stale' : 'server_target_mismatch' } } });
                expect(spawn).not.toHaveBeenCalled();
                return;
            }
            expect(inspected, 'The original terminal member must admit its daemon-produced same-Home receipt').not.toBeNull();
            if (!inspected) throw new Error('Original terminal binding was refused');
            const settled: unknown[] = [];
            const continuation = createActionApprovalContinuation({ artifactId: pending.artifactId, actionId, scope: pending.scope,
                expectedInput: inspected.actionArgs, expectedRequestId: inspected.executionOriginV1.requestId,
                expectedExecutionOrigin: inspected.executionOriginV1, onSucceeded: value => { settled.push(value); },
                onFailed: code => { throw new Error(code); } });
            const decided = await producer.execute('approval.request.decide',
                { artifactId: pending.artifactId, decision: 'approve' }, { surface: 'cli', authority: 'present_user', serverId: creatorProfile });
            expect(decided, JSON.stringify(decided)).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            const executed = await account.fetchArtifact(pending.artifactId);
            if (!executed || typeof executed.body !== 'string') throw new Error('Missing executed Artifact');
            const stored: ApprovalRequest = ApprovalRequestSchema.parse(JSON.parse(executed.body));
            expect(stored).toMatchObject({ actionArgs: input, executionOriginV1: { serverId: creatorProfile } });
            expect(inspectMachineTerminalMemberApproval({ artifact: executed, pending, machineId, request })).not.toBeNull();
            expect(await continuation.onExecuted(executed)).toBe('consumed');
            const receipt = DaemonTerminalEnsureResponseSchema.parse(stored.execution?.result);
            expect(receipt).toMatchObject({ ok: true, terminalId: expect.any(String), reused: false });
            const outputSchema = getActionSpec(actionId).outputSchema;
            if (!outputSchema) throw new Error('Terminal Action output schema missing');
            expect(outputSchema.parse(receipt)).toEqual(receipt);
            expect(settled).toEqual([receipt]);
            if (!receipt.ok) throw new Error('Expected a physical terminal receipt');
            expect(terminals.list()).toMatchObject([{ terminalId: receipt.terminalId,
                terminalKey: request.terminalKey, cwd: request.cwd, sessionId: request.sessionId }]);
            // A new mounted consumer retains the same settled Artifact. It does
            // not replay its approved effect merely to recover the process id.
            const returning: unknown[] = [];
            const returningContinuation = createActionApprovalContinuation({ artifactId: pending.artifactId,
                actionId, scope: pending.scope, expectedInput: inspected.actionArgs,
                expectedRequestId: inspected.executionOriginV1.requestId, expectedExecutionOrigin: inspected.executionOriginV1,
                onSucceeded: value => { returning.push(value); }, onFailed: code => { throw new Error(code); } });
            expect(await returningContinuation.onExecuted(executed)).toBe('consumed');
            expect(returning).toEqual([receipt]);
            expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_ENSURE, request))
                .toEqual({ ok: true, terminalId: receipt.terminalId, reused: true });
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(await db.artifact.count({ where: { accountId: owner.id } })).toBe(1);
            expect(inspectMachineTerminalMemberApproval({ artifact: executed, pending, machineId,
                request: { ...request, terminalKey: `${request.terminalKey}:another-member` } })).toBeNull();
            expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_TERMINAL_CLOSE, { terminalId: receipt.terminalId })).toEqual({ ok: true });
            expect(terminals.list()).toEqual([]);
        } finally { registration.dispose(); account.dispose(); await homes.dispose(); await app.close(); }
    });

    it.each([
        ['plain', 'session', 'plain'], ['e2ee', 'session', 'plain'], ['plain', 'project', 'plain'], ['e2ee', 'project', 'plain'],
        ['e2ee', 'project', 'e2ee'], ['e2ee', 'own-session', 'e2ee'],
        ['e2ee', 'paired-terminal', 'plain'],
    ] as const)('retains one strict Shell receipt for %s %s on %s custody through original Account approval and the installed Machine ingress', async (requesterMode, targetKind, ownerMode) => {
        const context = { onTestFinished };
        const ownerSecret = new Uint8Array(32).fill(43);
        const ownerKeys = nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(ownerSecret));
        const owner = await db.account.create({ data: { encryptionMode: ownerMode,
            ...(ownerMode === 'e2ee' ? createSignedAccountContentBinding(ownerKeys.publicKey) : {}) } });
        const requesterSecret = new Uint8Array(32).fill(42);
        const requesterKeys = nacl.box.keyPair.fromSecretKey(deriveAccountMachineKeyFromRecoverySecret(requesterSecret));
        const requester = targetKind === 'own-session' ? owner : await db.account.create({ data: { encryptionMode: requesterMode,
            ...(requesterMode === 'e2ee' ? createSignedAccountContentBinding(requesterKeys.publicKey) : {}) } });
        const ownerToken = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterToken = await auth.createToken(requester.id, undefined, { kind: 'account', authority: 'present_user' });
        const requesterCredentials = { token: requesterToken,
            ...(requesterMode === 'e2ee' ? { secret: encodeBase64(targetKind === 'own-session' ? ownerSecret : requesterSecret, 'base64') } : {}) };
        const ownerCredentials = { token: ownerToken, encryption: ownerMode === 'e2ee'
            ? { type: 'legacy' as const, secret: ownerSecret } : null };
        const homeId = await initializeServerIdentityCache();
        if (!homeId) throw new Error('Home startup identity missing');
        const machineKey = new Uint8Array(32).fill(44);
        const ownerEnvelope = ownerMode === 'e2ee' ? sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey,
            recipientPublicKey: ownerKeys.publicKey, randomBytes: nacl.randomBytes }) : null;
        const codec = createMachineContentCodec(ownerMode === 'e2ee'
            ? { encryptionMode: 'e2ee', encryptionKey: machineKey, encryptionVariant: 'dataKey' } : { encryptionMode: 'plain' });
        const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
            installationId: crypto.randomUUID(), active: true,
            metadata: codec.encodeStored({ host: 'r35-terminal', platform: 'linux', happyCliVersion: '0.3',
                homeDir: database.baseDir, happyHomeDir: database.baseDir }),
            dataEncryptionKey: ownerEnvelope ?? new Uint8Array(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')) } });
        if (requester.id !== owner.id) await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        if (ownerEnvelope && requester.id !== owner.id) await db.machineKeyEnvelope.create({ data: { machineId: machine.id,
            recipientAccountId: requester.id, encryptedDataKey: sealEncryptedDataKeyEnvelopeV1({ dataKey: machineKey,
                recipientPublicKey: requesterKeys.publicKey, randomBytes: nacl.randomBytes }),
            machineOwnerEnvelopeFingerprint: computeMachineOwnerEnvelopeFingerprintV1(ownerEnvelope),
            recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(requesterKeys.publicKey) } });
        const sessionMetadata = { machineId: machine.id, path: database.baseDir };
        const ownerMetadata = createSessionOwnerMetadataV1({ metadata: sessionMetadata });
        if (!ownerMetadata.ok) throw new Error('Session owner metadata producer refused the fixture');
        const encryptedOwnerSession = targetKind === 'own-session';
        const sessionCodec = createMachineContentCodec({ encryptionMode: 'e2ee', encryptionKey: ownerSecret, encryptionVariant: 'legacy' });
        const session = await db.session.create({ data: { accountId: requester.id, tag: crypto.randomUUID(),
            ...(encryptedOwnerSession ? { encryptionMode: 'e2ee', metadataLayoutVersion: 1,
                metadata: sessionCodec.encodeStored(projectSessionSharedMetadataV1({ metadata: sessionMetadata })),
                ownerMetadata: JSON.stringify(sealSessionOwnerMetadataEnvelopeV1({ material: { type: 'legacy', secret: ownerSecret },
                    ownerMetadata: ownerMetadata.ownerMetadata, randomBytes: nacl.randomBytes })) }
                : { encryptionMode: 'plain', metadata: JSON.stringify(sessionMetadata) }) } });
        const app = Fastify({ logger: false }) as unknown as AppFastify;
        context.onTestFinished(async () => { await app.close(); });
        enableSchemaValidation(app);
        enableErrorHandlers(app);
        enableAuthentication(app);
        enableMonitoring(app);
        enableOptionalStatics(app);
        registerAuthPingRoute(app);
        registerAccountApiTokenManagementRoutes(app);
        accountRoutes(app);
        featuresRoutes(app, { homeConnectionDescriptorContinuityStore:
            createFileHomeConnectionDescriptorContinuityStore(join(database.baseDir, 'home-descriptor.json')) });
        artifactsRoutes(app);
        sessionRoutes(app);
        machinesRoutes(app);
        startSocket(app);
        registerExternalActionRoutes(app);
        const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
        // This disposable Home has an explicit loopback ingress, just like Stack.
        // Its production descriptor publisher, rather than a copied wire fixture,
        // supplies the daemon's authenticated profile identity.
        vi.stubEnv('HAPPIER_CANONICAL_SERVER_URL', endpoint);
        vi.stubEnv('HAPPIER_PUBLIC_SERVER_URL', endpoint);
        context.onTestFinished(() => { vi.unstubAllEnvs(); });
        let apiMachine: ApiMachineClient | null = null;
        const daemonProfileId = 'r47-stack';
        const daemonHomeDir = join(database.baseDir, 'signed-terminal-daemon', machine.id);
        const daemon = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: daemonHomeDir,
            activeServerDir: join(daemonHomeDir, 'servers', daemonProfileId), serverId: daemonProfileId, serverHttpBaseUrl: endpoint,
            machineId: machine.id, custodianAccountId: owner.id, credentials: ownerCredentials,
            connectedServicesMaterializationBaseDir: join(daemonHomeDir, 'connected-services'),
            registry: new ConnectedServiceRuntimeRegistry(), trackedSessions: new Map(), getRequester: () => null,
            resolveQualifiedConnectedAccountV4Support: () => 'advertised', getApiMachineForSessions: () => apiMachine,
            beforeStartup: async () => {
                const profile = await addServerProfile({ name: daemonProfileId, serverUrl: endpoint, webappUrl: endpoint });
                expect(profile.id).toBe(daemonProfileId);
                expect(await refreshServerProfileHomeConnectionDescriptor({ profileId: profile.id, serverUrl: endpoint, token: ownerToken }))
                    .toBe('updated');
                // Production starts from the credential reader, including its
                // non-persisted login provenance. Both startup and CLI use it.
                await writeStoredCredentialsForServerId(daemonProfileId, ownerCredentials);
                const stored = await readStoredCredentialsForServerId(daemonProfileId);
                if (!stored) throw new Error('Stored daemon credential producer missing');
                Object.assign(ownerCredentials, stored);
            },
            startup: { resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
                serverUrl: endpoint, resolveCurrentMachineId: () => machine.id,
            }) },
        });
        context.onTestFinished(daemon.dispose);
        // Real installed currentness reads the daemon's retained Account
        // credentials; supplying a constructor token alone is not that custody.
        await writeStoredCredentialsForServerId(daemonProfileId, ownerCredentials);
        const cliCredentials = await readStoredCredentialsForServerId(daemonProfileId);
        if (!cliCredentials) throw new Error('Stored CLI credential producer missing');
        const runtime = daemon.runtime;
        if (!daemon.installation || !runtime?.externalActionIngressOwner) throw new Error('Installed Action owner missing');
        const installation = daemon.installation;
        await db.machine.update({ where: { id: machine.id }, data: { installationId: installation.installationId,
            installationPublicKey: new Uint8Array(decodeBase64(installation.publicKey, 'base64url')) } });
        // Virtual positive process/group identities belong only to this OS
        // fixture. Unexpected process-tree targets fail without signaling a host.
        const processes = new Map<number, PtyProcess>();
        const spawn = vi.fn<PtyProvider['spawn']>(() => {
            const byteListeners = new Set<(data: Buffer | string) => void>();
            const exitListeners = new Set<(event: PtyExitEvent) => void>();
            const pid = 54321 + processes.size;
            const process = { pid, ownedProcessGroupId: pid, write: data => { for (const listener of byteListeners) listener(Buffer.from(data)); },
                resize: () => {}, kill: () => { for (const listener of exitListeners) listener({ exitCode: 0 }); },
                onData: () => ({ dispose: () => {} }),
                onDataBytes: listener => { byteListeners.add(listener); return { dispose: () => { byteListeners.delete(listener); } }; },
                onExit: listener => { exitListeners.add(listener); return { dispose: () => { exitListeners.delete(listener); } }; },
            } satisfies PtyProcess;
            processes.set(pid, process);
            return process;
        });
        const ptyProvider = vi.spyOn(ptyOsBoundary, 'createNodePtyProvider').mockReturnValue({ spawn });
        context.onTestFinished(() => { ptyProvider.mockRestore(); });
        const stopProcessTree = vi.spyOn(processTreeOsBoundary, 'terminateProcessTree').mockImplementation(async root => {
            if (typeof root.pid !== 'number') throw new Error('Unexpected OS process-tree identity');
            const process = processes.get(root.pid);
            if (!process) throw new Error('Unexpected OS process-tree target');
            process.kill();
        });
        context.onTestFinished(() => { stopProcessTree.mockRestore(); });
        const probeProcessGroup = vi.spyOn(processGroupOsBoundary, 'probeProcessGroupLiveness').mockImplementation(pid => {
            if (!processes.has(pid)) throw new Error('Unexpected OS process-group probe');
            return 'absent';
        });
        context.onTestFinished(() => { probeProcessGroup.mockRestore(); });
        const ownerApi = await runWithServerHttpBaseUrl(endpoint, () => ApiClient.create(ownerCredentials));
        const published = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
        if (!published) throw new Error('Installed Machine read missing');
        apiMachine = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.machineSyncClient(published));
        const installed = apiMachine;
        context.onTestFinished(async () => { await installed.shutdown(); });
        const projectIo = createProjectNativeIo();
        const workerAdmission = createProjectWorkerAdmission({ machineId: machine.id, admissionDrain: createDaemonAdmissionDrain(),
            // This fixture has no setup or command declaration. A worker launch
            // would be a distinct effect, not permission to simulate its policy.
            readPolicy: async () => { throw new Error('Unexpected finite Project command'); } });
        const createProjectFiniteRuntime: NonNullable<ApiMachineClientLifecycleDependencies['createProjectFiniteRuntime']> = async (ports, ingress) => {
            const account = await installed.resolveOwnSessionRuntime(ingress);
            if (!account) return null;
            return { ...ports, ...account, workerAdmission, nativeIo: projectIo.commandIo,
                environmentIo: projectIo.environmentIo, resolveWorkspaceExecutionConfig: async () => null };
        };
        const lifecycle = await runWithServerHttpBaseUrl(endpoint, () => installed.setRPCHandlers({
            spawnSession: runtime.spawnSession, stopSession: runtime.stopSession,
            isSessionActive: runtime.isSessionAlreadyRunning,
            requestShutdown: () => { throw new Error('Unexpected OS daemon shutdown request'); },
        }, { currentMachineId: machine.id, currentServerId: daemonProfileId, workingDirectory: database.baseDir,
            externalActionIngressOwner: runtime.externalActionIngressOwner,
            ...(targetKind === 'project' ? { createProjectFiniteRuntime } : {}) }));
        // The real Machine transport creates its signed installed Socket and
        // owns registration, generation checks and RpcHandlerManager dispatch.
        await runWithServerHttpBaseUrl(endpoint, () => new Promise<void>(resolve => {
            installed.connect({ onConnect: resolve });
        }));
        await vi.waitFor(async () => {
            const ready = await runWithServerHttpBaseUrl(endpoint, () => ownerApi.getMachine(machine.id));
            expect(ready?.daemonState?.status).toBe('running');
        }, { timeout: 180_000 });
        const actionHttp: Array<Readonly<{ path: string; status: number }>> = [];
        const homes = await serveActionHomes({ homes: [{ key: 'home', serverUrl: endpoint, accountId: requester.id, currentAccount: true,
            accountMode: requesterMode, credentials: requesterCredentials }],
            route: async request => {
                const method = request.method;
                if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'PATCH'
                    && method !== 'DELETE' && method !== 'OPTIONS' && method !== 'HEAD') {
                    throw new Error('Unexpected Home HTTP method');
                }
                // The network harness exposes strings; validate the HTTP boundary before Fastify injection.
                const response = await app.inject({ method, url: request.url.pathname + request.url.search,
                    headers: Object.fromEntries(request.headers), ...(request.body === undefined ? {} : { payload: JSON.stringify(request.body) }) });
                if (request.url.pathname.startsWith('/v1/actions/')) {
                    actionHttp.push({ path: request.url.pathname, status: response.statusCode });
                }
                return new Response(response.body, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
            } });
        context.onTestFinished(homes.dispose);
        const browserProfileId = homes.homes.home!.id;
        const learned = await setServerProfileIdentityForUrl(endpoint, homeId);
        if (!learned) throw new Error('Home identity missing');
        context.onTestFinished(async () => { await removeServerProfile(learned.id); });
        const credentials = await TokenStorage.setCredentialsForServerUrlWithRollback(endpoint,
            { serverId: learned.id }, requesterCredentials);
        if (!credentials) throw new Error('Requester credential missing');
        context.onTestFinished(async () => { if (!await credentials.rollback()) throw new Error('Requester credential rollback failed'); });
        // Explicit Inbox policy keeps this journey independent of the default
        // direct-confirmation UI. The real settings writer seals E2EE content.
        const policyAccount = await captureLazyActionAccountContext(learned.id);
        try {
            await policyAccount.mutateRawSettings(raw => ({ ...raw, actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                actions: { 'machines.terminal.open': { approvalRequiredSurfaces: ['ui'] },
                    'machines.terminal.close': { approvalRequiredSurfaces: ['ui'] } } }) }));
        } finally { policyAccount.dispose(); }
        if (targetKind === 'project') {
            const executor = createDefaultActionExecutor();
            const uiContext = { surface: 'ui' as const, authority: 'present_user' as const,
                actionCaller: { kind: 'host' as const }, serverId: learned.id, actionRequestId: crypto.randomUUID() };
            const openedResult = await executor.execute('projects.open', { serverId: homeId, machineId: machine.id,
                source: { kind: 'folder', path: database.baseDir }, materialization: { kind: 'attach' } }, {
                ...uiContext,
                // This harness has no modal renderer: record the user's Project
                // confirmation at that UI boundary, as the close journey does.
                // The separate Machine terminal open remains under real Ask.
                presentUserConfirmation: { actionId: 'projects.open' },
            });
            let openedValue: unknown = openedResult.ok ? openedResult.result : null;
            const projectApproval = ActionApprovalRequestCreatedResultSchema.safeParse(openedValue);
            if (projectApproval.success) {
                // Project preparation now has its own native Ask. Consume its
                // real approved receipt before exercising the separate Shell.
                const decision = await executor.execute('approval.request.decide', {
                    artifactId: projectApproval.data.artifactId, decision: 'approve',
                }, { ...uiContext, actionRequestId: crypto.randomUUID(),
                    presentUserConfirmation: { actionId: 'approval.request.decide' } });
                expect(decision).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
                const projectAccount = await captureLazyActionAccountContext(learned.id);
                try {
                    const artifact = await projectAccount.fetchArtifact(projectApproval.data.artifactId);
                    if (typeof artifact?.body !== 'string') throw new Error('Approved Project preparation receipt missing');
                    openedValue = ApprovalRequestSchema.parse(JSON.parse(artifact.body)).execution?.result;
                } finally { projectAccount.dispose(); }
            }
            expect(openedResult, JSON.stringify({ ok: openedResult.ok,
                errorCode: openedResult.ok ? null : openedResult.errorCode, actionHttp }))
                .toMatchObject({ ok: true });
            if (!openedResult.ok) throw new Error('Requester Project Open refused');
            const opened = OpenProjectResultV1Schema.parse(openedValue);
            if (opened.kind !== 'opened') throw new Error('Requester Project missing');
            const workspace = opened.workspace;
            const preparationArtifactCount = await db.artifact.count({ where: { accountId: requester.id } });
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            getStorage().getState().activateProfileScope({ serverId: homeId, accountId: requester.id });
            await getStorage().getState().activateSettingsScope({ serverId: homeId, accountId: requester.id });
            const account = await captureLazyActionAccountContext(learned.id);
            context.onTestFinished(account.dispose);
            const scope = account.accountLifetime.scope;
            // Learning a Home identity precedes the production Sync scope activation.
            // The HTTP harness starts with the local profile, so publish that same activation here.
            getStorage().getState().activateProjectAccountRowsScope(scope);
            const rows = await createUiProjectAccountRowsClient(account).read();
            expect(rows.status).toBe('ready');
            const projectScopeId = buildProjectPaneScopeId(workspace.workspaceId, learned.id, 'guest-project-pane');
            const projectMemberId = crypto.randomUUID();
            const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => React.createElement(AppPaneProvider, null, children);
            const paneHost = await renderHook(() => null, { wrapper });
            context.onTestFinished(paneHost.unmount);
            await act(async () => {
                expect(initializeSessionTerminalWorkspaceForScope(projectScopeId, EMPTY_TERMINAL_WORKSPACE)).toBe(true);
                expect(dispatchSessionTerminalWorkspaceCommand(projectScopeId, { type: 'open', terminal: {
                    id: projectMemberId, target: { kind: 'workspace_shell', workspace } } })).toBe(true);
            });
            const listInput = { serverId: learned.id, machineId: machine.id, workspace };
            const census = await executor.execute('machines.terminal.list', listInput, uiContext);
            expect(census, JSON.stringify({ ok: census.ok, errorCode: census.ok ? null : census.errorCode,
                error: census.ok ? null : census.error, actionHttp })).toMatchObject({ ok: true, result: { ok: true, terminals: [] } });
            if (!census.ok) throw new Error('Requester census refused');
            DaemonTerminalListResponseV1Schema.parse(getActionSpec('machines.terminal.list').outputSchema!.parse(census.result));
            // Machine Use alone remains insufficient for a private Project read.
            expect(await machineTerminalList(machine.id, { serverId: learned.id, accountId: requester.id, workspace }))
                .toMatchObject({ ok: false, errorCode: 'terminal_unavailable' });
            const wrongWorkspace = await executor.execute('machines.terminal.list', { ...listInput,
                workspace: { ...workspace, workspaceId: crypto.randomUUID() } }, { ...uiContext, actionRequestId: crypto.randomUUID() });
            expect(wrongWorkspace).toMatchObject({ ok: false, errorCode: 'terminal_cwd_denied' });
            const ownerRowsResponse = await app.inject({ method: 'POST', url: '/v1/account/project-rows/list',
                headers: { authorization: `Bearer ${ownerToken}` }, payload: {} });
            expect(ownerRowsResponse.statusCode).toBe(200);
            expect(ProjectAccountRowListResponseV1Schema.parse(ownerRowsResponse.json())).toMatchObject({ status: 'listed', rows: [] });
            expect(spawn).not.toHaveBeenCalled();
            const input = { ...listInput, terminalKey: buildProjectTerminalKey(scope, workspace, projectMemberId),
                cwd: database.baseDir };
            const hook = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: input.terminalKey,
                workspace, scopeId: projectScopeId, memberId: projectMemberId }));
            const interest = new AbortController();
            let result: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> | undefined;
            // Use the actual renderer's request producer, including absent optional fields.
            const rendererRequest = buildMachineTerminalSessionRequest({ terminalKey: input.terminalKey,
                cwd: input.cwd, workspace, cols: 80, rows: 24 });
            // C12's immediate transport consumes this object BEFORE encoding.
            // Deferred Artifact JSON would hide the same producer defect.
            expect(() => ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, input: rendererRequest })).not.toThrow();
            const admission = hook.getCurrent().admit(rendererRequest, false, interest.signal)
                .then(value => { result = value; return value; });
            context.onTestFinished(async () => { interest.abort(); await admission; await hook.unmount(); });
            await vi.waitFor(() => expect(Boolean(readSessionTerminalWorkspaceForScope(projectScopeId)?.tabs.flatMap(tab => tab.terminals)
                .find(member => member.id === projectMemberId)?.pendingActionApproval) || result !== undefined).toBe(true), { timeout: 30_000 });
            expect(result, 'New guest Project member must reach approval through real census/admission').toBeUndefined();
            const artifactId = readSessionTerminalWorkspaceForScope(projectScopeId)?.tabs.flatMap(tab => tab.terminals)
                .find(member => member.id === projectMemberId)?.pendingActionApproval?.artifactId;
            if (!artifactId) throw new Error('Requester approval missing');
            // The in-process fixture mounts the admission owner, not the full
            // app's Account-change subscriber. Return through the real retained
            // Artifact/census path after Inbox, as the Session case does below.
            interest.abort();
            await admission;
            await hook.unmount();
            const decision = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
                { ...uiContext, actionRequestId: crypto.randomUUID(), presentUserConfirmation: { actionId: 'approval.request.decide' } });
            expect(decision).toMatchObject({ ok: true, result: { status: 'executed', execution: { ok: true } } });
            const artifact = await account.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Executed Project approval missing');
            const approval = ApprovalRequestSchema.parse(JSON.parse(artifact.body));
            const receipt = DaemonTerminalEnsureResponseSchema.parse(getActionSpec('machines.terminal.open').outputSchema!.parse(approval.execution?.result));
            expect(receipt).toMatchObject({ ok: true, reused: false });
            if (!receipt.ok) throw new Error('Project PTY missing');
            const returning = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: input.terminalKey,
                workspace, scopeId: projectScopeId, memberId: projectMemberId }));
            const returningInterest = new AbortController();
            try {
                expect(await returning.getCurrent().admit({ terminalKey: input.terminalKey, cwd: input.cwd, workspace }, false,
                    returningInterest.signal)).toEqual({ ok: true, terminalId: receipt.terminalId, reused: true });
            } finally { returningInterest.abort(); await returning.unmount(); }
            expect(lifecycle.getFiniteTerminalSessions().getCustody(receipt.terminalId)).toMatchObject({
                requesterAccountId: requester.id, machineId: machine.id, installationId: installation.installationId,
                workspaceRefId: workspace.workspaceId, rootPath: database.baseDir });
            const listed = await executor.execute('machines.terminal.list', listInput, { ...uiContext, actionRequestId: crypto.randomUUID() });
            expect(listed).toMatchObject({ ok: true, result: { ok: true, terminals: [{ terminalId: receipt.terminalId, terminalKey: input.terminalKey }] } });
            if (!listed.ok) throw new Error('Retained Project census refused');
            DaemonTerminalListResponseV1Schema.parse(getActionSpec('machines.terminal.list').outputSchema!.parse(listed.result));
            // C14: approved reuse/census succeeds, then the mounted stream's
            // read/input must retain the SAME requester through the real ingress.
            const carrier = createMachineRpcTerminalStreamCarrier({ machineId: machine.id,
                serverId: learned.id, accountId: requester.id });
            // Mis-binding the mounted carrier to raw guest Machine RPC must
            // reproduce C14's refusal; it cannot borrow private requester rows.
            const unboundCarrier = createMachineRpcTerminalStreamCarrier({ machineId: machine.id, serverId: learned.id });
            expect(await unboundCarrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: 0 } })).toMatchObject({ ok: false, code: 'terminal_forbidden' });
            const firstRead = await carrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: 0 }, rendererId: 'r56-renderer', surfaceEpoch: 1,
                ackedByteOffset: 0, creditBytes: 1024 });
            expect(firstRead).toMatchObject({ ok: true });
            await carrier.sendInput(receipt.terminalId, { t: 'text', text: 'r56 guest output\n' });
            const output = await carrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: 0 }, rendererId: 'r56-renderer', surfaceEpoch: 1,
                ackedByteOffset: 0, creditBytes: 1024 });
            expect(output).toMatchObject({ ok: true, frames: [expect.objectContaining({ t: 'bytes' })] });
            if (!output.ok) throw new Error('Guest stream refused');
            expect(Buffer.concat(output.frames.flatMap(frame => frame.t === 'bytes' ? [Buffer.from(frame.bytes)] : []))
                .toString()).toBe('r56 guest output\n');
            await carrier.acknowledge({ terminalId: receipt.terminalId, rendererId: 'r56-renderer', surfaceEpoch: 1,
                ackedByteOffset: output.nextCursor, creditBytes: 1024 });
            await carrier.sendInput(receipt.terminalId, { t: 'resize', cols: 100, rows: 30 });
            await carrier.sendInput(receipt.terminalId, { t: 'text', text: 'after acknowledgement\n' });
            const nextOutput = await carrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: output.nextCursor } });
            expect(nextOutput).toMatchObject({ ok: true });
            if (!nextOutput.ok) throw new Error('Guest stream continuation refused');
            expect(Buffer.concat(nextOutput.frames.flatMap(frame => frame.t === 'bytes' ? [Buffer.from(frame.bytes)] : []))
                .toString()).toBe('after acknowledgement\n');
            const wrongAccountCarrier = createMachineRpcTerminalStreamCarrier({ machineId: machine.id,
                serverId: learned.id, accountId: owner.id });
            await expect(wrongAccountCarrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: 0 } })).rejects.toMatchObject({ code: 'action_account_scope_changed' });
            // A previously admitted stream must recheck current Machine Use.
            await db.machineAccountGrant.deleteMany({ where: { machineId: machine.id, accountId: requester.id } });
            await expect(carrier.read({ terminalId: receipt.terminalId,
                cursor: { mode: 'byte-offset', value: 0 } })).rejects.toMatchObject({ code: 'admission_unavailable' });
            await expect(carrier.sendInput(receipt.terminalId, { t: 'text', text: 'forbidden input' }))
                .rejects.toMatchObject({ code: 'admission_unavailable' });
            await db.machineAccountGrant.create({ data: { machineId: machine.id, accountId: requester.id,
                accessLevel: 'view', createdByAccountId: owner.id } });
            const exit = lifecycle.getFiniteTerminalSessions().waitForExit({ terminalId: receipt.terminalId });
            const closed = await executor.execute('machines.terminal.close', { serverId: learned.id, machineId: machine.id,
                terminalId: receipt.terminalId }, { ...uiContext, actionRequestId: crypto.randomUUID(),
                    presentUserConfirmation: { actionId: 'machines.terminal.close' } });
            expect(closed).toMatchObject({ ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } });
            if (!closed.ok) throw new Error('Guest Project close refused');
            const closeApproval = ActionApprovalRequestCreatedResultSchema.parse(closed.result);
            const pendingClose = await account.fetchArtifact(closeApproval.artifactId);
            if (!pendingClose || typeof pendingClose.body !== 'string') throw new Error('Pending close approval missing');
            const closeOrigin = ApprovalRequestSchema.parse(JSON.parse(pendingClose.body));
            expect(resolveApprovalExecutor(closeOrigin)).toMatchObject({ kind: 'daemon', machineId: machine.id });
            if (closeOrigin.v !== 2) throw new Error('Exact close origin missing');
            expect(closeOrigin.executionOriginV1.externalActionExecutionAuthorization?.requesterAccountContext).toBeUndefined();
            const closeDecision = await executor.execute('approval.request.decide', { artifactId: closeApproval.artifactId, decision: 'approve' },
                { ...uiContext, actionRequestId: crypto.randomUUID(), presentUserConfirmation: { actionId: 'approval.request.decide' } });
            const closeResult = closeDecision.ok && closeDecision.result && typeof closeDecision.result === 'object' ? closeDecision.result : null;
            const closeExecution = closeResult ? Reflect.get(closeResult, 'execution') : null;
            const closeSummary = { ok: closeDecision.ok, status: closeResult ? Reflect.get(closeResult, 'status') : null,
                executionOk: closeExecution && typeof closeExecution === 'object' ? Reflect.get(closeExecution, 'ok') : null,
                errorCode: closeExecution && typeof closeExecution === 'object' ? Reflect.get(closeExecution, 'errorCode') : null };
            expect(closeSummary, JSON.stringify(closeSummary)).toMatchObject({ ok: true, status: 'executed', executionOk: true });
            const closeArtifact = await account.fetchArtifact(closeApproval.artifactId);
            if (!closeArtifact || typeof closeArtifact.body !== 'string') throw new Error('Executed Project close approval missing');
            const closeRequest = ApprovalRequestSchema.parse(JSON.parse(closeArtifact.body));
            expect(DaemonTerminalCloseResponseSchema.parse(getActionSpec('machines.terminal.close').outputSchema!.parse(closeRequest.execution?.result)))
                .toMatchObject({ ok: true });
            expect(await exit).toMatchObject({ kind: 'exited' });
            expect(lifecycle.getFiniteTerminalSessions().list()).toHaveLength(0);
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(preparationArtifactCount + 2);
            // A failed pre-dispatch member has no PTY or approval receipt. Its
            // product Close-tab must census through the same signed requester owner.
            const failedMemberId = crypto.randomUUID();
            await act(async () => {
                expect(dispatchSessionTerminalWorkspaceCommand(projectScopeId, { type: 'open', terminal: {
                    id: failedMemberId, target: { kind: 'workspace_shell', workspace } } })).toBe(true);
            });
            const failedTab = readSessionTerminalWorkspaceForScope(projectScopeId)?.tabs
                .find(tab => tab.terminals.some(member => member.id === failedMemberId));
            if (!failedTab) throw new Error('Failed Project member missing');
            expect(await executor.execute('session.terminals.close_tab',
                { scopeId: projectScopeId, tabId: failedTab.id }, { ...uiContext, actionRequestId: crypto.randomUUID(),
                    presentUserConfirmation: { actionId: 'session.terminals.close_tab' } }))
                .toMatchObject({ ok: true, result: { ok: true } });
            expect(readSessionTerminalWorkspaceForScope(projectScopeId)?.tabs.flatMap(tab => tab.terminals)
                .some(member => member.id === failedMemberId)).toBe(false);
            return;
        }
        const member = { id: 'embedded', target: { kind: 'workspace_shell' as const } };
        const originalState = createWorkspaceState({ id: 'original-pane', target: { kind: 'session',
            params: { id: session.id, serverId: homeId, bottom: 'terminal' } }, pinned: false, preview: true });
        const catalog = resolveCompactAppDestinations({ builtins: { externalSessions: false, inbox: true, workflows: true, friends: false }, pages: [] });
        navigationBoundary.pathname = `/session/${session.id}`;
        navigationBoundary.params = { serverId: homeId, bottom: 'terminal' };
        const layoutKey = workspaceLayoutScopeKey({ serverId: targetKind === 'own-session' ? homeId : learned.id,
            accountId: requester.id, windowId: 'main' });
        const store = getStorage();
        if (targetKind === 'own-session') {
            // This journey begins at an already-readable Session. Seed the real
            // store through its fixture/producer, using the DB setup's metadata;
            // Session-route hydration is a separate owner from PTY reattachment.
            publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
            store.getState().activateProfileScope({ serverId: homeId, accountId: requester.id });
            store.getState().applyMachines([createMachineFixture({ id: machine.id, active: true, activeAt: Date.now() })]);
            const metadata = MetadataSchema.parse(sessionMetadata);
            store.getState().applySessions([createSessionFixture({ id: session.id, serverId: homeId,
                encryptionMode: requesterMode, metadataLayoutVersion: 1,
                metadata: projectSessionSharedMetadataV1({ metadata }), ownerMetadataView: metadata })]);
        }
        const previousReadiness = store.getState().isDataReady;
        const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
        const previousLayout = workspaceLayoutsState.read(layoutKey);
        workspaceLayoutsState.set(layoutKey, serializeWorkspaceLayout(originalState));
        store.setState({ isDataReady: true });
        context.onTestFinished(() => {
            if (previousLayout === undefined) workspaceLayoutsState.remove(layoutKey);
            else workspaceLayoutsState.set(layoutKey, previousLayout);
            store.setState({ isDataReady: previousReadiness });
        });
        let navigation!: WorkspaceNavigationContextValue;
        const scopeId = createSessionPaneScopeId(session.id, homeId, 'original-pane');
        const request = { terminalKey: resolveSessionTerminalIdentity({ sessionId: session.id, scopeId, terminal: member }).terminalKey,
            cwd: database.baseDir, sessionId: session.id };
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        const wrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => React.createElement(InjectedAuthProvider,
            { credentials: requesterCredentials }, React.createElement(WorkspaceProvider,
            { enabled: true, catalog, children: current => {
                navigation = current;
                return React.createElement(AppPaneProvider, null, React.createElement(DestinationInstanceHost,
                    { tabId: 'original-pane', ref: originalState.tabs['original-pane'].target,
                        pathname: navigationBoundary.pathname, focused: true, visible: true,
                        navigation: current.navigationForTab('original-pane') }, children));
            } }));
        const paneHost = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: request.terminalKey,
            machineId: machine.id, serverId: learned.id, scopeId, memberId: member.id }), { wrapper });
        context.onTestFinished(paneHost.unmount);
        expect(navigation.state.tabs['original-pane'], 'Saved layout must match the admitted Account scope before process creation').toBeDefined();
        await act(async () => {
            expect(initializeSessionTerminalWorkspaceForScope(scopeId, readSessionTerminalWorkspace(undefined))).toBe(true);
        });
        const actionId = 'machines.terminal.open' as const;
        const executor = createDefaultActionExecutor();
        const uiContext = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
            serverId: learned.id, actionRequestId: crypto.randomUUID() };
        // A paired terminal has its own authentic automation credential; the app
        // deciding its retained approval still uses the requester's Account login.
        const pairedCredentials = targetKind === 'paired-terminal' ? {
            token: await auth.createToken(requester.id, { session: 'r55-paired-terminal' },
                { kind: 'terminal', authority: 'account_automation' }),
            encryption: { type: 'legacy' as const, secret: requesterSecret },
        } : null;
        const dispatchPairedClose = async (input: unknown) => {
            if (!pairedCredentials) throw new Error('Paired terminal credentials missing');
            return await dispatchOriginalAccountAction({ actionId: 'machines.terminal.close', input, requestId: crypto.randomUUID(),
                target: { kind: 'machine', machineId: machine.id }, credentials: pairedCredentials,
                serverHttpBaseUrl: endpoint, serverIdentityId: homeId, authority: 'account_automation',
                onRequesterSessionCredentialDisclosure: () => true });
        };
        const source = paneHost;
        const sourceInterest = new AbortController();
        let admissionResult: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> | undefined;
        const sourceAdmission = source.getCurrent().admit(request, false, sourceInterest.signal).then(result => {
            admissionResult = result;
            return result;
        });
        context.onTestFinished(async () => { sourceInterest.abort(); await sourceAdmission; await source.unmount(); });
        await vi.waitFor(() => expect(Boolean(readSessionTerminalWorkspaceForScope(scopeId)?.tabs.flatMap(tab => tab.terminals)
            .find(row => row.id === member.id)?.pendingActionApproval) || admissionResult !== undefined).toBe(true), { timeout: 30_000 });
        expect(admissionResult).toBeUndefined();
        const artifactId = readSessionTerminalWorkspaceForScope(scopeId)!.tabs.flatMap(tab => tab.terminals)
            .find(row => row.id === member.id)!.pendingActionApproval!.artifactId;
        // Inbox navigation retires the view's receipt interest, not its retained
        // member or the original signed execution authority.
        sourceInterest.abort();
        await sourceAdmission;
        // Observe with the current Account context after real front-door
        // admission, not an earlier setup-only scope lease.
        const account = await captureLazyActionAccountContext(learned.id);
        context.onTestFinished(account.dispose);
        const pendingArtifact = await account.fetchArtifact(artifactId);
        if (!pendingArtifact || typeof pendingArtifact.body !== 'string') throw new Error('Original pending Artifact missing');
        const pendingApproval = ApprovalRequestSchema.parse(JSON.parse(pendingArtifact.body));
        expect(pendingApproval.actionArgs).toEqual({ ...request, machineId: machine.id, serverId: homeId });
        const decided = await executor.execute('approval.request.decide', { artifactId, decision: 'approve' },
            { ...uiContext, actionRequestId: crypto.randomUUID() });
        const decisionResult = decided.ok && decided.result && typeof decided.result === 'object' ? decided.result : null;
        const execution = decisionResult ? Reflect.get(decisionResult, 'execution') : null;
        // An approval may carry signed custody. Failure diagnostics project
        // only statuses/codes, never the retained authorization or bearer.
        const decisionSummary = { ok: decided.ok, status: decisionResult ? Reflect.get(decisionResult, 'status') : null,
            executionOk: execution && typeof execution === 'object' ? Reflect.get(execution, 'ok') : null,
            errorCode: decided.ok ? execution && typeof execution === 'object' ? Reflect.get(execution, 'errorCode') : null : decided.errorCode,
            physicalBirths: spawn.mock.calls.length,
        };
        expect(decisionSummary, JSON.stringify(decisionSummary)).toMatchObject({ ok: true, status: 'executed', executionOk: true });
        if (requester.id !== owner.id) expect(actionHttp).toContainEqual({ path: '/v1/actions/approval.request.decide/execution-authorization', status: 200 });
        expect(actionHttp).toContainEqual({ path: '/v1/actions/approval.request.decide', status: 200 });
        const artifact = await account.fetchArtifact(artifactId);
        if (!artifact || typeof artifact.body !== 'string') throw new Error('Executed original Artifact missing');
        const approval = ApprovalRequestSchema.parse(JSON.parse(artifact.body));
        expect(approval.actionArgs).toEqual(pendingApproval.actionArgs);
        expect(approval.v === 2 && approval.executionOriginV1).toEqual(pendingApproval.v === 2 && pendingApproval.executionOriginV1);
        const outputSchema = getActionSpec(actionId).outputSchema;
        if (!outputSchema) throw new Error('Terminal Action output schema missing');
        const receipt = DaemonTerminalEnsureResponseSchema.parse(outputSchema.parse(approval.execution?.result));
        expect(receipt).toMatchObject({ ok: true, terminalId: expect.any(String), reused: false });
        if (!receipt.ok) throw new Error('Expected a physical terminal receipt');
        const settled: unknown[] = [];
        if (approval.v !== 2) throw new Error('Original execution origin missing');
        const nativeGuard = createCliActionDeps({ token: requesterToken, credentials: { token: requesterToken, encryption: null },
            sessionId: session.id, serverId: homeId, serverHttpBaseUrl: endpoint, mode: 'plain', ctx: null,
            machineActionDirectTargetTransport: { machineId: machine.id,
                invoke: (method: string, payload: unknown, options?: Parameters<RpcHandlerManager['invokeLocal']>[2]) => installed.getPeerMediationMachineRpcHandlerManager().invokeLocal(method, payload, options) } });
        // Refute a broad alias bypass at the native owner. These are restrictive
        // mutations of the actual verified replay origin, never public UI scope.
        const retainedContext = { surface: approval.executionOriginV1.surface, authority: approval.executionOriginV1.authority,
            serverId: approval.executionOriginV1.serverId, serverIdentityId: approval.executionOriginV1.serverIdentityId,
            executionRunTargetMachineId: approval.executionOriginV1.machineId, bypassApprovals: true };
        for (const refused of [
            { input: { machineId: machine.id, serverId: 'unrelated-creator-profile' }, context: retainedContext },
            { input: { machineId: machine.id, serverId: learned.id }, context: { ...retainedContext, serverIdentityId: 'srv_foreign_home' } },
            { input: { machineId: 'foreign-machine', serverId: learned.id }, context: retainedContext },
        ]) {
            await expect(nativeGuard.machineTerminalAction!({ actionId: 'machines.terminal.list', ...refused }))
                .rejects.toMatchObject({ code: 'server_scope_mismatch' });
        }
        const continuation = createActionApprovalContinuation({ artifactId, actionId, scope: account.accountLifetime.scope,
            expectedInput: approval.actionArgs, expectedRequestId: approval.executionOriginV1.requestId,
            expectedExecutionOrigin: approval.executionOriginV1,
            onSucceeded: value => { settled.push(value); }, onFailed: code => { throw new Error(code); } });
        expect(await continuation.onExecuted(artifact)).toBe('consumed');
        expect(settled).toEqual([receipt]);
        const custody = lifecycle.getFiniteTerminalSessions().getCustody(receipt.terminalId);
        const custodySummary = { physicalBirths: spawn.mock.calls.length,
            retainedTerminals: lifecycle.getFiniteTerminalSessions().list().length,
            kind: custody?.kind ?? 'unqualified',
            originalRequester: custody?.requesterAccountId === requester.id };
        expect(custodySummary, JSON.stringify(custodySummary)).toMatchObject({ physicalBirths: 1,
            retainedTerminals: 1, kind: 'session', originalRequester: true });
        const census = await executor.execute('machines.terminal.list', { machineId: machine.id, serverId: learned.id }, uiContext);
        expect(census).toMatchObject({ ok: true, result: { ok: true, terminals: [{ terminalId: receipt.terminalId,
            terminalKey: request.terminalKey, cwd: request.cwd, sessionId: request.sessionId }] } });
        // The pane/member outlives its view. Both the returning view and its
        // remount recover actual requester custody through the real census;
        // neither carries a cached process id nor asks to approve another open.
        for (const mount of targetKind === 'paired-terminal' ? [] : ['selected-recipient', 'selected-return', 'returning', 'reopened', 'phone-pane-params', 'cold-alias', 'phone-terminal', 'wide-terminal', 'wide-chat', 'phone-remount'] as const) {
            const href = buildScopedSessionRouteHref({ sessionId: session.id,
                serverId: mount === 'reopened' ? homeId : browserProfileId });
            let coldHost: typeof paneHost | undefined;
            if (mount.startsWith('selected-')) {
                // A pane recipient owns a different destination window instance,
                // while its selected slot retains the source's exact scope/member.
            } else if (mount === 'returning') {
                // ApprovalSessionContextCard uses the Expo URL ingress. Its
                // return omits the original pane's bottom=terminal presentation.
                await act(async () => { expect(navigation.openHref(`/inbox?item=${encodeURIComponent(`approval:${learned.id}:${artifactId}`)}`)).toBe(true); });
                // Browser reload/restore uses the actual local layout producer.
                const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
                expect(parseWorkspaceLayout(workspaceLayoutsState.read(layoutKey))?.tabs['original-pane']).toBeDefined();
                expect(navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId].target.kind).toBe('inbox');
                // ApprovalSessionContextCard imports Expo's router directly.
                // Deliver its produced bare URL through real provider adoption.
                expoRouter.push(href);
                await paneHost.rerender();
            } else if (mount === 'reopened') {
                // Session-list rows live in the app rail, alongside an ordinary destination pane.
                await act(async () => { expect(navigation.openHref('/projects')).toBe(true); });
                await act(async () => { expect(navigation.openHref(href)).toBe(true); });
            } else if (mount === 'phone-pane-params') {
                // R66 remains on /session/<id>: the cockpit adds its Terminal
                // selection to the retained desktop bottom-pane parameters.
                expoRouter.push(`${href}&bottom=terminal&right=terminal`);
                await paneHost.rerender();
            } else if (mount === 'cold-alias') {
                // Full reload: retire the provider, round-trip its actual saved
                // layout and mount from the alias URL with terminal presentation.
                await paneHost.unmount();
                const { workspaceLayoutsState } = await import('@/sync/domains/state/filePaneUiState');
                workspaceLayoutsState.set(layoutKey, JSON.parse(JSON.stringify(workspaceLayoutsState.read(layoutKey))));
                expect(parseWorkspaceLayout(workspaceLayoutsState.read(layoutKey))?.tabs['original-pane'])
                    .toMatchObject({ preview: false, target: { params: { serverId: homeId, bottom: 'terminal' } } });
                expoRouter.push(`${href}&bottom=terminal`);
                coldHost = await renderHook(() => useMachineTerminalActionAdmission({ terminalKey: request.terminalKey,
                    machineId: machine.id, serverId: learned.id, scopeId, memberId: member.id }), { wrapper });
                context.onTestFinished(coldHost.unmount);
            } else {
                // Width/route remounts re-admit the phone Terminal child URL,
                // then the desktop Session URL, through the real provider.
                const terminalHref = mount === 'wide-chat'
                    ? `${href}&mobileSurface=chat`
                    : mount === 'wide-terminal'
                    ? `${href}&bottom=terminal&right=terminal`
                    : `/session/${session.id}/terminal?serverId=${browserProfileId}&bottom=terminal&right=terminal`;
                expoRouter.push(terminalHref);
                coldHost = await renderHook(() => null, { wrapper });
                context.onTestFinished(coldHost.unmount);
            }
            const pane = navigation.state.tabs[navigation.state.groups[navigation.state.focusedGroupId].activeTabId];
            expect.soft(pane.id, 'Route remount must retain the original pane before return adoption').toBe('original-pane');
            const returningScope = createSessionPaneScopeId(session.id, pane.target.params.serverId, pane.id);
            expect.soft(returningScope, 'The retained pane must keep its terminal workspace').toBe(scopeId);
            expect.soft(resolveSessionTerminalIdentity({ sessionId: session.id, scopeId: returningScope, terminal: member }).terminalKey)
                .toBe(request.terminalKey);
            const returningRequest = { ...request, terminalKey: resolveSessionTerminalIdentity({ sessionId: session.id,
                scopeId: returningScope, terminal: member }).terminalKey };
            const driverWrapper: React.ComponentType<React.PropsWithChildren> = ({ children }) => React.createElement(InjectedAuthProvider,
                { credentials: requesterCredentials }, React.createElement(AppPaneProvider, null,
                React.createElement(DestinationInstanceHost,
                    { tabId: mount === 'selected-recipient' ? 'recipient-instance' : pane.id, ref: pane.target, pathname: navigationBoundary.pathname, focused: true, visible: true,
                        navigation: navigation.navigationForTab(pane.id) }, children)));
            if (targetKind === 'own-session') {
                // Use the actual renderer controller and request producer, including
                // its ready/resize lifecycle rather than manually invoking admission.
                const renderer = await renderHook(() => {
                    const driverScope = useRegisterSessionPaneDriver(session.id, pane.target.params.serverId, undefined,
                        mount.startsWith('selected-') ? { scopeId } : undefined);
                    expect(driverScope).toBe(scopeId);
                    const identity = resolveSessionTerminalIdentity({ sessionId: session.id, scopeId: driverScope, terminal: member });
                    return useSessionEmbeddedTerminalPaneModel({ sessionId: session.id, scopeId: driverScope,
                        currentDockLocation: mount.startsWith('phone') ? 'sidebar' : 'bottom',
                        terminal: member, terminalIdentity: identity, focused: true }).controller;
                }, { wrapper: driverWrapper });
                try {
                    await act(async () => { renderer.getCurrent().onReady(mount.startsWith('phone') ? 42 : 160, 24); });
                    await vi.waitFor(() => expect(renderer.getCurrent().terminalId !== null
                        || renderer.getCurrent().approvalPending || renderer.getCurrent().status === 'error').toBe(true), { timeout: 30_000 });
                    expect(renderer.getCurrent(), mount).toMatchObject({ terminalId: receipt.terminalId,
                        approvalPending: false, error: null });
                    expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(1);
                } finally { await renderer.unmount(); }
            }
            const hook = await renderHook(() => {
                const driverScope = useRegisterSessionPaneDriver(session.id, pane.target.params.serverId, undefined,
                    mount.startsWith('selected-') ? { scopeId } : undefined);
                expect.soft(driverScope).toBe(scopeId);
                const identity = resolveSessionTerminalIdentity({ sessionId: session.id, scopeId: driverScope, terminal: member });
                return useMachineTerminalActionAdmission({ terminalKey: identity.terminalKey,
                    machineId: machine.id, serverId: learned.id, scopeId: driverScope, memberId: member.id });
            }, { wrapper: driverWrapper });
            const interest = new AbortController();
            let observed: Awaited<ReturnType<ReturnType<typeof useMachineTerminalActionAdmission>['admit']>> | undefined;
            const admission = hook.getCurrent().admit(returningRequest, false, interest.signal).then(value => { observed = value; return value; });
            try {
                await vi.waitFor(() => expect(observed !== undefined || hook.getCurrent().approvalPending).toBe(true), { timeout: 30_000 });
                expect(observed, mount).toEqual({ ok: true, terminalId: receipt.terminalId, reused: true });
                expect(hook.getCurrent().approvalPending).toBe(false);
                expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(1);
            } finally { interest.abort(); await admission; await hook.unmount(); await coldHost?.unmount(); }
        }
        expect(lifecycle.getFiniteTerminalSessions().list()).toHaveLength(1);
        expect(spawn).toHaveBeenCalledTimes(1);
        expect(await db.artifact.count({ where: { accountId: requester.id } })).toBe(1);
        const exit = lifecycle.getFiniteTerminalSessions().waitForExit({ terminalId: receipt.terminalId });
        const closeInput = { serverId: targetKind === 'own-session' ? daemonProfileId : homeId,
            machineId: machine.id, terminalId: receipt.terminalId };
        // C12 cleanup originated at the CLI Account carrier, then replayed its exact
        // original approval. An own-Machine UI direct close is a different ingress.
        const closed = pairedCredentials ? await dispatchPairedClose(closeInput) : targetKind === 'own-session'
            ? await createCliActionExecutorFromCredentials({ credentials: cliCredentials, serverId: daemonProfileId,
                serverApiUrl: endpoint, pluginActionExecutionOwner: 'current_process' })
                .execute('machines.terminal.close', closeInput, { surface: 'cli', authority: 'present_user',
                    actionCaller: { kind: 'host' }, serverId: daemonProfileId, actionRequestId: crypto.randomUUID() })
            : await executor.execute('machines.terminal.close', closeInput, { ...uiContext, actionRequestId: crypto.randomUUID(),
                presentUserConfirmation: { actionId: 'machines.terminal.close' } });
        if (!closed.ok) throw new Error(`Session close approval refused: ${closed.errorCode}`);
        expect(closed).toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        const closeApproval = ActionApprovalRequestCreatedResultSchema.parse(closed.result);
        if (pairedCredentials) {
            const pendingCloseArtifact = await account.fetchArtifact(closeApproval.artifactId);
            if (typeof pendingCloseArtifact?.body !== 'string') throw new Error('Paired terminal close Artifact missing');
            const pendingClose = ApprovalRequestSchema.parse(JSON.parse(pendingCloseArtifact.body));
            if (pendingClose.v !== 2) throw new Error('Paired terminal execution origin missing');
            const origin = pendingClose.executionOriginV1;
            const authorization = origin.externalActionExecutionAuthorization;
            if (!authorization) throw new Error('Paired terminal signed root missing');
            expect(authorization.binding).toMatchObject({ authentication: { kind: 'terminal' },
                accountId: requester.id, custodianAccountId: owner.id, machineId: machine.id,
                installationId: installation.installationId });
            expect(authorization.requesterAccountContext).toBeUndefined();
            // Restrictive mutations of the real stored proof cannot borrow the
            // deciding Account's custody or close the retained requester PTY.
            for (const foreignBinding of [{ accountId: owner.id }, { installationId: crypto.randomUUID() }]) {
                const foreign = ApprovalRequestSchema.parse({ ...pendingClose, executionOriginV1: { ...origin,
                    ...('accountId' in foreignBinding ? { accountId: foreignBinding.accountId } : {}),
                    externalActionExecutionAuthorization: { ...authorization,
                        binding: { ...authorization.binding, ...foreignBinding } } } });
                const foreignArtifactId = await account.createArtifact(buildApprovalRequestArtifactHeaderV1(foreign), JSON.stringify(foreign));
                try {
                    const refused = await executor.execute('approval.request.decide', { artifactId: foreignArtifactId, decision: 'approve' },
                        { ...uiContext, actionRequestId: crypto.randomUUID() });
                    expect(refused).toMatchObject({ ok: true, result: { status: 'failed', execution: { ok: false } } });
                    expect(lifecycle.getFiniteTerminalSessions().list()).toMatchObject([{ terminalId: receipt.terminalId }]);
                } finally { await account.workflowArtifacts.delete(foreignArtifactId); }
            }
        }
        if (targetKind === 'own-session') {
            const originalCloseArtifact = await account.fetchArtifact(closeApproval.artifactId);
            if (typeof originalCloseArtifact?.body !== 'string') throw new Error('Original CLI close Artifact missing');
            const originalClose = ApprovalRequestSchema.parse(JSON.parse(originalCloseArtifact.body));
            const binding = originalClose.v === 2 ? originalClose.executionOriginV1.externalActionExecutionAuthorization?.binding : null;
            expect({ hasOriginalProof: Boolean(binding), requesterMatches: binding?.accountId === owner.id,
                homeMatches: binding?.serverIdentityId === homeId, machineMatches: binding?.machineId === machine.id,
                installationMatches: binding?.installationId === installation.installationId })
                .toEqual({ hasOriginalProof: true, requesterMatches: true, homeMatches: true, machineMatches: true, installationMatches: true });
            const conflictingTarget = await createCliActionExecutorFromCredentials({ credentials: cliCredentials,
                serverId: daemonProfileId, serverApiUrl: endpoint, pluginActionExecutionOwner: 'current_process' })
                .execute('machines.terminal.close', { ...closeInput, machineId: crypto.randomUUID() }, {
                    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
                    serverId: daemonProfileId, externalActionTarget: { kind: 'machine', machineId: machine.id } });
            expect(conflictingTarget).toMatchObject({ ok: false, errorCode: 'target_unavailable' });
        }
        const decision = targetKind === 'own-session'
            ? await createCliActionExecutorFromCredentials({ credentials: cliCredentials, serverId: daemonProfileId,
                serverApiUrl: endpoint, pluginActionExecutionOwner: 'current_process' })
                .execute('approval.request.decide', { artifactId: closeApproval.artifactId, decision: 'approve' }, {
                    surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' }, serverId: daemonProfileId,
                    actionRequestId: crypto.randomUUID(), presentUserConfirmation: { actionId: 'approval.request.decide' } })
            : await executor.execute('approval.request.decide', { artifactId: closeApproval.artifactId, decision: 'approve' },
                { ...uiContext, actionRequestId: crypto.randomUUID(), presentUserConfirmation: { actionId: 'approval.request.decide' } });
        const closeDecisionResult = decision.ok && decision.result && typeof decision.result === 'object' ? decision.result : null;
        const closeDecisionExecution = closeDecisionResult ? Reflect.get(closeDecisionResult, 'execution') : null;
        const decisionShape = { ok: decision.ok, status: closeDecisionResult ? Reflect.get(closeDecisionResult, 'status') : null,
            executionOk: closeDecisionExecution && typeof closeDecisionExecution === 'object' ? Reflect.get(closeDecisionExecution, 'ok') : null,
            errorCode: !decision.ok ? decision.errorCode : closeDecisionExecution && typeof closeDecisionExecution === 'object'
                ? Reflect.get(closeDecisionExecution, 'errorCode') : null };
        expect(decisionShape, JSON.stringify(decisionShape)).toMatchObject({ ok: true, status: 'executed', executionOk: true });
        const closeArtifact = await account.fetchArtifact(closeApproval.artifactId);
        if (!closeArtifact || typeof closeArtifact.body !== 'string') throw new Error('Session close receipt missing');
        const closeRequest = ApprovalRequestSchema.parse(JSON.parse(closeArtifact.body));
        expect(DaemonTerminalCloseResponseSchema.parse(getActionSpec('machines.terminal.close').outputSchema!.parse(closeRequest.execution?.result)))
            .toEqual({ ok: true });
        expect(await exit).toMatchObject({ kind: 'exited' });
        expect(lifecycle.getFiniteTerminalSessions().list()).toHaveLength(0);
    }, 180_000);
});
