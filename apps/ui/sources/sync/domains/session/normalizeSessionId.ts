export function normalizeSessionId(sessionId: string | readonly string[] | null | undefined): string {
    if (Array.isArray(sessionId)) {
        for (const candidate of sessionId) {
            const normalizedCandidate = String(candidate ?? '').trim();
            if (normalizedCandidate) {
                return normalizedCandidate;
            }
        }
        return '';
    }

    return String(sessionId ?? '').trim();
}
