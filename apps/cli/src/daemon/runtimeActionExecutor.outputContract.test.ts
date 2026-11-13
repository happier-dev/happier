import { expect, it } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { ACTION_ID_FAMILIES_V1, FeaturesResponseSchema, LocalServicePreviewResourceV1Schema } from '@happier-dev/protocol';
import type { LocalServicePublicExposureV1, LocalServicePublicPreviewSnapshotV1, RuntimeActionIdV1 } from '@happier-dev/protocol';
import { RUNTIME_ACTION_IDS_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableRuntimeActionExecutor, isRuntimeActionExecutorReal } from '@happier-dev/protocol/actions/executor/dispatch';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createLocalServiceActionConfirmationNonceV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { resolveLocalServiceActionKindForRuntimeActionId } from '@happier-dev/protocol/actions/specs/localServices';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { withActionOutputContract } from '@/testkit/actionOutputContract';
import { createProcessTreeTerminator } from '@/processes/terminate/terminateProcessTree';
import { createDaemonRuntimeActionExecutor, type DaemonRuntimeActionRouteOwners } from './runtimeActionExecutor';
import { createLocalServiceInventoryRegistry } from './local/services/inventory/registry';
import { createLocalServiceInventoryRoutes } from './local/services/inventory/routes';
import { createLocalServiceLauncherFeed } from './local/services/launch/feed';
import { createLocalServiceLauncherRoutes } from './local/services/launch/routes';
import { createLocalServiceLauncherHistoryStore, createLocalServiceLauncherLeafRoutes } from './local/services/launch/leaves';
import { createLocalServicePreviewRegistry } from './local/services/preview/registry';
import { createLocalServicePreviewRoutes } from './local/services/preview/routes';
import { createLocalServicePublicPreviewServerRoutes } from './local/services/public/routes';
import { createLocalServiceActionRoutes } from './local/services/actions/routes';
import { createTerminateDetectedService } from './local/services/actions/terminate';
import { createDaemonPeerMediationFlowEvent } from './peer/mediation/observability/events';
import { createDaemonPeerMediationObservabilityStore } from './peer/mediation/observability/store';
import { createBrowserAutomationCdpAdapter } from './browser/automation/adapters/cdp';
import { createBrowserAutomationDaemonService } from './browser/automation/service';
import { createBrowserAutomationRoutes } from './browser/automation/routes';
import { createBrowserDiagnosticsActionRoutes } from './browser/diagnostics/actionRoutes';
import { createBrowserDiagnosticsDaemonStore } from './browser/diagnostics/store';
import { createBrowserDaemonControlBroker } from './browser/control/broker';
import { createBrowserDaemonControlRoutes } from './browser/control/routes';
import { createBrowserSidecarCdpControlAdapter } from './browser/sidecar/controlAdapter';
import { createSimulatorPreviewDaemonRuntime } from './devices/simulator/runtime';
import { SimulatorPreviewActionResultV1Schema } from '@happier-dev/protocol/devices/simulator/runtimeV1';

const machineId = 'output-machine';
const sessionId = 'output-session';
const accountId = 'output-account';
const features = FeaturesResponseSchema.parse({ features: {
    localServices: { enabled: true, inventory: { enabled: true }, launcher: { enabled: true }, managed: { enabled: true },
        actions: { enabled: true, terminate: { enabled: true } }, preview: { enabled: true }, publicPreview: { enabled: true } },
    browser: { enabled: true, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true }, automation: { enabled: true },
        context: { enabled: true }, diagnostics: { enabled: true } },
    machines: { enabled: true, liveStream: { enabled: true }, peerMediation: { enabled: true, observability: { enabled: true } } },
    devices: { enabled: true, simulatorPreview: { enabled: true } },
}, capabilities: {} });

type ContractCase = Readonly<{
    owners: DaemonRuntimeActionRouteOwners;
    input: unknown;
    expected: unknown;
    assertSuccess?: () => void;
    additionalSuccess?: Readonly<{ input: unknown; expected: unknown }>;
    /** Drop the installed owner for routes whose domain has no failure variant. */
    refusal?: Readonly<{ input: unknown; expected: unknown; prepare?: () => void }>;
    dispose?: () => void | Promise<void>;
}>;
type CaseFactory = (actionId: RuntimeActionIdV1) => Promise<ContractCase>;

