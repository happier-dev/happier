export type LiveStreamPlayerDiagnostic = Readonly<{
    reasonCode: string;
}>;

export function createLiveStreamPlayerDiagnostic(input: Readonly<{
    reasonCode?: string | null;
    message?: string | null;
}>): LiveStreamPlayerDiagnostic {
    const reasonCode = typeof input.reasonCode === 'string' && input.reasonCode.trim().length > 0
        ? input.reasonCode.trim()
        : 'stream_player_error';
    return { reasonCode };
}
