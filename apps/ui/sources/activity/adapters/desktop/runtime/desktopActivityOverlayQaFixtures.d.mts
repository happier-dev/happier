import type { DesktopActivityOverlayModel } from '../presentation/buildDesktopActivityOverlayModel';

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

export type DesktopActivityOverlayQaModel = Omit<DesktopActivityOverlayModel, 'generatedAt'>;

export declare function buildDesktopActivityOverlayQaModel(mode: DesktopActivityOverlayQaSeedMode): DesktopActivityOverlayQaModel;