async function serviceCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const inventory = createLocalServiceInventoryRegistry();
    inventory.replaceSnapshot({ v: 1, machineId, generatedAt: 2_000, refreshState: 'idle', diagnostics: [], entries: [{
        id: 'listener', machineId, address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        endpoint: { scheme: 'http', host: '127.0.0.1', port: 5173, probeState: 'ready', probedAt: 2_000 },
        port: 5173, protocol: 'tcp', detectedAt: 1_000, lastSeenAt: 2_000, state: 'listening', source: 'detected',
        labels: [], diagnostics: [], confidence: 'high', processOwnershipConfidence: 'high', workspaceAssociationConfidence: 'high',
        classification: { kind: 'vite', signals: [] },
        provenance: { process: { pid: 4321, lineagePids: [4321], command: 'vite', redacted: true } },
    }] });
    const previews = createLocalServicePreviewRegistry();
    const previewRoutes = createLocalServicePreviewRoutes({ machineId, accountId, inventoryRegistry: inventory, now: () => 2_000,
        registry: previews, server: { token: 'fixture-token', serverBaseUrl: 'https://home.example.test', http: {
            // Only Home HTTP is replaced; registration and preview lifecycle are real.
            async post(_url, body) {
                const resource = LocalServicePreviewResourceV1Schema.parse(body);
                return { data: { resource, accessUrl: 'https://private.example.test/?previewToken=fixture', expiresAt: 61_000 } };
            },
            async delete() { return { data: { ok: true } }; },
        } } });
    const history = createLocalServiceLauncherHistoryStore();
    const feed = createLocalServiceLauncherFeed({ machineId, inventoryRegistry: inventory, previewRegistry: previews, history });
    const launcherRoutes = createLocalServiceLauncherRoutes({ feed, history,
        leaves: createLocalServiceLauncherLeafRoutes({ machineId, feed, previewRoutes, history }) });
    const actionRoutes = createLocalServiceActionRoutes({ machineId, inventoryRegistry: inventory, terminateEnabled: () => true,
        verifyConfirmationNonce: request => request.confirmationNonce === createLocalServiceActionConfirmationNonceV1(request),
        terminateDetectedService: createTerminateDetectedService({
            // OS reports that the listener is already free: real idempotent termination settlement.
            probeListener: async () => ({ status: 'free' }), terminateTree: createProcessTreeTerminator(), wait: delay,
        }) });
    const owners = { localServices: { inventoryRoutes: createLocalServiceInventoryRoutes({ registry: inventory }),
        launcherRoutes, previewRoutes, actionRoutes } };
    if (actionId === 'localServices.inventory.list' || actionId === 'localServices.inventory.refresh') {
        return { owners, input: { machineId }, expected: { entries: [{ id: 'listener' }] },
            ...(actionId === 'localServices.inventory.list' ? { additionalSuccess: {
                input: { machineId, projection: 'count' }, expected: { summary: { state: 'ready' } },
            } } : {}) };
    }
    if (actionId === 'localServices.launcher.snapshot') {
        return { owners, input: { machineId, scope: 'machine' }, expected: { targets: [expect.objectContaining({ source: 'inventory_entry' })] } };
    }
    const snapshot = await launcherRoutes.getSnapshot({ scope: 'machine' });
    const targetId = snapshot.targets.find(target => target.source === 'inventory_entry')?.id;
    if (!targetId) throw new Error('Populated launcher target missing');
    if (actionId === 'localServices.launcher.history.clear') {
        await launcherRoutes.leaves!.openPreview({ machineId, sessionId, targetId, scope: 'machine' });
        return { owners, input: { machineId, scope: 'machine' }, expected: { cleared: 1 } };
    }
    if (actionId === 'localServices.launcher.openPreview' || actionId === 'localServices.launcher.registerPreview') {
        return { owners, input: { machineId, sessionId, targetId, scope: 'machine' },
            expected: { status: actionId === 'localServices.launcher.openPreview' ? 'opened' : 'registered' },
            refusal: { input: { machineId, sessionId, targetId: 'missing' },
                expected: { ok: true, result: { status: 'unavailable', reasonCode: 'launcher_target_unknown' } } } };
    }
    if (ACTION_ID_FAMILIES_V1.local_services_preview.some(id => id === actionId)) {
        const created = await previewRoutes.openOrCreate!({ machineId, sessionId, inventoryEntryId: 'listener' });
        const previewId = [...previews.previewsById.keys()][0];
        if (!previewId) throw new Error(`Preview setup did not create resource: ${created.ok ? 'accepted' : created.reasonCode}`);
        return { owners,
            input: actionId === 'localServices.preview.revoke' ? { machineId, previewId }
                : actionId === 'localServices.preview.status' ? { machineId, sessionId }
                    : { machineId, sessionId, inventoryEntryId: 'listener' },
            expected: actionId === 'localServices.preview.status' ? { resources: [{ previewId }] }
                : actionId === 'localServices.preview.revoke' ? { revoked: true } : { status: 'existing' },
            // Revoke is idempotent for a missing preview; use owner unavailability for its refusal.
            ...(actionId !== 'localServices.preview.openOrCreate' ? {} : { refusal: {
                input: { machineId, sessionId, inventoryEntryId: 'missing' },
                expected: { ok: false, errorCode: 'runtime_action_disabled' },
            } }) };
    }
    const action = resolveLocalServiceActionKindForRuntimeActionId(actionId);
    if (!action) throw new Error(`No Services contract fixture for ${actionId}`);
    const request = { requestId: 'output-control', action, force: false,
        target: { kind: 'inventory_entry' as const, machineId, sessionId, inventoryEntryId: 'listener' } };
    return { owners, input: { ...request, confirmationNonce: createLocalServiceActionConfirmationNonceV1(request) },
        expected: action === 'open_preview' ? { status: 'created' } : { status: 'succeeded' },
        ...(action === 'forget' ? { assertSuccess: () => expect(inventory.getSnapshot().entries).toEqual([]) } : {}),
        refusal: { input: { ...request, target: { ...request.target, inventoryEntryId: 'missing' } },
            expected: action === 'open_preview' ? { ok: false, errorCode: 'runtime_action_disabled' }
                : { ok: true, result: { status: 'denied', reasonCode: 'unknown_inventory_entry' } } } };
}

