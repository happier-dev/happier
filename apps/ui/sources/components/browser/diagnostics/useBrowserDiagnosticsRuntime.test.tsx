import type { BrowserDiagnosticEventV1, BrowserDiagnosticsSnapshotV1 } from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createNativeWebViewPageInfoDiagnosticEvent } from '@/components/browser/adapters/diagnostics';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import { selectBrowserDiagnosticsForView } from '@/sync/domains/browser/diagnostics/store';
import { useBrowserDiagnosticsDaemonSnapshot } from '@/sync/domains/browser/diagnostics/daemonSnapshot';
import type { BrowserDiagnosticsSnapshotClientInput, BrowserDiagnosticsSnapshotClientResult } from '@/sync/domains/browser/diagnostics/machineRpc';

import { useBrowserDiagnosticsRuntime as useRuntime, type UseBrowserDiagnosticsRuntimeInput } from './useBrowserDiagnosticsRuntime';
import { createActionExecutor } from '@happier-dev/protocol';
import { countTransportRequests, createActionExecutorBoundaryFixture } from '@/dev/testkit';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { clearBrowserRuntimeControlRegistryForTests, registerBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createBrowserControlState } from '@/sync/domains/browser/control/reducer';
import { handleUiBrowserAutomationDispatchRequest } from '@/sync/domains/browser/automation/reverseDispatchHandler';
import { loadBrowserDaemonRuntimeForTests } from '@/dev/testkit/harness/browserDaemonRuntime';
import { BrowserDiagnosticsEvalResultV1Schema, BrowserDiagnosticsElementPickerResultV1Schema, BrowserDiagnosticsGetPropertiesResultV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';

// These hook cases have a presented snapshot consumer. BrowserShell.test.tsx exercises the
// actual drawer's open/closed acquisition wiring. Admission, snapshot and collector logic stay real.
const executor = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute: createDefaultRuntimeActionExecutor() }));
const noDaemonSnapshot = { view: null, enabled: false, onEvents: () => {} };
function useBrowserDiagnosticsRuntime(input: UseBrowserDiagnosticsRuntimeInput) {
    const runtime = useRuntime({ ...input, actionExecute: input.actionExecute ?? executor.execute,
        actionContext: { surface: 'ui', authority: 'present_user', bypassApprovals: true, ...input.actionContext } });
    useBrowserDiagnosticsDaemonSnapshot(runtime?.daemonSnapshot ?? noDaemonSnapshot);
    const current = React.useRef(input.view);
    current.current = input.view;
    React.useEffect(() => {
        const view = current.current;
        if (!view) return;
        return registerBrowserRuntimeControlAdapter({ browserSessionId: view.browserSessionId,
            control: { readState: () => ({ ...createBrowserControlState(), viewsById: current.current ? { [current.current.viewId]: current.current } : {} }),
                applyDispatchResult: () => {} },
            ...(runtime?.runtimeAdapter ? { diagnostics: runtime.runtimeAdapter } : {}),
        });
    }, [input.view?.browserSessionId, runtime?.runtimeAdapter]);
    return runtime;
}

// The RPC adapter is the network boundary; deterministic snapshot/store/collector logic stays real.
vi.mock('@/sync/domains/browser/diagnostics/machineRpc', () => ({
    fetchBrowserDiagnosticsSnapshotViaMachineRpc: vi.fn(async () => ({ ok: false, reason: 'unavailable' })),
}));

afterEach(() => {
    standardCleanup();
    vi.unstubAllGlobals();
    clearBrowserRuntimeControlRegistryForTests();
});

function stubCryptoRandomUuid(): void {
    let sequence = 0;
    vi.stubGlobal('crypto', {
        randomUUID: vi.fn(() => {
            sequence += 1;
            return `uuid_${sequence}`;
        }),
    });
}

function createLocalPreviewView(
    overrides: Partial<Pick<
        BrowserControlViewState,
        'adapterKind' | 'currentUrl' | 'engineKind' | 'navigationGeneration' | 'securityOrigin' | 'viewId'
    >> = {},
): BrowserControlViewState {
    const adapterKind = overrides.adapterKind ?? 'localPreview';
    const engineKind = overrides.engineKind ?? 'webIframe';
    return {
        browserSessionId: 'browser_session_1',
        viewId: overrides.viewId ?? 'view_1',
        target: {
            kind: 'localServicePreview',
            targetId: 'preview_1',
            sessionId: 'session_1',
            machineId: 'machine_1',
            display: {
                title: 'Preview',
                addressLabel: 'localhost:5173',
            },
        },
        platform: 'web',
        adapterKind,
        engineKind,
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind,
            supportedTargetKinds: ['localServicePreview'],
            supportedRenderEngines: [engineKind],
        }),
        currentUrl: overrides.currentUrl ?? 'https://preview.happier.test/dashboard?token=redacted',
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'Preview',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: overrides.navigationGeneration ?? 7,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: overrides.securityOrigin ?? 'https://preview.happier.test/',
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createSimulatorView(): BrowserControlViewState {
    return {
        browserSessionId: 'browser_session_1',
        viewId: 'view_simulator_1',
        target: {
            kind: 'simulatorPreview',
            targetId: 'simulator_1',
            deviceId: 'device_1',
            display: {
                title: 'iPhone 16',
            },
        },
        platform: 'web',
        adapterKind: 'simulatorPreview',
        engineKind: 'streamedSurface',
        adapterCapabilities: buildBrowserAdapterCapabilities({
            adapterKind: 'simulatorPreview',
            supportedTargetKinds: ['simulatorPreview'],
            supportedRenderEngines: ['streamedSurface'],
        }),
        currentUrl: null,
        currentUrlExpiresAt: null,
        pendingUrl: null,
        title: 'iPhone 16',
        faviconUrl: null,
        loadingState: 'ready',
        loadingProgress: 1,
        navigationGeneration: 0,
        canGoBack: false,
        canGoForward: false,
        securityOrigin: null,
        lastError: null,
        openerViewId: null,
        adapterRefreshStatus: 'idle',
        adapterRefreshError: null,
    };
}

