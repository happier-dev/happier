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
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { buildBrowserAdapterCapabilities } from '../adapters/capabilities';
import { createBrowserAutomationControlService, type BrowserAutomationRequest } from '../automation';
import type { BrowserControlCommandDispatchResult, BrowserControlState } from '../control';
import { applyBrowserControlEvent, createBrowserControlState } from '../control';

type BrowserRuntimeActionExecutorModule = Readonly<{
    createBrowserRuntimeActionExecutor?: (input: Readonly<{
        control?: Readonly<{
            readState: () => BrowserControlState | null | undefined;
            applyDispatchResult: (result: BrowserControlCommandDispatchResult) => void | Promise<void>;
            sendDaemonCommand?: (command: BrowserCommandV1) => void;
        }>;
        resolveControl?: (input: BrowserCommandV1) => Readonly<{
            readState: () => BrowserControlState | null | undefined;
            applyDispatchResult: (result: BrowserControlCommandDispatchResult) => void | Promise<void>;
            sendDaemonCommand?: (command: BrowserCommandV1) => void;
        }> | null | undefined;
        automation?: Readonly<{
            controlService: ReturnType<typeof createBrowserAutomationControlService>;
        }>;
        resolveAutomation?: (input: Readonly<{ browserSessionId: string }>) => Readonly<{
            controlService: ReturnType<typeof createBrowserAutomationControlService>;
        }> | null | undefined;
    }>) => (args: RuntimeActionExecuteArgs) => Promise<unknown>;
}>;

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
            resultSummary: expect.objectContaining({
                status: 'succeeded',
            }),
        });
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
            error: 'runtime_action_disabled:browser:browser_automation_unavailable',
        });
        expect(controlService.getActionTimeline({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        })).toEqual([]);
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
            const lease = controlService.acquireLease({
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                requestedBy: 'agent',
                requesterRef: { kind: 'session', id: 'session_1' },
                ttlMs: 1_000,
            });
            if (!lease.ok) throw new Error(`expected lease for ${actionKind}`);

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
                    leaseId: lease.leaseId,
                    expectedControlEpoch: lease.controlEpoch,
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

        const canceled = await execute(runtimeArgs({
            actionId: 'browser.automation.cancelActive',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        }));
        const noActive = await execute(runtimeArgs({
            actionId: 'browser.automation.cancelActive',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        }));

        expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(canceled).success).toBe(true);
        expect(canceled).toEqual({ v: 1, outcome: 'canceled', canceledCount: 1 });
        expect(BrowserAutomationCancelActiveResultV1Schema.safeParse(noActive).success).toBe(true);
        expect(noActive).toEqual({ v: 1, outcome: 'no_active', canceledCount: 0 });
        await expect(activeAction).resolves.toMatchObject({
            status: 'canceled',
            errorCode: 'user_canceled',
        });
        releaseAction();
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
        const lease = controlService.acquireLease({
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            requestedBy: 'agent',
            requesterRef: { kind: 'session', id: 'session_1' },
            ttlMs: 1_000,
        });
        if (!lease.ok) throw new Error('expected automation lease');
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
                leaseId: lease.leaseId,
                expectedControlEpoch: lease.controlEpoch,
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
        const sendDaemonCommand = vi.fn();
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
        expect(applyDispatchResult).toHaveBeenCalledTimes(commands.length);
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

    // SUPPORT MATRIX (FINALIZATION-PLAN §3.2 / §10): the UI runtime executor has NO local producer
    // for browser diagnostics, context capture, or the non-attach recording actions — those are
    // serviced by the DAEMON executor. The UI executor must fail closed with a labeled reason
    // (never fake a dispatch). These lock the honest deferral so it cannot silently regress.
    it('fails closed with a labeled reason for daemon-owned diagnostics actions', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.diagnostics.eval',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1', expression: '1+1' },
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

    it('routes browser.context.annotation.* through the in-app annotation adapter front door', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const dispatch = vi.fn(async (request: { kind: string }) => {
            if (request.kind === 'start') {
                return { status: 'started' as const, state: { marker: 'started' } as never };
            }
            if (request.kind === 'captureRegion') {
                return {
                    status: 'captured' as const,
                    state: { marker: 'captured' } as never,
                    attachmentId: 'annotation_attachment_1',
                    contextId: 'browser_context_view_1_browserAnnotation_0_1',
                };
            }
            return { status: 'unavailable' as const, reason: 'browser_context_annotation_inactive' };
        });
        const execute = realMod.createBrowserRuntimeActionExecutor({ annotation: { dispatch } });

        await expect(execute(runtimeArgs({
            actionId: 'browser.context.annotation.start',
            input: { browserSessionId: 'browser_session_1', viewId: 'view_1' },
        }))).resolves.toMatchObject({
            v: 1,
            actionId: 'browser.context.annotation.start',
            status: 'started',
        });

        await expect(execute(runtimeArgs({
            actionId: 'browser.context.annotation.captureRegion',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                target: { kind: 'region', rect: { x: 1, y: 2, width: 30, height: 40 } },
                styleIntent: 'callout',
            },
        }))).resolves.toMatchObject({
            v: 1,
            actionId: 'browser.context.annotation.captureRegion',
            status: 'captured',
            attachmentId: 'annotation_attachment_1',
        });

        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ kind: 'start' }));
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
            kind: 'captureRegion',
            target: { kind: 'region', rect: { x: 1, y: 2, width: 30, height: 40 } },
            styleIntent: 'callout',
        }));
    });

    it('fails closed for browser.context.annotation.* when no annotation adapter is registered', async () => {
        const realMod = await import('./runtimeActionExecutor');
        const execute = realMod.createBrowserRuntimeActionExecutor({});

        await expect(execute(runtimeArgs({
            actionId: 'browser.context.annotation.captureElement',
            input: {
                browserSessionId: 'browser_session_1',
                viewId: 'view_1',
                target: { kind: 'element', selectorPath: 'main > button' },
            },
        }))).resolves.toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
            error: 'runtime_action_disabled:browser:browser_context_annotation_unavailable',
        });
    });
});