async function publicPreviewCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const exposure: LocalServicePublicExposureV1 = { exposureId: 'exposure', previewId: 'preview', sessionId, machineId,
        mode: 'secret_link', state: 'active', publicUrl: 'https://public.example.test/', issuedAt: 1_000, expiresAt: 61_000,
        auditEventIds: ['audit'], rateLimitProfileId: 'default' };
    const snapshot: LocalServicePublicPreviewSnapshotV1 = { v: 1, machineId, sessionId, previewId: 'preview', generatedAt: 2_000,
        refreshState: 'idle', policy: { enabled: true, allowedModes: ['secret_link'], maxTtlMs: 60_000, dnsTlsRequired: false,
            auditRequired: true, rateLimitProfileIds: [] }, exposures: [exposure], diagnostics: [] };
    let refuse = false;
    let revoked = false;
    const failure = { isAxiosError: true, response: { status: 403,
        data: { error: 'public_preview_denied', reasonCode: 'public_preview_disabled' } } };
    const publicPreviewRoutes = createLocalServicePublicPreviewServerRoutes({ token: 'fixture-token', http: {
        async post(url) {
            if (refuse) throw failure;
            return { data: url.endsWith('/status') ? { protocolVersion: 1,
                snapshot: revoked ? { ...snapshot, exposures: [{ ...exposure, state: 'revoked', revokedAt: 3_000 }] } : snapshot } : { exposure } };
        },
        async delete() { if (refuse) throw failure; revoked = true; return { data: { ok: true } }; },
    } });
    const base = { machineId, sessionId, previewId: 'preview' };
    const input = actionId === 'localServices.publicPreview.create'
        ? { ...base, mode: 'secret_link', ttlMs: 60_000, confirmation: { acknowledged: true } }
        : actionId === 'localServices.publicPreview.status' ? base : { ...base, exposureId: 'exposure' };
    return { owners: { localServices: { publicPreviewRoutes } }, input,
        expected: actionId === 'localServices.publicPreview.status' ? { exposures: [{ exposureId: 'exposure' }] }
            : actionId === 'localServices.publicPreview.revoke' ? { exposureId: exposure.exposureId, revokedAt: 3_000 }
                : actionId === 'localServices.publicPreview.copyUrl' ? { publicUrl: exposure.publicUrl } : { exposure },
        refusal: { input, prepare: () => { refuse = true; }, expected: actionId === 'localServices.publicPreview.create'
            ? { ok: false, errorCode: 'public_preview_denied', details: { reasonCode: 'public_preview_disabled' } }
            : { ok: false, errorCode: 'public_preview_disabled' } } };
}

