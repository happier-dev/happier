import type { StoredCredentials } from '@/persistence';
import { fetchSessionByIdCompat, type RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';

export type ForkTranscriptSegment = Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    metadata: Readonly<Record<string, unknown>> | null;
    upToSeqInclusive?: number;
}>;

/** One lineage acquisition owner; dialog and visual readers retain their own content admission. */
export async function fetchForkTranscriptSegments(params: Readonly<{
    credentials: StoredCredentials;
    accountEncryptionMode: 'plain' | 'e2ee';
    startingSessionId: string;
    upToSeqInclusive?: number;
    afterSeqExclusive?: number | null;
    /** The dialog reader's existing depth budget. Visual copying imposes no additional cutoff. */
    maxDepth?: number;
    startingRawSession?: RawSessionRecord;
    startingMetadata?: Readonly<Record<string, unknown>>;
}>): Promise<Readonly<{ segments: readonly ForkTranscriptSegment[]; chainTerminatedNaturally: boolean; acquisitionError?: unknown }>> {
    const segments: ForkTranscriptSegment[] = [];
    const visited = new Set<string>();
    let currentSessionId = params.startingSessionId.trim();
    let currentCutoff = params.upToSeqInclusive;
    let chainTerminatedNaturally = false;
    let acquisitionError: unknown;
    for (let depth = 0; params.maxDepth === undefined || depth < params.maxDepth; depth += 1) {
        if (!currentSessionId) { chainTerminatedNaturally = true; break; }
        if (visited.has(currentSessionId)) break;
        visited.add(currentSessionId);
        const rawSession = depth === 0 && params.startingRawSession ? params.startingRawSession
            : await fetchSessionByIdCompat({ token: params.credentials.token, sessionId: currentSessionId }).catch(error => {
                acquisitionError = error;
                return null;
            });
        if (!rawSession) break;
        const metadata = depth === 0 && params.startingMetadata ? params.startingMetadata
            : tryDecryptSessionOwnerMetadataView({ credentials: params.credentials, rawSession,
                accountEncryptionMode: params.accountEncryptionMode });
        segments.push({ sessionId: currentSessionId, rawSession, metadata,
            ...(typeof currentCutoff === 'number' && Number.isFinite(currentCutoff)
                ? { upToSeqInclusive: Math.max(0, Math.floor(currentCutoff)) } : {}) });
        if (params.afterSeqExclusive != null) { chainTerminatedNaturally = true; break; }
        if (!metadata) break;
        const fork = metadata.forkV1;
        if (!fork || typeof fork !== 'object' || Array.isArray(fork)) { chainTerminatedNaturally = true; break; }
        const value = fork as Readonly<Record<string, unknown>>;
        const parentSessionId = typeof value.parentSessionId === 'string' ? value.parentSessionId.trim() : '';
        const cutoff = typeof value.parentCutoffSeqInclusive === 'number' && Number.isFinite(value.parentCutoffSeqInclusive)
            ? Math.max(0, Math.floor(value.parentCutoffSeqInclusive)) : null;
        if (value.v !== 1 || !parentSessionId || cutoff === null) { chainTerminatedNaturally = true; break; }
        currentSessionId = parentSessionId;
        currentCutoff = cutoff;
    }
    return { segments, chainTerminatedNaturally, ...(acquisitionError !== undefined ? { acquisitionError } : {}) };
}
