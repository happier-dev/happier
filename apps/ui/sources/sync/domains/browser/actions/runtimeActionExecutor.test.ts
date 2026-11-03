import type {
    BrowserAdapterCapabilitiesV1,
    BrowserAutomationActionKindV1,
    BrowserCommandV1,
    BrowserEventV1,
    BrowserViewTargetV1,
    RuntimeActionIdV1,
    RuntimeActionExecuteArgs,
} from '@happier-dev/protocol';
import {
    BrowserAutomationCancelActiveResultV1Schema,
    BrowserCommandDispatchResultV1Schema,
    BrowserTargetPolicyDecisionV1Schema,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { createBrowserAutomationControlService, type BrowserAutomationRequest } from '../automation';
import type { BrowserControlCommandDispatchResult, BrowserControlState } from '../control';
import { applyBrowserControlEvent, createBrowserControlState } from '../control';
import type { BrowserDaemonControlDispatchClientResult } from '../control/machineRpc';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { unavailableDesktopWebViewNativeAvailability } from '../adapters/desktopWebView';

// OS browser handoff is a genuine platform boundary; keep selection and dispatch real.
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));

type BrowserRuntimeActionExecutorModule = typeof import('./runtimeActionExecutor');

it.each(['ui', 'agent', 'cli'] as const)('forwards approved sandbox recovery from %s to its exact Machine', async surface => {
    const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
    const executeOnMachine = vi.fn(async () => ({ status: 'failed', code: 'os_authorization_required' }));
    const execute = createBrowserRuntimeActionExecutor({ executeOnMachine });
    const args = { actionId: 'browser.sandbox.install' as const, input: { machineId: 'machine_1' },
        context: { surface, authority: 'account_automation' as const, bypassApprovals: true,
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine_1' } } };
    expect(await execute(args)).toEqual({ status: 'failed', code: 'os_authorization_required' });
    expect(executeOnMachine).toHaveBeenCalledWith(args);
    executeOnMachine.mockClear();
    expect(await execute({ ...args, input: {} })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(await execute({ ...args, context: { ...args.context, externalActionTarget: undefined } }))
        .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(executeOnMachine).not.toHaveBeenCalled();
});

it.each([
    ['browser.context.capturePage', { browserSessionId: 'browser', viewId: 'view' }],
    ['browser.context.attachToComposer', { browserSessionId: 'browser', viewId: 'view', contextId: 'context' }],
    ['browser.context.attachToComposer', { browserSessionId: 'browser', viewId: 'view', contextId: 'context', source: undefined }],
    ['browser.recording.status', { recordingId: 'recording' }],
] as const)('routes daemon-owned non-command %s by its catalog schema', async (actionId, input) => {
    const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
    const failure = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } as const;
    const executeOnMachine = vi.fn(async () => failure);
    const execute = createBrowserRuntimeActionExecutor({ executeOnMachine });
    expect(await execute({ actionId, input, context: { authority: 'present_user',
        externalActionTarget: { kind: 'machine', machineId: 'machine' } } })).toEqual(failure);
});

it('never falls back from a mounted page attachment to a Machine owner', async () => {
    const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
    const executeOnMachine = vi.fn();
    const execute = createBrowserRuntimeActionExecutor({ executeOnMachine });
    const input = { browserSessionId: 'browser', viewId: 'view', navigationGeneration: 0, source: 'activePage' };
    const context = { surface: 'ui' as const, externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } };
    expect(await execute({ actionId: 'browser.context.attachToComposer', input, context }))
        .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    expect(await execute({ actionId: 'browser.context.attachToComposer', input: { ...input, source: 'unknown' }, context }))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    expect(executeOnMachine).not.toHaveBeenCalled();
});

const localPreviewTarget = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

const externalTarget = {
    kind: 'externalUrl',
    targetId: 'external_1',
    url: 'https://browser.example.test/start',
    display: {
        title: 'Browser',
        addressLabel: 'browser.example.test',
    },
} satisfies BrowserViewTargetV1;

const localPreviewCapabilities = {
    ...buildBrowserAdapterCapabilities({
        adapterKind: 'localPreview',
        supportedTargetKinds: ['localServicePreview'],
        supportedRenderEngines: ['webIframe'],
    }),
    navigation: {
        canNavigate: true,
        canGoBack: false,
        canGoForward: false,
        canReload: true,
        canStop: true,
    },
} satisfies BrowserAdapterCapabilitiesV1;

const sidecarCapabilities = {
    ...localPreviewCapabilities,
    adapterKind: 'chromiumSidecar',
    supportedTargetKinds: ['externalUrl'],
    supportedRenderEngines: ['desktopWebView'],
    navigation: {
        canNavigate: true,
        canGoBack: true,
        canGoForward: true,
        canReload: true,
        canStop: true,
    },
    inputRouting: 'native',
} satisfies BrowserAdapterCapabilitiesV1;

function runtimeArgs(
    args: Omit<RuntimeActionExecuteArgs, 'context'> & Partial<Pick<RuntimeActionExecuteArgs, 'context'>>,
): RuntimeActionExecuteArgs {
    return {
        context: {},
        ...args,
    };
}

async function loadRuntimeActionExecutor(): Promise<BrowserRuntimeActionExecutorModule | null> {
    const path = './runtimeActionExecutor';
    return import(path).catch(() => null) as Promise<BrowserRuntimeActionExecutorModule | null>;
}

function stateFromEvents(events: readonly BrowserEventV1[]): BrowserControlState {
    return events.reduce(
        (nextState, event) => applyBrowserControlEvent(nextState, event),
        createBrowserControlState(),
    );
}

function openViewState(input: Readonly<{
    adapterKind: BrowserEventV1 extends infer Event
        ? Event extends { kind: 'viewOpened'; adapterKind: infer AdapterKind }
            ? AdapterKind
            : never
        : never;
    engineKind: BrowserEventV1 extends infer Event
        ? Event extends { kind: 'viewOpened'; engineKind: infer EngineKind }
            ? EngineKind
            : never
        : never;
    target: BrowserViewTargetV1;
    capabilities: BrowserAdapterCapabilitiesV1;
    currentUrl: string;
}>): BrowserControlState {
    return stateFromEvents([{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: 'browser_session_1',
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        target: input.target,
        platform: input.target.kind === 'externalUrl' ? 'desktop' : 'web',
        currentUrl: input.currentUrl,
        adapterKind: input.adapterKind,
        engineKind: input.engineKind,
        adapterCapabilities: input.capabilities,
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        occurredAt: 1_002,
    }]);
}

describe('browser runtime action executor', () => {
    it.each(['browser.view.close', 'browser.automation.snapshot'] as const)(
        'routes mounted and unmounted %s through its exact Machine owner', async (actionId) => {
            const { createDefaultRuntimeActionExecutor } = await import('@/sync/ops/actions/defaultRuntimeActionExecutor');
            const { registerBrowserRuntimeControlAdapter } = await import('./runtimeControlRegistry');
            const input = actionId === 'browser.view.close'
                ? { kind: 'closeView', commandId: 'close-unmounted', browserSessionId: 'browser_session_1', viewId: 'view_1' }
                : { v: 1, automationRequestId: 'snapshot-unmounted', browserSessionId: 'browser_session_1', viewId: 'view_1',
                    navigationGeneration: 4, requestedBy: 'agent', requesterRef: { kind: 'session', id: 'session_1' },
                    actionKind: 'snapshot', payload: {}, timeoutMs: 1000 };
            // The captured-Account Machine Action transport is the external boundary. Its
            // admission/approval refusal must survive forwarding unchanged.
            const result = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } as const;
            const executeOnMachine = vi.fn(async () => result);
            const state = openViewState({ adapterKind: 'chromiumSidecar', engineKind: 'streamedSurface',
                target: externalTarget, capabilities: sidecarCapabilities, currentUrl: externalTarget.url });
            const unmount = registerBrowserRuntimeControlAdapter({ browserSessionId: 'browser_session_1',
                control: { readState: () => state, applyDispatchResult: () => {} } });
            const execute = createDefaultRuntimeActionExecutor({}, undefined, executeOnMachine);
            const args = runtimeArgs({ actionId, input, context: { authority: 'account_automation', surface: 'agent',
                externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } });
            try {
                expect(await execute(args)).toEqual(result);
                unmount();
                expect(await execute(args)).toEqual(result);
                expect(executeOnMachine).toHaveBeenCalledWith(args);
            } finally {
                unmount();
            }
            executeOnMachine.mockClear();
            for (const context of [
                { defaultSessionMachineId: 'machine_1' },
                { externalActionTarget: { kind: 'machine', machineId: ' ' } },
                { externalActionTarget: { kind: 'session', sessionId: 'session_1' } },
            ] satisfies RuntimeActionExecuteArgs['context'][]) {
                expect(await execute({ ...args, context })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
            }
            expect(executeOnMachine).not.toHaveBeenCalled();
        },
    );

    it('routes a close through the exact Machine when an explicit control has no requested view', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = createBrowserControlState();
        const applyDispatchResult = vi.fn();
        // The captured-Account Machine transport is the external boundary; preserve its refusal.
        const result = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } as const;
        const executeOnMachine = vi.fn(async () => result);
        const execute = createBrowserRuntimeActionExecutor({
            control: { readState: () => state, applyDispatchResult },
            executeOnMachine,
        });
        const args = runtimeArgs({ actionId: 'browser.view.close',
            input: { kind: 'closeView', commandId: 'close-empty-control', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            context: { authority: 'account_automation', surface: 'agent',
                externalActionTarget: { kind: 'machine', machineId: 'machine_1' } },
        });

        expect(await execute(args)).toEqual(result);
        expect(executeOnMachine).toHaveBeenCalledWith(args);
        expect(applyDispatchResult).not.toHaveBeenCalled();

        executeOnMachine.mockClear();
        for (const context of [
            {},
            { defaultSessionMachineId: 'machine_1' },
            { externalActionTarget: { kind: 'machine', machineId: ' ' } },
            { externalActionTarget: { kind: 'session', sessionId: 'session_1' } },
        ] satisfies RuntimeActionExecuteArgs['context'][]) {
            expect(await execute({ ...args, context })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        }
        expect(executeOnMachine).not.toHaveBeenCalled();
        expect(applyDispatchResult).not.toHaveBeenCalled();
    });

    it('observes daemon-owned views through their admitted machine Action without using the in-app owner', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = openViewState({ adapterKind: 'chromiumSidecar', engineKind: 'desktopWebView',
            target: externalTarget, capabilities: sidecarCapabilities, currentUrl: externalTarget.url });
        const controlService = createBrowserAutomationControlService({ nowMs: () => 1000 });
        const engine = vi.fn(async () => ({ status: 'succeeded' as const }));
        controlService.registerOwner({ ownerId: 'local', authority: 'uiLocal', browserSessionId: 'browser_session_1',
            viewId: 'view_1', navigationGeneration: 4, adapterKind: 'localPreview', fidelity: 'webIframe',
            trustedInput: false, supportedActions: ['snapshot'], executeAction: engine });
        // The machine Action transport is a network boundary. The runtime's routing stays real.
        const executeOnMachine = vi.fn(async () => ({ status: 'succeeded', automationRequestId: 'fresh' }));
        const execute = createBrowserRuntimeActionExecutor({ control: { readState: () => state, applyDispatchResult: () => {} },
            automation: { controlService }, executeOnMachine });
        const request = { v: 1, automationRequestId: 'fresh', browserSessionId: 'browser_session_1', viewId: 'view_1',
            navigationGeneration: 4, requestedBy: 'user', requesterRef: { kind: 'session', id: 'session_1' },
            actionKind: 'snapshot', payload: {}, timeoutMs: 1000 };
        const context = { authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } satisfies RuntimeActionExecuteArgs['context'];
        expect(await execute(runtimeArgs({ actionId: 'browser.automation.snapshot', input: request, context })))
            .toMatchObject({ status: 'succeeded', automationRequestId: 'fresh' });
        expect(executeOnMachine).toHaveBeenCalledWith(expect.objectContaining({ actionId: 'browser.automation.snapshot', input: request, context }));
        expect(engine).not.toHaveBeenCalled();
        executeOnMachine.mockClear();
        for (const unavailableContext of [
            { authority: 'present_user', defaultSessionMachineId: 'machine_1' },
            { authority: 'present_user', externalActionTarget: { kind: 'session', sessionId: 'session_1' } },
            { authority: 'present_user', externalActionTarget: { kind: 'machine', machineId: ' ' } },
        ] satisfies RuntimeActionExecuteArgs['context'][]) {
            expect(await execute(runtimeArgs({ actionId: 'browser.automation.snapshot', input: request, context: unavailableContext })))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        }
        expect(executeOnMachine).not.toHaveBeenCalled();
        expect(engine).not.toHaveBeenCalled();
    });
    it('returns typed unsupported device emulation for a mounted native view', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = openViewState({ adapterKind: 'externalUrl', engineKind: 'desktopWebView', target: externalTarget,
            capabilities: localPreviewCapabilities, currentUrl: externalTarget.url });
        const execute = createBrowserRuntimeActionExecutor({ control: { readState: () => state, applyDispatchResult: () => {} } });
        expect(await execute(runtimeArgs({ actionId: 'browser.view.setViewport', input: {
            kind: 'setViewport', browserSessionId: 'browser_session_1', viewId: 'view_1', commandId: 'emulate', emulation: { kind: 'preset', presetId: 'phone' },
        } }))).toMatchObject({ status: 'failed', error: { code: 'unsupported_command', retryable: false } });
    });
    it('opens the exact mounted page in the system browser without navigating or replacing it', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = openViewState({ adapterKind: 'localPreview', engineKind: 'webIframe', target: localPreviewTarget,
            capabilities: localPreviewCapabilities, currentUrl: 'https://preview.example.test/page' });
        const applyDispatchResult = vi.fn();
        const execute = createBrowserRuntimeActionExecutor({ control: { readState: () => state, applyDispatchResult } });
        expect(await execute(runtimeArgs({ actionId: 'browser.view.openExternal', input: {
            browserSessionId: 'browser_session_1', viewId: 'view_1', commandId: 'open-current-page',
        } }))).toMatchObject({ status: 'dispatched', commandId: 'open-current-page' });
        expect(openExternalUrl).toHaveBeenCalledWith('https://preview.example.test/page');
        expect(applyDispatchResult).not.toHaveBeenCalled();
        vi.mocked(openExternalUrl).mockClear();
        expect(await execute(runtimeArgs({ actionId: 'browser.view.openExternal', input: {
            browserSessionId: 'another-session', viewId: 'view_1', commandId: 'wrong-source',
        } }))).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(openExternalUrl).not.toHaveBeenCalled();
    });
    it('fulfills an allowed OS-tab handoff below browser.view.open without materializing a view', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = createBrowserControlState();
        const execute = createBrowserRuntimeActionExecutor({ control: {
            readState: () => state,
            applyDispatchResult: () => {},
            readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({ targetKind: 'externalUrl', state: 'allowed' }),
                desktopWebViewAvailability: unavailableDesktopWebViewNativeAvailability('desktop_webview_unsupported_platform') }),
        } });
        const result = await execute(runtimeArgs({ actionId: 'browser.view.open', input: {
            kind: 'openView', commandId: 'external-handoff', browserSessionId: 'browser_session_1',
            viewId: 'external-view', target: externalTarget, platform: 'desktop', focus: true,
        } }));
        expect(result).toMatchObject({ status: 'dispatched', adapterKind: 'externalUrl' });
        expect(openExternalUrl).toHaveBeenCalledWith(externalTarget.url);
        expect(state.viewsById['external-view']).toBeUndefined();
    });

    it('preserves an unconfirmed daemon dispatch instead of reporting optimistic acceptance', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = openViewState({ adapterKind: 'chromiumSidecar', engineKind: 'desktopWebView',
            target: externalTarget, capabilities: sidecarCapabilities, currentUrl: externalTarget.url });
        const execute = createBrowserRuntimeActionExecutor({ control: {
            readState: () => state,
            applyDispatchResult: () => { throw new Error('Daemon events must not be overwritten by the pre-dispatch projection'); },
            sendDaemonCommand: async () => ({ ok: false, reason: 'request_failed' }),
        } });
        expect(await execute(runtimeArgs({ actionId: 'browser.control.takeControl', input: {
            kind: 'takeControl', commandId: 'take-unconfirmed', browserSessionId: 'browser_session_1', viewId: 'view_1',
        } }))).toMatchObject({ ok: false, errorCode: 'browser_control_unconfirmed' });
    });

    it('does not report an OS handoff as dispatched when the platform refuses it', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        vi.mocked(openExternalUrl).mockResolvedValueOnce(false);
        const execute = createBrowserRuntimeActionExecutor({ control: {
            readState: createBrowserControlState,
            applyDispatchResult: () => {},
            readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({ targetKind: 'externalUrl', state: 'allowed' }),
                desktopWebViewAvailability: unavailableDesktopWebViewNativeAvailability('desktop_webview_unsupported_platform') }),
        } });
        expect(await execute(runtimeArgs({ actionId: 'browser.view.open', input: {
            kind: 'openView', commandId: 'refused-handoff', browserSessionId: 'browser_session_1',
            viewId: 'external-view', target: externalTarget, platform: 'desktop',
        } }))).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    });
    it('uses the mounted target policy when opening an external URL through the Action owner', async () => {
        const mod = await loadRuntimeActionExecutor();
        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;
        let state = createBrowserControlState();
        const executeOnMachine = vi.fn();
        const execute = mod.createBrowserRuntimeActionExecutor({ control: {
            readState: () => state,
            applyDispatchResult: result => { state = result.state; },
            readDispatchOptions: () => ({ targetPolicyDecision: BrowserTargetPolicyDecisionV1Schema.parse({ targetKind: 'externalUrl', state: 'denied', reasonCode: 'policy_denied' }) }),
        }, executeOnMachine });
        const result = await execute(runtimeArgs({ actionId: 'browser.view.open', input: {
            kind: 'openView', commandId: 'open-through-action', browserSessionId: 'browser_session_1', viewId: 'view_1',
            target: externalTarget, platform: 'ios', currentUrl: externalTarget.url, focus: true,
        }, context: { externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } }));
        expect(result).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        expect(state.viewsById.view_1).toBeUndefined();
        expect(executeOnMachine).not.toHaveBeenCalled();
    });

    it('does not replace an explicitly targeted managed open with a registered local Browser', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const local = { readState: createBrowserControlState, applyDispatchResult: vi.fn() };
        const command = { kind: 'openView' as const, commandId: 'managed-open', browserSessionId: 'session_1',
            viewId: 'managed-view', target: externalTarget, platform: 'web' as const, focus: true };
        const result = BrowserCommandDispatchResultV1Schema.parse({ v: 1, commandId: command.commandId,
            status: 'failed', error: { code: 'feature_disabled', message: 'Managed Browser is disabled' } });
        // The Machine Action transport is the network boundary; its refusal must survive intact.
        const executeOnMachine = vi.fn(async () => result);
        const execute = createBrowserRuntimeActionExecutor({ resolveControl: () => local, executeOnMachine });
        const context = { authority: 'present_user' as const,
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine_1' } };
        expect(await execute(runtimeArgs({ actionId: 'browser.view.open', input: command, context }))).toEqual(result);
        expect(local.applyDispatchResult).not.toHaveBeenCalled();
        const unavailable = createBrowserRuntimeActionExecutor({ resolveControl: () => local });
        expect(await unavailable(runtimeArgs({ actionId: 'browser.view.open', input: command, context })))
            .toMatchObject({ ok: false, error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
        expect(local.applyDispatchResult).not.toHaveBeenCalled();
    });

    it('routes browser.navigate through the domain control dispatcher and commits the accepted state', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const state = openViewState({
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            target: localPreviewTarget,
            capabilities: localPreviewCapabilities,
            currentUrl: 'https://preview.happier.test/',
        });
        const commits: BrowserControlCommandDispatchResult[] = [];
        const execute = mod.createBrowserRuntimeActionExecutor({
            control: {
                readState: () => state,
                applyDispatchResult: (result) => {
                    commits.push(result);
                },
            },
        });

        const command = {
            kind: 'navigate',
            commandId: 'command_navigate',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            url: 'https://preview.happier.test/dashboard',
        } satisfies BrowserCommandV1;

        const result = await execute(runtimeArgs({
            actionId: 'browser.navigate',
            input: command,
        }));

        expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_navigate',
            status: 'dispatched',
            adapterKind: 'localPreview',
            events: [],
        });

        const committed = commits[0];
        expect(committed).toBeDefined();
        if (!committed) return;
        expect(committed.effects).toEqual([{
            kind: 'clientLocalNavigation',
            viewId: 'view_1',
            command,
        }]);
        expect(committed.state.viewsById.view_1?.pendingUrl).toBe('https://preview.happier.test/dashboard');
    });

    it('AMD-8: answers Back, Forward and Stop on a third-party web iframe page with the typed history reason, and still reloads', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const state = openViewState({
            adapterKind: 'externalUrl',
            engineKind: 'webIframe',
            target: externalTarget,
            capabilities: buildBrowserAdapterCapabilities({
                adapterKind: 'externalUrl', supportedTargetKinds: ['externalUrl'], supportedRenderEngines: ['webIframe'],
            }),
            currentUrl: 'https://browser.example.test/start',
        });
        const commits: BrowserControlCommandDispatchResult[] = [];
        const execute = createBrowserRuntimeActionExecutor({
            control: { readState: () => state, applyDispatchResult: (result) => { commits.push(result); } },
        });
        const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' } as const;

        for (const [actionId, kind] of [['browser.goBack', 'goBack'], ['browser.goForward', 'goForward'], ['browser.stop', 'stop']] as const) {
            await expect(execute(runtimeArgs({ actionId, input: { kind, commandId: `command_${kind}`, ...view } }))).resolves.toEqual({
                ok: false,
                errorCode: 'runtime_action_disabled',
                error: 'runtime_action_disabled:browser:browser_page_history_uncontrollable',
            });
        }
        expect(commits).toEqual([]);

        await expect(execute(runtimeArgs({ actionId: 'browser.reload', input: { kind: 'reload', commandId: 'command_reload', ...view } })))
            .resolves.toMatchObject({ status: 'dispatched', commandId: 'command_reload' });
    });

    it('fails closed before local dispatch when a browser Action id carries another command kind', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const state = openViewState({
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            target: localPreviewTarget,
            capabilities: localPreviewCapabilities,
            currentUrl: 'https://preview.happier.test/',
        });
        const applyDispatchResult = vi.fn();
        const execute = mod.createBrowserRuntimeActionExecutor({
            control: {
                readState: () => state,
                applyDispatchResult,
            },
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.view.focus',
            input: {
                kind: 'navigate',
                commandId: 'command_mismatched',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://preview.happier.test/escaped-navigation',
            } satisfies BrowserCommandV1,
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'invalid_parameters',
            error: 'invalid_parameters',
        });
        expect(applyDispatchResult).not.toHaveBeenCalled();
    });

    it('resolves browser control from the command browser session before dispatching', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const state = openViewState({
            adapterKind: 'localPreview',
            engineKind: 'webIframe',
            target: localPreviewTarget,
            capabilities: localPreviewCapabilities,
            currentUrl: 'https://preview.happier.test/',
        });
        const commits: BrowserControlCommandDispatchResult[] = [];
        const execute = mod.createBrowserRuntimeActionExecutor({
            resolveControl: (command) => 'browserSessionId' in command && command.browserSessionId === 'browser_session_1'
                ? {
                    readState: () => state,
                    applyDispatchResult: (result) => {
                        commits.push(result);
                    },
                }
                : null,
        });

        const result = await execute(runtimeArgs({
            actionId: 'browser.navigate',
            input: {
                kind: 'navigate',
                commandId: 'command_registry_navigate',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://preview.happier.test/registered',
            } satisfies BrowserCommandV1,
        }));

        expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_registry_navigate',
            status: 'dispatched',
            adapterKind: 'localPreview',
        });

        expect(commits[0]?.state.viewsById.view_1?.pendingUrl).toBe('https://preview.happier.test/registered');
    });

    it('resolves browser automation status from the request browser session and returns the action result contract', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const controlService = createBrowserAutomationControlService({ nowMs: () => 2_000 });
        controlService.registerOwner({
            ownerId: 'owner_1',
            authority: 'uiLocal',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            adapterKind: 'localPreview',
            fidelity: 'webIframe',
            trustedInput: false,
            supportedActions: ['getStatus'],
            executeAction: async () => ({ status: 'succeeded' }),
        });
        const execute = mod.createBrowserRuntimeActionExecutor({
            resolveAutomation: (input) => input.browserSessionId === 'browser_session_1'
                ? { controlService }
                : null,
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.automation.status',
            input: {
                v: 1,
                automationRequestId: 'automation_request_1',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 4,
                requestedBy: 'agent',
                requesterRef: { kind: 'session', id: 'session_1' },
                actionKind: 'getStatus',
                payload: {},
                timeoutMs: 1_000,
            },
        }))).resolves.toMatchObject({
            v: 1,
            automationRequestId: 'automation_request_1',
            status: 'succeeded',
            adapterKind: 'localPreview',
            fidelity: 'webIframe',
            trustedInput: false,
            navigationGenerationBefore: 4,
            navigationGenerationAfter: 4,
            controlEpochBefore: 0,
            controlEpochAfter: 0,
            diagnostics: {},
            resultSummary: { controller: 'none', controlEpoch: 0 },
        });
        expect(controlService.getActionTimeline({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toEqual([]);
    });

    it('fails closed when browser automation has no owner evidence to project a canonical result', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const controlService = createBrowserAutomationControlService({ nowMs: () => 2_000 });
        const execute = mod.createBrowserRuntimeActionExecutor({ automation: { controlService } });

        await expect(execute(runtimeArgs({
            actionId: 'browser.automation.status',
            input: {
                v: 1,
                automationRequestId: 'automation_request_without_owner',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 4,
                requestedBy: 'agent',
                requesterRef: { kind: 'session', id: 'session_1' },
                actionKind: 'getStatus',
                payload: {},
                timeoutMs: 1_000,
            },
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_view_unavailable',
        });
        expect(controlService.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).toEqual([]);
    });

    it('rejects forged human input at Action admission and stamps present-user input', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const controlService = createBrowserAutomationControlService({ nowMs: Date.now });
        const applied: string[] = [];
        const view = { browserSessionId: 'browser_session_1', viewId: 'view_1' };
        controlService.registerOwner({ ...view, ownerId: 'human-owner', authority: 'uiLocal', navigationGeneration: 4,
            adapterKind: 'localPreview', fidelity: 'webIframe', trustedInput: false, supportedActions: ['click'],
            executeAction: async request => { applied.push(request.requestedBy); return { status: 'succeeded' }; } });
        controlService.recordHumanInput({ ...view, inputKind: 'pointer', occurredAtMs: Date.now() });
        const execute = createBrowserRuntimeActionExecutor({ automation: { controlService } });
        const input = { v: 1, ...view, automationRequestId: 'request', navigationGeneration: 4,
            requestedBy: 'user', requesterRef: { kind: 'agent', id: 'agent' }, actionKind: 'click',
            payload: { locator: { kind: 'css', value: '#submit' } }, timeoutMs: 1000 };
        expect(await execute(runtimeArgs({ actionId: 'browser.automation.click', input,
            context: { authority: 'account_automation' } }))).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(applied).toEqual([]);
        expect(await execute(runtimeArgs({ actionId: 'browser.automation.click', input: { ...input, requestedBy: 'agent' },
            context: { authority: 'present_user' } }))).toMatchObject({ status: 'succeeded' });
        expect(applied).toEqual(['user']);
    });

    it('dispatches browser automation navigation action ids through the registered automation owner', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        let now = 3_000;
        const controlService = createBrowserAutomationControlService({ nowMs: () => now });
        const executedActionKinds: string[] = [];
        const executeAction = vi.fn(async (request: BrowserAutomationRequest) => {
            executedActionKinds.push(request.actionKind);
            return { status: 'succeeded' as const };
        });
        controlService.registerOwner({
            ownerId: 'owner_navigation',
            authority: 'uiLocal',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            adapterKind: 'localPreview',
            fidelity: 'webIframe',
            trustedInput: false,
            supportedActions: ['navigate', 'reload', 'goBack', 'goForward'],
            executeAction,
        });
        const execute = mod.createBrowserRuntimeActionExecutor({
            automation: { controlService },
        });
        const actions = [
            ['browser.automation.navigate', 'navigate'],
            ['browser.automation.reload', 'reload'],
            ['browser.automation.goBack', 'goBack'],
            ['browser.automation.goForward', 'goForward'],
        ] as const satisfies readonly (readonly [RuntimeActionIdV1, BrowserAutomationActionKindV1])[];

        for (const [actionId, actionKind] of actions) {
            now += 10;

            const result = await execute(runtimeArgs({
                actionId,
                input: {
                    v: 1,
                    automationRequestId: `automation_request_${actionKind}`,
                    browserSessionId: 'browser_session_1',
                    viewId: 'view_1',
                    navigationGeneration: 4,
                    requestedBy: 'agent',
                    requesterRef: { kind: 'session', id: 'session_1' },
                    actionKind,
                    payload: actionKind === 'navigate'
                        ? { url: 'https://browser.example.test/next' }
                        : {},
                    timeoutMs: 1_000,
                },
            }));

            expect(result).toMatchObject({
                v: 1,
                automationRequestId: `automation_request_${actionKind}`,
                status: 'succeeded',
                adapterKind: 'localPreview',
                fidelity: 'webIframe',
            });
        }

        expect(executedActionKinds).toEqual([
            'navigate',
            'reload',
            'goBack',
            'goForward',
        ]);
    });

    it('serializes browser.automation.cancelActive as the canonical cancellation outcome with the real count', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        let releaseAction: () => void = () => undefined;
        const pendingAction = new Promise<void>((resolve) => {
            releaseAction = resolve;
        });
        const controlService = createBrowserAutomationControlService({ nowMs: () => 4_000 });
        controlService.registerOwner({
            ownerId: 'owner_cancel_active',
            authority: 'uiLocal',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            adapterKind: 'localPreview',
            fidelity: 'webIframe',
            trustedInput: false,
            supportedActions: ['waitFor'],
            executeAction: async () => {
                await pendingAction;
                return { status: 'succeeded' };
            },
        });
        const activeAction = controlService.executeAction({
            v: 1,
            automationRequestId: 'automation_request_cancel_active',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            actionKind: 'waitFor',
            payload: {},
            timeoutMs: 1_000,
        });
        await Promise.resolve();
        const execute = mod.createBrowserRuntimeActionExecutor({ automation: { controlService } });

        for (const context of [{}, { authority: 'account_automation' as const }]) {
            expect(await execute(runtimeArgs({
                actionId: 'browser.automation.cancelActive',
                input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
                context,
            }))).toEqual({ v: 1, outcome: 'owner_mismatch', canceledCount: 0 });
        }
        const canceled = await execute(runtimeArgs({
            actionId: 'browser.automation.cancelActive',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            context: { authority: 'present_user' },
        }));

        expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(canceled).success).toBe(true);
        expect(canceled).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1, completion: 'uncertain' });
        releaseAction();
        await expect(activeAction).resolves.toMatchObject({
            status: 'canceled',
            errorCode: 'user_canceled',
        });
        const noActive = await execute(runtimeArgs({
            actionId: 'browser.automation.cancelActive',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
            context: { authority: 'present_user' },
        }));
        expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(noActive).success).toBe(true);
        expect(noActive).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
    });

    it('fails closed when a browser automation action id reaches an owner that does not support the action kind', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const controlService = createBrowserAutomationControlService({ nowMs: () => 4_000 });
        const executeAction = vi.fn(async () => ({ status: 'succeeded' as const }));
        controlService.registerOwner({
            ownerId: 'owner_snapshot_only',
            authority: 'uiLocal',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 4,
            adapterKind: 'localPreview',
            fidelity: 'webIframe',
            trustedInput: false,
            supportedActions: ['snapshot'],
            executeAction,
        });
        const execute = mod.createBrowserRuntimeActionExecutor({
            automation: { controlService },
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.automation.reload',
            input: {
                v: 1,
                automationRequestId: 'automation_request_reload',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 4,
                requestedBy: 'agent',
                requesterRef: { kind: 'session', id: 'session_1' },
                actionKind: 'reload',
                payload: {},
                timeoutMs: 1_000,
            },
        }))).resolves.toMatchObject({
            v: 1,
            automationRequestId: 'automation_request_reload',
            status: 'unsupported',
            errorCode: 'unsupported_action',
        });
        expect(executeAction).not.toHaveBeenCalled();
    });

    it('fails closed with a typed disabled reason when daemon-authoritative browser control has no command route', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const state = openViewState({
            adapterKind: 'chromiumSidecar',
            engineKind: 'desktopWebView',
            target: externalTarget,
            capabilities: sidecarCapabilities,
            currentUrl: 'https://browser.example.test/start',
        });
        const applyDispatchResult = vi.fn();
        const execute = mod.createBrowserRuntimeActionExecutor({
            control: {
                readState: () => state,
                applyDispatchResult,
            },
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.navigate',
            input: {
                kind: 'navigate',
                commandId: 'command_sidecar_navigate',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://browser.example.test/next',
            } satisfies BrowserCommandV1,
        }))).resolves.toEqual({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_control_route_unavailable',
        });
        expect(applyDispatchResult).not.toHaveBeenCalled();
    });

    it('A3: routes daemon-authoritative browser navigation commands through the supplied sendDaemonCommand seam', async () => {
        const mod = await loadRuntimeActionExecutor();

        expect(mod?.createBrowserRuntimeActionExecutor).toBeTypeOf('function');
        if (!mod?.createBrowserRuntimeActionExecutor) return;

        const state = openViewState({
            adapterKind: 'chromiumSidecar',
            engineKind: 'desktopWebView',
            target: externalTarget,
            capabilities: sidecarCapabilities,
            currentUrl: 'https://browser.example.test/start',
        });
        const applyDispatchResult = vi.fn();
        const sendDaemonCommand = vi.fn(async (command: BrowserCommandV1): Promise<BrowserDaemonControlDispatchClientResult> => ({
            ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events: [] },
        }));
        const execute = mod.createBrowserRuntimeActionExecutor({
            control: {
                readState: () => state,
                applyDispatchResult,
                sendDaemonCommand,
            },
        });
        const commands = [
            ['browser.navigate', {
                kind: 'navigate',
                commandId: 'command_sidecar_navigate',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                url: 'https://browser.example.test/next',
            }],
            ['browser.reload', {
                kind: 'reload',
                commandId: 'command_sidecar_reload',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            }],
            ['browser.stop', {
                kind: 'stop',
                commandId: 'command_sidecar_stop',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            }],
            ['browser.goBack', {
                kind: 'goBack',
                commandId: 'command_sidecar_back',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            }],
            ['browser.goForward', {
                kind: 'goForward',
                commandId: 'command_sidecar_forward',
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
            }],
        ] as const satisfies readonly (readonly [RuntimeActionIdV1, BrowserCommandV1])[];

        for (const [actionId, command] of commands) {
            const result = await execute(runtimeArgs({ actionId, input: command }));

            // With the seam wired the daemon command is dispatched —
            // never the browser_control_route_unavailable fail-closed of the unwired path.
            expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
            expect(result).toMatchObject({
                v: 1,
                commandId: command.commandId,
                status: 'dispatched',
                adapterKind: 'chromiumSidecar',
                events: [],
            });
            expect(result).not.toMatchObject({ error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
            expect(sendDaemonCommand).toHaveBeenCalledWith(command);
        }
        expect(applyDispatchResult).not.toHaveBeenCalled();
    });

    it('dispatches browser.recording.attachToComposer to the recording-attach adapter', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const attach = vi.fn(async () => ({
            status: 'attached' as const,
            state: {
                sessionsById: {},
                sessionOrder: [],
                activeRecordingIdByViewId: {},
                attachmentsById: {},
                attachmentOrder: [],
            },
            attachmentId: 'attachment_1',
        }));
        const execute = realMod.createBrowserRuntimeActionExecutor({ recordingAttach: { attach } });

        await expect(execute(runtimeArgs({
            actionId: 'browser.recording.attachToComposer',
            input: { recordingId: 'browser_recording_1', sessionId: 'session_1' },
        }))).resolves.toMatchObject({
            v: 1,
            actionId: 'browser.recording.attachToComposer',
            status: 'attached',
            attachmentId: 'attachment_1',
        });
        expect(attach).toHaveBeenCalledWith({ recordingId: 'browser_recording_1', sessionId: 'session_1' });
    });

    it('fails closed for browser.recording.attachToComposer when no attach adapter exists', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.recording.attachToComposer',
            input: { recordingId: 'browser_recording_1' },
        }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_recording_unavailable',
        });
    });

    it.each(['ui', 'agent'] as const)('routes Machine-targeted diagnostics through the %s front door', async (surface) => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        // This port is the remote Machine Action transport; all local validation stays real.
        const refused = { ok: false, errorCode: 'browser_view_unavailable', error: 'browser_view_unavailable' };
        const executeOnMachine = vi.fn(async () => refused);
        const execute = createBrowserRuntimeActionExecutor({ executeOnMachine });
        const context = { surface, externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } satisfies RuntimeActionExecuteArgs['context'];
        const input = { browserSessionId: ' browser_session_1 ', viewId: ' view_1 ' };
        expect(await execute(runtimeArgs({ actionId: 'browser.diagnostics.snapshot', input, context }))).toEqual(refused);
        expect(executeOnMachine).toHaveBeenCalledWith({ actionId: 'browser.diagnostics.snapshot',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' }, context });
    });

    it('rejects invalid diagnostics input and missing exact Machine targets before transport', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const executeOnMachine = vi.fn();
        const execute = createBrowserRuntimeActionExecutor({ executeOnMachine });
        const input = { browserSessionId: 'browser_session_1', viewId: 'view_1' };
        expect(await execute(runtimeArgs({ actionId: 'browser.diagnostics.snapshot', input: { ...input, viewId: '' },
            context: { externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } })))
            .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        for (const context of [
            {},
            { defaultSessionMachineId: 'machine_1' },
            { externalActionTarget: { kind: 'session', sessionId: 'session_1' } },
            { externalActionTarget: { kind: 'machine', machineId: ' ' } },
        ] satisfies RuntimeActionExecuteArgs['context'][]) {
            expect(await execute(runtimeArgs({ actionId: 'browser.diagnostics.snapshot', input, context })))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
        }
        expect(executeOnMachine).not.toHaveBeenCalled();
        const withoutMachineTransport = createBrowserRuntimeActionExecutor();
        expect(await withoutMachineTransport(runtimeArgs({ actionId: 'browser.diagnostics.snapshot', input,
            context: { externalActionTarget: { kind: 'machine', machineId: 'machine_1' } } })))
            .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
    });

    // These daemon-owned actions remain unavailable without the explicit Machine transport.
    it('fails closed with a labeled reason for daemon-owned diagnostics actions', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.diagnostics.snapshot',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_diagnostics_unavailable',
        });
    });

    it('fails closed with a labeled reason for daemon-owned context capture actions', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.context.capturePage',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_context_unavailable',
        });
    });

    it('fails closed for browser.context.annotation.* when no annotation adapter is registered', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.context.annotation.attachDraft',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                navigationGeneration: 1,
            },
        }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_context_annotation_unavailable',
        });
    });
    it('attaches a supplied picker result through its scoped mounted owner and preserves ordinary Machine capture', async () => {
        const { createBrowserRuntimeActionExecutor } = await import('./runtimeActionExecutor');
        const { createBrowserContextAnnotationAdapter } = await import('../context/annotationAdapter');
        const { createBrowserContextState } = await import('../context/state');
        const { registerBrowserContextAnnotationAdapter, readRegisteredBrowserContextAnnotationAdapter } = await import('../context/runtimeAnnotationRegistry');
        const scope = { serverId: 'picker_home', accountId: 'picker_account' };
        const view = openViewState({ adapterKind: 'localPreview', engineKind: 'webIframe',
            target: localPreviewTarget, currentUrl: 'https://preview.example/page', capabilities: {
                ...localPreviewCapabilities, contextKinds: ['browserSelectedElement'],
                diagnosticsFidelityByFamily: { elements: 'injectedPage' },
            } }).viewsById.view_1!;
        let state = createBrowserContextState();
        let publications = 0;
        const adapter = createBrowserContextAnnotationAdapter({
            resolveBinding: () => ({ state, view, browserContextEnabled: true, browserDiagnosticsEnabled: true,
                contextCapabilities: { enabled: true, available: true, supportedContextKinds: ['browserSelectedElement'],
                    supportedAdapterKinds: ['localPreview'], screenshot: { supported: false, requiresAttachmentUploads: true },
                    text: { maxSelectionChars: 2048, maxSummaryChars: 8192 }, disabledReasons: [], policyDeniedReasons: [] } }),
            onStateChange: next => { state = next; publications += 1; },
        });
        const unregister = registerBrowserContextAnnotationAdapter({ scope,
            browserSessionId: view.browserSessionId, viewId: view.viewId, adapter });
        const machineResult = { ok: false, errorCode: 'permission_denied', error: 'permission_denied' } as const;
        const executeOnMachine = vi.fn(async () => machineResult);
        const execute = createBrowserRuntimeActionExecutor({ resolveAnnotation: readRegisteredBrowserContextAnnotationAdapter, executeOnMachine });
        const pickerResult = { v: 1 as const, pickerRequestId: 'picker_1', viewId: view.viewId,
            navigationGeneration: view.navigationGeneration, tier: 'injectedPage' as const, status: 'selected' as const,
            audited: true, selectorPath: '#submit', accessibleName: 'Submit', componentName: 'Checkout',
            sourceLocation: { file: 'src/Checkout.tsx', line: 24, column: 8 } };
        const input = { browserSessionId: view.browserSessionId, viewId: view.viewId, pickerResult };
        const context = { surface: 'agent' as const, serverId: scope.serverId, runtimeAccountId: scope.accountId,
            externalActionTarget: { kind: 'machine' as const, machineId: 'machine_1' } };
        try {
            expect(await execute({ actionId: 'browser.context.captureSelectedElement', input, context })).toMatchObject({
                kind: 'browserSelectedElement', selectorPath: '#submit', componentName: 'Checkout', sourceLocation: pickerResult.sourceLocation,
            });
            expect(state.attachmentOrder).toHaveLength(1);
            expect(publications).toBe(1);
            expect(executeOnMachine).not.toHaveBeenCalled();
            expect(await execute({ actionId: 'browser.context.captureSelectedElement', input,
                context: { ...context, runtimeAccountId: 'other_account' } })).toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
            expect(await execute({ actionId: 'browser.context.captureSelectedElement',
                input: { ...input, pickerResult: { ...pickerResult, navigationGeneration: view.navigationGeneration + 1 } }, context }))
                .toMatchObject({ ok: false, errorCode: 'runtime_action_disabled' });
            expect(publications).toBe(1);
            expect(executeOnMachine).not.toHaveBeenCalled();
            expect(await execute({ actionId: 'browser.context.captureSelectedElement',
                input: { browserSessionId: view.browserSessionId, viewId: view.viewId }, context })).toEqual(machineResult);
        } finally { unregister(); }
    });
});