async function peerCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const store = createDaemonPeerMediationObservabilityStore({ nowMs: () => 1_000 });
    store.publish(createDaemonPeerMediationFlowEvent({ accountId, machineId, flowKind: 'tcp_tunnel',
        flowId: 'contract-flow', kind: 'flow.started', nowMs: 1_000 }));
    const scope = { kind: 'machine', accountId, machineId };
    return { owners: { peerMediationObservability: { store, accountId, machineId } },
        input: actionId === 'peerMediation.observability.snapshot' ? {} : { scope },
        expected: actionId === 'peerMediation.observability.unsubscribe' ? { ok: true }
            : { snapshot: { flows: [expect.objectContaining({ flow: expect.objectContaining({ flowId: 'contract-flow' }) })] } },
        refusal: { input: actionId === 'peerMediation.observability.snapshot' ? { machineId: 'another-machine' }
            : { scope: { ...scope, accountId: 'another-account' } }, expected: { ok: false, errorCode: 'runtime_action_disabled' } } };
}

async function browserFixture() {
    const view = { browserSessionId: sessionId, viewId: 'output-view' };
    const control = createBrowserSidecarCdpControlAdapter({ browserSessionId: sessionId, sidecarId: 'output-sidecar', transport: {
        openPage: async () => ({ targetId: 'output-page', sessionId: 'output-cdp-session' }),
        dispatchPageCommand: async command => command.method === 'Page.getNavigationHistory'
            ? { currentIndex: 1, entries: [{ id: 1 }, { id: 2 }, { id: 3 }] } : {},
        dispatchBrowserCommand: async command => command.method === 'Target.closeTarget' ? { success: true } : {},
    } });
    await control.dispatchCommand({ kind: 'openView', commandId: 'setup-view', ...view, platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'output-target', url: 'https://example.test/' } });
    const broker = createBrowserDaemonControlBroker();
    broker.registerAdapter(control);
    let fail = false;
    const service = createBrowserAutomationDaemonService({ adapter: createBrowserAutomationCdpAdapter({ transport: {
        // CDP is the external boundary. Admission, controller, timeline, routes and settlement stay real.
        ownsView: target => target.browserSessionId === sessionId && target.viewId === view.viewId,
        getNavigationGeneration: () => 0,
        dispatchControlCommand: async command => ({ v: 1, commandId: command.commandId, status: 'dispatched',
            adapterKind: 'chromiumSidecar', events: [] }),
        dispatchPageQuery: async () => fail ? { ok: false, errorCode: 'view_closed' } : { ok: true, data: { title: 'Contract page' } },
        dispatchInputCommand: async () => fail ? { ok: false, errorCode: 'view_closed' } : { ok: true },
    } }) });
    const owners: DaemonRuntimeActionRouteOwners = {
        browserControl: createBrowserDaemonControlRoutes({ broker, automation: () => service }),
        browserAutomation: createBrowserAutomationRoutes({ service }),
        browserUiAutomation: { ownsAutomationView: control.ownsView, uiAutomation: createUnavailableRuntimeActionExecutor() },
    };
    return { owners, service, view, setFailure: (value: boolean) => { fail = value; },
        dispose: () => { service.dispose(); control.dispose(); } };
}

