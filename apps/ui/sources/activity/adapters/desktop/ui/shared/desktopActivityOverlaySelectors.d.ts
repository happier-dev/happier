export type DesktopActivityOverlayVisualModeForTestID = 'notch_integrated' | 'floating_overlay';

export declare const desktopActivityOverlayQaCardSeedIds: Readonly<{
    permission_request: 'qa-permission-request';
    user_question: 'qa-user-question';
    quota_summary: 'qa-quota-summary';
    completion_state: 'qa-completion-state';
}>;

export declare function normalizeDesktopActivityOverlayCardKindForTestID(kind: unknown): string;
export declare function resolveDesktopActivityOverlaySurfaceTestID(
    baseTestID: string,
    visualMode: DesktopActivityOverlayVisualModeForTestID,
): string;
export declare function resolveDesktopActivityOverlaySurfaceSelector(
    baseTestID: string,
    visualMode: DesktopActivityOverlayVisualModeForTestID,
): string;
export declare function resolveDesktopActivityOverlayCardKindTestID(kind: unknown): string;
export declare function resolveDesktopActivityOverlayCardKindSelector(kind: unknown): string;
export declare function resolveDesktopActivityOverlayCardInstanceTestID(card: Record<string, unknown>): string;
export declare function resolveDesktopActivityOverlayCardSelectorByKind(
    kind: unknown,
    cardInstanceId?: string | null,
): string;
export declare function resolveDesktopActivityOverlayCardActionKindTestID(actionId: string): string;
export declare function resolveDesktopActivityOverlayCardActionInstanceTestID(cardId: string, actionId: string): string;
