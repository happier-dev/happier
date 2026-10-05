import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { Buffer } from 'buffer';

import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

/**
 * One Account's Artifact rows as its Home persists them, answered over HTTP.
 *
 * This is the persistence boundary only: the Home's `/v1/artifacts` routes
 * with their real versioned compare-and-set (`artifactsRoutes.ts` and
 * `artifactWriteService.ts` in `apps/server`). Everything a client runs above
 * it stays real — the Artifact codec, the Account-scoped request authority, the
 * approval subject/transition owner and its writer — so an approval test built
 * on it observes the same claim, rejection and settlement races the Home
 * enforces, instead of a fake that accepts every write.
 *
 * Stored header and body bytes are kept exactly as the client sent them and
 * returned unchanged, which is what the Home does for both storage modes once
 * its at-rest sealing is opened again.
 */
export type ArtifactStoreBoundary = Readonly<{
    /** Answers one Artifact route, or returns `null` for any other path. */
    handle(path: string, init?: RequestInit): Promise<Response> | null;
    /** The stored row, exactly as the Home would serve it. */
    read(artifactId: string): Artifact | null;
    /** Every stored row, in creation order. */
    list(): Artifact[];
    /**
     * The decoded body string of a Plain Account row: the approval request
     * JSON for an approval Artifact. Also the serialized bytes a privacy
     * assertion inspects, since this is all the Home keeps.
     */
    readPlainBody(artifactId: string): string | null;
    /**
     * Runs `hook` inside the next update, after the request reached the Home
     * and before its compare-and-set, so a case can commit a competing write
     * exactly where a concurrent client would.
     */
    beforeNextUpdate(hook: () => Promise<void>): void;
    clear(): void;
}>;