async function automationCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const h = await browserFixture();
    const request = { v: 1 as const, ...h.view, automationRequestId: 'output-snapshot', actionKind: 'snapshot' as const,
        navigationGeneration: 0, requestedBy: 'user' as const, requesterRef: { kind: 'user', id: 'output-user' }, payload: {} };
    // A populated timeline must include both success and typed failure from the real producer.
    await h.service.execute(request);
    h.setFailure(true);
    await h.service.execute({ ...request, automationRequestId: 'output-failed-snapshot' });
    h.setFailure(false);
    const suffix = actionId.slice('browser.automation.'.length);
    const actionKind = suffix === 'status' ? 'getStatus' : suffix === 'timeline.get' ? 'getActionTimeline' : suffix;
    const payload = actionKind === 'navigate' ? { url: 'https://example.test/' }
        : actionKind === 'clipboardWrite' ? { text: 'contract' }
            : actionKind === 'answerDialog' ? { dialogId: 'output-dialog', accept: false }
                : actionKind === 'download' ? { downloadId: 'output-download', offset: 0, byteLength: 128 } : {};
    const input = actionKind === 'cancelActive' ? h.view : { ...request, automationRequestId: 'output-action', actionKind, payload };
    return { owners: h.owners, input,
        expected: actionKind === 'getActionTimeline' ? { entries: [
            expect.objectContaining({ status: 'succeeded' }), expect.objectContaining({ status: 'failed', reasonCode: 'view_closed' }),
        ] } : actionKind === 'cancelActive' ? { outcome: 'no_active', canceledCount: 0 } : { status: 'succeeded' },
        dispose: h.dispose };
}

const browserControlInputs = {
    'browser.view.list': { machineId, browserSessionId: sessionId },
    'browser.view.open': { kind: 'openView', platform: 'web', focus: true,
        target: { kind: 'externalUrl', targetId: 'output-target', url: 'https://example.test/' } },
    'browser.view.close': { kind: 'closeView' },
    'browser.view.focus': { kind: 'focusView' },
    'browser.view.setViewport': { kind: 'setViewport', emulation: { kind: 'fitViewer' } },
    'browser.target.set': { kind: 'setTarget', target: { kind: 'externalUrl', targetId: 'output-target', url: 'https://example.test/next' } },
    'browser.navigate': { kind: 'navigate', url: 'https://example.test/next' },
    'browser.reload': { kind: 'reload' },
    'browser.goBack': { kind: 'goBack' },
    'browser.goForward': { kind: 'goForward' },
    'browser.stop': { kind: 'stop' },
    'browser.control.takeControl': { kind: 'takeControl' },
    'browser.control.handBack': { kind: 'handBack' },
} satisfies Partial<Record<RuntimeActionIdV1, unknown>>;

async function browserControlCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const h = await browserFixture();
    const command = browserControlInputs[actionId as keyof typeof browserControlInputs];
    return { owners: h.owners,
        input: actionId === 'browser.view.list' ? command : { ...h.view, commandId: 'output-command', ...command },
        expected: actionId === 'browser.view.list' ? { views: [{ viewId: h.view.viewId }] } : { status: 'dispatched' },
        dispose: h.dispose };
}

async function diagnosticsCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const h = await browserFixture();
    const store = createBrowserDiagnosticsDaemonStore({ machineId, now: () => 2_000 });
    const view = { browserSessionId: sessionId, viewId: 'output-view' };
    store.publishEvent({ v: 1, ...view, eventId: 'output-event', navigationGeneration: 0, capturedAtMs: 1_000,
        family: 'network', kind: 'network.requestStarted', fidelity: 'cdp', trusted: true,
        data: { method: 'GET', url: 'https://example.test/' },
        redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false } });
    return { owners: { ...h.owners, browserDiagnostics: createBrowserDiagnosticsActionRoutes({ store }) }, input: view,
        expected: actionId === 'browser.diagnostics.snapshot' ? { events: [{ eventId: 'output-event' }] } : { ok: true }, dispose: h.dispose };
}

