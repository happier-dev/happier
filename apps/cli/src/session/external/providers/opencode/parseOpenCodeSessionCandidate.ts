import type { ExternalSessionCandidateV1 } from '@happier-dev/protocol';

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function getString(value: unknown, key: string): string {
    const rec = asRecord(value);
    const raw = rec ? rec[key] : null;
    return typeof raw === 'string' ? raw : '';
}

function getNumber(value: unknown, key: string): number | null {
    const rec = asRecord(value);
    const raw = rec ? rec[key] : null;
    const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
    return n != null ? Math.trunc(n) : null;
}

export function parseOpenCodeSessionCandidate(raw: unknown): ExternalSessionCandidateV1 | null {
    const rec = asRecord(raw);
    if (!rec) return null;
    const remoteSessionId = getString(rec, 'id').trim();
    if (!remoteSessionId) return null;

    const title = getString(rec, 'title').trim();
    const updatedAtMs = getNumber(rec, 'updatedAtMs') ?? getNumber(rec, 'updatedAt') ?? null;
    const updatedAtMsFinal = updatedAtMs != null ? updatedAtMs : Date.now();

    return {
        kindVersion: 1,
        remoteSessionId,
        title: title || undefined,
        updatedAtMs: updatedAtMsFinal,
        activity: 'unknown',
        details: {},
    };
}
