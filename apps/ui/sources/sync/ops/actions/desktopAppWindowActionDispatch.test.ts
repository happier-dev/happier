import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred } from '@/dev/testkit';
import type { AppWindowRecord } from '@/desktop/window/appWindowBoot';
import type { DesktopAppWindowSurface } from '@/desktop/window/appWindowSurface';
import { currentUiContextCommandClientRpcMethod, UiActionDispatchRequestV1Schema } from '@happier-dev/protocol/actions/clientDispatchV1';
import { workflowDraftClientRpcMethod, WorkflowDraftGetResultV1Schema, WorkflowMountedDraftV1Schema } from '@happier-dev/protocol/actions/workflowAuthoringAction';
import { emitDesktopWindowActionResult } from '@/utils/platform/desktopWindowActionBridge';
import { invokeWorkflowAuthoringAction, registerMountedWorkflowDraftOwner } from './workflowAuthoringAction';
import { createWorkflowEditorDraft } from '@/sync/domains/workflows/workflowEditorDraft';
import { buildWorkflowDefinitionCandidate, validateWorkflowEditorDraft } from '@/sync/domains/workflows/workflowAuthoring';
import { executeCurrentUiContextAction, registerCurrentUiContextActionPort } from '@/components/appShell/currentUiContext/currentUiContextActionRuntime';
import { createCurrentUiContextVoiceToolPort } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import type { CurrentUiContextResolvedCommand } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';

const native = vi.hoisted(() => ({
    label: 'main',
    listeners: new Map<string, Set<(payload: unknown) => void>>(),
    requests: [] as Array<Record<string, unknown>>,
    results: [] as Array<Record<string, unknown>>,
    opened: false,
    restored: [] as AppWindowRecord[],
    surfaces: [] as DesktopAppWindowSurface[],
    deliverAction: undefined as ((payload: Record<string, unknown>) => Promise<void>) | undefined,
}));
// The native event bus is the process boundary; the dispatcher and settlement stay real.
vi.mock('@/utils/platform/desktopHost', () => ({
    desktopHostKind: () => 'tauri',
    isDesktopHost: () => true,
    getDesktopHostWindowLabel: () => native.label,
    getDesktopHostAvailability: async () => ({ windows: { kind: 'available' } }),
    invokeDesktopHost: async (command: string, args: { payload: Record<string, unknown> }) => {
        if (command === 'desktop_app_window_restore') return native.restored;
        if (command === 'desktop_app_window_surfaces') return native.surfaces;
        if (command === 'desktop_app_window_placement') return { workArea: null, frame: null, previousFrame: null };
        if (command === 'desktop_app_window_open') {
            native.opened = true;
            return { windowId: 'moving', windowLabel: 'destination_moving', ready: false, reused: false };
        }
        if (command === 'desktop_window_emit_action') {
            native.requests.push(args.payload);
            await native.deliverAction?.(args.payload);
        }
        if (command === 'desktop_window_emit_action_result') {
            native.results.push(args.payload);
            native.listeners.get('desktopWindow://action-result')?.forEach(listener => listener(args.payload));
        }
    },
    listenDesktopHostEvent: async (event: string, listener: (payload: unknown) => void) => {
        const listeners = native.listeners.get(event) ?? new Set();
        native.listeners.set(event, listeners);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },
}));

import {
    registerDesktopAppWindowActionResponder,
    registerDesktopAppWindowReturnHandler,
    requestDesktopAppWindowReturn,
    prepareDesktopAppWindowReturn,
    requestDesktopAppWindowResume,
    executeDesktopAppWindowClientAction,
    watchDesktopSessionDraft,
} from './desktopAppWindowActionDispatch';
// Load the real workspace graph during collection rather than spending a test's
// behavior deadline on its first module transform.
import { createWorkspaceState, createWorkspaceEmptyTab } from '@/components/appShell/workspace/workspaceState';
import { openDesktopAppWindow, registerDesktopAppWindowWorkspace } from '@/desktop/window/appWindowRuntime';

afterEach(() => { native.label = 'main'; native.listeners.clear(); native.requests.length = 0; native.results.length = 0;
    native.opened = false; native.restored = []; native.surfaces = []; native.deliverAction = undefined; });