const ARTIFACTS_PATH = '/v1/artifacts';

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function parseBody(init: RequestInit | undefined): Record<string, unknown> | null {
    if (typeof init?.body !== 'string') return null;
    try {
        const parsed: unknown = JSON.parse(init.body);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

function isVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function createArtifactStoreBoundary(params: Readonly<{
    ownerAccountId: () => string | null;
    encryptionMode: 'plain' | 'e2ee';
}>): ArtifactStoreBoundary {
    const rows = new Map<string, Artifact>();
    let pendingBeforeUpdate: (() => Promise<void>) | null = null;

    const create = (input: Record<string, unknown> | null): Response => {
        const ownerAccountId = params.ownerAccountId();
        if (!ownerAccountId) return json({ error: 'Not authenticated' }, 401);
        const { id, header, body, dataEncryptionKey } = input ?? {};
        if (typeof id !== 'string' || typeof header !== 'string' || typeof body !== 'string'
            || typeof dataEncryptionKey !== 'string') {
            return json({ error: 'Invalid parameters' }, 400);
        }
        // Re-creating an id the Account already holds returns the stored row
        // unchanged, as the Home's idempotent create does.
        const existing = rows.get(id);
        if (existing) return json(existing);
        const now = Date.now();
        const row: Artifact = {
            ownerAccountId, access: 'owner', encryptionMode: params.encryptionMode,
            id, header, headerVersion: 1, body, bodyVersion: 1, dataEncryptionKey, seq: 0, createdAt: now, updatedAt: now,
        };
        rows.set(id, row);
        return json(row);
    };

    const update = async (artifactId: string, input: Record<string, unknown> | null): Promise<Response> => {
        const { header, expectedHeaderVersion, body, expectedBodyVersion } = input ?? {};
        const headerChange = typeof header === 'string' && isVersion(expectedHeaderVersion)
            ? { bytes: header, expected: expectedHeaderVersion } : null;
        const bodyChange = typeof body === 'string' && isVersion(expectedBodyVersion)
            ? { bytes: body, expected: expectedBodyVersion } : null;
        if ((header !== undefined && !headerChange) || (body !== undefined && !bodyChange)
            || (!headerChange && !bodyChange)) {
            return json({ error: 'Invalid parameters' }, 400);
        }
        const hook = pendingBeforeUpdate;
        pendingBeforeUpdate = null;
        await hook?.();
        const current = rows.get(artifactId);
        if (!current) return json({ error: 'Artifact not found' }, 404);
        if ((headerChange && headerChange.expected !== current.headerVersion)
            || (bodyChange && bodyChange.expected !== current.bodyVersion)) {
            return json({
                success: false,
                error: 'version-mismatch',
                ...(headerChange ? { currentHeaderVersion: current.headerVersion, currentHeader: current.header } : {}),
                ...(bodyChange ? { currentBodyVersion: current.bodyVersion, currentBody: current.body } : {}),
            });
        }
        const next: Artifact = {
            ...current,
            ...(headerChange ? { header: headerChange.bytes, headerVersion: headerChange.expected + 1 } : {}),
            ...(bodyChange ? { body: bodyChange.bytes, bodyVersion: bodyChange.expected + 1 } : {}),
            seq: current.seq + 1,
            updatedAt: Math.max(Date.now(), current.updatedAt + 1),
        };
        rows.set(artifactId, next);
        return json({
            success: true,
            ...(headerChange ? { headerVersion: next.headerVersion } : {}),
            ...(bodyChange ? { bodyVersion: next.bodyVersion } : {}),
        });
    };

    return Object.freeze({
        handle(path: string, init?: RequestInit): Promise<Response> | null {
            const method = (init?.method ?? 'GET').toUpperCase();
            const url = new URL(path, 'https://artifact-boundary.example');
            if (url.pathname === ARTIFACTS_PATH && method === 'GET') {
                if (!params.ownerAccountId()) return Promise.resolve(json({ error: 'Not authenticated' }, 401));
                const limit = Number(url.searchParams.get('limit') ?? 500);
                if (!Number.isInteger(limit) || limit < 1 || limit > 500) return Promise.resolve(json({ error: 'Failed to get artifacts' }, 400));
                let cursor: { updatedAt: number; id: string } | null = null;
                const encodedCursor = url.searchParams.get('cursor');
                if (encodedCursor) {
                    try {
                        const decoded: unknown = JSON.parse(Buffer.from(encodedCursor, 'base64url').toString('utf8'));
                        if (decoded && typeof decoded === 'object' && 'id' in decoded && typeof decoded.id === 'string' && 'updatedAt' in decoded) {
                            const updatedAt = new Date(Number(decoded.updatedAt)).getTime();
                            if (Number.isFinite(updatedAt)) cursor = { updatedAt, id: decoded.id };
                        }
                    } catch { /* Malformed cursors are rejected just as by the Home route. */ }
                    if (!cursor) return Promise.resolve(json({ error: 'Failed to get artifacts' }, 400));
                }
                const inventory = [...rows.values()].filter(row => row.ownerAccountId === params.ownerAccountId()
                    && (!cursor || row.updatedAt < cursor.updatedAt || (row.updatedAt === cursor.updatedAt && row.id < cursor.id)))
                    .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
                return Promise.resolve(json(inventory.slice(0, limit).map(row => {
                    if (url.searchParams.get('includeBody') === 'true') return row;
                    const { body: _body, bodyVersion: _bodyVersion, ...header } = row;
                    return header;
                })));
            }
            if (path === ARTIFACTS_PATH) {
                return method === 'POST' ? Promise.resolve(create(parseBody(init))) : null;
            }
            if (!path.startsWith(`${ARTIFACTS_PATH}/`)) return null;
            const artifactId = decodeURIComponent(path.slice(ARTIFACTS_PATH.length + 1));
            if (!artifactId || artifactId.includes('/')) return null;
            if (method === 'GET') {
                const row = rows.get(artifactId);
                return Promise.resolve(row ? json(row) : json({ error: 'Artifact not found' }, 404));
            }
            if (method === 'POST') return update(artifactId, parseBody(init));
            return null;
        },
        read(artifactId: string): Artifact | null {
            const row = rows.get(artifactId);
            return row ? { ...row } : null;
        },
        list(): Artifact[] {
            return [...rows.values()].map((row) => ({ ...row }));
        },
        readPlainBody(artifactId: string): string | null {
            const stored = rows.get(artifactId)?.body;
            if (typeof stored !== 'string') return null;
            const decoded = decodePlainArtifactStoredContent(stored);
            const body = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
                ? Reflect.get(decoded, 'body') : null;
            return typeof body === 'string' ? body : null;
        },
        beforeNextUpdate(hook: () => Promise<void>): void {
            pendingBeforeUpdate = hook;
        },
        clear(): void {
            rows.clear();
            pendingBeforeUpdate = null;
        },
    });
}
