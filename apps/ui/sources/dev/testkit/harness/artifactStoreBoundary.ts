import { decodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { Buffer } from 'buffer';

import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';
import { vi } from 'vitest';

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
    /** Hold the real creation acknowledgement after the Home has stored the request. */
    afterNextCreate(hook: () => Promise<void>): void;
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
    let pendingAfterCreate: (() => Promise<void>) | null = null;

    const create = (input: Record<string, unknown> | null): Response => {
        const ownerAccountId = params.ownerAccountId();
        if (!ownerAccountId) return json({ error: 'Not authenticated' }, 401);
        const { id, header, body, dataEncryptionKey, provenance, provenanceDataEncryptionKey } = input ?? {};
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
            ownerAccountId, access: 'owner', encryptionMode: params.encryptionMode, publicAudience: 'none',
            id, header, headerVersion: 1, body, bodyVersion: 1, dataEncryptionKey, seq: 0, createdAt: now, updatedAt: now,
            ...(typeof provenance === 'string' || provenance === null ? { provenance } : {}),
            ...(typeof provenanceDataEncryptionKey === 'string' || provenanceDataEncryptionKey === null ? { provenanceDataEncryptionKey } : {}),
        };
        rows.set(id, row);
        return json(row);
    };

    const update = async (artifactId: string, input: Record<string, unknown> | null): Promise<Response> => {
        const { header, expectedHeaderVersion, body, expectedBodyVersion, provenance, provenanceDataEncryptionKey } = input ?? {};
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
            ...(typeof provenance === 'string' || provenance === null ? { provenance } : {}),
            ...(typeof provenanceDataEncryptionKey === 'string' || provenanceDataEncryptionKey === null ? { provenanceDataEncryptionKey } : {}),
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
                    const { body: _body, ...header } = row;
                    return header;
                })));
            }
            if (path === ARTIFACTS_PATH) {
                if (method !== 'POST') return null;
                const response = create(parseBody(init));
                const hook = pendingAfterCreate;
                pendingAfterCreate = null;
                return Promise.resolve(hook?.()).then(() => response);
            }
            if (!path.startsWith(`${ARTIFACTS_PATH}/`)) return null;
            const recipientTarget = /^\/v1\/artifacts\/([^/]+)\/access\/recipients$/.exec(url.pathname);
            if (recipientTarget && method === 'GET') {
                const callerAccountId = params.ownerAccountId();
                if (!callerAccountId) return Promise.resolve(json({ error: 'Not authenticated' }, 401));
                const row = rows.get(decodeURIComponent(recipientTarget[1]!));
                // This owner-only store has no grant writer or other authorized audience.
                if (!row || row.ownerAccountId !== callerAccountId) return Promise.resolve(json({ error: 'artifact_not_found' }, 404));
                const plain = row.encryptionMode === 'plain';
                return Promise.resolve(json(ArtifactAccessRecipientCensusResponseV1Schema.parse({
                    artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access,
                    encryptionMode: row.encryptionMode,
                    dataEncryptionKey: plain ? null : row.dataEncryptionKey,
                    callerDataEncryptionKey: plain ? null : row.dataEncryptionKey,
                    provenanceDataEncryptionKey: plain ? null : row.provenanceDataEncryptionKey ?? null,
                    callerProvenanceDataEncryptionKey: plain ? null : row.provenanceDataEncryptionKey ?? null,
                    // No Account content-key binding is published in this boundary.
                    // Local key possession is not server recipient readiness.
                    recipients: [{ recipientAccountId: row.ownerAccountId,
                        contentKey: { status: 'unavailable', reason: plain ? 'plain_account' : 'encryption_setup_required' },
                        contentPublicKeyFingerprint: null, encryptedDataKey: null,
                        encryptedProvenanceDataKey: null, recipientContentPublicKeyFingerprint: null }],
                })));
            }
            const grantsTarget = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/.exec(url.pathname);
            if (grantsTarget && method === 'GET') {
                const row = rows.get(decodeURIComponent(grantsTarget[1]!));
                return Promise.resolve(row ? json(ArtifactAccessGrantsListResponseV1Schema.parse({
                    artifactId: row.id, ownerAccountId: row.ownerAccountId, access: row.access, grants: [],
                })) : json({ error: 'Artifact not found' }, 404));
            }
            if (method === 'DELETE') {
                const target = /^\/v1\/artifacts\/([^/]+)(?:\/revision\/(\d+)\/(\d+))?$/.exec(url.pathname);
                const encodedArtifactId = target?.[1];
                if (!target || !encodedArtifactId) return null;
                const artifactId = decodeURIComponent(encodedArtifactId);
                if (!artifactId || artifactId.includes('/')) return null;
                const row = rows.get(artifactId);
                if (!row) return Promise.resolve(json({ error: 'Artifact not found' }, 404));
                if (target[2] !== undefined && (row.headerVersion !== Number(target[2]) || row.bodyVersion !== Number(target[3]))) {
                    return Promise.resolve(json({ error: 'version-mismatch' }, 409));
                }
                rows.delete(artifactId);
                return Promise.resolve(json({ success: true }));
            }
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
        afterNextCreate(hook: () => Promise<void>): void {
            pendingAfterCreate = hook;
        },
        clear(): void {
            rows.clear();
            pendingBeforeUpdate = null;
            pendingAfterCreate = null;
        },
    });
}

/** Real qualified client operations above the shared HTTP/CAS boundary. */
export async function createPlainArtifactHomeFixture(serverUrl: string, options?: Readonly<{
    /** Additional real Home HTTP routes needed by the consumer under test. */
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
}>) {
    const [{ TokenStorage }, { upsertAndActivateServer, getActiveServerSnapshot }, { storage }, { setRuntimeFetch, resetRuntimeFetch }, applied] = await Promise.all([
        import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
        import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
        import('@/sync/runtime/orchestration/appliedActiveServerRuntime'),
    ]);
    const accountId = 'artifact-account';
    const token = `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const credentialSpy = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockResolvedValue({ token });
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain' });
    const requests: Readonly<{ path: string; method: string }>[] = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping' || url.pathname === '/v1/features') return json({});
        if (url.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return json({ mode: 'plain', version: 0,
            signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 0 });
        if (url.origin !== new URL(serverUrl).origin) throw new Error(`Unexpected Home ${url.origin}`);
        requests.push({ path, method: init?.method ?? 'GET' });
        const additional = await options?.handleRequest?.(path, init);
        if (additional) return additional;
        return await boundary.handle(path, init) ?? json({ error: 'not_found' }, 404);
    });
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    const home = await upsertAndActivateServer({ serverUrl, scope: 'device' });
    storage.setState({ settingsScope: { serverId: home.id, accountId }, profileScope: { serverId: home.id, accountId }, artifacts: {} });
    // The connection owner admits a Home after restoring its Account scope.
    // Persisting selection alone does not make Account content available.
    applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    return {
        home, boundary, requests,
        dispose() {
            resetRuntimeFetch(); credentialSpy.mockRestore();
            storage.setState(previousState, true);
            applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
        },
    };
}