describe('desktop destination admitted dispatch', () => {
    it('invokes a generic file destination command only in its exact Home and Account', async () => {
        const scope = { serverId: 'file-home', accountId: 'alice' };
        const input = { commandId: 'current-ui:moved-file-preview' };
        const context = { serverId: scope.serverId, runtimeAccountId: scope.accountId,
            surface: 'ui' as const, authority: 'present_user' as const };
        native.restored = [{ windowId: 'file-editor', layoutId: 'file-editor', homeId: scope.serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'destination', target: { kind: 'file', params: {} } } }];
        native.surfaces = [{ windowId: 'file-editor', homeId: scope.serverId, accountId: scope.accountId,
            sessionId: null, focused: false, methods: [currentUiContextCommandClientRpcMethod(input.commandId)] }];
        const stopSurfaces = await (await import('@/desktop/window/appWindowSurface')).observeDesktopAppWindowSurfaces();
        const state = createWorkspaceState(createWorkspaceEmptyTab('main-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        const invocationRealms: string[] = [];
        let view = 'source';
        const command: CurrentUiContextResolvedCommand = { id: input.commandId, retirementSignal: new AbortController().signal,
            command: { kind: 'hostLocal', invoke: () => {
                invocationRealms.push(native.label); view = 'preview';
                return { ok: true, result: { view } };
            } } };
        native.deliverAction = async payload => {
            expect(payload.targetWindowLabel).toBe('destination_file-editor');
            const sourceLabel = native.label;
            native.label = 'destination_file-editor';
            const retire = registerCurrentUiContextActionPort(surface => createCurrentUiContextVoiceToolPort({
                invocationSurface: surface,
                reader: { readCurrentUiContext: () => ({ navigation: { area: 'app', screen: 'file' },
                    commands: [{ id: command.id, title: 'Preview file' }] }),
                    resolveCurrentUiCommand: id => id === command.id ? command : null, subscribe: () => () => {} },
                readProjection: () => EMPTY_PLUGIN_UI_PROJECTION, readNavigationBinding: () => null,
            }));
            try {
                const data = payload.data;
                if (!data || typeof data !== 'object' || !('request' in data) || !('serverId' in data)
                    || typeof data.serverId !== 'string' || !('accountId' in data) || typeof data.accountId !== 'string') {
                    throw new Error('Expected admitted client request and Account address');
                }
                const wire = UiActionDispatchRequestV1Schema.parse(data.request);
                expect(wire.actionId).toBe('ui.current_context.command.invoke');
                const result = await executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input: wire.input,
                    context: { ...wire.context, serverId: data.serverId, runtimeAccountId: data.accountId } });
                if (typeof payload.requestId !== 'string') throw new Error('Expected native result address');
                await emitDesktopWindowActionResult({ windowLabel: 'main', requestId: payload.requestId, phase: 'settled', ...result });
            } finally { retire(); native.label = sourceLabel; }
        };
        let mainFallbacks = 0;
        const execute = async () => {
            mainFallbacks++;
            return executeCurrentUiContextAction({ actionId: 'ui.current_context.command.invoke', input, context });
        };
        try {
            for (const otherScope of [{ serverId: 'another-home', runtimeAccountId: scope.accountId },
                { serverId: scope.serverId, runtimeAccountId: 'another-account' }]) {
                await expect(executeDesktopAppWindowClientAction({ actionId: 'ui.current_context.command.invoke', input,
                    context: { ...context, ...otherScope }, execute })).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
            }
            expect(native.requests).toEqual([]);
            expect(view).toBe('source');
            await expect(executeDesktopAppWindowClientAction({ actionId: 'ui.current_context.command.invoke', input, context, execute }))
                .resolves.toEqual({ ok: true, result: { view: 'preview' } });
            expect(view).toBe('preview');
            expect(invocationRealms).toEqual(['destination_file-editor']);
            expect(native.requests).toHaveLength(1);
            expect(mainFallbacks).toBe(2);
        } finally {
            native.deliverAction = undefined;
            stopSurfaces();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it.each(['exact draft', 'scope listing'] as const)('reads a moved workflow editor at its presenting owner (%s) and withdraws its address', async addressKind => {
        const scope = { serverId: 'workflow-home', accountId: 'alice' };
        const draft = createWorkflowEditorDraft({ draftId: 'moved-workflow-draft', name: 'Window review' });
        const input = addressKind === 'exact draft' ? { scope, draftId: draft.draftId } : { scope };
        const context = { serverId: scope.serverId, runtimeAccountId: scope.accountId,
            surface: 'agent' as const, authority: 'account_automation' as const };
        const snapshot = WorkflowMountedDraftV1Schema.parse({ scope, draftId: draft.draftId, name: draft.name,
            definition: buildWorkflowDefinitionCandidate(draft), blockLabels: [],
            settings: { description: '', projectTarget: null, executionTarget: 'session',
                triggers: { rows: [], project: null, inputs: {} } },
            validationIssues: validateWorkflowEditorDraft(draft).issues, dirty: true, draftRevision: 7 });
        native.restored = [{ windowId: 'workflow-editor', layoutId: 'workflow-editor', homeId: scope.serverId,
            accountId: scope.accountId, selectedAddress: { kind: 'destination', target: { kind: 'workflowEditor', params: {} } } }];
        const surface = { windowId: 'workflow-editor', homeId: scope.serverId, accountId: scope.accountId,
            sessionId: null, focused: false, methods: [workflowDraftClientRpcMethod({ scope, draftId: draft.draftId }),
                workflowDraftClientRpcMethod({ scope })] };
        native.surfaces = [surface];
        const stopSurfaces = await (await import('@/desktop/window/appWindowSurface')).observeDesktopAppWindowSurfaces();
        const state = createWorkspaceState(createWorkspaceEmptyTab('main-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        const snapshotRealms: string[] = [];
        // An OS delivery enters a separate renderer. Its local mounted registry exists only there,
        // so the main fallback cannot accidentally answer from an in-process shadow owner.
        native.deliverAction = async payload => {
            expect(payload.targetWindowLabel).toBe('destination_workflow-editor');
            const sourceLabel = native.label;
            native.label = 'destination_workflow-editor';
            const retire = registerMountedWorkflowDraftOwner({ kind: 'workflow',
                getContext: () => ({ scope, draft, editable: true, whereMachineId: null, candidates: [] }),
                onChange: () => { throw new Error('A workflow read must not edit its draft'); },
                actions: { getSnapshot: () => { snapshotRealms.push(native.label); return snapshot; },
                    execute: async () => { throw new Error('A workflow read must not invoke a mutation'); } } });
            try {
                const data = payload.data;
                if (!data || typeof data !== 'object' || !('request' in data) || !('serverId' in data)
                    || typeof data.serverId !== 'string' || !('accountId' in data) || typeof data.accountId !== 'string') {
                    throw new Error('Expected admitted client request and Account address');
                }
                const wire = UiActionDispatchRequestV1Schema.parse(data.request);
                expect(wire.actionId).toBe('workflow.authoring.draft.get');
                const result = WorkflowDraftGetResultV1Schema.parse(await invokeWorkflowAuthoringAction({
                    actionId: 'workflow.authoring.draft.get', input: wire.input, context: { ...wire.context,
                        serverId: data.serverId, runtimeAccountId: data.accountId } }));
                if (typeof payload.requestId !== 'string') throw new Error('Expected native result address');
                await emitDesktopWindowActionResult({ windowLabel: 'main', requestId: payload.requestId,
                    phase: 'settled', ok: true, result });
            } finally { retire(); native.label = sourceLabel; }
        };
        let mainFallbacks = 0;
        const execute = async () => {
            mainFallbacks++;
            return { ok: true as const, result: await invokeWorkflowAuthoringAction({
                actionId: 'workflow.authoring.draft.get', input, context }) };
        };
        try {
            const result = await executeDesktopAppWindowClientAction({ actionId: 'workflow.authoring.draft.get', input, context, execute });
            expect(result).toEqual({ ok: true, result: { status: 'available', drafts: [snapshot] } });
            expect(snapshotRealms).toEqual(['destination_workflow-editor']);
            expect(native.requests).toHaveLength(1);
            expect(mainFallbacks).toBe(0);
            native.listeners.get('desktopAppWindow://surface')?.forEach(listener => listener({ ...surface, methods: [] }));
            await expect(executeDesktopAppWindowClientAction({ actionId: 'workflow.authoring.draft.get', input, context, execute }))
                .resolves.toEqual({ ok: true, result: { status: 'unavailable' } });
            expect(native.requests).toHaveLength(1);
            expect(mainFallbacks).toBe(1);
            expect(snapshotRealms).toEqual(['destination_workflow-editor']);
        } finally {
            native.deliverAction = undefined;
            stopSurfaces();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it('follows focused full-window draft demand without rewriting records and disposes the remote watch', async () => {
        native.label = 'destination_responder';
        const scope = { serverId: 'home-b', accountId: 'alice' };
        native.restored = ['first', 'second'].map(windowId => ({ windowId, layoutId: windowId, chrome: 'full',
            homeId: scope.serverId, accountId: scope.accountId, selectedAddress: { kind: 'home' } } satisfies AppWindowRecord));
        const surface = { windowId: 'first', homeId: scope.serverId, accountId: scope.accountId, sessionId: 'lead', focused: true };
        native.surfaces = [surface];
        const stopFocus = await (await import('@/desktop/window/appWindowSurface')).observeDesktopAppWindowSurfaces();
        const state = createWorkspaceState(createWorkspaceEmptyTab('responder-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'responder', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        const lifetime = new AbortController();
        try {
            const stop = await watchDesktopSessionDraft({ ...scope, sessionId: 'lead' }, () => {}, lifetime.signal);
            await vi.waitFor(() => expect(native.requests.filter(request => request.actionIdentifier === 'desktop.sessionDraft.watch')).toHaveLength(1));
            native.listeners.get('desktopAppWindow://surface')?.forEach(listener => listener({ ...surface, windowId: 'second' }));
            await vi.waitFor(() => expect(native.requests.filter(request => request.actionIdentifier === 'desktop.sessionDraft.watch')).toHaveLength(2));
            const watches = native.requests.filter(request => request.actionIdentifier === 'desktop.sessionDraft.watch');
            expect(watches.map(request => request.targetWindowLabel)).toEqual(['destination_first', 'destination_second']);
            expect(watches.every(request => request.windowLabel === 'destination_responder')).toBe(true);
            stop();
            expect(native.requests.filter(request => request.actionIdentifier === 'desktop.sessionDraft.unwatch')).toHaveLength(2);
        } finally {
            lifetime.abort(); stopFocus(); release();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
        }
    });

    it('forwards an admitted Home-responder Action once from a full secondary to its presenting realm', async () => {
        native.label = 'destination_responder';
        const scope = { serverId: 'home-b', accountId: 'alice' };
        native.restored = [{ windowId: 'addressed', layoutId: 'addressed', homeId: scope.serverId, accountId: scope.accountId,
            selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState(createWorkspaceEmptyTab('responder-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'responder', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        let localExecutions = 0;
        const lifetime = new AbortController();
        try {
            const pending = executeDesktopAppWindowClientAction({ actionId: 'ui.find', input: { op: 'read' },
                context: { serverId: scope.serverId, runtimeAccountId: scope.accountId, surface: 'ui', authority: 'account_automation',
                    defaultSessionId: 'lead', signal: lifetime.signal },
                execute: async () => { localExecutions++; return { ok: true, result: { status: 'idle' } }; } });
            await vi.waitFor(() => expect(native.requests).toHaveLength(1));
            const request = native.requests[0]!;
            expect(request).toMatchObject({ windowLabel: 'destination_responder', targetWindowLabel: 'destination_addressed',
                actionIdentifier: 'desktop.clientAction.execute.admitted' });
            native.listeners.get('desktopWindow://action-result')?.forEach(listener => listener({
                windowLabel: 'destination_responder', requestId: request.requestId, phase: 'settled', ok: true, result: { status: 'idle' },
            }));
            await expect(pending).resolves.toEqual({ ok: true, result: { status: 'idle' } });
            expect(localExecutions).toBe(0);
        } finally {
            lifetime.abort();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it.each(['return', 'close'] as const)('distinguishes %s intent at the mounted departure guard', async intent => {
        native.label = 'destination_notes';
        let received: 'return' | 'close' | undefined;
        const removeHandler = registerDesktopAppWindowReturnHandler(async (departureIntent?: 'return' | 'close') => {
            received = departureIntent;
            return true;
        });
        const dispose = await registerDesktopAppWindowActionResponder();
        native.label = 'main';
        try {
            const pending = intent === 'close'
                ? requestDesktopAppWindowReturn('destination_notes', 'close')
                : requestDesktopAppWindowReturn('destination_notes');
            await vi.waitFor(() => expect(native.requests).toHaveLength(1));
            const request = native.requests[0]!;
            native.listeners.get('desktopWindow://action')?.forEach(listener => listener(request));
            await expect(pending).resolves.toBe(true);
            expect(received).toBe(intent);
            if (intent === 'close') expect(request.data).toMatchObject({ intent: 'close' });
        } finally { removeHandler(); dispose(); }
    });

    it.each([
        { address: 'invoking Session default', actionId: 'ui.find', input: { op: 'read' }, defaultSessionId: 'lead', result: { status: 'idle' } },
        { address: 'explicit Session composer', actionId: 'ui.prompts.picker.open', input: { composerRef: { kind: 'session', sessionId: 'lead' } },
            defaultSessionId: 'another-session', result: { status: 'noEligibleComposer' } },
        { address: 'pending Message composer', actionId: 'ui.prompts.picker.open', input: { composerRef: { kind: 'pendingMessage', sessionId: 'lead', localId: 'pending-local' } },
            defaultSessionId: 'another-session', result: { status: 'noEligibleComposer' } },
        { address: 'explicit New Session composer', actionId: 'ui.prompts.picker.open', input: { composerRef: { kind: 'newSession', instanceId: 'local-composer' } },
            defaultSessionId: 'lead', result: { status: 'noEligibleComposer' }, local: true },
    ] as const)('keeps $address at its actual presenting owner', async fixture => {
        const scope = { serverId: 'home', accountId: 'alice' };
        native.restored = [{ windowId: 'addressed', layoutId: 'addressed', homeId: scope.serverId, accountId: scope.accountId,
            selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState(createWorkspaceEmptyTab('main-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope, getState: () => state,
            dispatch: () => {}, catalog: [], activateTab: () => {}, placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        const lifetime = new AbortController();
        try {
            let localExecutions = 0;
            const pending = executeDesktopAppWindowClientAction({ actionId: fixture.actionId, input: fixture.input,
                context: { serverId: scope.serverId, runtimeAccountId: scope.accountId, surface: 'ui', authority: 'present_user',
                    defaultSessionId: fixture.defaultSessionId, signal: lifetime.signal },
                execute: async () => { localExecutions++; return { ok: true, result: fixture.result }; } });
            if ('local' in fixture) {
                await vi.waitFor(() => expect(localExecutions).toBe(1));
                expect(native.requests).toEqual([]);
                await expect(pending).resolves.toEqual({ ok: true, result: fixture.result });
                return;
            }
            await vi.waitFor(() => expect(native.requests).toHaveLength(1));
            const request = native.requests[0]!;
            expect(request.targetWindowLabel).toBe('destination_addressed');
            native.listeners.get('desktopWindow://action-result')?.forEach(listener => listener({
                windowLabel: 'main', requestId: request.requestId, phase: 'settled', ok: true, result: fixture.result,
            }));
            await expect(pending).resolves.toEqual({ ok: true, result: fixture.result });
            expect(localExecutions).toBe(0);
        } finally {
            lifetime.abort();
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it('keeps Session lifecycle in main while its composer is presented in another window', async () => {
        const scope = { serverId: 'home', accountId: 'alice' };
        native.restored = [{ windowId: 'composer', layoutId: 'composer', homeId: scope.serverId, accountId: scope.accountId,
            selectedAddress: { kind: 'session', sessionId: 'lead' } }];
        const state = createWorkspaceState({ id: 'session-tab', target: { kind: 'session', params: { id: 'lead', ...scope } },
            pinned: false, preview: false, presentation: { windowId: 'composer' } });
        const release = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope,
            getState: () => state, dispatch: () => {}, catalog: [], activateTab: () => {},
            placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        try {
            let lifecycleRealm: string | undefined;
            const pending = executeDesktopAppWindowClientAction({ actionId: 'session.open', input: { sessionId: 'lead' },
                context: { serverId: scope.serverId, runtimeAccountId: scope.accountId, surface: 'ui', authority: 'present_user' },
                execute: async () => { lifecycleRealm = native.label; return { ok: true, result: { sessionId: 'lead' } }; } });
            await vi.dynamicImportSettled();
            expect(lifecycleRealm).toBe('main');
            expect(native.requests).toEqual([]);
            await expect(pending).resolves.toMatchObject({ ok: true });
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it('waits for canonical presentation readiness before choosing the draft writer', async () => {
        const scope = { serverId: 'home', accountId: 'alice' };
        const state = createWorkspaceState(createWorkspaceEmptyTab('main-empty'));
        const release = registerDesktopAppWindowWorkspace({ windowId: 'main-layout', scope,
            getState: () => state, dispatch: () => {}, catalog: [], activateTab: () => {},
            placementMetrics: { cascadeOffset: 24, screenInset: 24 } });
        try {
            const opened = openDesktopAppWindow({ windowId: 'moving', target: { kind: 'session', ...scope, sessionId: 'lead' } });
            await vi.waitFor(() => expect(native.opened).toBe(true));
            let localWrites = 0;
            const pending = executeDesktopAppWindowClientAction({ actionId: 'session.draft.append',
                input: { sessionId: 'lead', text: 'During transfer' }, context: { serverId: scope.serverId,
                    runtimeAccountId: scope.accountId, surface: 'ui', authority: 'present_user' },
                execute: async () => { localWrites++; return { ok: true, result: {
                    status: 'appended', sessionId: 'lead', createdAtMs: 1,
                } }; } });
            await vi.dynamicImportSettled();
            expect(localWrites).toBe(0);
            expect(native.requests).toEqual([]);
            native.listeners.get('desktopAppWindow://lifecycle')?.forEach(listener => listener({ kind: 'ready', windowId: 'moving' }));
            await opened;
            await vi.waitFor(() => expect(native.requests).toHaveLength(1));
            const request = native.requests[0]!;
            expect(request.targetWindowLabel).toBe('destination_moving');
            native.listeners.get('desktopWindow://action-result')?.forEach(listener => listener({
                windowLabel: 'main', requestId: request.requestId, phase: 'settled', ok: true,
                result: { status: 'appended', sessionId: 'lead', createdAtMs: 2 },
            }));
            await expect(pending).resolves.toMatchObject({ ok: true, result: { status: 'appended' } });
            expect(localWrites).toBe(0);
        } finally {
            native.listeners.get('desktopAppWindow://records')?.forEach(listener => listener([]));
            release();
        }
    });

    it('settles return only after the destination releases its writable presentation', async () => {
        native.label = 'destination_notes';
        const released = createDeferred<boolean>();
        const removeHandler = registerDesktopAppWindowReturnHandler(() => released.promise);
        const dispose = await registerDesktopAppWindowActionResponder();
        native.label = 'main';
        const pending = requestDesktopAppWindowReturn('destination_notes');
        await vi.waitFor(() => expect(native.requests).toHaveLength(1));
        const request = native.requests[0]!;
        expect(request).toMatchObject({ windowLabel: 'main', targetWindowLabel: 'destination_notes', actionIdentifier: 'desktop.window.return' });
        native.listeners.get('desktopWindow://action')?.forEach(listener => listener(request));
        await Promise.resolve();
        expect(native.results).toEqual([]);
        released.resolve(true);
        await expect(pending).resolves.toBe(true);
        expect(native.results).toHaveLength(1);
        removeHandler(); dispose();
    });

    it('keeps the presentation open when its existing navigation guard cancels return', async () => {
        native.label = 'destination_notes';
        const removeHandler = registerDesktopAppWindowReturnHandler(async () => false);
        const dispose = await registerDesktopAppWindowActionResponder();
        native.label = 'main';
        const pending = requestDesktopAppWindowReturn('destination_notes');
        await vi.waitFor(() => expect(native.requests).toHaveLength(1));
        native.listeners.get('desktopWindow://action')?.forEach(listener => listener(native.requests[0]));
        await expect(pending).resolves.toBe(false);
        expect(native.results).toEqual([expect.objectContaining({ ok: false, errorCode: 'cancelled' })]);
        removeHandler(); dispose();
    });

    it('releases locally for retarget and resumes the same owner after a failed native effect', async () => {
        native.label = 'destination_notes';
        let writable = true;
        const removeHandler = registerDesktopAppWindowReturnHandler(async () => { writable = false; return true; },
            async () => { writable = true; });
        const dispose = await registerDesktopAppWindowActionResponder();
        expect(await prepareDesktopAppWindowReturn()).toBe(true);
        expect(writable).toBe(false);
        expect(native.requests).toEqual([]);
        native.label = 'main';
        const pending = requestDesktopAppWindowResume('destination_notes');
        await vi.waitFor(() => expect(native.requests).toHaveLength(1));
        native.listeners.get('desktopWindow://action')?.forEach(listener => listener(native.requests[0]));
        await expect(pending).resolves.toBe(true);
        expect(writable).toBe(true);
        removeHandler(); dispose();
    });

    it('restores the current destination locally after its native retarget fails', async () => {
        native.label = 'destination_notes';
        let writable = true;
        const removeHandler = registerDesktopAppWindowReturnHandler(async () => { writable = false; return true; },
            async () => { writable = true; });
        try {
            expect(await prepareDesktopAppWindowReturn()).toBe(true);
            expect(writable).toBe(false);
            const resumed = requestDesktopAppWindowResume('destination_notes');
            await vi.dynamicImportSettled();
            expect(writable).toBe(true);
            await expect(resumed).resolves.toBe(true);
            expect(native.requests).toEqual([]);
        } finally { removeHandler(); }
    });
});
