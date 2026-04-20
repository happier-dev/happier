export type SessionSplitCanvasDragData = Readonly<{
    sessionId: string;
}>;

export function encodeSessionSplitCanvasDragData(input: Readonly<{
    sessionId: string;
}>): string {
    return JSON.stringify({
        sessionId: String(input.sessionId ?? '').trim(),
    });
}

export function decodeSessionSplitCanvasDragData(payload: string): SessionSplitCanvasDragData | null {
    if (!payload) {
        return null;
    }

    try {
        const parsed = JSON.parse(payload) as Partial<SessionSplitCanvasDragData> | null;
        const sessionId = String(parsed?.sessionId ?? '').trim();
        if (!sessionId) {
            return null;
        }
        return { sessionId };
    } catch {
        return null;
    }
}
