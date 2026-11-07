import { createSnapshotCaptureTestRoutes, snapshotReadBoundaryFixture } from '../context/cdp/snapshotMasking.testkit';
import '../../../../../ui/sources/dev/vitestSetup';
import { createHash, randomBytes } from 'node:crypto';
import axios from 'axios';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import type { BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import { BrowserOpenViewInProgressV1Schema } from '@happier-dev/protocol/browser/control/v1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

const boundary = vi.hoisted(() => ({ home: '', download: vi.fn() }));
vi.mock('@/configuration', async importOriginal => ({ ...await importOriginal<typeof import('@/configuration')>(), configuration: {
    ...(await importOriginal<typeof import('@/configuration')>()).configuration,
    get happyHomeDir() { return boundary.home; },
    set happyHomeDir(value: string) { boundary.home = value; },
    get logsDir() { return join(boundary.home, 'logs'); },
} }));
// The daemon listener is an OS boundary; installed ingress and Action execution stay real.
vi.mock('@/daemon/controlServer', () => ({ startDaemonControlServer: async () => ({ port: 44322, stop: async () => {} }) }));
// Only the third-party download boundary is replaced. Extraction, digest/receipt
// validation, provisioning, refreshed routes, dispatch and operation custody are real.
vi.mock('@happier-dev/cli-common/agents', async importOriginal => ({
    ...await importOriginal<typeof import('@happier-dev/cli-common/agents')>(),
    downloadGitHubReleaseAsset: boundary.download,
}));

import { installChromiumForTesting } from '@/packagedRuntime/installables/sourceAdapters/chromiumForTesting';
import { createHostActionOperationRuntime } from '../../actionOperations/createHostActionOperationRuntime';
import { createDaemonRuntimeActionExecutor, type DaemonRuntimeActionRouteOwners } from '../../runtimeActionExecutor';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserSidecarCdpControlAdapter } from './controlAdapter';
import { createBrowserAutomationRuntimeProvisioner } from './provisioning';
import { createBrowserAutomationRoutes } from '../automation/routes';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { resolveManagedBrowserSidecarCandidate } from './source';
import { ApiMachineClient, createActionOperationSnapshotPublisher } from '@/api/apiMachine';
import { createRequesterSessionControlRuntimeFixture } from '../../testkit/requesterSessionControlRuntimeFixture';
import { ConnectedServiceRuntimeRegistry } from '../../connectedServices/runtimeRegistry/registry';
import { readOrCreateInstallationIdentity } from '../../identity/store';
import { executeExternalAction } from '../../externalActions/executeExternalAction';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionAccountServerPrincipalV1Schema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { ACTION_OPERATION_RPC_METHODS_V2, ActionOperationGetV1ResponseSchema, ActionOperationListV1ResponseSchema } from '@happier-dev/protocol/actions/operations/v1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';
import type { ActionOperationRpcContext } from '../../actionOperations/actionOperationRpcHandlers';
import { logger } from '@/ui/logger';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createCliApprovalsArtifactStore } from '@/session/actions/approvals/artifactStore';
import { act, renderHook } from '../../../../../ui/sources/dev/testkit';
import { useSessionCompletedBrowserActionKey } from '../../../../../ui/sources/sync/store/hooks';
import { actionOperationStore } from '../../../../../ui/sources/sync/domains/actionOperations/actionOperationStore';
import { writeStoredCredentialsForServerId } from '@/persistence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { dispatchRuntimeAction } from '@happier-dev/protocol/actions/executor/dispatch';
import { createBrowserRuntimeActionExecutor } from '../../../../../ui/sources/sync/domains/browser/actions/runtimeActionExecutor';

// A tiny valid ZIP with an executable and companion file; no real Chromium is fetched.
const archive = Buffer.from('UEsDBBQAAAAAAKCqIl2/ze6ZDgAAAA4AAAASAAAAYWd5X2FjcF9zZXJ2ZXIucGFyc2VydmVyLWZpeHR1cmVQSwMEFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAABsb2NhbGhhcm5lc3NfZXh0ZXJuYWxoYXJuZXNzLWZpeHR1cmVQSwECFAMUAAAAAACgqiJdv83umQ4AAAAOAAAAEgAAAAAAAAAAAAAA7YEAAAAAYWd5X2FjcF9zZXJ2ZXIucGFyUEsBAhQDFAAAAAAAoKoiXeOBVF8PAAAADwAAABUAAAAAAAAAAAAAAO2BPgAAAGxvY2FsaGFybmVzc19leHRlcm5hbFBLBQYAAAAAAgACAIMAAACAAAAAAAA=', 'base64');
const asset = { archiveUrl: 'https://fixture.invalid/browser.zip', executableSubpath: 'agy_acp_server.par',
    integrityDigest: `sha256:${createHash('sha256').update(archive).digest('hex')}` };
