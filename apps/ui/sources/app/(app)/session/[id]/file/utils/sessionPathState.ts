type SessionPathState =
    | { status: 'ready'; error: null }
    | { status: 'waiting'; error: null }
    | { status: 'error'; error: string };

export function resolveSessionPathState(input: {
    sessionId: string;
    sessionPath: string | null;
    sessionsReady: boolean;
}): SessionPathState {
    const { sessionId, sessionPath, sessionsReady } = input;

    if (!sessionId) {
        return { status: 'error', error: 'Session path is unavailable' };
    }

    if (sessionPath) {
        return { status: 'ready', error: null };
    }

    if (!sessionsReady) {
        return { status: 'waiting', error: null };
    }

    return { status: 'error', error: 'Session path is unavailable' };
}