async function simulatorCase(actionId: RuntimeActionIdV1): Promise<ContractCase> {
    const source = { simulatorId: 'output-simulator', streamId: 'output-stream', sourceId: 'simulator:android:output:screen' };
    const runtime = createSimulatorPreviewDaemonRuntime({ machineId, now: () => 2_000,
        resources: [{ v: 1, simulatorId: source.simulatorId, platform: 'android', deviceId: 'emulator-output', displayName: 'Contract emulator',
            capture: { status: 'available', sourceId: source.sourceId, supportedCodecs: ['h264.avcc'], inputMode: 'exclusive',
                supportedInputKinds: ['tap'], streamControls: { requestKeyframe: true, snapshot: true, setQuality: true, setFps: true, setScale: true } } }],
        // Encoder control is the external stream boundary; real runtime/lease/translators remain installed.
        dispatchStreamControl: async () => ({ ok: true }),
    });
    const acquired = SimulatorPreviewActionResultV1Schema.parse(await runtime.routes.dispatchAction({
        type: 'simulator.lease.acquire', ...source, viewerId: 'output-viewer',
    }));
    if (acquired.status !== 'accepted' || !acquired.lease) throw new Error('Simulator fixture failed to acquire real lease');
    const control = { v: 1 as const, streamId: source.streamId, sourceId: source.sourceId, eventId: 'output-control', leaseId: acquired.lease.leaseId };
    const inputs = {
        'devices.simulator.list': { type: 'simulator.devices.list' },
        'devices.simulator.stream.keyframe': { type: 'simulator.keyframe.request', ...source, control: { ...control, kind: 'request_keyframe' } },
        'devices.simulator.stream.snapshot': { type: 'simulator.snapshot.request', ...source, eventId: 'output-snapshot' },
        'devices.simulator.stream.quality.set': { type: 'simulator.quality.set', ...source, control: { ...control, kind: 'set_quality', maxFramesPerSecond: 24 } },
        'devices.simulator.stream.fps.set': { ...source, value: 24 },
        'devices.simulator.stream.scale.set': { ...source, value: 720 },
        'devices.simulator.lease.acquire': { type: 'simulator.lease.acquire', ...source, viewerId: 'output-viewer' },
        'devices.simulator.lease.renew': { type: 'simulator.lease.renew', ...source, leaseId: acquired.lease.leaseId, viewerId: 'output-viewer' },
        'devices.simulator.lease.release': { type: 'simulator.lease.release', ...source, leaseId: acquired.lease.leaseId },
    } satisfies Partial<Record<RuntimeActionIdV1, unknown>>;
    if (!Object.hasOwn(inputs, actionId)) throw new Error(`Missing simulator fixture for ${actionId}`);
    return { owners: { simulatorPreview: runtime.routes }, input: inputs[actionId as keyof typeof inputs],
        expected: actionId === 'devices.simulator.list' ? { resources: [{ simulatorId: source.simulatorId }] } : { status: 'accepted' },
        dispose: runtime.stop };
}

// Exclusions name the actual live producer prerequisite. They are accounted for below,
// rather than passing schema-shaped synthetic successes off as producer evidence.
const exclusions = new Map<RuntimeActionIdV1, string>();
const cases = new Map<RuntimeActionIdV1, CaseFactory>();
for (const id of RUNTIME_ACTION_IDS_V1) {
    if (!isRuntimeActionExecutorReal(id)) exclusions.set(id, 'Protocol declares this route statically unbacked; no success producer exists.');
}
for (const id of [...ACTION_ID_FAMILIES_V1.local_services_inventory, ...ACTION_ID_FAMILIES_V1.local_services_launcher,
    ...ACTION_ID_FAMILIES_V1.local_services_preview, ...ACTION_ID_FAMILIES_V1.local_services_actions]) cases.set(id, serviceCase);