function createDaemonConsoleEvent(
    overrides: Partial<BrowserDiagnosticEventV1> = {},
): BrowserDiagnosticEventV1 {
    return {
        v: 1,
        eventId: 'evt_daemon_console_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 7,
        capturedAtMs: 3_000,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'cdp',
        trusted: true,
        data: {
            level: 'log',
            textPreview: 'daemon console entry',
        },
        redaction: {
            level: 'metadataOnly',
            queryRedacted: true,
            headersRedacted: true,
            truncated: false,
        },
        ...overrides,
    };
}

function createDaemonDiagnosticsSnapshot(
    events: readonly BrowserDiagnosticEventV1[],
): BrowserDiagnosticsSnapshotV1 {
    return {
        v: 1,
        machineId: 'machine_1',
        generatedAt: 3_100,
        refreshState: 'idle',
        events: [...events],
        diagnostics: [{
            code: 'daemon_browser_diagnostics_snapshot_ready',
        }],
    };
}

describe('useBrowserDiagnosticsRuntime', () => {
    it('retains an Ask-first console invocation until approval and receives the actual mounted engine result', async () => {
        stubCryptoRandomUuid();
        const decision = createDeferred<void>();
        let waitingForDecision = false;
        const lifetime = new AbortController();
        const retained = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: createDefaultRuntimeActionExecutor(),
            hostActionApprovalLifetime: { actionId: 'browser.diagnostics.eval', surface: 'ui', signal: lifetime.signal },
            isActionApprovalRequired: () => true,
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async () => ({ artifactId: 'diagnostics_approval' }),
            approvalsUpdate: async () => ({ ok: true }),
            approvalsWaitForDecision: async ({ request }) => {
                waitingForDecision = true;
                await decision.promise;
                return { decision: 'approve' as const, request, decisionAuthority: 'present_user' as const };
            },
        }));
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        const hook = await renderHook(() => useBrowserDiagnosticsRuntime({ view, enabled: true, actionExecute: retained.execute,
            actionContext: { surface: 'ui', authority: 'present_user', bypassApprovals: false,
                serverId: 'home_1', defaultSessionId: 'session_1', actionRequestId: 'diagnostics_ask', signal: lifetime.signal } }));
        await act(async () => hook.getCurrent()?.interaction?.onEnableInteraction?.());
        await act(async () => { hook.getCurrent()?.requestEval({ expression: 'document.title' }); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(waitingForDecision).toBe(true);
        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([]);
        await act(async () => decision.resolve());
        await flushHookEffects({ cycles: 2, turns: 2 });
        const request = hook.getCurrent()?.bridge?.evalRequest;
        expect(request, JSON.stringify(hook.getCurrent()?.interaction?.evalConsole?.entries)).toMatchObject({ expression: 'document.title' });
        await act(async () => hook.getCurrent()?.bridge?.onEvalResult?.(BrowserDiagnosticsEvalResultV1Schema.parse({
            v: 1, evalRequestId: request!.evalRequestId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage', audited: true, status: 'completed', result: { type: 'string', value: 'approved mounted page' },
        })));
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toMatchObject([{ status: 'completed', result: { value: 'approved mounted page' } }]);
    });
    it('keeps disabled Actions away from the engine and settles console/property presentation', async () => {
        stubCryptoRandomUuid();
        const denied = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: createDefaultRuntimeActionExecutor(), isActionEnabled: () => false,
        }));
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        const hook = await renderHook(() => useBrowserDiagnosticsRuntime({ view, enabled: true, actionExecute: denied.execute }));
        await act(async () => hook.getCurrent()?.interaction?.onEnableInteraction?.());
        await act(async () => {
            hook.getCurrent()?.requestEval({ expression: 'document.title' });
            hook.getCurrent()?.interaction?.evalConsole?.onExpandObject('object_1', 'group_1');
            hook.getCurrent()?.interaction?.onStartElementPicker?.();
        });
        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.getPropertiesRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.elementPickerRequest).toBeUndefined();
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toMatchObject([{ status: 'blocked' }]);
        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties.object_1).toMatchObject({ status: 'failed' });
        expect(hook.getCurrent()?.interaction?.pickerState).toBe('idle');
    });

    it('delivers concurrent console requests in order and ignores late results after navigation', async () => {
        stubCryptoRandomUuid();
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        const hook = await renderHook(({ currentView }: { currentView: BrowserControlViewState }) =>
            useBrowserDiagnosticsRuntime({ view: currentView, enabled: true }), { initialProps: { currentView: view } });
        await act(async () => hook.getCurrent()?.interaction?.onEnableInteraction?.());
        await act(async () => {
            hook.getCurrent()?.requestEval({ expression: 'first()' });
            hook.getCurrent()?.requestEval({ expression: 'second()' });
        });
        const firstBridge = hook.getCurrent()!.bridge!;
        expect(firstBridge.evalRequest?.expression).toBe('first()');
        const result = BrowserDiagnosticsEvalResultV1Schema.parse({ v: 1, evalRequestId: firstBridge.evalRequest!.evalRequestId,
            viewId: view.viewId, navigationGeneration: view.navigationGeneration, tier: 'injectedPage', audited: true,
            status: 'completed', result: { type: 'number', value: 1 } });
        await act(async () => firstBridge.onEvalResult?.(result));
        expect(hook.getCurrent()?.bridge?.evalRequest?.expression).toBe('second()');
        await hook.rerender({ currentView: { ...view, navigationGeneration: view.navigationGeneration + 1 } });
        await act(async () => firstBridge.onEvalResult?.(result));
        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.interaction?.state).toBe('disabled');
        await act(async () => hook.getCurrent()?.interaction?.onEnableInteraction?.());
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([]);
    });
    it.each(['nativeWebView', 'desktopWebView', 'webIframe'] as const)('routes admitted Agent diagnostics to the exact mounted %s engine and returns its strict results', async engineKind => {
        stubCryptoRandomUuid();
        const adapterKind = engineKind === 'webIframe' ? 'localPreview' : 'externalUrl';
        const view = createLocalPreviewView({ engineKind, adapterKind });
        const otherView = createLocalPreviewView({ engineKind, adapterKind, viewId: 'other_view' });
        const collector = { automationEnabled: engineKind === 'webIframe', parentOrigin: 'https://app.happier.test' };
        let current = true;
        const mounted = await renderHook(({ currentView }: { currentView: BrowserControlViewState }) =>
            useBrowserDiagnosticsRuntime({ view: currentView, enabled: true, ...collector, isCurrent: () => current }),
        { initialProps: { currentView: view } });
        const other = await renderHook(() => useBrowserDiagnosticsRuntime({ view: otherView, enabled: true, ...collector }));
        expect(mounted.getCurrent()?.interaction?.state).toBe('disabled');
        const boundView = { browserSessionId: view.browserSessionId, viewId: view.viewId, sessionId: 'invoking_session' };
        const answeringViews = new Map([
            [uiBrowserAutomationDispatchMethod(view), boundView],
            [uiBrowserAutomationDispatchMethod(otherView), { ...boundView, viewId: otherView.viewId }],
        ]);
        const { createDaemonRuntimeActionExecutor, createBrowserAutomationReverseDispatcher } = await loadBrowserDaemonRuntimeForTests();
        const runtimeActionExecute = createDaemonRuntimeActionExecutor({ env: { NODE_ENV: 'test' },
            resolveRouteOwners: () => ({ browserUiAutomation: { ownsAutomationView: () => false,
                uiAutomation: createBrowserAutomationReverseDispatcher({ getMachineClient: () => ({
                    hasConnectedClientRpcHandler: method => answeringViews.has(method),
                    callConnectedClientRpc: async (method, payload, options) => {
                        const answeringView = answeringViews.get(method);
                        if (!answeringView) throw new Error('No mounted view owns the addressed reverse RPC room');
                        options?.onIssued?.();
                        return { ok: true, result: await handleUiBrowserAutomationDispatchRequest(payload, answeringView, { signal: options?.signal }) };
                    },
                }) }),
            } }),
            resolveServerFeaturesSnapshot: () => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {
                browser: { enabled: true, diagnostics: { enabled: true }, viewTargets: { enabled: true }, internal: { enabled: true }, sidecar: { enabled: true } },
            } }) }),
        });
        const agent = createActionExecutor(createActionExecutorBoundaryFixture({ runtimeActionExecute }));
        const context = { surface: 'agent', authority: 'account_automation', defaultSessionId: boundView.sessionId, bypassApprovals: true,
            externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } as const;
        const input = { v: 1, browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage', diagnosticsInteractionEnabled: true, evalRequestId: 'agent_eval', expression: 'document.title', objectGroupId: 'agent_group' };
        let evalResult!: ReturnType<typeof agent.execute>;
        await act(async () => { evalResult = agent.execute('browser.diagnostics.eval', input, context); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(mounted.getCurrent()?.bridge?.evalRequest).toMatchObject({ evalRequestId: 'agent_eval', expression: 'document.title' });
        expect(other.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        const result = BrowserDiagnosticsEvalResultV1Schema.parse({ v: 1, evalRequestId: 'agent_eval', viewId: view.viewId,
            navigationGeneration: view.navigationGeneration, tier: 'injectedPage', audited: true, status: 'completed', result: { type: 'string', value: 'mounted page' } });
        await act(async () => mounted.getCurrent()?.bridge?.onEvalResult?.(result));
        // Explicit, admitted eval results retain the sidecar Action contract. Passive diagnostic
        // events separately use their destination-aware owner-only field classifier.
        expect(await evalResult).toMatchObject({ ok: true, result });
        expect(mounted.getCurrent()?.interaction?.evalConsole?.entries[0]?.result).toEqual(result.result);
        expect(mounted.getCurrent()?.interaction?.state).toBe('enabled');
        const propertiesInput = { v: 1, browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage', diagnosticsInteractionEnabled: true, propertyRequestId: 'agent_properties', objectId: 'agent_object', objectGroupId: 'agent_group' };
        let propertiesResult!: ReturnType<typeof agent.execute>;
        await act(async () => { propertiesResult = agent.execute('browser.diagnostics.getProperties', propertiesInput, context); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(mounted.getCurrent()?.bridge?.getPropertiesRequest).toMatchObject({ propertyRequestId: 'agent_properties', objectId: 'agent_object' });
        const properties = BrowserDiagnosticsGetPropertiesResultV1Schema.parse({ v: 1, propertyRequestId: 'agent_properties', viewId: view.viewId,
            navigationGeneration: view.navigationGeneration, tier: 'injectedPage', audited: true, status: 'completed', objectId: 'agent_object', properties: [] });
        await act(async () => mounted.getCurrent()?.bridge?.onPropertiesResult?.(properties));
        expect(await propertiesResult).toMatchObject({ ok: true, result: properties });
        const pickerInput = { v: 1, browserSessionId: view.browserSessionId, viewId: view.viewId, navigationGeneration: view.navigationGeneration,
            tier: 'injectedPage', diagnosticsInteractionEnabled: true, pickerRequestId: 'agent_picker', action: 'start' };
        let pickerResult!: ReturnType<typeof agent.execute>;
        await act(async () => { pickerResult = agent.execute('browser.diagnostics.elementPicker.start', pickerInput, context); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(mounted.getCurrent()?.bridge?.elementPickerRequest).toMatchObject({ pickerRequestId: 'agent_picker', action: 'start' });
        expect(other.getCurrent()?.bridge?.elementPickerRequest).toBeUndefined();
        const picked = BrowserDiagnosticsElementPickerResultV1Schema.parse({ v: 1, pickerRequestId: 'agent_picker', viewId: view.viewId,
            navigationGeneration: view.navigationGeneration, tier: 'injectedPage', audited: true, status: 'selected', selectorPath: '#mounted' });
        await act(async () => mounted.getCurrent()?.bridge?.onElementPickerResult?.(picked));
        expect(await pickerResult).toMatchObject({ ok: true, result: picked });
        expect(await agent.execute('browser.diagnostics.eval', input, { ...context, defaultSessionId: 'wrong_session' })).toMatchObject({ ok: false });
        current = false;
        expect(await agent.execute('browser.diagnostics.eval', { ...input, evalRequestId: 'retired_eval' }, context)).toMatchObject({ ok: false });
        expect(mounted.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        current = true;
        await act(async () => mounted.getCurrent()?.interaction?.onDisableInteraction?.());
        expect(await agent.execute('browser.diagnostics.eval', { ...input, evalRequestId: 'revoked_eval' }, context)).toMatchObject({ ok: false });
        expect(await agent.execute('browser.diagnostics.getProperties', { ...propertiesInput, propertyRequestId: 'revoked_properties' }, context)).toMatchObject({ ok: false });
        expect(await agent.execute('browser.diagnostics.elementPicker.start', { ...pickerInput, pickerRequestId: 'revoked_picker' }, context)).toMatchObject({ ok: false });
        expect(mounted.getCurrent()?.interaction?.state).toBe('disabled');
        expect(mounted.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(mounted.getCurrent()?.bridge?.getPropertiesRequest).toBeUndefined();
        expect(mounted.getCurrent()?.bridge?.elementPickerRequest).toBeUndefined();
        const navigatedView = { ...view, navigationGeneration: view.navigationGeneration + 1 };
        await mounted.rerender({ currentView: navigatedView });
        expect(await agent.execute('browser.diagnostics.eval', { ...input, evalRequestId: 'revoked_navigation_eval',
            navigationGeneration: navigatedView.navigationGeneration }, context)).toMatchObject({ ok: false });
        expect(mounted.getCurrent()?.interaction?.state).toBe('disabled');
        await act(async () => mounted.getCurrent()?.interaction?.onEnableInteraction?.());
        let reenabled!: ReturnType<typeof agent.execute>;
        await act(async () => { reenabled = agent.execute('browser.diagnostics.eval', { ...input, evalRequestId: 'reenabled_eval',
            navigationGeneration: navigatedView.navigationGeneration }, context); });
        await flushHookEffects({ cycles: 2, turns: 2 });
        expect(mounted.getCurrent()?.bridge?.evalRequest).toMatchObject({ evalRequestId: 'reenabled_eval' });
        await act(async () => mounted.getCurrent()?.interaction?.onDisableInteraction?.());
        expect(await reenabled).toMatchObject({ ok: false });
        await act(async () => mounted.getCurrent()?.bridge?.onEvalResult?.({ ...result, evalRequestId: 'reenabled_eval',
            navigationGeneration: navigatedView.navigationGeneration }));
        expect(mounted.getCurrent()?.interaction?.state).toBe('disabled');
        await mounted.unmount();
        expect(await agent.execute('browser.diagnostics.eval', input, context)).toMatchObject({ ok: false });
    });
    it('admits mounted console and picker UI through the real Action executor and default runtime composition', async () => {
        stubCryptoRandomUuid();
        const execute = createDefaultRuntimeActionExecutor();
        const admitted: string[] = [];
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            runtimeActionExecute: async args => { admitted.push(args.actionId); return execute(args); },
        }));
        const hook = await renderHook(() => useBrowserDiagnosticsRuntime({
            view: createLocalPreviewView({ engineKind: 'nativeWebView' }), enabled: true,
            actionExecute: executor.execute,
            actionContext: { surface: 'ui', authority: 'present_user', bypassApprovals: true },
        }));
        await act(async () => hook.getCurrent()?.interaction?.onEnableInteraction?.());
        await act(async () => { hook.getCurrent()?.requestEval({ expression: 'document.title' }); });
        expect(admitted).toEqual(['browser.diagnostics.eval']);
        expect(hook.getCurrent()?.bridge?.evalRequest).toMatchObject({ expression: 'document.title', viewId: 'view_1' });
        await act(async () => hook.getCurrent()?.interaction?.onStartElementPicker?.());
        expect(admitted).toEqual(['browser.diagnostics.eval', 'browser.diagnostics.elementPicker.start']);
        expect(hook.getCurrent()?.bridge?.elementPickerRequest).toMatchObject({ action: 'start', viewId: 'view_1' });
    });
    it('collects event updates without re-rendering the producer host after availability is established', async () => {
        stubCryptoRandomUuid();
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        let renders = 0;
        const hook = await renderHook(() => {
            renders += 1;
            return useBrowserDiagnosticsRuntime({ view, enabled: true });
        });
        const bridge = hook.getCurrent()?.bridge;
        expect(bridge).toBeTruthy();
        const before = renders;
        for (let index = 0; index < 20; index += 1) {
            await act(async () => { bridge?.onEvents?.([createDaemonConsoleEvent({ eventId: `event_${index}` })]); });
        }
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, view).eventCount).toBe(20);
        expect(renders - before).toBe(0);
    });
    it.each(['webIframe', 'nativeWebView', 'desktopWebView'] as const)('provides the %s collector identity for automation while diagnostics presentation is disabled', async (engineKind) => {
        stubCryptoRandomUuid();
        const view: BrowserControlViewState = {
            ...createLocalPreviewView({ engineKind, adapterKind: 'externalUrl' }),
            target: { kind: 'externalUrl', targetId: 'external_1', url: 'https://preview.happier.test/' },
        };
        const hook = await renderHook(() => useBrowserDiagnosticsRuntime({
            view, enabled: false, automationEnabled: true, parentOrigin: 'https://app.happier.test',
        }));
        expect(hook.getCurrent()?.bridge).toMatchObject({
            browserSessionId: view.browserSessionId, viewId: view.viewId,
            navigationGeneration: view.navigationGeneration,
        });
        expect(hook.getCurrent()?.requestEval({ expression: 'document.title' })).toBe(false);
        expect(hook.getCurrent()?.bridge?.consoleValueCapture).toBe(false);
        await act(async () => hook.getCurrent()?.bridge?.onEvents([createDaemonConsoleEvent()]));
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, view).eventCount).toBe(0);
    });

    it('keeps the installed collector identity across native history-only updates', async () => {
        stubCryptoRandomUuid();
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        const hook = await renderHook(({ currentView }: { currentView: BrowserControlViewState }) =>
            useBrowserDiagnosticsRuntime({ view: currentView, enabled: true, automationEnabled: true }),
        { initialProps: { currentView: view } });
        const before = hook.getCurrent()!.bridge!;
        await hook.rerender({ currentView: { ...view, canGoBack: true, title: 'Updated title' } });
        expect(hook.getCurrent()?.bridge).toMatchObject({ collectorId: before.collectorId, nonce: before.nonce });
        await hook.rerender({ currentView: { ...view, navigationGeneration: view.navigationGeneration + 1 } });
        expect(hook.getCurrent()?.bridge?.collectorId).not.toBe(before.collectorId);
        expect(hook.getCurrent()?.bridge?.nonce).not.toBe(before.nonce);
    });

    it('fails closed when diagnostics runtime is not explicitly enabled', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()).toBeNull();
        expect(snapshotClient).not.toHaveBeenCalled();
    });

    it('creates a scoped injected diagnostics bridge for supported local preview views and applies events', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test/',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        const runtime = hook.getCurrent();
        expect(runtime?.bridge).toEqual(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            collectorId: 'browser_diagnostics:view_1:7:uuid_1',
            nonce: 'uuid_2',
            collectorVersion: '1.0.0',
            sourceOrigin: 'https://preview.happier.test',
            webPostMessageTargetOrigin: 'https://app.happier.test',
        }));

        const bridge = runtime?.bridge;
        expect(bridge).toBeTruthy();
        if (!bridge) return;

        const event: BrowserDiagnosticEventV1 = {
            v: 1,
            eventId: 'evt_console_1',
            browserSessionId: bridge.browserSessionId,
            viewId: bridge.viewId,
            navigationGeneration: bridge.navigationGeneration,
            capturedAtMs: 2_000,
            family: 'console',
            kind: 'console.entry',
            fidelity: 'injectedPage',
            trusted: false,
            collector: {
                collectorId: bridge.collectorId,
                nonce: bridge.nonce,
                version: bridge.collectorVersion,
            },
            data: {
                level: 'info',
                argCount: 1,
                textAvailable: true,
            },
            redaction: {
                level: 'metadataOnly',
                queryRedacted: true,
                headersRedacted: true,
                truncated: false,
            },
        };

        await act(async () => {
            bridge.onEvents([event]);
        });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.fidelity).toBe('injectedPage');
        expect(projection.families.find((family) => family.family === 'console')).toEqual(expect.objectContaining({
            status: 'available',
            fidelity: 'injectedPage',
            trusted: false,
        }));
    });

    it('drops the previous document\'s events when the view moves to a new navigation generation, and ignores its late stragglers', async () => {
        stubCryptoRandomUuid();
        const view = createLocalPreviewView({ engineKind: 'nativeWebView' });
        const hook = await renderHook(({ currentView }: { currentView: BrowserControlViewState }) =>
            useBrowserDiagnosticsRuntime({ view: currentView, enabled: true }), { initialProps: { currentView: view } });
        const bridge = hook.getCurrent()!.bridge!;
        const consoleEvent = (generation: number, eventId: string): BrowserDiagnosticEventV1 => ({
            v: 1, eventId, browserSessionId: bridge.browserSessionId, viewId: bridge.viewId, navigationGeneration: generation, capturedAtMs: 2_000,
            family: 'console', kind: 'console.entry', fidelity: 'injectedPage', trusted: false,
            collector: { collectorId: bridge.collectorId, nonce: bridge.nonce, version: bridge.collectorVersion },
            data: { level: 'info', argCount: 1, textAvailable: true },
            redaction: { level: 'metadataOnly', queryRedacted: true, headersRedacted: true, truncated: false },
        });
        const eventCount = () => selectBrowserDiagnosticsForView(hook.getCurrent()!.state, { browserSessionId: view.browserSessionId, viewId: view.viewId }).eventCount;
        await act(async () => bridge.onEvents([consoleEvent(7, 'evt_old_1'), consoleEvent(7, 'evt_old_2')]));
        expect(eventCount()).toBe(2);

        // An external page carries no collector, so nothing ever replaces the old events; the drawer must not keep counting them.
        await hook.rerender({ currentView: { ...view, adapterKind: 'externalUrl', engineKind: 'webIframe', navigationGeneration: 8, currentUrl: 'https://example.com/' } });
        expect(eventCount()).toBe(0);
        await act(async () => bridge.onEvents([consoleEvent(7, 'evt_late')]));
        expect(eventCount()).toBe(0);
    });

    it('does not create a fake injected bridge for local-preview web iframes but still ingests daemon snapshots', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(hook.getCurrent()?.bridge).toBeNull();
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'unavailable',
            pickerState: 'unavailable',
        }));
        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
        }));
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).events).toEqual([
            expect.objectContaining({ eventId: 'evt_daemon_console_1' }),
        ]);
    });

    it('keeps unsupported streamed simulator views visible but without an injected diagnostics bridge', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createSimulatorView(),
                },
            },
        );

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            bridge: null,
        }));
    });

    it('attaches a full injected diagnostics bridge for the desktop Wry engine (no web origin handshake, interaction supported via host eval)', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({
                        adapterKind: 'externalUrl',
                        engineKind: 'desktopWebView',
                        currentUrl: 'https://example.com/dashboard',
                        securityOrigin: 'https://example.com',
                    }),
                },
            },
        );

        const runtime = hook.getCurrent();
        const bridge = runtime?.bridge;
        // Desktop Wry has no CDP/injection, so the bridge carries native page-info only: it is
        // present (events flow) but has NO injected-collector origin handshake.
        expect(bridge).toBeTruthy();
        if (!bridge) return;
        expect(bridge.sourceOrigin).toBeUndefined();
        expect(bridge.webPostMessageTargetOrigin).toBeUndefined();
        // Interactive eval / element-picker IS supported on desktop (host evals the command scripts);
        // it starts disabled-but-enableable, exactly like the other injected surfaces.
        expect(runtime?.interaction).toEqual(expect.objectContaining({
            state: 'disabled',
            canEnable: true,
            pickerState: 'idle',
        }));

        // The native page-info channel flows real events into the diagnostics store.
        const event = createNativeWebViewPageInfoDiagnosticEvent({
            eventId: 'evt_pageinfo_1',
            browserSessionId: bridge.browserSessionId,
            viewId: bridge.viewId,
            navigationGeneration: bridge.navigationGeneration,
            capturedAtMs: 2_000,
            url: 'https://example.com/dashboard',
            loading: false,
            title: 'Example dashboard',
        });
        await act(async () => {
            bridge.onEvents([event]);
        });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.families.find((family) => family.family === 'pageInfo')).toEqual(expect.objectContaining({
            status: 'available',
        }));
    });

    it('ingests daemon diagnostics snapshots for the active machine-scoped view', async () => {
        stubCryptoRandomUuid();
        const snapshotClient = vi.fn(async () => ({
            ok: true as const,
            snapshot: createDaemonDiagnosticsSnapshot([
                createDaemonConsoleEvent(),
                createDaemonConsoleEvent({
                    eventId: 'evt_other_view',
                    viewId: 'view_2',
                    capturedAtMs: 3_001,
                }),
            ]),
        }));

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(snapshotClient).toHaveBeenCalledWith(expect.objectContaining({
            machineId: 'machine_1',
        }));
        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.eventCount).toBe(1);
        expect(projection.fidelity).toBe('cdp');
        expect(projection.events).toEqual([
            expect.objectContaining({ eventId: 'evt_daemon_console_1' }),
        ]);
    });

    it('keeps local frame diagnostics when daemon snapshots are unavailable or invalid', async () => {
        stubCryptoRandomUuid();
        const deferred = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const snapshotClient = vi.fn(() => deferred.promise);

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: null,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        const bridge = hook.getCurrent()?.bridge;
        expect(bridge).toBeTruthy();
        if (!bridge) return;

        await act(async () => {
            bridge.onEvents([{
                ...createDaemonConsoleEvent({
                    eventId: 'evt_local_console_1',
                    fidelity: 'injectedPage',
                    trusted: false,
                    capturedAtMs: 2_000,
                    collector: {
                        collectorId: bridge.collectorId,
                        nonce: bridge.nonce,
                        version: bridge.collectorVersion,
                    },
                    data: {
                        level: 'info',
                        argCount: 1,
                        textAvailable: true,
                    },
                }),
            }]);
        });
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).events).toEqual([
            expect.objectContaining({ eventId: 'evt_local_console_1' }),
        ]);

        deferred.resolve({ ok: false, reason: 'invalid_response' });
        await flushHookEffects({ cycles: 2, turns: 2 });

        const projection = selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });
        expect(projection.events).toEqual([
            expect.objectContaining({ eventId: 'evt_local_console_1' }),
        ]);
    });

    it('keeps one daemon snapshot acquisition across same-document view updates', async () => {
        stubCryptoRandomUuid();
        const signals: AbortSignal[] = [];
        const transport = countTransportRequests(async (input: BrowserDiagnosticsSnapshotClientInput): Promise<BrowserDiagnosticsSnapshotClientResult> => {
            if (input.signal) signals.push(input.signal);
            return { ok: true, snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]) };
        }, () => 'diagnostics.snapshot');
        const view = createLocalPreviewView();
        const hook = await renderHook(({ current }: { current: BrowserControlViewState }) => useBrowserDiagnosticsRuntime({
            view: current, enabled: true, parentOrigin: 'https://app.happier.test',
            daemonSnapshotClient: transport.request, daemonSnapshotRefreshIntervalMs: null,
        }), { initialProps: { current: view } });

        for (let arrival = 0; arrival < 20; arrival += 1) {
            await hook.rerender({ current: { ...view, title: `Application ${arrival}`, loadingProgress: arrival / 20 } });
        }
        expect(transport.read()).toEqual({ 'diagnostics.snapshot': 1 });
        expect(signals[0]?.aborted).toBe(false);
        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, view).eventCount).toBe(1);

        await hook.rerender({ current: { ...view, navigationGeneration: view.navigationGeneration + 1 } });
        expect(transport.read()).toEqual({ 'diagnostics.snapshot': 2 });
        expect(signals[0]?.aborted).toBe(true);
        await hook.unmount();
        expect(signals[1]?.aborted).toBe(true);
    });

    it('cancels daemon diagnostics refreshes on active view changes and unmount', async () => {
        vi.useFakeTimers();
        stubCryptoRandomUuid();
        const firstRefresh = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const secondRefresh = createDeferred<BrowserDiagnosticsSnapshotClientResult>();
        const signals: AbortSignal[] = [];
        const snapshotClient = vi.fn((input: { signal?: AbortSignal }) => {
            if (input.signal) signals.push(input.signal);
            return snapshotClient.mock.calls.length === 1
                ? firstRefresh.promise
                : secondRefresh.promise;
        });

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                    daemonSnapshotClient: snapshotClient,
                    daemonSnapshotRefreshIntervalMs: 5_000,
                }),
            {
                initialProps: {
                    view: createLocalPreviewView(),
                },
            },
        );

        expect(snapshotClient).toHaveBeenCalledTimes(1);

        await hook.rerender({
            view: createLocalPreviewView({ viewId: 'view_2' }),
        });

        expect(snapshotClient).toHaveBeenCalledTimes(2);
        expect(signals[0]?.aborted).toBe(true);

        firstRefresh.resolve({
            ok: true,
            snapshot: createDaemonDiagnosticsSnapshot([createDaemonConsoleEvent()]),
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(selectBrowserDiagnosticsForView(hook.getCurrent()!.state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }).eventCount).toBe(0);

        await hook.unmount();

        expect(signals[1]?.aborted).toBe(true);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(snapshotClient).toHaveBeenCalledTimes(2);
    });

    it('keeps diagnostics interaction default-off and publishes nonce-bound injected command requests after explicit enablement', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'disabled',
            ownerOnly: true,
            canEnable: true,
            pickerState: 'idle',
        }));
        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.requestEval({
            expression: 'window.location.href',
        })).toBe(false);

        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });

        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            ownerOnly: true,
            pickerState: 'idle',
        }));

        await act(async () => {
            expect(hook.getCurrent()?.requestEval({
                expression: 'window.location.href',
            })).toBe(true);
            expect(hook.getCurrent()?.requestGetProperties({
                objectId: 'object_1',
                objectGroupId: 'group_1',
            })).toBe(true);
            expect(hook.getCurrent()?.requestReleaseObjectGroup({
                objectGroupId: 'group_1',
            })).toBe(true);
            hook.getCurrent()?.interaction?.onStartElementPicker?.();
        });

        expect(hook.getCurrent()?.bridge).toEqual(expect.objectContaining({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 7,
            collectorId: 'browser_diagnostics:view_1:7:uuid_1',
            nonce: 'uuid_2',
            evalRequest: expect.objectContaining({
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                tier: 'injectedPage',
                expression: 'window.location.href',
                objectGroupId: 'browser_diagnostics:view_1:7',
                diagnosticsInteractionEnabled: true,
            }),
            getPropertiesRequest: expect.objectContaining({
                propertyRequestId: 'properties:view_1:7:2',
                objectId: 'object_1',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            }),
            releaseObjectGroupRequest: expect.objectContaining({
                releaseRequestId: 'release:view_1:7:3',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            }),
            elementPickerRequest: expect.objectContaining({
                pickerRequestId: 'picker:view_1:7:4',
                action: 'start',
                diagnosticsInteractionEnabled: true,
            }),
        }));
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            pickerState: 'active',
        }));

        await act(async () => {
            hook.getCurrent()?.bridge?.onEvalResult?.({
                v: 1,
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                result: {
                    type: 'string',
                    value: 'https://preview.happier.test/dashboard',
                    preview: [],
                },
            });
            hook.getCurrent()?.bridge?.onPropertiesResult?.({
                v: 1,
                propertyRequestId: 'properties:view_1:7:2',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectId: 'object_1',
                properties: [],
            });
            hook.getCurrent()?.bridge?.onReleaseObjectGroupResult?.({
                v: 1,
                releaseRequestId: 'release:view_1:7:3',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectGroupId: 'group_1',
            });
            hook.getCurrent()?.bridge?.onElementPickerResult?.({
                v: 1,
                pickerRequestId: 'picker:view_1:7:4',
                viewId: 'view_1',
                navigationGeneration: 7,
                tier: 'injectedPage',
                status: 'cancelled',
                audited: true,
            });
        });

        expect(hook.getCurrent()?.bridge?.evalRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.getPropertiesRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.releaseObjectGroupRequest).toBeUndefined();
        expect(hook.getCurrent()?.bridge?.elementPickerRequest).toBeUndefined();
        expect(hook.getCurrent()?.interaction).toEqual(expect.objectContaining({
            state: 'enabled',
            pickerState: 'idle',
        }));
    });

    it('fails closed without cryptographic token support', async () => {
        vi.stubGlobal('crypto', {});

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        expect(hook.getCurrent()).toEqual(expect.objectContaining({
            bridge: null,
        }));
    });

    it('stores eval results and expanded object properties for the local-owner console instead of discarding them', async () => {
        stubCryptoRandomUuid();

        const hook = await renderHook(
            ({ view }: { view: BrowserControlViewState | null }) =>
                useBrowserDiagnosticsRuntime({
                    view,
                    enabled: true,
                    parentOrigin: 'https://app.happier.test',
                }),
            {
                initialProps: {
                    view: createLocalPreviewView({ engineKind: 'nativeWebView' }),
                },
            },
        );

        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });

        // The console submits an expression through the eval-console control surface (DEV-3).
        await act(async () => {
            expect(hook.getCurrent()?.interaction?.evalConsole?.onSubmitExpression('document.title')).toBe(true);
        });

        // Before the result arrives the entry is pending and reachable from the projection.
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([
            expect.objectContaining({
                evalRequestId: 'eval:view_1:7:1',
                expression: 'document.title',
                status: 'pending',
            }),
        ]);

        await act(async () => {
            hook.getCurrent()?.bridge?.onEvalResult?.({
                v: 1,
                evalRequestId: 'eval:view_1:7:1',
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                result: {
                    type: 'object',
                    objectId: 'object_42',
                    className: 'HTMLDocument',
                    description: '#document',
                    preview: [{ name: 'title', valuePreview: 'Dashboard', truncated: false }],
                },
            });
        });

        // DEV-3: the completed result is STORED and rendered, not discarded.
        const completedEntry = hook.getCurrent()?.interaction?.evalConsole?.entries?.[0];
        expect(completedEntry).toEqual(expect.objectContaining({
            evalRequestId: 'eval:view_1:7:1',
            expression: 'document.title',
            status: 'completed',
            result: expect.objectContaining({
                type: 'object',
                objectId: 'object_42',
                className: 'HTMLDocument',
            }),
        }));

        // DEV-4: expanding the remote object loads its properties through getProperties and stores them.
        await act(async () => {
            expect(
                hook.getCurrent()?.interaction?.evalConsole?.onExpandObject(
                    'object_42',
                    completedEntry!.objectGroupId,
                ),
            ).toBe(true);
        });

        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties?.object_42).toEqual(
            expect.objectContaining({ status: 'loading' }),
        );
        expect(hook.getCurrent()?.bridge?.getPropertiesRequest).toEqual(expect.objectContaining({
            objectId: 'object_42',
            objectGroupId: completedEntry!.objectGroupId,
        }));

        await act(async () => {
            hook.getCurrent()?.bridge?.onPropertiesResult?.({
                v: 1,
                propertyRequestId: hook.getCurrent()!.bridge!.getPropertiesRequest!.propertyRequestId,
                viewId: 'view_1',
                navigationGeneration: 7,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                objectId: 'object_42',
                properties: [
                    {
                        name: 'title',
                        value: { type: 'string', value: 'Dashboard', preview: [] },
                        enumerable: true,
                    },
                ],
            });
        });

        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties?.object_42).toEqual(
            expect.objectContaining({
                status: 'loaded',
                properties: [
                    expect.objectContaining({
                        name: 'title',
                        value: expect.objectContaining({ type: 'string', value: 'Dashboard' }),
                    }),
                ],
            }),
        );

        // Navigation/clear releases the stored objects so they cannot leak across generations (DEV-4):
        // interaction resets to disabled and, when re-enabled on the new generation, the console is empty.
        await act(async () => {
            await hook.rerender({ view: createLocalPreviewView({ engineKind: 'nativeWebView', navigationGeneration: 8 }) });
        });
        expect(hook.getCurrent()?.interaction?.state).toBe('disabled');
        await act(async () => {
            hook.getCurrent()?.interaction?.onEnableInteraction?.();
        });
        expect(hook.getCurrent()?.interaction?.evalConsole?.entries).toEqual([]);
        expect(hook.getCurrent()?.interaction?.evalConsole?.objectProperties).toEqual({});
    });
});
