import type { DesktopOverlayPolicy } from './resolveDesktopOverlayPolicy';
import type { DesktopActivityOverlaySyncPayload } from './desktopActivityOverlayBridge';

export type DesktopActivityOverlayQaSeedMode =
    | 'active_session'
    | 'attention_only'
    | 'idle'
    | 'permission_request'
    | 'user_question'
    | 'quota_summary'
    | 'multi_session_list'
    | 'completion_state';

export declare const desktopActivityOverlayQaSeedModes: readonly DesktopActivityOverlayQaSeedMode[];

export declare function buildDesktopActivityOverlayQaSyncPayload(input: Readonly<{
    mode: DesktopActivityOverlayQaSeedMode;
    policy: DesktopOverlayPolicy;
}>): DesktopActivityOverlaySyncPayload;
