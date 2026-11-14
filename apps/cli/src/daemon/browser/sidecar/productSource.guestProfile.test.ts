import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { FeaturesResponseSchema, type ExternalActionExecutionAuthorizationV1, type RuntimeActionIdV1 } from '@happier-dev/protocol';
import { DaemonBrowserControlDispatchResponseV1Schema, DaemonBrowserViewListResponseV1Schema, type BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { ApiMachineClient } from '@/api/apiMachine';
import { createDaemonMachineRpcRouteAttachmentCache } from '@/daemon/machineRpcRouteAttachments';
import { registerDaemonBrowserViewWatchHandler } from '@/rpc/handlers/daemonBrowserControl';
import { createDaemonControlApp } from '@/daemon/controlServer';
import { buildDaemonControlHttpHeaders } from '@/daemon/controlHttp';
import { createDaemonRuntimeActionExecutor } from '@/daemon/runtimeActionExecutor';
import type { TrackedSession } from '@/daemon/types';
import { requesterActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from '../actions/controlTransport';
import { createBrowserDaemonControlBroker } from '../control/broker';
import { createBrowserDaemonControlRoutes } from '../control/routes';
import { createBrowserDaemonViewDiscovery } from '../control/viewDiscovery';
import { createBrowserAutomationDaemonService } from '../automation/service';
import { createBrowserAutomationRoutes } from '../automation/routes';
import { createBrowserAutomationReverseDispatcher } from '../automation/reverseDispatch';
import { createSidecarCdpDiagnosticsRuntime } from './diagnostics/runtime';
import { createBrowserDiagnosticsRoutes } from '../diagnostics/routes';
import { DEFAULT_BROWSER_RECORDING_CAPABILITIES } from '@happier-dev/protocol/features/payload/capabilities/browserCapabilities';
import { createBrowserDiagnosticsActionRoutes } from '../diagnostics/actionRoutes';
import { createBrowserDiagnosticsDaemonStore } from '../diagnostics/store';
import { createBrowserDiagnosticsInteractionTransport } from '../diagnostics/interactionTransport';
import { createBrowserRecordingDaemonRuntime } from '../recording/runtime';
import { createBrowserContextRoutes } from '../context/routes';
import { createSidecarCdpBrowserContextSource } from '../context/cdp/productSource';
import { createTransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import { createBrowserAutomationCdpAdapter } from '../automation/adapters/cdp';
import { createControlAdapterAutomationTransport } from '../automation/adapters/controlBridge';
import { createBrowserProfileStore } from '../profiles/store';
import { createBrowserExtensionService } from '../extensions/service';
import { createBrowserStoragePartitionOwner } from '../storage/partitions';
import { createBrowserSidecarLaunchOwnerControlAdapterFactory } from './launchOwner';
import { createProductBrowserSidecarControlAdapterFactory } from './productSource';

const profileIngresses = ['Session', 'signed Machine'] as const;
const profileRoles = ['use', undefined, 'manage', 'owner'] as const;
it.each([
    ...profileIngresses.flatMap(ingress => profileRoles.map(role => ({ ingress, role }))),
    ...(['use', 'manage', 'owner'] as const).map(role => ({ ingress: 'raw Machine RPC' as const, role })),
])(
    'isolates guest profiles while preserving $role custody through $ingress', async ({ role, ingress }) => {
    const root = await mkdtemp(join(tmpdir(), 'browser-guest-profile-'));
    const profiles = createBrowserProfileStore({ storageRootDirectory: root,
        partitionOwner: createBrowserStoragePartitionOwner({ storageRootDirectory: root }) });
    const persistent = await profiles.registerPersistentProfile({ profileId: 'owner-personal', storageMode: 'user',
        owner: { kind: 'user', id: 'owner' }, cleanupOnSessionClose: false });
    const extension = { id: 'a'.repeat(32), name: 'Fixture', version: '1', enabled: true,
        source: { kind: 'unpacked' as const, directory: '/fixture' }, directory: join(root, 'extension'),
        permissions: [], hostPermissions: [], actionPopup: 'popup.html' };
    await profiles.setExtension(persistent.profileId, extension);
    // Private lifecycle custody, with the same shape as the SEC-FIX-CU fixture.
    const guest = { happySessionId: 'guest-session', startedBy: 'daemon', pid: 4242,
        requesterSessionRuntimeContext: role === 'owner' ? undefined : { bootstrap: { savedSecretOperationContext: { machineAdmission: {
            actorAccountId: 'guest', custodianAccountId: 'owner', role } } } } } as unknown as TrackedSession;
    const launches: string[][] = [];
    const cdpCommands: string[] = [];
    let holdNextHistory: (() => Promise<void>) | undefined;
    const runtime = await createProductBrowserSidecarControlAdapterFactory({ profileStore: profiles,
        readSessionAccountId: (sessionId: string) => sessionId === 'guest-session' || sessionId === 'raw-guest-session'
            ? 'guest' : sessionId === 'owner-session' || sessionId === 'machine-session' ? 'owner' : null,
        resolveManagedCandidate: async () => ({ source: 'managedBrowserPackage', executablePath: '/managed/chrome',
            discoveryKind: 'managedRuntime', available: true, provenance: { origin: 'managed_package',
                pinnedVersion: '127.0.6533.88', channel: 'stable', integrityDigest: `sha256:${'a'.repeat(64)}`, license: 'BSD-3-Clause' } }),
        createLaunchOwnerFactory: input => createBrowserSidecarLaunchOwnerControlAdapterFactory({ ...input,
            // Only the native process and CDP transport boundaries are substituted.
            spawnProcess: (_executable, args) => {
                launches.push([...args]);
                const child = new EventEmitter();
                const stderr = new PassThrough();
                return Object.assign(child, { pid: 84, stderr,
                    stdio: [null, null, stderr, new PassThrough(), new PassThrough()],
                    kill: () => { child.emit('exit', 0, 'SIGTERM'); return true; } });
            },
            connectTransport: async () => ({ transport: { openPage: async () => ({ targetId: 'target', sessionId: 'cdp' }),
                dispatchPageCommand: async input => { cdpCommands.push(input.method);
                    if (input.method === 'Page.getNavigationHistory' && holdNextHistory) {
                        const hold = holdNextHistory;
                        holdNextHistory = undefined;
                        await hold();
                    }
                    if (input.method === 'DOMSnapshot.captureSnapshot') return { strings: [], documents: [{
                        nodes: { parentIndex: [], backendNodeId: [], nodeName: [], nodeValue: [], attributes: [] },
                        layout: { nodeIndex: [], styles: [] },
                    }] };
                    return input.method === 'Runtime.evaluate' ? { result: { type: 'number', value: 42 } } : {}; },
                dispatchBrowserCommand: async input => { cdpCommands.push(input.method); return { success: true }; } } }),
        }),
    })({ machineId: 'machine', readMachineMemory: () => ({ reported: true, totalBytes: 8 * 1024 ** 3,
        availableBytes: 8 * 1024 ** 3, usedBytes: 0, pressure: { level: 'calm', source: 'none' } }) });
    if (!runtime.ok) throw new Error(runtime.errorCode);
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(runtime.adapter);
    const context = createBrowserContextRoutes({ ownerAccountId: 'owner',
        source: createSidecarCdpBrowserContextSource({ contextCapture: runtime.contextCapture!, workingDirectory: root,
            pathAllowanceRegistry: createTransferPathAllowanceRegistry() }),
        resolveGate: () => ({ featureEnabled: true, policyAllowed: true, runtimeAvailable: true }),
    });
    const automation = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({
        transport: createControlAdapterAutomationTransport({ adapter: runtime.adapter, contextCapture: runtime.contextCapture,
            browserContext: context }),
    }) });
    const control = createBrowserDaemonControlRoutes({ broker, automation: () => automation,
        extensions: createBrowserExtensionService({ profileStore: profiles, runtime: runtime.extensions }) });
    const diagnosticsInteraction = createBrowserDiagnosticsInteractionTransport({ contextCapture: runtime.contextCapture! });
    const discarded: string[] = [];
    const attached: string[] = [];
    const machineClients: ApiMachineClient[] = [];
    const recording = createBrowserRecordingDaemonRuntime({ workingDirectory: root,
        // Native capture and session-media persistence are the recording OS boundaries.
        captureAdapters: [{ captureKind: 'cdpScreencast', start: async () => ({ status: 'started' }),
            stop: async () => ({ durationMs: 10, byteSize: 10, frameCount: 1, fps: 1, mimeType: 'video/webm',
                source: { kind: 'local-file', path: join(root, 'capture.webm'), mimeType: 'video/webm' } }),
            discard: async () => {} }, { captureKind: 'nativeViewCapture', start: async () => ({ status: 'started' }),
            stop: async () => ({ durationMs: 10, byteSize: 10, frameCount: 1, fps: 1, mimeType: 'image/png',
                source: { kind: 'local-file', path: join(root, 'mounted.png'), mimeType: 'image/png' } }), discard: async () => {} }],
        mediaWriter: { persistRecording: async ({ artifact }) => ({ refKind: 'sessionMedia', mediaId: 'media',
            mediaKind: artifact.mimeType.startsWith('image/') ? 'image' : 'video',
            mimeType: artifact.mimeType, sizeBytes: artifact.byteSize }), discardRecording: async ({ recording }) => { discarded.push(recording.recordingId); } },
        resolveStartContext: () => ({ browserRecordingEnabled: true, captureSourceAvailable: true, recordingCapabilities: {
            ...DEFAULT_BROWSER_RECORDING_CAPABILITIES, enabled: true, available: true,
            supportedCaptureKinds: ['cdpScreencast', 'nativeViewCapture'], supportedAdapterKinds: ['chromiumSidecar', 'externalUrl'],
            supportedMimeTypes: ['video/webm', 'image/png'], supportedRetentionClasses: ['preSend'], disabledReasons: [], policyDeniedReasons: [],
        } }),
    });
    const diagnosticsStore = createBrowserDiagnosticsDaemonStore({ machineId: 'machine' });
    const recordingInput = (view: Readonly<{ browserSessionId: string; viewId: string }>, recordingId: string) => ({
        ...view, recordingId, profileId: runtime.contextCapture?.resolveProfile?.(view)?.profileId ?? 'missing-fixture-profile', targetKind: 'externalUrl' as const, adapterKind: 'chromiumSidecar' as const,
        renderEngineKind: 'streamedSurface' as const, captureKind: 'cdpScreencast' as const, fidelity: 'cdp' as const,
        navigationGeneration: 0, mimeType: 'video/webm', retentionClass: 'preSend' as const,
    });
    const seedRecording = async (view: Readonly<{ browserSessionId: string; viewId: string }>, recordingId: string, expiresAtMs?: number, finalize = true) => {
        expect(await recording.routes.startRecording(recordingInput(view, recordingId))).toMatchObject({ status: 'started' });
        if (finalize) expect(await recording.routes.stopRecording({ recordingId, navigationGenerationEnd: 0, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) })).toMatchObject({ status: 'finalized' });
    };
    const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({
        browserControl: control, browserContext: context, browserAutomation: createBrowserAutomationRoutes({ service: automation }),
        browserUiAutomation: { ownsAutomationView: broker.ownsView,
            uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => null }) },
        browserDiagnostics: createBrowserDiagnosticsActionRoutes({
            store: diagnosticsStore, interaction: diagnosticsInteraction }),
        browserRecording: recording.routes,
        // The composer commit is an outbound Session-media boundary.
        attachBrowserRecordingToComposer: async ({ recordingId }) => { attached.push(recordingId); return { ok: true, attachmentId: recordingId }; },
    }), resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
        attachments: { uploads: { enabled: true } },
        browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true },
            automation: { enabled: true }, diagnostics: { enabled: true }, recording: { enabled: true, attachments: { enabled: true } }, context: { enabled: true } },
    } }) }) });
    const viewActions = (view: Readonly<{ browserSessionId: string; viewId: string }>) => [
        { actionId: 'browser.automation.snapshot', input: { v: 1, ...view, automationRequestId: 'profile-snapshot',
            navigationGeneration: 0, requestedBy: 'user', requesterRef: { kind: 'user', id: 'fixture' },
            actionKind: 'snapshot', payload: {} }, expected: { status: 'succeeded' } },
        { actionId: 'browser.automation.click', input: { v: 1, ...view, automationRequestId: 'profile-click',
            navigationGeneration: 0, requestedBy: 'user', requesterRef: { kind: 'user', id: 'fixture' },
            actionKind: 'click', payload: { x: 10, y: 10 } }, expected: { status: 'succeeded' } },
        { actionId: 'browser.diagnostics.eval', input: { v: 1, ...view, evalRequestId: 'profile-eval',
            navigationGeneration: 0, tier: 'cdp', expression: '6 * 7', objectGroupId: 'profile', diagnosticsInteractionEnabled: true },
            expected: { status: 'completed', result: { value: 42 } } },
        { actionId: 'browser.diagnostics.snapshot', input: view, expected: { v: 1, events: [] } },
        { actionId: 'browser.recording.listForView', input: view, expected: [] },
        { actionId: 'browser.context.capturePage', input: { ...view, navigationGeneration: 0, contextId: 'profile-page' },
            expected: { lifecycleState: 'available' } },
    ] satisfies ReadonlyArray<{ actionId: RuntimeActionIdV1; input: unknown; expected: unknown }>;
    const executeViewActions = async (view: Readonly<{ browserSessionId: string; viewId: string }>, denied: boolean) => {
        const nativeBefore = [...cdpCommands];
        const controlBefore = automation.getStatus(view);
        const actions = [...viewActions(view), ...(denied
            ? viewActions({ ...view, browserSessionId: ` ${view.browserSessionId} ` })
                .filter(action => action.actionId === 'browser.diagnostics.eval') : [])];
        for (const action of actions) {
            const result = await execute({ actionId: action.actionId, input: action.input, context: { authority: 'present_user', surface: 'ui',
                actionCaller: { kind: 'host' }, ...machineContext(role) } });
            if (denied) expect.soft(result).toMatchObject({ ok: false, errorCode: 'profile_policy_denied' });
            else expect.soft(result).toMatchObject(action.expected);
        }
        if (denied) {
            expect.soft(cdpCommands).toEqual(nativeBefore);
            expect.soft(automation.getStatus(view)).toEqual(controlBefore);
        }
    };
    const app = createDaemonControlApp({ getChildren: () => [guest], machineId: 'machine', controlToken: 'profile-test',
        stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
        requestShutdown: () => {}, onHappySessionWebhook: () => {},
        runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {},
            resolveRouteOwners: () => ({ browserControl: control }),
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
            } }) }),
        }) });
    const open = (sessionId: string, browserSessionId = sessionId, profileId?: string) =>
        app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('profile-test'), payload: { sessionId, actionId: 'browser.view.open', input: {
                kind: 'openView', commandId: `open:${sessionId}:${browserSessionId}`, browserSessionId, viewId: 'view', platform: 'web',
                ...(profileId ? { profileId } : {}), target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' },
            } } });
    const machineContext = (admittedRole: typeof role) => {
        if (admittedRole === 'owner') return undefined;
        // Admitted host-private ingress fixture: only the custody facet used by Browser is populated.
        const authorization = { requesterAccountProjection: { [requesterActionContext]: {
            savedSecretOperationContext: { machineAdmission: {
                actorAccountId: 'guest', custodianAccountId: 'owner', role: admittedRole,
            } },
        } } } as unknown as ExternalActionExecutionAuthorizationV1;
        return { externalActionExecutionAuthorization: authorization };
    };
    try {
        if (ingress !== 'Session') {
            // Raw routes may publish before sidecar enablement. Admission reads the current owner.
            let activeMachine: ApiMachineClient | null = null;
            const attachments = createDaemonMachineRpcRouteAttachmentCache({ getApiMachineForSessions: () => activeMachine });
            attachments.attachDevicesRoleRoutes({ browserContext: context, browserRecording: recording.routes,
                browserDiagnostics: createBrowserDiagnosticsRoutes({ store: diagnosticsStore }) });
            const attachMachine = () => {
                const client = new ApiMachineClient('profile-test-token', { id: 'machine', encryptionMode: 'plain',
                    metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0 });
                machineClients.push(client);
                activeMachine = client;
                attachments.attachApiMachineForSessions(client);
                const manager: unknown = Reflect.get(client, 'rpcHandlerManager');
                if (!(manager instanceof RpcHandlerManager)) throw new Error('Missing Machine RPC owner');
                registerDaemonBrowserViewWatchHandler(manager, createBrowserDaemonViewDiscovery({ broker }));
                return manager;
            };
            let rpc = attachMachine();
            attachments.attachDevicesRoleRoutes({ browserControl: control });
            const rawContext = {
                verifiedPeerAuthority: 'present_user' as const, rpcContext: { machineAdmission: {
                    actorAccountId: role === 'owner' ? 'owner' : 'guest', custodianAccountId: 'owner',
                    role: role === 'use' ? 'use' as const : 'manage' as const, machineId: 'machine',
                    installationId: 'installation', encryptionMode: 'plain' as const,
                } },
            };
            const exerciseRaw = async (view: Readonly<{ browserSessionId: string; viewId: string }>, denied: boolean) => {
                const nativeBefore = [...cdpCommands];
                const attachedBefore = [...attached];
                const base = { protocolVersion: 1, machineId: 'machine' };
                const recordingId = `${view.browserSessionId}-raw`;
                await seedRecording(view, recordingId);
                if (denied) {
                    profiles.register({ profileId: 'spoof-ephemeral', storageMode: 'ephemeral', owner: { kind: 'session', id: 'guest' } });
                    const spoofedInput = { ...recordingInput(view, 'spoofed-start'), profileId: 'spoof-ephemeral' };
                    expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_START,
                        { ...base, input: spoofedInput }, rawContext).catch((error: unknown) => error))
                        .toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                    expect.soft(await execute({ actionId: 'browser.recording.start', input: spoofedInput, context: {
                        authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                        .toMatchObject({ ok: false, errorCode: 'profile_policy_denied' });
                    expect.soft(await recording.routes.getRecordingStatus({ recordingId: 'spoofed-start' })).toBeNull();
                }
                for (const [actionId, fields, expected] of [
                    ['browser.recording.status', {}, { recordingId: `${recordingId}-runtime` }],
                    ['browser.recording.stop', { navigationGenerationEnd: 0 }, { status: 'finalized' }],
                    ['browser.recording.cancel', { reason: 'user_canceled' }, { status: 'canceled' }],
                    ['browser.recording.discard', { reason: 'user_discarded' }, { status: 'discarded' }],
                    ['browser.recording.attachToComposer', {}, { ok: true }],
                ] as const) {
                    const id = `${recordingId}-${actionId}`;
                    await seedRecording(view, id, undefined, actionId !== 'browser.recording.cancel');
                    const result = await execute({ actionId, input: { recordingId: id, ...fields }, context: {
                        authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } });
                    if (denied) expect.soft(result).toMatchObject({ ok: false, errorCode: 'profile_policy_denied' });
                    else expect.soft(result).toMatchObject(actionId === 'browser.recording.status' ? { recordingId: id } : expected);
                    await recording.routes.stopRecording({ recordingId: id, navigationGenerationEnd: 0 });
                }
                diagnosticsStore.publishEvent({ v: 1, ...view, navigationGeneration: 0, eventId: recordingId,
                    capturedAtMs: 1, family: 'network', kind: 'network.requestStarted', fidelity: 'cdp', trusted: true,
                    data: { method: 'GET', url: 'https://example.test/' },
                    redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false } });
                const calls: ReadonlyArray<readonly [string, unknown, unknown]> = [
                    [RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH, { machineId: 'machine', actionId: 'browser.context.capturePage',
                        input: { ...view, navigationGeneration: 0, contextId: 'raw-context' } }, { result: { lifecycleState: 'available' } }],
                    [RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT, { machineId: 'machine', view: { ...view, navigationGeneration: 0 } }, { snapshot: { events: [{ eventId: recordingId }] } }],
                    [RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT, { machineId: 'machine', view: { ...view, navigationGeneration: 0 }, requestId: 'request' }, { requestDetail: { status: 'unavailable' } }],
                    // sinceRevision below the current revision returns immediately through the real watch owner.
                    [RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT, { machineId: 'machine', view: { ...view, navigationGeneration: 0 }, sinceRevision: 0 }, { snapshot: { events: [{ eventId: recordingId }] } }],
                    [RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST, { ...base, ...view }, { recordings: expect.arrayContaining([expect.objectContaining({ recordingId })]) }],
                    [RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS, { ...base, recordingId }, { recording: { recordingId } }],
                    [RPC_METHODS.DAEMON_BROWSER_RECORDING_STOP, { ...base, recordingId, navigationGenerationEnd: 0, expiresAtMs: 1 }, { result: { status: 'finalized' } }],
                    [RPC_METHODS.DAEMON_BROWSER_RECORDING_CANCEL, { ...base, recordingId, reason: 'user_discarded' }, { result: { status: 'discarded' } }],
                    [RPC_METHODS.DAEMON_BROWSER_RECORDING_START, { ...base, input: recordingInput(view, `${recordingId}-start`) }, { result: { status: 'started' } }],
                ];
                for (const [method, request, expected] of calls) {
                    const result = await rpc.invokeLocal(method, request, rawContext).catch((error: unknown) => error);
                    if (denied) expect.soft(result).toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                    else expect.soft(result).toMatchObject(expected);
                }
                await recording.routes.stopRecording({ recordingId: `${recordingId}-start`, navigationGenerationEnd: 0 });
                const global = await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT, { machineId: 'machine' }, rawContext);
                if (denied) expect.soft(global).toMatchObject({ snapshot: { events: [] } });
                else expect.soft(global).toMatchObject({ snapshot: { events: expect.arrayContaining([expect.objectContaining({ eventId: recordingId })]) } });
                // Global cleanup may delete only admitted targets, with record→view resolved by the lifecycle owner.
                const expired = `${recordingId}-expired`;
                await seedRecording(view, expired, 1);
                expect(await recording.routes.stopRecording({ recordingId: expired, navigationGenerationEnd: 0, expiresAtMs: 1 }))
                    .toMatchObject({ status: 'finalized' });
                const beforeDiscard = [...discarded];
                const cleanup = await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_CLEANUP, { ...base, nowMs: 2 }, rawContext);
                expect.soft(cleanup).toMatchObject({ result: { discardedRecordingIds: denied ? [] : [expired] } });
                const actionExpired = `${recordingId}-action-expired`;
                await seedRecording(view, actionExpired, 1);
                await recording.routes.stopRecording({ recordingId: actionExpired, navigationGenerationEnd: 0, expiresAtMs: 1 });
                const actionCleanup = await execute({ actionId: 'browser.recording.cleanupExpired', input: { nowMs: 2 }, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } });
                expect.soft(actionCleanup).toMatchObject({ discardedRecordingIds: denied ? [] : [actionExpired] });
                if (denied) { expect.soft(attached).toEqual(attachedBefore); expect.soft(discarded).toEqual(beforeDiscard); expect.soft(cdpCommands).toEqual(nativeBefore); }
            };
            const dispatch = async (command: BrowserCommandV1) => ingress === 'raw Machine RPC'
                ? DaemonBrowserControlDispatchResponseV1Schema.parse(await rpc.invokeLocal(
                    RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, { machineId: 'machine', command }, rawContext)).result
                : control.dispatchCommand(command, machineContext(role));
            const readViews = async (browserSessionId: string, watch = false) => DaemonBrowserViewListResponseV1Schema.parse(
                await rpc.invokeLocal(watch ? RPC_METHODS.DAEMON_BROWSER_VIEW_WATCH : RPC_METHODS.DAEMON_BROWSER_VIEW_LIST,
                    { machineId: 'machine', browserSessionId, ...(watch ? { knownViewIds: ['foreign-view'] } : {}) }, rawContext)).views;
            const selected = await dispatch({ kind: 'openView', commandId: 'machine-profile-open',
                browserSessionId: 'machine-session', viewId: 'view', platform: 'web', focus: true, profileId: persistent.profileId,
                target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } });
            const popup = await control.extensions!.execute('browser.extensions.openActionPopup', {
                machineId: 'machine', browserSessionId: 'machine-session', viewId: 'popup', commandId: 'machine-popup',
                profileId: persistent.profileId, extensionId: extension.id,
            }, machineContext(role));
            const permitted = role === 'manage' || role === 'owner';
            expect(selected).toMatchObject({ status: permitted ? 'dispatched' : 'failed' });
            expect(popup).toMatchObject({ status: permitted ? 'dispatched' : 'failed' });
            const persistentDirectory = `--user-data-dir=${profiles.resolveProfileDirectory(persistent.profileId)}`;
            expect(launches.some(args => args.includes(persistentDirectory))).toBe(permitted);
            if (ingress === 'raw Machine RPC' && role === 'use') {
                const ownerView = { browserSessionId: 'guest-session', viewId: 'owner-view' };
                expect(await control.dispatchCommand({ kind: 'openView', commandId: 'owner-open', ...ownerView,
                    platform: 'web', profileId: persistent.profileId,
                    target: { kind: 'externalUrl', targetId: 'owner', url: 'https://example.test/' } }, { authority: 'present_user' }))
                    .toMatchObject({ status: 'dispatched' });
                const before = automation.getStatus(ownerView);
                await executeViewActions(ownerView, true);
                await expect(rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
                    { machineId: 'machine', actionId: 'browser.context.capturePage', input: { ...ownerView,
                        navigationGeneration: 0, contextId: 'late-owner' } }, rawContext))
                    .rejects.toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                rpc = attachMachine();
                await exerciseRaw(ownerView, true);
                // Mounted UI recordings have canonical profile IDs outside the native profile store.
                const mounted = { browserSessionId: 'mounted-session', viewId: 'mounted-view' };
                expect(await recording.routes.startRecording({ ...recordingInput(mounted, 'mounted-recording'),
                    profileId: 'mounted-ui-profile', adapterKind: 'externalUrl', renderEngineKind: 'desktopWebView',
                    captureKind: 'nativeViewCapture', fidelity: 'nativeCallback', mimeType: 'image/png', captureSource: {
                        kind: 'machineLiveStream', streamFamily: 'browser.view', sourceId: 'mounted-source' } }))
                    .toMatchObject({ status: 'started' });
                await recording.routes.stopRecording({ recordingId: 'mounted-recording', navigationGenerationEnd: 0 });
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
                    { protocolVersion: 1, machineId: 'machine', recordingId: 'mounted-recording' }, rawContext))
                    .toMatchObject({ recording: { recordingId: 'mounted-recording' } });
                expect.soft(await execute({ actionId: 'browser.recording.status', input: { recordingId: 'mounted-recording' }, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                    .toMatchObject({ recordingId: 'mounted-recording' });
                expect(await dispatch({ kind: 'openView', commandId: 'guest-profile-open',
                    browserSessionId: 'raw-guest-session', viewId: 'own-view', platform: 'web', focus: true,
                    target: { kind: 'externalUrl', targetId: 'own-fixture', url: 'https://example.test/' } }))
                    .toMatchObject({ status: 'dispatched' });
                for (const kind of ['raw', 'action']) {
                    const contextId = `contended-context-${kind}`;
                    let announceCapture!: () => void;
                    let resumeCapture!: () => void;
                    const captureEntered = new Promise<void>(resolve => { announceCapture = resolve; });
                    const captureMayFinish = new Promise<void>(resolve => { resumeCapture = resolve; });
                    holdNextHistory = async () => { announceCapture(); await captureMayFinish; };
                    const input = { browserSessionId: 'raw-guest-session', viewId: 'own-view', navigationGeneration: 0, contextId };
                    const guestCapture = kind === 'raw'
                        ? rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
                            { machineId: 'machine', actionId: 'browser.context.capturePage', input }, rawContext)
                        : execute({ actionId: 'browser.context.capturePage', input, context: { authority: 'present_user', surface: 'ui',
                            actionCaller: { kind: 'host' }, ...machineContext(role) } });
                    await captureEntered;
                    try {
                        expect(await execute({ actionId: 'browser.context.capturePage', input: { ...ownerView, navigationGeneration: 0, contextId },
                            context: { authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' } } }))
                            .toMatchObject({ contextId, sourceViewId: ownerView.viewId });
                    } finally { resumeCapture(); }
                    expect.soft(await guestCapture).toMatchObject(kind === 'raw'
                        ? { result: { ok: false, errorCode: 'runtime_action_disabled' } }
                        : { ok: false, errorCode: 'runtime_action_disabled' });
                    expect.soft(await context.dispatch('browser.context.attachToComposer', { ...ownerView, contextId }))
                        .toMatchObject({ state: 'available', sourceViewId: ownerView.viewId });
                }
                for (const phase of ['live', 'closed', 'reopened']) {
                    for (const kind of ['raw-attach', 'action-attach', 'raw-clear', 'action-clear', 'raw-capture', 'action-capture']) {
                        const contextId = `owner-${phase}-${kind}`;
                        expect(await execute({ actionId: 'browser.context.capturePage', input: { ...ownerView,
                            navigationGeneration: 0, contextId }, context: { authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' } } }))
                            .toMatchObject({ contextId, lifecycleState: 'available' });
                        expect(await context.dispatch('browser.context.attachToComposer', { ...ownerView, contextId }))
                            .toMatchObject({ contextId, state: 'available' });
                    }
                }
                const exerciseContextClaims = async (phase: 'live' | 'closed' | 'reopened') => {
                    for (const kind of ['raw-attach', 'action-attach', 'raw-clear', 'action-clear', 'raw-capture', 'action-capture']) {
                        const contextId = `owner-${phase}-${kind}`;
                        const input = kind.endsWith('capture')
                            ? { browserSessionId: 'raw-guest-session', viewId: 'own-view', navigationGeneration: 0, contextId }
                            : { browserSessionId: 'caller-claimed-own-session', viewId: 'caller-own-view', contextId };
                        const actionId = kind.endsWith('attach') ? 'browser.context.attachToComposer'
                            : kind.endsWith('capture') ? 'browser.context.capturePage' : 'browser.context.clear';
                        if (kind.startsWith('raw')) {
                            expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH,
                                { machineId: 'machine', actionId, input }, rawContext).catch((error: unknown) => error))
                                .toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                        } else {
                            expect.soft(await execute({ actionId, input, context: { authority: 'present_user', surface: 'ui',
                                actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                                .toMatchObject({ ok: false, errorCode: 'profile_policy_denied' });
                        }
                        expect.soft(await context.dispatch('browser.context.attachToComposer', { ...ownerView, contextId }))
                            .toMatchObject({ contextId, state: 'available', sourceViewId: ownerView.viewId });
                    }
                };
                await exerciseContextClaims('live');
                const nativeCommandsBefore = [...cdpCommands];
                expect.soft(await readViews(ownerView.browserSessionId)).toEqual([]);
                expect.soft(await readViews(ownerView.browserSessionId, true)).toEqual([]);
                const sessionList = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
                    headers: buildDaemonControlHttpHeaders('profile-test'), payload: { sessionId: 'guest-session',
                        actionId: 'browser.view.list', input: { machineId: 'machine', browserSessionId: ownerView.browserSessionId } } });
                expect.soft(sessionList.statusCode).toBe(200);
                expect.soft(sessionList.json().result).toMatchObject({ protocolVersion: 1, views: [] });
                const deniedCommands: BrowserCommandV1[] = [
                    { ...ownerView, kind: 'navigate', commandId: 'guest-navigate', url: 'https://example.test/guest' },
                    { ...ownerView, kind: 'takeControl', commandId: 'guest-take' },
                    { ...ownerView, kind: 'handBack', commandId: 'guest-handback' },
                    { ...ownerView, kind: 'reload', commandId: 'guest-reload' },
                    { ...ownerView, kind: 'setTarget', commandId: 'guest-target', target: {
                        kind: 'externalUrl', targetId: 'guest', url: 'https://example.test/guest' } },
                    { ...ownerView, kind: 'closeView', commandId: 'guest-close' },
                ];
                for (const command of deniedCommands) {
                    expect.soft(await dispatch(command)).toMatchObject({ status: 'failed', error: { code: 'profile_policy_denied' } });
                    expect.soft(automation.getStatus(ownerView)).toEqual(before);
                    expect.soft(cdpCommands).toEqual(nativeCommandsBefore);
                }
                // Production diagnostics clears on the native view lifecycle; finalized media persists.
                const capture = runtime.contextCapture!;
                const diagnosticsLifecycle = createSidecarCdpDiagnosticsRuntime({ ownerAccountId: 'owner', store: diagnosticsStore,
                    isEnabled: () => true, contextCapture: { transport: capture.transport,
                        getNavigationState: capture.getNavigationState!, resolvePageHandle: capture.resolvePageHandle,
                        subscribeCdpEvents: capture.subscribeCdpEvents!, subscribeViewLifecycle: capture.subscribeViewLifecycle! } });
                expect(await control.dispatchCommand({ ...ownerView, kind: 'closeView', commandId: 'owner-close' },
                    { authority: 'present_user' })).toMatchObject({ status: 'dispatched' });
                diagnosticsLifecycle.dispose();
                await exerciseContextClaims('closed');
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_DIAGNOSTICS_SNAPSHOT,
                    { machineId: 'machine' }, rawContext)).toMatchObject({ snapshot: { events: [] } });
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
                    { protocolVersion: 1, machineId: 'machine', recordingId: 'guest-session-raw-expired' }, rawContext)
                    .catch((error: unknown) => error)).toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                const retainedListInput = { machineId: 'machine', ...ownerView };
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
                    { protocolVersion: 1, ...retainedListInput }, rawContext)).toMatchObject({ recordings: [] });
                expect.soft(await execute({ actionId: 'browser.recording.listForView', input: ownerView, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } })).toEqual([]);
                // A Session can reopen with its default ephemeral profile while old owner media survives.
                expect(await dispatch({ kind: 'openView', commandId: 'same-session-ephemeral-open', ...ownerView,
                    platform: 'web', focus: true, target: { kind: 'externalUrl', targetId: 'own', url: 'https://example.test/' } }))
                    .toMatchObject({ status: 'dispatched' });
                await exerciseContextClaims('reopened');
                await seedRecording(ownerView, 'same-session-ephemeral-recording');
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
                    { protocolVersion: 1, machineId: 'machine', recordingId: 'guest-session-raw-expired' }, rawContext)
                    .catch((error: unknown) => error)).toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                expect.soft(await execute({ actionId: 'browser.recording.status', input: { recordingId: 'guest-session-raw-expired' }, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                    .toMatchObject({ ok: false, errorCode: 'profile_policy_denied' });
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_LIST,
                    { protocolVersion: 1, ...retainedListInput }, rawContext))
                    .toMatchObject({ recordings: [{ recordingId: 'same-session-ephemeral-recording' }] });
                expect.soft(await execute({ actionId: 'browser.recording.listForView', input: ownerView, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                    .toMatchObject([{ recordingId: 'same-session-ephemeral-recording' }]);
                expect(await dispatch({ kind: 'closeView', commandId: 'same-session-ephemeral-close', ...ownerView }))
                    .toMatchObject({ status: 'dispatched' });
                expect(await profiles.purgeForExplicitRequest({ profileIds: [persistent.profileId] }))
                    .toMatchObject({ purgedProfileIds: [persistent.profileId] });
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
                    { protocolVersion: 1, machineId: 'machine', recordingId: 'guest-session-raw-expired' }, rawContext)
                    .catch((error: unknown) => error)).toMatchObject({ rpcErrorCode: 'profile_policy_denied' });
                // Refusing owner custody must leave the guest's own browser usable.
                expect(runtime.contextCapture?.resolveProfile?.({ browserSessionId: 'raw-guest-session', viewId: 'own-view' }))
                    .toMatchObject({ storageMode: 'ephemeral', owner: { kind: 'session', id: 'raw-guest-session' } });
                expect(await dispatch({ kind: 'navigate', commandId: 'guest-own-navigate', browserSessionId: 'raw-guest-session',
                    viewId: 'own-view', url: 'https://example.test/own' })).toMatchObject({ status: 'dispatched' });
                expect(await dispatch({ kind: 'takeControl', commandId: 'guest-own-take', browserSessionId: 'raw-guest-session',
                    viewId: 'own-view' })).toMatchObject({ status: 'dispatched' });
                expect(await readViews('raw-guest-session')).toMatchObject([{ viewId: 'own-view' }]);
                expect(await readViews('raw-guest-session', true)).toMatchObject([{ viewId: 'own-view' }]);
                await executeViewActions({ browserSessionId: 'raw-guest-session', viewId: 'own-view' }, false);
                await exerciseRaw({ browserSessionId: 'raw-guest-session', viewId: 'own-view' }, false);
                for (const [actionId, contextId] of [['browser.context.capturePage', 'own-context-raw'], ['browser.context.capturePage', 'own-context-action']] as const) {
                    expect(await execute({ actionId, input: { browserSessionId: 'raw-guest-session', viewId: 'own-view',
                        navigationGeneration: 0, contextId }, context: { authority: 'present_user', surface: 'ui',
                        actionCaller: { kind: 'host' }, ...machineContext(role) } })).toMatchObject({ lifecycleState: 'available' });
                }
                expect(await dispatch({ kind: 'closeView', commandId: 'own-close', browserSessionId: 'raw-guest-session', viewId: 'own-view' }))
                    .toMatchObject({ status: 'dispatched' });
                expect(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_CONTEXT_DISPATCH, { machineId: 'machine',
                    actionId: 'browser.context.attachToComposer', input: { browserSessionId: 'another-session', viewId: 'another-view', contextId: 'own-context-raw' } }, rawContext))
                    .toMatchObject({ result: { state: 'available', sourceViewId: 'own-view' } });
                expect(await execute({ actionId: 'browser.context.attachToComposer', input: { browserSessionId: 'another-session',
                    viewId: 'another-view', contextId: 'own-context-action' }, context: { authority: 'present_user', surface: 'ui',
                    actionCaller: { kind: 'host' }, ...machineContext(role) } })).toMatchObject({ state: 'available', sourceViewId: 'own-view' });
                const ownRecordingId = 'raw-guest-session-raw-browser.recording.status';
                expect.soft(await rpc.invokeLocal(RPC_METHODS.DAEMON_BROWSER_RECORDING_STATUS,
                    { protocolVersion: 1, machineId: 'machine', recordingId: ownRecordingId }, rawContext))
                    .toMatchObject({ recording: { recordingId: ownRecordingId, status: 'finalized' } });
                expect.soft(await execute({ actionId: 'browser.recording.status', input: { recordingId: ownRecordingId }, context: {
                    authority: 'present_user', surface: 'ui', actionCaller: { kind: 'host' }, ...machineContext(role) } }))
                    .toMatchObject({ recordingId: ownRecordingId, status: 'finalized' });
                expect(launches).toHaveLength(3);
                expect(launches[1]).not.toContain(persistentDirectory);
            } else if (ingress === 'raw Machine RPC') {
                expect(await dispatch({ kind: 'navigate', commandId: 'manager-navigate', browserSessionId: 'machine-session',
                    viewId: 'view', url: 'https://example.test/owner' })).toMatchObject({ status: 'dispatched' });
                expect(await dispatch({ kind: 'takeControl', commandId: 'manager-take', browserSessionId: 'machine-session',
                    viewId: 'view' })).toMatchObject({ status: 'dispatched' });
                expect(await dispatch({ kind: 'handBack', commandId: 'manager-handback', browserSessionId: 'machine-session',
                    viewId: 'view' })).toMatchObject({ status: 'dispatched' });
                expect(await readViews('machine-session')).toEqual(expect.arrayContaining([expect.objectContaining({ viewId: 'view' })]));
                expect(await readViews('machine-session', true)).toEqual(expect.arrayContaining([expect.objectContaining({ viewId: 'view' })]));
                await executeViewActions({ browserSessionId: 'machine-session', viewId: 'view' }, false);
                await exerciseRaw({ browserSessionId: 'machine-session', viewId: 'view' }, false);
            }
            return;
        }
        const ownerDefault = await open('owner-session');
        expect(ownerDefault.statusCode).toBe(200);
        expect(ownerDefault.json().result).toMatchObject({ status: 'dispatched' });
        const selected = await open('guest-session', 'guest-session', persistent.profileId);
        expect(selected.statusCode).toBe(200);
        const popup = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('profile-test'), payload: { sessionId: 'guest-session',
                actionId: 'browser.extensions.openActionPopup', input: { machineId: 'machine',
                    browserSessionId: 'guest-session', viewId: 'popup', commandId: 'open-popup',
                    profileId: persistent.profileId, extensionId: extension.id } } });
        expect(popup.statusCode).toBe(200);
        // Security falsifier: a guest must not launch the custodian's persistent directory.
        const persistentDirectory = `--user-data-dir=${profiles.resolveProfileDirectory(persistent.profileId)}`;
        if (role === 'manage' || role === 'owner') {
            expect(selected.json().result).toMatchObject({ status: 'dispatched' });
            expect(popup.json().result).toMatchObject({ status: 'dispatched' });
            expect(launches.at(-1)).toContain(persistentDirectory);
        } else {
            expect(launches).toHaveLength(1);
            expect(launches.at(-1)).not.toContain(persistentDirectory);
            expect(selected.json().result).toMatchObject({ status: 'failed' });
            expect(popup.json().result).toMatchObject({ status: 'failed' });
            const ownDefault = await open('guest-session');
            expect(ownDefault.json().result).toMatchObject({ status: 'dispatched' });
            const directoryArgs = launches.map(args => args.find(arg => arg.startsWith('--user-data-dir=')));
            expect(new Set(directoryArgs).size).toBe(2);
            expect(directoryArgs).not.toContain(persistentDirectory);
            expect(runtime.contextCapture?.resolveProfile?.({ browserSessionId: 'guest-session', viewId: 'view' }))
                .toMatchObject({ storageMode: 'ephemeral', owner: { kind: 'session', id: 'guest-session' } });
        }
        // Machine opens carry the same private role to the same selection owner.
        const machine = await control.dispatchCommand({ kind: 'openView', commandId: 'machine-open',
            browserSessionId: 'guest-session', viewId: 'machine-view', platform: 'web',
            profileId: persistent.profileId, target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } },
            machineContext(role));
        expect(machine).toMatchObject({ status: role === 'manage' || role === 'owner' ? 'dispatched' : 'failed' });
        if (role === 'manage') {
            // A new Use open cannot silently reuse a persistent engine by omitting profileId.
            expect(await control.dispatchCommand({ kind: 'openView', commandId: 'reuse-owner-profile',
                browserSessionId: 'guest-session', viewId: 'new-guest-view', platform: 'web',
                target: { kind: 'externalUrl', targetId: 'fixture', url: 'https://example.test/' } },
                machineContext('use'))).toMatchObject({ status: 'failed' });
        }
        const forgedSession = await open('guest-session', 'owner-session');
        expect(forgedSession.statusCode).toBe(200);
        expect(forgedSession.json().result).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    } finally { for (const client of machineClients) client.shutdown(); await app.close(); await recording.stop(); await diagnosticsInteraction.dispose(); automation.dispose(); await runtime.dispose?.(); await rm(root, { recursive: true, force: true }); }
});
