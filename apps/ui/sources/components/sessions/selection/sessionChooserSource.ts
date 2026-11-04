import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { CaptureDefaultReason } from '@/components/screenCapture/main/resolveCaptureDefaultTarget';
import type { SessionSelectionRow } from './projectSessionSelectionRows';
import type { SessionChooserPageRequest } from './readSessionChooserPage';
import { DESKTOP_CAPTURE_SESSION_CHOOSER_READ, executeDesktopWindowActionWithResult, type DesktopWindowActionWaitOptions } from '@/utils/platform/desktopWindowActionBridge';
export type SessionChooserPage = Readonly<{ rows: readonly SessionSelectionRow[]; total: number }>;
export type SessionChooserTarget = Readonly<{
    address: SessionAddress | null;
    defaultReason?: CaptureDefaultReason;
    /** The Account signed in to this address's Home; delivery targets carry it. */
    accountId: string | null;
    row: SessionSelectionRow | null;
    uploadAvailable: boolean;
    machineReachability: 'reachable' | 'unreachable' | 'unknown';
    /** Prose outside typed reference ranges in the main window's canonical draft. */
    hasDraftText: boolean;
}>;
export type SessionChooserReadRequest =
    | (SessionChooserPageRequest & Readonly<{ kind: 'page' }>)
    | Readonly<{ kind: 'target'; targetSession?: SessionAddress }>;

/** Capture asks only on open/query or a target change. No retained listener or publisher. */
export function readSessionChooserFromCaptureWindow(request: Extract<SessionChooserReadRequest, { kind: 'page' }>, options?: DesktopWindowActionWaitOptions): Promise<SessionChooserPage>;
export function readSessionChooserFromCaptureWindow(request: Extract<SessionChooserReadRequest, { kind: 'target' }>, options?: DesktopWindowActionWaitOptions): Promise<SessionChooserTarget>;
export async function readSessionChooserFromCaptureWindow(request: SessionChooserReadRequest, options?: DesktopWindowActionWaitOptions): Promise<SessionChooserPage | SessionChooserTarget> {
    // A native pin also carries Account identity; this read contract accepts only its address.
    const data = request.kind === 'target' ? { kind: request.kind,
        ...(request.targetSession ? { targetSession: { serverId: request.targetSession.serverId,
            sessionId: request.targetSession.sessionId } } : {}) } : { ...request };
    const result = await executeDesktopWindowActionWithResult({ windowLabel: 'capture',
        actionIdentifier: DESKTOP_CAPTURE_SESSION_CHOOSER_READ, data }, options);
    if (!result.ok) throw new Error(result.errorCode ?? 'action_failed');
    // Both ends use this private, native-label-checked bridge's single typed reader.
    return result.result as SessionChooserPage | SessionChooserTarget;
}