const command = { kind: 'openView', commandId: 'approved-open', browserSessionId: 'session', viewId: 'view',
    platform: 'web', target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://page.invalid' } } as const;
const homes: string[] = [];
const pending: Promise<unknown>[] = [];
afterEach(async () => {
    await Promise.all(pending.splice(0));
    for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetServerFeaturesClientForTests();
    actionOperationStore.reset();
});

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function setup(pageOpenFailure?: Error, publishControlBeforeInstall = false) {
    boundary.home = await mkdtemp(join(tmpdir(), 'happier-browser-first-use-'));
    homes.push(boundary.home);
    const downloading = deferred();
    const release = deferred();
    const opened: string[] = [];
    boundary.download.mockImplementation(async ({ destinationPath, digest }: { destinationPath: string; digest: string }) => {
        expect(digest).toBe(asset.integrityDigest);
        downloading.resolve();
        await release.promise;
        await writeFile(destinationPath, archive);
    });
    const broker = createBrowserDaemonControlBroker();
    let routes: DaemonRuntimeActionRouteOwners = {};
    const errors: unknown[] = [];
    const provisioner = createBrowserAutomationRuntimeProvisioner({ platform: 'linux', arch: 'x64', onError: error => errors.push(error),
        resolveManagedCandidate: params => resolveManagedBrowserSidecarCandidate({ ...params, assetOverride: asset }),
        installManagedBrowserChromium: params => installChromiumForTesting({ ...params, asset }),
        refreshRouteOwners: async () => {
            expect(await resolveManagedBrowserSidecarCandidate({ platform: 'linux', arch: 'x64', assetOverride: asset }))
                .toMatchObject({ available: true });
            // Match the publication owner's idempotent reuse of an existing adapter.
            if (routes.browserAutomation) return;
            // CDP is the other external boundary; real adapter/broker own view state.
            const transport = { openPage: async ({ url }: { url: string }) => {
                    if (pageOpenFailure) throw pageOpenFailure;
                    opened.push(url); return { targetId: 'target', sessionId: 'cdp' };
                },
                dispatchPageCommand: async (command: { method: string; params?: Record<string, unknown> }) => snapshotReadBoundaryFixture(command)
                    ?? (command.method === 'Runtime.evaluate' ? { result: { type: 'string', value: 'Provisioned page' } } : {}),
                dispatchBrowserCommand: async () => ({}) };
            const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'session', sidecarId: 'sidecar', transport });
            broker.registerAdapter(adapter);
            const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
                transport: createControlAdapterAutomationTransport({ adapter,
                    browserContext: createSnapshotCaptureTestRoutes({ transport, resolvePageHandle: adapter.resolvePageHandle }),
                    contextCapture: { transport, resolvePageHandle: adapter.resolvePageHandle,
                        getNavigationState: adapter.getNavigationState } }) }) });
            routes = { ...routes, browserControl: createBrowserDaemonControlRoutes({ broker }),
                browserAutomation: createBrowserAutomationRoutes({ service }),
                browserUiAutomation: { ownsAutomationView: broker.ownsView,
                    uiAutomation: async () => { throw new Error('Owned managed view must not dispatch to UI'); } } };
        },
    });
    routes = { provisionBrowserAutomationRuntime: provisioner.provision,
        ...(publishControlBeforeInstall ? { browserControl: createBrowserDaemonControlRoutes({ broker }) } : {}) };
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account',
        generateOperationId: (() => { let count = 0; return () => count++ ? `open-operation-${count}` : 'first-open-operation'; })() });
    let sidecarEnabled = true;
    const runtime = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: () => routes,
        observeExecution: operations.observeExecution,
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: sidecarEnabled }, automation: { enabled: true } },
        } }) }),
    });
    const uiRuntime = createBrowserRuntimeActionExecutor({ executeOnMachine: args => dispatchRuntimeAction({
        ...args, runtimeActionExecute: runtime,
    }) });
    const execute = async (input: BrowserCommandV1 = command) => {
        const result = await dispatchRuntimeAction({ runtimeActionExecute: uiRuntime, actionId: 'browser.view.open', input,
            context: { surface: 'agent', authority: 'account_automation', bypassApprovals: true,
                externalActionTarget: { kind: 'machine', machineId: 'machine' } } });
        const accepted = BrowserOpenViewInProgressV1Schema.safeParse(result);
        if (accepted.success) pending.push(operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, accepted.data.operationId));
        return result;
    };
    const snapshot = () => runtime({ actionId: 'browser.automation.snapshot', input: {
        v: 1, automationRequestId: 'after-provisioning', browserSessionId: 'session', viewId: command.viewId,
        navigationGeneration: 0, actionKind: 'snapshot', payload: {}, requestedBy: 'agent', timeoutMs: 5_000,
        requesterRef: { kind: 'agent', id: 'first-use-agent' },
    }, context: { surface: 'agent', authority: 'account_automation', bypassApprovals: true, defaultSessionId: 'session' } });
    return { execute, snapshot, operations, broker, downloading, release, opened, provisioner, routes: () => routes, errors,
        disableSidecar: () => { sidecarEnabled = false; },
        clearRoutes: () => { routes = {}; },
        installBeforeOpen: async () => {
            // Sandbox installation uses this same acquisition owner before installing
            // the OS profile. No daemon route refresh accompanies that CLI/Action effect.
            expect(await resolveManagedBrowserSidecarCandidate({ platform: 'linux', arch: 'x64', assetOverride: asset }))
                .toMatchObject({ available: false });
            release.resolve();
            expect(await installChromiumForTesting({ platform: 'linux', arch: 'x64', asset })).toMatchObject({ ok: true });
            expect(broker.listViews('session')).toEqual([]);
            expect(routes.browserControl).toBeUndefined();
            boundary.download.mockClear();
        } };
}

