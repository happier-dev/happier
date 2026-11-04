import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ScreenCaptureOpenInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { DESKTOP_CAPTURE_NEW_SESSION, DESKTOP_CAPTURE_OPEN_SESSION, DESKTOP_CAPTURE_OPEN_SETTINGS, DESKTOP_CAPTURE_SESSION_CHOOSER_READ, emitDesktopWindowActionResult, isCaptureWindowLabel, type DesktopWindowActionRequest } from './desktopWindowActionBridge';

// This is the Capture webview's capability surface, not a second Action catalog.
const CAPTURE_WINDOW_ACTION_IDS = [
    'screenCapture.open', 'screenCapture.addToDraft', 'screenCapture.send', 'screenCapture.discard',
    'screenCapture.copy', 'screenCapture.showInFolder',
    'screenCapture.recording.status', 'screenCapture.recording.pause',
    'screenCapture.recording.resume', 'screenCapture.recording.stop',
    'screenCapture.recording.edit', 'screenCapture.recording.read',
    'media.annotation.read', 'media.annotation.apply',
] as const satisfies readonly ActionId[];
type CaptureWindowActionId = typeof CAPTURE_WINDOW_ACTION_IDS[number];

export function admitDesktopCaptureWindowAction(request: Readonly<{ windowLabel: string; actionIdentifier: string }>):
    | Readonly<{ ok: true; actionId: CaptureWindowActionId | typeof DESKTOP_CAPTURE_SESSION_CHOOSER_READ | typeof DESKTOP_CAPTURE_NEW_SESSION | typeof DESKTOP_CAPTURE_OPEN_SETTINGS | typeof DESKTOP_CAPTURE_OPEN_SESSION }>
    | Readonly<{ ok: false; errorCode: 'window_action_refused' }> {
    const actionId = request.actionIdentifier === DESKTOP_CAPTURE_NEW_SESSION ? DESKTOP_CAPTURE_NEW_SESSION
        : request.actionIdentifier === DESKTOP_CAPTURE_OPEN_SESSION ? DESKTOP_CAPTURE_OPEN_SESSION
        : request.actionIdentifier === DESKTOP_CAPTURE_OPEN_SETTINGS ? DESKTOP_CAPTURE_OPEN_SETTINGS
        : request.actionIdentifier === DESKTOP_CAPTURE_SESSION_CHOOSER_READ ? DESKTOP_CAPTURE_SESSION_CHOOSER_READ
        : CAPTURE_WINDOW_ACTION_IDS.find(id => id === request.actionIdentifier);
    if (!isCaptureWindowLabel(request.windowLabel) || !actionId) return { ok: false, errorCode: 'window_action_refused' };
    return { ok: true, actionId };
}

/** Runs only in main, using the same executor and UI admission as an in-app press. */
export async function dispatchDesktopCaptureWindowAction(
    request: DesktopWindowActionRequest,
    executor: Readonly<{
        execute: (actionId: CaptureWindowActionId, input: unknown, context: Readonly<{
            surface: 'ui'; serverId?: string; runtimeAccountId?: string;
        }>) => Promise<ActionExecuteResult>;
    }>,
): Promise<void> {
    const admission = admitDesktopCaptureWindowAction(request);
    if (!request.requestId) return;
    const address = { windowLabel: request.windowLabel, requestId: request.requestId };
    if (!admission.ok) {
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false, errorCode: admission.errorCode });
        return;
    }
    await emitDesktopWindowActionResult({ ...address, phase: 'admitted', ok: true });
    try {
        let data = request.data;
        let context: Readonly<{ surface: 'ui'; serverId?: string; runtimeAccountId?: string }> = { surface: 'ui' };
        if ((admission.actionId === 'media.annotation.apply' || admission.actionId === 'media.annotation.read')
            && data.target && typeof data.target === 'object' && 'kind' in data.target
            && (data.target.kind === 'recordingFrame' || data.target.kind === 'capture')) {
            // The auxiliary window has no Sync. Bind its device-local frame edit to
            // main's Account; the default executor captures that Account lifetime.
            const { storage } = await import('@/sync/domains/state/storage');
            const scope = storage.getState().profileScope;
            if (!scope) {
                await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false, errorCode: 'not_authenticated' });
                return;
            }
            data = { ...data, scope: { serverId: scope.serverId, accountId: scope.accountId } };
            context = { surface: 'ui', serverId: scope.serverId, runtimeAccountId: scope.accountId };
        }
        const outcome = admission.actionId === DESKTOP_CAPTURE_SESSION_CHOOSER_READ
            ? { ok: true as const, result: await (await import('@/components/screenCapture/main/readCaptureSessionChooser')).readCaptureSessionChooser(request.data) }
            : admission.actionId === DESKTOP_CAPTURE_NEW_SESSION
            ? await (await import('@/components/screenCapture/main/openCaptureNewSession')).openCaptureNewSession(request.data)
            : admission.actionId === DESKTOP_CAPTURE_OPEN_SESSION
            ? await (await import('@/components/screenCapture/main/openCaptureSession')).openCaptureSession(request.data)
            : admission.actionId === DESKTOP_CAPTURE_OPEN_SETTINGS
            ? await (await import('@/components/screenCapture/main/openCaptureSession')).openCaptureSettings()
            : await executor.execute(admission.actionId, data, context);
        if (outcome.ok && admission.actionId === 'screenCapture.open' && request.intent === 'chooseSession') {
            // The executor admitted this input; only an actual chooser pick advances its default.
            const opened = data as ReturnType<typeof ScreenCaptureOpenInputSchema.parse>;
            if (opened.targetSession) {
                const { rememberCaptureSessionPick } = await import('@/components/screenCapture/main/resolveCaptureDefaultTarget');
                rememberCaptureSessionPick(opened.targetSession);
            }
        }
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ...outcome });
    } catch {
        await emitDesktopWindowActionResult({ ...address, phase: 'settled', ok: false, errorCode: 'action_failed', error: 'action_failed' });
    }
}