for (const id of ACTION_ID_FAMILIES_V1.local_services_public_preview) cases.set(id, publicPreviewCase);
for (const id of ACTION_ID_FAMILIES_V1.peer_mediation_observability) cases.set(id, peerCase);
for (const id of ACTION_ID_FAMILIES_V1.browser_control) exclusions.set(id, 'Success requires a managed browser/profile/extension or mounted view lifecycle; no such owner is installed by this daemon-only fixture.');
for (const id of ACTION_ID_FAMILIES_V1.browser_automation) exclusions.set(id, 'Success requires an owned CDP page; daemon-only fixture has no managed sidecar.');
for (const id of ACTION_ID_FAMILIES_V1.browser_context) exclusions.set(id, 'Success requires a mounted context/annotation/composer owner and owned CDP page.');
for (const id of ACTION_ID_FAMILIES_V1.browser_diagnostics) exclusions.set(id, 'Interactive success requires the managed sidecar CDP page and object lifecycle.');
for (const id of ACTION_ID_FAMILIES_V1.browser_recording) exclusions.set(id, 'Success requires a live capture/encoder stream and composer attachment transport.');
for (const id of ACTION_ID_FAMILIES_V1.computer) {
    if (isRuntimeActionExecutorReal(id)) exclusions.set(id, 'Success requires a native selected desktop/window, OS permissions and CUA subprocess.');
}
for (const id of ACTION_ID_FAMILIES_V1.devices_simulator) {
    if (!isRuntimeActionExecutorReal(id)) continue;
    if (id.startsWith('devices.simulator.input.') || id === 'devices.simulator.sideband.request') {
        exclusions.set(id, 'Success requires a native simulator input/sideband adapter, not only the encoder transport used here.');
    } else { cases.set(id, simulatorCase); exclusions.delete(id); }
}
for (const id of ['localServices.launcher.start', 'localServices.actions.stopManaged', 'localServices.actions.restartManaged', 'projects.service.relocate'] as const) {
    cases.delete(id);
    exclusions.set(id, 'Managed process/Start admission and cross-Machine Move fixture lives in projectDeclarations.item2Head.composed.test.ts; retain its stateful output assertions.');
}
for (const id of ACTION_ID_FAMILIES_V1.browser_automation) {
    if (id === 'browser.automation.secret.fill') {
        exclusions.set(id, 'Confidential fill requires a live focused credential target and credential preparation/secret provider; no approved secret is acquired by this test.');
        continue;
    }
    cases.set(id, automationCase);
    exclusions.delete(id);
}
for (const id of ['browser.diagnostics.snapshot', 'browser.diagnostics.clear'] as const) {
    cases.set(id, diagnosticsCase);
    exclusions.delete(id);
}
for (const id of ACTION_ID_FAMILIES_V1.browser_control) {
    if (!Object.hasOwn(browserControlInputs, id)) continue;
    cases.set(id, browserControlCase);
    exclusions.delete(id);
}

it('settles every reachable daemon route success and typed refusal against its declared Action output, with named live-boundary exclusions', async () => {
    expect(new Set([...cases.keys(), ...exclusions.keys()])).toEqual(new Set(RUNTIME_ACTION_IDS_V1));
    const failures: string[] = [];
    for (const actionId of RUNTIME_ACTION_IDS_V1) {
        const factory = cases.get(actionId);
        if (!factory) {
            expect(exclusions.get(actionId), `${actionId}: missing named prerequisite`).toBeTruthy();
            continue;
        }
        expect(exclusions.has(actionId), `${actionId}: covered and excluded`).toBe(false);
        let row: ContractCase | undefined;
        try {
            row = await factory(actionId);
            let owners = row.owners;
            const runtimeActionExecute = withActionOutputContract(createDaemonRuntimeActionExecutor({ env: {},
                resolveRouteOwners: () => owners, resolveServerFeaturesSnapshot: () => ({ status: 'ready', features }) }));
            const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
                isActionApprovalRequired: () => false, runtimeActionExecute });
            const input = getActionSpec(actionId).inputSchema.parse(row.input);
            const success = await executor.execute(actionId, input, { surface: 'ui', authority: 'present_user' });
            expect(success, `${actionId}: real success${success.ok ? '' : ` (${success.errorCode}: ${success.error})`}`)
                .toMatchObject({ ok: true, result: row.expected });
            row.assertSuccess?.();
            if (row.additionalSuccess) {
                const additional = await executor.execute(actionId, row.additionalSuccess.input, { surface: 'ui', authority: 'present_user' });
                expect(additional, `${actionId}: count projection`).toMatchObject({ ok: true, result: row.additionalSuccess.expected });
            }
            row.refusal?.prepare?.();
            if (!row.refusal) owners = {};
            const refused = await executor.execute(actionId, row.refusal?.input ?? input, { surface: 'ui', authority: 'present_user' });
            expect(refused, `${actionId}: typed refusal${refused.ok ? '' : ` (${refused.errorCode}: ${refused.error})`}`)
                .toMatchObject(row.refusal?.expected ?? { ok: false, errorCode: 'runtime_action_disabled' });
            if (!refused.ok) ActionExecuteFailureSchema.parse(refused);
        } catch (error) {
            failures.push(`${actionId}: ${error instanceof Error ? error.message : String(error)}`);
        } finally { await row?.dispose?.(); }
    }
    expect(failures).toEqual([]);
});