async function setupInstalledRequester(requesterAccountId = 'bob', replayRoute: 'decision' | 'daemon' = 'decision') {
    const browser = await setup();
    const directory = boundary.home;
    const homeId = 'srv_browser_first_use';
    const endpoint = 'https://browser-first-use.test';
    const token = (accountId: string, terminal = false) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 0,
        provenance: { v: 1, kind: terminal ? 'terminal' : 'account', authority: terminal ? 'account_automation' : 'present_user' } })).toString('base64url')}.signature`;
    const credentials = { token: token('alice', true), encryption: null };
    const currentnessChannel = await createRequesterCurrentnessSocketHarness();
    const settings = { actionsSettingsV1: { v: 1, actions: { 'browser.view.open': { approvalRequiredSurfaces: ['ui', 'rpc', 'cli'] } } } };
    let artifact: Record<string, unknown> | undefined;
    let originalAuthorizationCurrent = true;
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async url => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return Response.json({ id: requesterAccountId });
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } } },
            capabilities: { serverIdentity: { serverIdentityId: homeId } } });
        throw new Error(`Unexpected Home fetch: ${path}`);
    }));
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/account/profile') return { status: 200, data: { id: String(options?.headers?.Authorization).includes(credentials.token) ? 'alice' : requesterAccountId } };
        if (path === '/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
        if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } } };
        if (path === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: settings }, version: 1 } };
        if (path === '/v1/artifacts') return { status: 200, data: artifact ? [artifact] : [] };
        if (artifact && path === `/v1/artifacts/${artifact.id}`) return { status: 200, data: artifact };
        // The real store admits HTTP statuses with validateStatus, then treats 404 as absent.
        if (/^\/v1\/artifacts\/[^/]+$/.test(path)) return { status: 404, data: { error: 'Artifact not found' } };
        throw new Error(`Unexpected Home read: ${path}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith('/execution-authorization/verify')) return {
            status: !originalAuthorizationCurrent && path === bindExternalActionExecutionAuthorizationVerifyHttpPathV1('browser.view.open') ? 403 : 200,
            data: { ok: true },
        };
        if (path === '/v1/artifacts') {
            const value = readCarrierMutation(body);
            artifact = { ...value, ownerAccountId: requesterAccountId, access: 'owner', encryptionMode: 'plain',
                headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
            return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
        }
        if (artifact && path === `/v1/artifacts/${artifact.id}`) {
            const value = readCarrierMutation(body);
            expect(value.expectedHeaderVersion).toBe(artifact.headerVersion);
            expect(value.expectedBodyVersion).toBe(artifact.bodyVersion);
            artifact = { ...artifact, ...value, headerVersion: Number(artifact.headerVersion) + 1, bodyVersion: Number(artifact.bodyVersion) + 1 };
            return { status: 200, data: { success: true, headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion } };
        }
        throw new Error(`Unexpected Home write: ${path}`);
    });
    let machine!: ApiMachineClient;
    const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' }, resolveRouteOwners: browser.routes,
        observeExecution: request => machine.observeActionExecution(request),
        resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
            browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
        } }) }),
    });
    const installed = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory,
        activeServerDir: join(directory, 'servers', homeId), serverId: homeId, serverHttpBaseUrl: endpoint,
        machineId: 'machine', custodianAccountId: 'alice', credentials,
        connectedServicesMaterializationBaseDir: join(directory, 'connected-services'), registry: new ConnectedServiceRuntimeRegistry(),
        trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'advertised',
        getApiMachineForSessions: () => machine,
        beforeStartup: async () => {
            await writeStoredCredentialsForServerId(homeId, credentials);
            await readOrCreateInstallationIdentity();
            machine = new ApiMachineClient(credentials.token, { id: 'machine', encryptionMode: 'plain',
                encryptionKey: new Uint8Array(32), encryptionVariant: 'legacy', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
        },
        startup: { runtimeActionExecute, resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'machine', serverIdentityId: homeId }) },
    });
    const installation = installed.installation!;
    const ingress = installed.runtime.externalActionIngressOwner!;
    // Production Machine bootstrap registers RPCs with the installed ingress
    // owner. Registering before startup instead selects standalone replay.
    machine.setRPCHandlers({ spawnSession: async () => ({ type: 'error', errorMessage: 'Unexpected launch' }),
        stopSession: async () => false, requestShutdown: () => {} }, { externalActionIngressOwner: ingress });
    const phaseDiagnostics = vi.spyOn(logger, 'warnLocalFile');
    const invoke = async (actionId: 'browser.view.open' | 'approval.request.decide', input: unknown, requestId: string, replayApproved = false) => {
        const target = { kind: 'machine' as const, machineId: 'machine' };
        const envelope = { v: 1 as const, requestId, target, input };
        const authentication = { kind: 'account' as const, tokenEpoch: 0 };
        const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'browser-root', binding: {
            accountId: requesterAccountId, custodianAccountId: 'alice', authentication, accountEncryptionMode: 'plain',
            machineId: 'machine', installationId: installation.installationId, serverIdentityId: homeId,
            actionId, requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target } });
        const boxed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
            invocation: { caller: { kind: 'host' }, surface: 'ui', authority: 'present_user', defaultSessionId: 'session' },
            installationPublicKey: decodeBase64(installation.publicKey, 'base64url'), credentials: { token: token(requesterAccountId) },
            randomBytes: length => new Uint8Array(randomBytes(length)) });
        if (replayApproved) {
            const prepared = await ingress.prepareRequesterAccountContext!({ authorization: boxed });
            if (!prepared) throw new Error('Requester replay custody was not admitted');
            try {
                return await machine.invokeLocalMachineAction(RPC_METHODS.APPROVAL_REQUEST_REPLAY_APPROVED,
                    { artifactId: artifact?.id }, { rpcContext: { ...requesterContext, signal: new AbortController().signal,
                        callerAuthority: 'present_user', callerInputAuthorization: prepared.authorization } });
            } finally { await prepared.dispose(); }
        }
        const outcome = await executeExternalAction({ actionId, envelope, surface: 'ui',
            principal: ExternalActionAccountServerPrincipalV1Schema.parse({ accountId: requesterAccountId, authentication, authority: 'present_user' }),
            currentMachineId: 'machine', currentServerId: homeId, currentServerHttpBaseUrl: endpoint,
            currentInstallationId: installation.installationId, executionAuthorization: boxed,
            externalActionMachineRequestPrivateKey: decodeBase64(installation.privateKey, 'base64url'),
            verifyExecutionAuthorization: async () => true, prepareRequesterAccountContext: ingress.prepareRequesterAccountContext,
            resolveTarget: ingress.resolveTarget, resolveEncryption: ingress.resolveEncryption, executor: ingress.executor });
        if (outcome.kind !== 'response') throw new Error(`Invalid installed request: ${JSON.stringify(outcome)}; phases=${JSON.stringify(
            phaseDiagnostics.mock.calls.filter(([name]) => name === '[external-action-phase]').map(([, detail]) => detail))}`);
        return outcome.response.execution;
    };
    const requesterContext: ActionOperationRpcContext = { machineAdmission: { actorAccountId: requesterAccountId, custodianAccountId: 'alice',
        machineId: 'machine', installationId: installation.installationId, role: 'use', encryptionMode: 'plain' }, verifyMachineAdmissionCurrent: async () => true };
    const read = async (operationId: string, waitForTerminal = false, requester = true) => ActionOperationGetV1ResponseSchema.parse(
        await machine.invokeLocalMachineAction(ACTION_OPERATION_RPC_METHODS_V2.get, { operationId, ...(waitForTerminal ? { waitForTerminal: true } : {}) },
            requester ? { rpcContext: requesterContext } : undefined));
    const list = async (requester = true) => ActionOperationListV1ResponseSchema.parse(await machine.invokeLocalMachineAction(
        ACTION_OPERATION_RPC_METHODS_V2.list, {}, requester ? { rpcContext: requesterContext } : undefined));
    const approvals = createCliApprovalsArtifactStore({ credentials: { token: token(requesterAccountId), encryption: null }, serverId: homeId });
    return { ...browser, machine, invoke, read, credentials, homeId,
        retireOriginalAuthorization: () => { originalAuthorizationCurrent = false; },
        approve: async () => {
            if (replayRoute === 'daemon') {
                const request = ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: String(artifact?.id) }));
                if (request.status === 'open') {
                    // The deciding-client fixture commits through the real Artifact
                    // transition/CAS owner; the registered daemon RPC owns replay.
                    const decidedAtMs = Date.now();
                    expect(await approvals.approvalsUpdate({ artifactId: String(artifact?.id), request: {
                        ...request, status: 'approved', updatedAtMs: decidedAtMs,
                        decision: { kind: 'approve', authority: 'present_user', decidedAtMs },
                    } })).toMatchObject({ ok: true });
                }
            }
            return await invoke('approval.request.decide', { artifactId: artifact?.id, decision: 'approve' },
                'approve-first-use', replayRoute === 'daemon');
        },
        approval: async () => ApprovalRequestV2Schema.parse(await approvals.approvalsGet({ artifactId: String(artifact?.id) })),
        list,
        close: async () => {
            browser.release.resolve();
            try {
                for (const requester of [true, false]) {
                    for (const operation of (await list(requester)).items) await read(operation.operationId, true, requester);
                }
            } finally { await installed.dispose(); await machine.shutdown(); await currentnessChannel.close(); }
        },
    };
}

