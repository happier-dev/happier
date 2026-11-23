export function readSessionTranscriptStorage(): 'direct' | 'persisted' {
    return process.env.HAPPIER_TRANSCRIPT_STORAGE?.trim().toLowerCase() === 'direct' ? 'direct' : 'persisted';
}
