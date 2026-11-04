import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createNativeScreenCaptureAction } from './screenCaptureActions';
import type { NativeCapturePermissions, NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';

const clipboard = vi.hoisted(() => ({ image: vi.fn(async (_base64: string) => {}), text: vi.fn(async (_text: string) => true) }));
vi.mock('expo-clipboard', () => ({ setImageAsync: clipboard.image, setStringAsync: clipboard.text }));
vi.mock('@tauri-apps/api/event', () => ({ listen: async () => () => {} }));

function createNativeExecutor(deps: Partial<ActionExecutorDeps>) {
    return createActionExecutor(createActionExecutorBoundaryFixture(deps));
}

describe('native capture Actions through real admission and desktop IPC', () => {
    const captured: NativeCaptureResult = { captureRef: 'kept', kind: 'still', path: '/Pictures/Happier/kept.png',
        mimeType: 'image/png', byteSize: 3, pixelSize: { width: 1, height: 1 }, scale: 1,
        origin: null, source: null, windowTextRef: null };
    const commands: string[] = [];
    let inUse = false;
    let preparedMissing = false;
    let windowTextOutcome: unknown;
    let cancelStart = false;
    let freshCapture = false;
    beforeEach(() => {
        commands.length = 0;
        inUse = false; preparedMissing = false; cancelStart = false; freshCapture = false; clipboard.image.mockClear(); clipboard.text.mockClear();
        windowTextOutcome = { status: 'unavailable', reason: 'provider_unavailable', source: null };
        // Desktop IPC is the only replaced acquisition, grant and filesystem boundary.
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_start') return cancelStart ? { status: 'cancelled' } : { status: 'completed', operationRef: 1, result: captured };
            if (command === 'desktop_capture_read_result') return captured;
            if (command === 'desktop_capture_read_delivery_state') return { inUse,
                disclosure: freshCapture ? null : { hasMarks: true, includeWindowText: false }, windowText: null };
            if (command === 'desktop_capture_read_source_png') throw 'file_io';
            if (command === 'desktop_capture_settle') return { status: 'idle' };
            if (command === 'desktop_capture_read_prepared_png') {
                if (preparedMissing) throw 'prepared_missing';
                return [4, 5, 6];
            }
            if (command === 'desktop_capture_show_in_folder') return;
            if (command === 'desktop_capture_targets') return { displays: [], windows: [] };
            if (command === 'desktop_capture_permissions') return { screen: 'per_request', windowText: 'not_required',
                recoveryActions: { screen: [], windowText: [] } };
            if (command === 'desktop_capture_request_permission') return { snapshot: { screen: 'unknown', windowText: 'unavailable',
                recoveryActions: { screen: [], windowText: [] } }, recovery: 'none' };
            if (command === 'desktop_capture_window_text') return windowTextOutcome;
            if (command === 'desktop_capture_recent_list') return { entries: [{ path: '/Pictures/shot.png', name: 'shot.png', kind: 'still',
                byteSize: 10, modifiedAt: 12, modifiedAtNanos: '12000000' }], folders: [{ path: '/Pictures', issue: null }] };
            throw new Error('Unexpected native command');
        } });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('preserves both restart recovery actions from native read and request results', async () => {
        const snapshot: NativeCapturePermissions = { screen: 'restart_required', windowText: 'restart_required',
            recoveryActions: { screen: ['reopen', 'open_settings'], windowText: ['reopen', 'open_settings'] } };
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (command === 'desktop_capture_permissions') return snapshot;
            if (command === 'desktop_capture_request_permission') return { snapshot, recovery: 'open_settings' };
            throw new Error('Unexpected permission recovery command');
        } });
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        expect(await executor.execute('screenCapture.permissions.read', {}, { surface: 'ui' }))
            .toEqual({ ok: true, result: snapshot });
        expect(await executor.execute('screenCapture.permissions.request', { subject: 'window_text' }, { surface: 'ui' }))
            .toEqual({ ok: true, result: { snapshot, recovery: 'open_settings' } });
        expect(commands).toEqual(['desktop_capture_permissions', 'desktop_capture_request_permission']);
    });

    it('start refuses a non-desktop client before resolving a Session', async () => {
        vi.stubGlobal('__TAURI_INTERNALS__', undefined);
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: {
            'screenCapture.start': ['agent'],
        } });
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) });
        for (const input of [{ mode: 'screenshot' }, { mode: 'recording' }, { mode: 'screenshot', target: { kind: 'frontmost' } }]) {
            expect(await executor.execute('screenCapture.start', input, {
                surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home',
                runtimeAccountId: 'account', defaultSessionMachineId: 'client',
            })).toMatchObject({ ok: false, errorCode: 'desktop_only' });
        }
        expect(commands).toEqual([]);
    });

    it('settles the native recording prerequisite at the Action result with no repolls until an explicit retry', async () => {
        vi.useFakeTimers();
        let available = false;
        vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string) => {
            commands.push(command);
            if (!available) throw 'video_encoder_unavailable';
            return { phase: 'recording', timing: { durationMs: 1000, activeSinceMs: 10_000 },
                sourceRef: 'movie', result: null, error: null };
        } });
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' } } as const;
        try {
            expect(await executor.execute('screenCapture.recording.resume', { operationRef: 7 }, context))
                .toMatchObject({ ok: false, errorCode: 'video_encoder_unavailable' });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(commands).toEqual(['desktop_recording_resume']);
            available = true;
            expect(await executor.execute('screenCapture.recording.resume', { operationRef: 7 }, context))
                .toMatchObject({ ok: true, result: { phase: 'recording' } });
            expect(commands).toEqual(['desktop_recording_resume', 'desktop_recording_resume']);
        } finally { vi.useRealTimers(); }
    });

    it('releases a direct capture after failed preparation so the next capture is not held invisibly', async () => {
        freshCapture = true;
        const settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': ['agent'] } });
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction(),
            isActionApprovalRequired: (id, context) => isApprovalRequiredByActionsSettings(id, settings, context) });
        expect(await executor.execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' }, targetSession: {
            serverId: 'home', accountId: 'account', sessionId: 'requester',
        } }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home',
            runtimeAccountId: 'account', defaultSessionMachineId: 'client' }))
            .toMatchObject({ ok: false, errorCode: 'file_io' });
        expect(commands).toEqual(['desktop_capture_start', 'desktop_capture_read_delivery_state',
            'desktop_capture_read_source_png', 'desktop_capture_settle']);
    });

    it('copies only prepared disclosed pixels and reveals the kept file without reading pixels', async () => {
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        expect(await executor.execute('screenCapture.copy', { captureRef: 'kept' }, { surface: 'ui' }))
            .toEqual({ ok: true, result: { captureRef: 'kept', status: 'copied' } });
        expect(clipboard.image.mock.calls).toEqual([['BAUG']]);
        expect(commands.filter(command => command === 'desktop_capture_read_prepared_png')).toHaveLength(1);
        expect(commands).not.toContain('desktop_capture_read_source_png');
        commands.length = 0;
        expect(await executor.execute('screenCapture.showInFolder', { captureRef: 'kept' }, { surface: 'ui' }))
            .toEqual({ ok: true, result: { captureRef: 'kept', status: 'revealed' } });
        expect(commands).toEqual(['desktop_capture_show_in_folder']);
    });

    it('refuses copy of an edited or unprepared capture before clipboard disclosure', async () => {
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        inUse = true;
        expect(await executor.execute('screenCapture.copy', { captureRef: 'kept' }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'capture_in_use' });
        inUse = false; preparedMissing = true;
        expect(await executor.execute('screenCapture.copy', { captureRef: 'kept' }, { surface: 'ui' }))
            .toMatchObject({ ok: false, errorCode: 'prepared_missing' });
        expect(clipboard.image.mock.calls).toEqual([]);
        expect(commands).not.toContain('desktop_capture_read_source_png');
    });

    it('copies explicit window text through the same admitted copy Action without image reads', async () => {
        const source = { appName: 'Editor', windowTitle: 'Chosen window', windowId: 7 };
        windowTextOutcome = { status: 'ready', text: 'Chosen window text', source };
        const executor = createActionExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        expect(await executor.execute('screenCapture.copy', { captureRef: 'kept', content: 'windowText' }, { surface: 'ui' }))
            .toEqual({ ok: true, result: { captureRef: 'kept', status: 'copied' } });
        expect(clipboard.text.mock.calls).toEqual([['Chosen window text']]);
        expect(clipboard.image).not.toHaveBeenCalled();
        expect(commands).toEqual(['desktop_capture_window_text']);
    });

    it('validates input before acquisition and returns producer outputs through their strict catalog schemas', async () => {
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        const context = { surface: 'ui' } as const;
        expect(commands).toEqual([]);
        expect(await executor.execute('screenCapture.start', { mode: 'screenshot', marks: [] }, context)).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(commands).toEqual([]);
        expect(await executor.execute('screenCapture.start', { mode: 'screenshot', target: { kind: 'frontmost' } }, context))
            .toMatchObject({ ok: true, result: { status: 'completed', result: { captureRef: 'kept' } } });
        expect(await executor.execute('screenCapture.targets.list', {}, context)).toEqual({ ok: true, result: { displays: [], windows: [] } });
        expect(await executor.execute('screenCapture.permissions.read', {}, context)).toEqual({ ok: true,
            result: { screen: 'per_request', windowText: 'not_required', recoveryActions: { screen: [], windowText: [] } } });
        expect(await executor.execute('screenCapture.permissions.request', { subject: 'window_text' }, context)).toMatchObject({ ok: true, result: { snapshot: { screen: 'unknown', windowText: 'unavailable' } } });
        expect(await executor.execute('screenCapture.windowText.read', { captureRef: 'kept' }, context)).toEqual({ ok: true,
            result: { captureRef: 'kept', status: 'unavailable', reason: 'provider_unavailable', source: null } });
        expect(await executor.execute('screenCapture.recent.list', {}, context)).toMatchObject({ ok: true,
            result: { entries: [{ name: 'shot.png', modifiedAtNanos: '12000000' }], folders: [{ issue: null }] } });
        expect(commands).toEqual(['desktop_capture_start', 'desktop_capture_targets', 'desktop_capture_permissions',
            'desktop_capture_request_permission', 'desktop_capture_window_text', 'desktop_capture_recent_list']);
    });

    it('returns extracted text through the existing admitted Action and strict output owner', async () => {
        const source = { appName: 'Editor', windowTitle: 'Chosen window', windowId: 7 };
        windowTextOutcome = { status: 'ready', text: 'Chosen window text', source };
        const executor = createNativeExecutor({ screenCaptureAction: createNativeScreenCaptureAction() });
        expect(await executor.execute('screenCapture.windowText.read', { captureRef: 'kept' }, { surface: 'ui' })).toEqual({ ok: true,
            result: { captureRef: 'kept', status: 'ready', text: 'Chosen window text', source } });
        expect(commands).toEqual(['desktop_capture_window_text']);
        const frontmost = { appName: 'Editor', windowTitle: 'Before the portal', windowId: null };
        windowTextOutcome = { status: 'ready', text: 'Whole frontmost content', source: frontmost, scope: 'whole_frontmost_window' };
        expect(await executor.execute('screenCapture.windowText.read', { captureRef: 'portal-kept' }, { surface: 'ui' })).toEqual({ ok: true,
            result: { captureRef: 'portal-kept', status: 'ready', text: 'Whole frontmost content', source: frontmost, scope: 'whole_frontmost_window' } });
        expect(commands).toEqual(['desktop_capture_window_text', 'desktop_capture_window_text']);
    });

    it.each(['agent', 'mcp'] as const)('rejects %s capture before native acquisition and honors an explicit disclosure waiver', async surface => {
        let settings = ActionsSettingsV1Schema.parse({ v: 1 });
        const deps = {
            isActionApprovalRequired: (actionId, context) => isApprovalRequiredByActionsSettings(actionId, settings, context),
            isApprovalExecutionOriginCurrent: async () => true,
            approvalsCreate: async () => ({ artifactId: 'native-capture-decision' }),
            approvalsUpdate: async () => ({ ok: true as const }),
            approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const,
                request: { ...request, status: 'rejected' as const, decision: { kind: 'reject' as const, decidedAtMs: Date.now() } } }),
            screenCaptureAction: createNativeScreenCaptureAction(),
        } satisfies Partial<ActionExecutorDeps>;
        const executor = createNativeExecutor(deps);
        const context = { surface, authority: 'account_automation', actionCaller: { kind: 'host' }, serverId: 'home',
            runtimeAccountId: 'account', actionRequestId: 'native-capture-decision', defaultSessionMachineId: 'client' } as const;
        const input = { mode: 'screenshot', target: { kind: 'frontmost' },
            targetSession: { serverId: 'home', accountId: 'account', sessionId: 'requesting-session' } };
        expect(await executor.execute('screenCapture.start', input, context)).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
        expect(commands).toEqual([]);
        settings = ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'screenCapture.start': [surface] } });
        cancelStart = true;
        expect(await executor.execute('screenCapture.start', input, context)).toMatchObject({ ok: false, errorCode: 'cancelled' });
        expect(commands).toEqual(['desktop_capture_start']);
    });
});