describe('managed Browser provisioning through the approved first open', () => {
    it('refuses daemon replay when the original requester authorization is no longer current', async () => {
        const fixture = await setupInstalledRequester('bob', 'daemon');
        try {
            const approval = await fixture.invoke('browser.view.open', command, 'first-use');
            expect(approval, JSON.stringify(approval)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created' } });
            fixture.retireOriginalAuthorization();
            // The daemon RPC starts a new replay admission, not just a consent receipt.
            // Approval cannot revive the original requester's withdrawn authorization.
            expect(await fixture.approve()).toMatchObject({ ok: false, errorCode: 'approval_stale' });
            // Requester-confirmation admission refuses replay before an execution claim;
            // the previously committed consent remains, without an execution receipt.
            const approved = await fixture.approval();
            expect(approved).toMatchObject({ status: 'approved', decision: { kind: 'approve' } });
            expect(approved.execution).toBeUndefined();
            expect((await fixture.list()).items).toEqual([]);
            expect(fixture.opened).toEqual([]);
            expect(boundary.download).not.toHaveBeenCalled();
        } finally { await fixture.close(); }
    });
    it.each([
        { accountId: 'bob', replayRoute: 'decision' as const },
        { accountId: 'alice', replayRoute: 'decision' as const },
        { accountId: 'bob', replayRoute: 'daemon' as const },
        { accountId: 'alice', replayRoute: 'daemon' as const },
    ])('keeps $replayRoute approval replay with admitted requester $accountId through terminal completion', async ({ accountId, replayRoute }) => {
        const fixture = await setupInstalledRequester(accountId, replayRoute);
        const observation = vi.spyOn(fixture.machine, 'observeActionExecution');
        try {
            const approval = await fixture.invoke('browser.view.open', command, 'first-use');
            expect(approval, JSON.stringify(approval)).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created' } });
            expect(fixture.opened).toEqual([]);
            expect(boundary.download).not.toHaveBeenCalled();
            expect((await fixture.list()).items).toEqual([]);
            expect(await fixture.approve()).toMatchObject({ ok: true });
            const accepted = BrowserOpenViewInProgressV1Schema.parse((await fixture.approval()).execution?.result);
            await fixture.downloading.promise;
            // Repeated approval joins the Artifact's original execution; it must
            // not create a second operation while the first download is held.
            expect(await fixture.approve()).toMatchObject({ ok: true });
            expect((await fixture.list()).items).toHaveLength(1);
            const admitted = observation.mock.calls.find(([request]) => request.actionId === 'browser.view.open')?.[0].rpcContext;
            expect(await fixture.list()).toMatchObject({ items: [{ operationId: accepted.operationId, scope: { accountId } }] });
            expect(await admitted?.verifyMachineAdmissionCurrent?.()).toBe(true);
            const running = await fixture.read(accepted.operationId);
            expect(running).toMatchObject({ kind: 'found', operation: { state: 'running', scope: { accountId, sessionId: 'session' } } });
            if (running.kind !== 'found') throw new Error('Missing requester operation');
            actionOperationStore.mergeSnapshots({ serverId: fixture.homeId, snapshots: [running.operation] });
            const requesterDiscovery = await renderHook(() => useSessionCompletedBrowserActionKey('session', {
                operationScope: { serverId: fixture.homeId, accountId, machineId: 'machine' } }));
            const custodianDiscovery = await renderHook(() => useSessionCompletedBrowserActionKey('session', {
                operationScope: { serverId: fixture.homeId, accountId: 'alice', machineId: 'machine' } }));
            expect(requesterDiscovery.getCurrent()).toBe('');
            if (accountId !== 'alice') {
                expect(await fixture.list(false)).toMatchObject({ items: [] });
                expect(await fixture.read(accepted.operationId, false, false)).toEqual({ kind: 'not_found' });
            }
            fixture.release.resolve();
            const terminal = await fixture.read(accepted.operationId, true);
            expect(terminal).toMatchObject({ kind: 'found', operation: { state: 'succeeded', scope: { accountId } } });
            expect(await admitted?.verifyMachineAdmissionCurrent?.()).toBe(false);
            if (terminal.kind !== 'found') throw new Error('Missing requester terminal operation');
            await act(async () => actionOperationStore.mergeSnapshots({ serverId: fixture.homeId, snapshots: [terminal.operation] }));
            expect(requesterDiscovery.getCurrent()).not.toBe('');
            if (accountId !== 'alice') expect(custodianDiscovery.getCurrent()).toBe('');
            await requesterDiscovery.unmount();
            await custodianDiscovery.unmount();
            expect(await fixture.list()).toMatchObject({ items: [{ operationId: accepted.operationId, state: 'succeeded' }] });
            expect(fixture.broker.listViews('session')).toMatchObject([{ viewId: command.viewId }]);
            expect(fixture.opened).toEqual([command.target.url]);
            expect(await fixture.approve()).toMatchObject({ ok: true });
            expect(fixture.opened).toHaveLength(1);
            const installed = { ...command, commandId: 'already-installed', viewId: 'installed-view' };
            expect(await fixture.invoke('browser.view.open', installed, 'installed-request')).toMatchObject({ ok: true,
                result: { kind: 'approval_request_created' } });
            expect(await fixture.approve()).toMatchObject({ ok: true });
            expect((await fixture.approval()).execution).toMatchObject({ ok: true,
                result: { commandId: installed.commandId, status: 'dispatched' } });
            expect(fixture.opened).toEqual([command.target.url, command.target.url]);
            expect(boundary.download).toHaveBeenCalledOnce();
            const installedOperations = (await fixture.list()).items;
            expect(installedOperations).toHaveLength(2);
            const installedOperation = installedOperations.find(operation => operation.requestId === 'installed-request');
            expect(installedOperation).toMatchObject({ actionId: 'browser.view.open', state: 'succeeded', scope: { accountId } });
            expect(await fixture.read(installedOperation!.operationId)).toMatchObject({ kind: 'found', operation: {
                result: { commandId: installed.commandId, status: 'dispatched' },
            } });
            expect(await fixture.approve()).toMatchObject({ ok: true });
            expect((await fixture.list()).items).toHaveLength(2);
            expect(fixture.opened).toHaveLength(2);
            if (terminal.kind === 'found' && accountId !== 'alice') {
                const published: unknown[] = [];
                await createActionOperationSnapshotPublisher({ resolveAccountId: async () => 'alice', serverBaseUrl: 'https://browser-first-use.test',
                    readCredentials: async () => fixture.credentials, publishContent: content => published.push(content) })(terminal.operation);
                expect(published).toEqual([]);
            }
        } finally { await fixture.close(); }
    });
    it.each([false, true])('accepts an installing open with an existing control route=%s, then opens that same view once after route refresh', async publishControlBeforeInstall => {
        const fixture = await setup(undefined, publishControlBeforeInstall);
        try {
            const result = await fixture.execute();
            expect(result).toMatchObject({ status: 'in_progress', commandId: command.commandId,
                operationId: 'first-open-operation', phase: 'browser_runtime_provisioning' });
            expect(getActionSpec('browser.view.open').outputSchema.safeParse(result).success).toBe(true);
            await fixture.downloading.promise;
            expect(fixture.broker.listViews('session')).toEqual([]);
            fixture.release.resolve();
            const terminal = await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'first-open-operation');
            expect(terminal).toMatchObject({ state: 'succeeded', result: { commandId: command.commandId, status: 'dispatched' } });
            expect(fixture.broker.listViews('session')).toMatchObject([{ browserSessionId: 'session', viewId: 'view' }]);
            expect(fixture.opened).toEqual([command.target.url]);
            expect(boundary.download).toHaveBeenCalledOnce();
            expect(await fixture.snapshot()).toMatchObject({ status: 'succeeded', fidelity: 'cdp',
                resultSummary: { visibleText: 'Provisioned page' } });
        } finally { fixture.release.resolve(); }
    });

    it('refreshes cold routes after sandbox acquisition installed Chromium outside the daemon', async () => {
        const fixture = await setup();
        await fixture.installBeforeOpen();
        expect(await fixture.execute()).toMatchObject({ status: 'dispatched', commandId: command.commandId });
        expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'first-open-operation'))
            .toMatchObject({ state: 'succeeded', result: { status: 'dispatched', commandId: command.commandId } });
        expect(fixture.broker.listViews('session')).toMatchObject([{ viewId: command.viewId }]);
        expect(fixture.opened).toEqual([command.target.url]);
        expect(boundary.download).not.toHaveBeenCalled();
    });

    it('preserves distinct feature-decision and genuinely absent route causes through UI and protocol dispatch', async () => {
        const fixture = await setup();
        try {
            fixture.clearRoutes();
            expect(await fixture.execute()).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled',
                details: { cause: 'browser_control_route_unavailable', phase: 'browser.control.route_resolution', retryable: false } });
            fixture.disableSidecar();
            expect(await fixture.execute({ ...command, commandId: 'disabled-open' })).toMatchObject({ ok: false,
                errorCode: 'runtime_action_disabled',
                details: { cause: 'browser_sidecar_disabled', phase: 'browser.control.feature_decision', retryable: false } });
            expect(boundary.download).not.toHaveBeenCalled();
            expect(fixture.opened).toEqual([]);
        } finally { fixture.release.resolve(); }
    });

    it('retains a typed actionable install failure on the accepted operation without opening a page', async () => {
        const fixture = await setup();
        boundary.download.mockImplementation(async () => { await fixture.release.promise; throw new Error('fixture network failure'); });
        try {
            expect(await fixture.execute()).toMatchObject({ status: 'in_progress' });
            fixture.release.resolve();
            const terminal = await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'first-open-operation');
            expect(terminal).toMatchObject({ state: 'failed', error: { errorCode: 'browser_runtime_provisioning_failed' } });
            expect(terminal?.error?.error).toMatch(/connection|disk/i);
            expect(fixture.opened).toEqual([]);
            expect(fixture.broker.listViews('session')).toEqual([]);
            expect(fixture.errors).toHaveLength(1);
            expect(String(fixture.errors[0])).toContain('fixture network failure');
            // A failure never retries on its own. A fresh explicit dispatch may retry.
            expect(boundary.download).toHaveBeenCalledOnce();
            boundary.download.mockImplementation(async ({ destinationPath }: { destinationPath: string }) => writeFile(destinationPath, archive));
            expect(await fixture.execute({ ...command, commandId: 'retry-open' })).toMatchObject({ status: 'in_progress' });
            expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'open-operation-2'))
                .toMatchObject({ state: 'succeeded' });
            expect(fixture.opened).toEqual([command.target.url]);
            expect(boundary.download).toHaveBeenCalledTimes(2);
        } finally { fixture.release.resolve(); }
    });
    it('does not dispatch an existing control route if the sidecar is disabled while provisioning', async () => {
        const fixture = await setup(undefined, true);
        try {
            const accepted = BrowserOpenViewInProgressV1Schema.parse(await fixture.execute());
            await fixture.downloading.promise;
            fixture.disableSidecar();
            fixture.release.resolve();
            expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, accepted.operationId))
                .toMatchObject({ state: 'failed', error: { errorCode: 'runtime_action_disabled',
                    error: 'runtime_action_disabled:browser:browser_sidecar_disabled',
                    failureCause: { phase: 'browser.control.feature_decision', errorClass: 'Error', errorCode: null, httpStatus: null } } });
            expect(fixture.opened).toEqual([]);
        } finally { fixture.release.resolve(); }
    });
    it('reprovisions on open when the installed executable disappears after control publication', async () => {
        const fixture = await setup();
        try {
            const first = BrowserOpenViewInProgressV1Schema.parse(await fixture.execute());
            fixture.release.resolve();
            expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, first.operationId))
                .toMatchObject({ state: 'succeeded' });
            const installed = await resolveManagedBrowserSidecarCandidate({ platform: 'linux', arch: 'x64', assetOverride: asset });
            if (!installed?.executablePath) throw new Error('Fixture Chromium executable was not installed');
            await rm(installed.executablePath);
            expect(await resolveManagedBrowserSidecarCandidate({ platform: 'linux', arch: 'x64', assetOverride: asset }))
                .toMatchObject({ available: false });
            const recovered = BrowserOpenViewInProgressV1Schema.parse(await fixture.execute({ ...command,
                commandId: 'recover-missing-install', viewId: 'recovered-view' }));
            expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, recovered.operationId))
                .toMatchObject({ state: 'succeeded', result: { commandId: 'recover-missing-install', status: 'dispatched' } });
            expect(fixture.broker.listViews('session')).toContainEqual(expect.objectContaining({ viewId: 'recovered-view' }));
            expect(boundary.download).toHaveBeenCalledTimes(2);
        } finally { fixture.release.resolve(); }
    });
    it('retains a typed command failure and its completion uncertainty for the bound operation get', async () => {
        const fixture = await setup(new Error('fixture CDP acknowledgement lost'));
        try {
            const accepted = BrowserOpenViewInProgressV1Schema.parse(await fixture.execute());
            fixture.release.resolve();
            const terminal = await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, accepted.operationId);
            // The Action returned a valid command result. Operation settlement
            // must preserve its physical-effect uncertainty and typed error.
            expect(terminal).toMatchObject({ state: 'succeeded', result: {
                commandId: command.commandId, status: 'failed', completion: 'unknown', error: { code: 'adapter_unavailable' },
            } });
            expect(fixture.opened).toEqual([]);
            const listed = await fixture.operations.handlers.listV2({});
            expect(listed.items[0]).not.toHaveProperty('result');
            expect(await fixture.operations.handlers.getV2({ operationId: accepted.operationId }))
                .toMatchObject({ kind: 'found', operation: { result: terminal?.result } });
            const installed = await fixture.execute({ ...command, commandId: 'installed-command-failure', viewId: 'installed-failure' });
            // Protocol projects a command failure once at the Action boundary;
            // the operation itself retains the original Browser command result.
            expect(installed).toMatchObject({ ok: false, errorCode: 'adapter_unavailable',
                details: { status: 'failed', completion: 'unknown', error: { code: 'adapter_unavailable' } } });
            const settled = (await fixture.operations.handlers.listV2({})).items;
            expect(settled).toHaveLength(2);
            const installedOperation = settled.find(operation => operation.operationId !== accepted.operationId);
            expect(await fixture.operations.handlers.getV2({ operationId: installedOperation!.operationId }))
                .toMatchObject({ kind: 'found', operation: { result: {
                    commandId: 'installed-command-failure', status: 'failed', completion: 'unknown',
                    error: { code: 'adapter_unavailable' },
                } } });
        } finally { fixture.release.resolve(); }
    });
    it('reports a thrown installer failure through onError without an unhandled operation rejection', async () => {
        const fixture = await setup();
        const failure = new Error('fixture download aborted');
        failure.name = 'AbortError';
        // The real archive installer rethrows cancellation at its external download boundary.
        boundary.download.mockRejectedValue(failure);
        try {
            expect(await fixture.execute()).toMatchObject({ status: 'in_progress' });
            expect(await fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, 'first-open-operation'))
                .toMatchObject({ state: 'failed', error: { errorCode: 'browser_runtime_provisioning_failed' } });
            expect(fixture.errors).toEqual([failure]);
            expect(fixture.opened).toEqual([]);
        } finally { fixture.release.resolve(); }
    });
    it('shares one install between concurrent opens and does not reacquire an installed browser', async () => {
        const fixture = await setup();
        try {
            const accepted = await Promise.all([fixture.execute(), fixture.execute({ ...command, commandId: 'second-open', viewId: 'second-view' })]);
            for (const result of accepted) expect(result).toMatchObject({ status: 'in_progress' });
            await fixture.downloading.promise;
            expect(boundary.download).toHaveBeenCalledOnce();
            fixture.release.resolve();
            const results = await Promise.all(['first-open-operation', 'open-operation-2'].map(id =>
                fixture.operations.runner.waitForTerminal({ accountId: 'account', machineId: 'machine' }, id)));
            expect(results.map(result => result?.state)).toEqual(['succeeded', 'succeeded']);
            expect(fixture.broker.listViews('session')).toHaveLength(2);
            expect(fixture.opened).toHaveLength(2);
            expect(await fixture.provisioner.provision()).toBe('ready');
            expect(boundary.download).toHaveBeenCalledOnce();
        } finally { fixture.release.resolve(); }
    });

    it('does not download or report progress for an unsupported platform', async () => {
        const onProvisioning = vi.fn();
        const refreshRouteOwners = vi.fn(async () => {});
        const provisioner = createBrowserAutomationRuntimeProvisioner({ platform: 'aix', arch: 'x64', refreshRouteOwners });
        expect(await provisioner.provision({ onProvisioning })).toBe('unavailable');
        expect(onProvisioning).not.toHaveBeenCalled();
        expect(refreshRouteOwners).not.toHaveBeenCalled();
        expect(boundary.download).not.toHaveBeenCalled();
    });
});
