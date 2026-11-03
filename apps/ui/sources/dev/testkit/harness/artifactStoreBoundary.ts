import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { ArtifactCoarseKindV1Schema, ArtifactStoredKindV1Schema, ArtifactKindWriteBatchInputV1Schema,
    ArtifactKindWriteBatchResponseV1Schema, type ArtifactCoarseKindV1, ArtifactKindCoverageV1Schema, decodeArtifactKindV1, deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema,
    ArtifactAccessGrantSetInputV1Schema, ArtifactAccessGrantMutationResponseV1Schema,
    ArtifactReadBatchHttpInputV1Schema, ArtifactReadBatchResponseV1Schema, ArtifactReadHeadersBatchResponseV1Schema,
    type ArtifactAccessGrantRowV1, type ArtifactAccessLevelV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { encodeBase64, decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { Buffer } from 'buffer';

import type { Artifact, DecryptedArtifact } from '@/sync/domains/artifacts/artifactTypes';

import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { CoordinationMessageRefV1Schema, type CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { ChangesResponseSchema, CurrentCursorResponseSchema, CursorGoneErrorSchema, type ChangeEntry } from '@happier-dev/protocol/changes';
import { getArtifactKindPolicyV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { deriveApprovalArtifactQueryHintsV1, isApprovalArtifactKindV1, ApprovalArtifactQueryHintsV1Schema,
    type ApprovalArtifactQueryHintsV1 } from '@happier-dev/protocol/approvals/approvalArtifactKindV1';

type StoredArtifactFixture = Artifact & Partial<ApprovalArtifactQueryHintsV1>;

/** The Home uses its index metadata for selection without projecting it into public reads. */
export function projectArtifactBoundaryReadRow<T extends object>(artifact: T): Omit<T, 'approvalState' | 'approvalSessionId'> {
    const row = { ...artifact };
    Reflect.deleteProperty(row, 'approvalState');
    Reflect.deleteProperty(row, 'approvalSessionId');
    return row;
}

/**
 * A Home's Artifact rows and explicitly seeded Account grants, answered over HTTP.
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
    /** Answers Artifact routes and their Account cursor/change feed; other paths return `null`. */
    handle(path: string, init?: RequestInit): Promise<Response> | null;
    /** The stored row, exactly as the Home would serve it. */
    read(artifactId: string): Artifact | null;
    /** A committed Home row observed outside this client's writes, including its current CAS ledger. */
    replaceStoredRow(artifact: Artifact): void;
    /** A committed Account grant, seeded outside this client's HTTP mutations. */
    seedAccountGrant(artifactId: string, accountId: string, accessLevel: ArtifactAccessLevelV1): void;
    /** Semantic grants actually persisted by this Home boundary. */
    readGrants(artifactId: string): readonly ArtifactAccessGrantRowV1[];
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

/**
 * The Home's served classification for a stored kind write: an indexed exact
 * hint projects `kind` and `kindHint`; a retained coarse or absent value stays
 * unclassified (no `kindHint`). Fixtures that answer a create or update request
 * with a row use this instead of spreading the request's write-side `kind`.
 */
export function projectArtifactStoredKind(storedKind: unknown): Readonly<{ kind: ArtifactCoarseKindV1 | null; kindHint?: string | null }> {
    const decoded = decodeArtifactKindV1(storedKind);
    return { kind: decoded.kind, ...(decoded.classified ? { kindHint: decoded.kindHint } : {}) };
}

/** Independent HTTP bytes for an explicitly seeded readable Plain Account fixture. */
export function createPlainArtifactHttpFixture(artifact: Extract<DecryptedArtifact, { isDecrypted: true }>, ownerAccountId: string): Artifact {
    const header = artifact.rawHeader ?? artifact.header;
    if (!header) throw new Error('A readable Artifact fixture requires its stored header');
    return {
        id: artifact.id, ownerAccountId: artifact.ownerAccountId ?? ownerAccountId, access: artifact.access ?? 'owner',
        publicAudience: artifact.publicAudience ?? 'none', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        ...projectArtifactStoredKind(deriveArtifactStoredKindV1(header)),
        ...deriveApprovalArtifactQueryHintsV1(header),
        header: encodePlainArtifactStoredContent(header),
        body: encodePlainArtifactStoredContent({ body: artifact.body ?? null }),
        headerVersion: artifact.headerVersion, bodyVersion: artifact.bodyVersion ?? 1,
        seq: artifact.seq, createdAt: artifact.createdAt, updatedAt: artifact.updatedAt,
    };
}

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

/** Strict batch framing over the fixture's existing complete row/census facts. */
export function createArtifactReadBatchHttpResponse(body: unknown, readItem: (artifactId: string) => unknown): Response {
    const input = ArtifactReadBatchHttpInputV1Schema.parse(body);
    const items = input.artifactIds.map(readItem).map(item => {
        if (!item || typeof item !== 'object' || Reflect.get(item, 'ok') !== true) return item;
        const artifact: unknown = Reflect.get(item, 'artifact');
        return artifact && typeof artifact === 'object' ? { ...item, artifact: projectArtifactBoundaryReadRow(artifact) } : item;
    });
    if (!('projection' in input)) return json(ArtifactReadBatchResponseV1Schema.parse({ items }));
    return json(ArtifactReadHeadersBatchResponseV1Schema.parse({ projection: 'headers', items: items.map(item => {
        if (!item || typeof item !== 'object' || Reflect.get(item, 'ok') !== true) return item;
        const artifact: unknown = Reflect.get(item, 'artifact');
        if (!artifact || typeof artifact !== 'object') return item;
        const header = Object.fromEntries(Object.entries(artifact).filter(([key]) => key !== 'body'));
        return { artifactId: Reflect.get(item, 'artifactId'), ok: true, artifact: header };
    }) }));
}

function isVersion(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** The Home's filtered/unfiltered Artifact list framing and structural keyset. */
export function createArtifactListHttpResponse(url: URL, inventory: readonly StoredArtifactFixture[]): Response {
    const limit = Number(url.searchParams.get('limit') ?? 500);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return json({ error: 'Failed to get artifacts' }, 400);
    let cursor: { updatedAt: number; id: string } | null = null;
    const encodedCursor = url.searchParams.get('cursor');
    if (encodedCursor) {
        try {
            const decoded: unknown = JSON.parse(Buffer.from(decodeBase64(encodedCursor, 'base64url')).toString('utf8'));
            if (decoded && typeof decoded === 'object' && 'id' in decoded && typeof decoded.id === 'string' && 'updatedAt' in decoded) {
                const updatedAt = new Date(Number(decoded.updatedAt)).getTime();
                if (Number.isFinite(updatedAt)) cursor = { updatedAt, id: decoded.id };
            }
        } catch { /* Malformed cursors are rejected just as by the Home route. */ }
        if (!cursor) return json({ error: 'Failed to get artifacts' }, 400);
    }
    const kind = url.searchParams.get('kind');
    if (kind !== null && !ArtifactCoarseKindV1Schema.safeParse(kind).success) return json({ error: 'Invalid parameters' }, 400);
    let kinds: readonly string[] | undefined;
    const encodedKinds = url.searchParams.get('kinds');
    if (encodedKinds !== null) {
        try {
            const value: unknown = JSON.parse(encodedKinds);
            if (!Array.isArray(value) || value.length === 0 || !value.every(item => typeof item === 'string' && item.length > 0)) return json({ error: 'Invalid parameters' }, 400);
            kinds = value;
        } catch { return json({ error: 'Invalid parameters' }, 400); }
    }
    const unclassified = url.searchParams.get('unclassified');
    const approvalStates = url.searchParams.has('approvalStates') ? JSON.parse(url.searchParams.get('approvalStates')!) as string[] : undefined;
    const approvalSessionIds = url.searchParams.has('approvalSessionIds') ? JSON.parse(url.searchParams.get('approvalSessionIds')!) as string[] : undefined;
    const approvalSelected = approvalStates !== undefined || approvalSessionIds !== undefined;
    const approvalKind = (row: Artifact) => isApprovalArtifactKindV1(row.kindHint);
    const approvalUnknown = (row: StoredArtifactFixture) => !Object.hasOwn(row, 'kindHint') || approvalKind(row) && row.approvalState == null;
    const browserListed = url.searchParams.get('browserListed');
    if ((unclassified !== null && unclassified !== 'true' && unclassified !== 'coarse' && unclassified !== 'approval')
        || (browserListed !== null && browserListed !== 'true')
        || Number(kind !== null) + Number(kinds !== undefined) + Number(unclassified !== null) + Number(browserListed !== null) > 1
        || (unclassified !== null && url.searchParams.get('includeBody') === 'true')) return json({ error: 'Invalid parameters' }, 400);
    const unknownKind = (row: Artifact) => kinds !== undefined || unclassified === 'true'
        ? !Object.hasOwn(row, 'kindHint') : row.kind == null;
    const ownerAccountId = url.searchParams.get('ownerAccountId');
    const scopedInventory = inventory.filter(row => ownerAccountId === null || row.ownerAccountId === ownerAccountId);
    const selected = scopedInventory.filter(row => unclassified === 'approval' ? approvalUnknown(row) : unclassified !== null ? unknownKind(row)
        : kinds !== undefined ? typeof row.kindHint === 'string' && kinds.includes(row.kindHint)
            : browserListed !== null ? getArtifactKindPolicyV1(row.kindHint).browserListed : kind === null || row.kind === kind)
        .filter(row => unclassified !== null || !approvalSelected || (!approvalKind(row) ? approvalSessionIds === undefined
            : row.approvalState != null && (!approvalStates || approvalStates.includes(row.approvalState))
                && (approvalSessionIds === undefined || row.approvalSessionId != null && approvalSessionIds.includes(row.approvalSessionId))))
        .filter(row => !cursor || row.updatedAt < cursor.updatedAt || (row.updatedAt === cursor.updatedAt && row.id < cursor.id))
        .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
    const items = selected.slice(0, limit).map(row => {
        if (url.searchParams.get('includeBody') === 'true') return projectArtifactBoundaryReadRow(row);
        const { body: _body, ...header } = row;
        return projectArtifactBoundaryReadRow(header);
    });
    const unclassifiedCount = scopedInventory.filter(row => approvalSelected || unclassified === 'approval' ? approvalUnknown(row) : !Object.hasOwn(row, 'kindHint')).length;
    const coverage = ArtifactKindCoverageV1Schema.parse(unclassifiedCount === 0
        ? { status: 'complete', unclassifiedCount: 0 }
        : { status: 'partial', unclassifiedCount, reason: 'unclassified_legacy_rows' });
    return json(kind === null && kinds === undefined && unclassified === null && browserListed === null && !approvalSelected ? items
        : { items, hasUnclassified: scopedInventory.some(unknownKind),
            ...(kinds !== undefined || unclassified !== null || browserListed !== null || approvalSelected ? { coverage } : {}) });
}

export function createArtifactStoreBoundary(params: Readonly<{
    ownerAccountId: () => string | null;
    encryptionMode: 'plain' | 'e2ee';
    /** Model the Home's source admission with explicitly admitted fixture messages. Absent = older Home. */
    admitMemoryDecisionSource?: (source: CoordinationMessageRefV1) => boolean;
}>): ArtifactStoreBoundary {
    const rows = new Map<string, StoredArtifactFixture>();
    const grants = new Map<string, Map<string, ArtifactAccessGrantRowV1>>();
    const principalKey = (principal: ArtifactAccessGrantRowV1['principal']) => JSON.stringify(principal.kind === 'account'
        ? ['account', principal.accountId] : ['team', principal.teamId]);
    const directAccountRecipients = (artifactId: string) => [...(grants.get(artifactId)?.values() ?? [])]
        .flatMap(grant => grant.principal.kind === 'account' ? [grant.principal.accountId] : []);
    // Mirror Account.seq and the Home's coalesced (Account, kind, entityId) ledger.
    // Keep publication at this boundary so HTTP writes and externally seeded
    // commits are equally visible to the real warm-inventory reader.
    const accountChanges = new Map<string, { cursor: number; entries: Map<string, ChangeEntry> }>();
    const publish = (row: Artifact, accountIds = [row.ownerAccountId, ...directAccountRecipients(row.id)]) => {
        for (const accountId of new Set(accountIds)) {
            const ledger = accountChanges.get(accountId) ?? { cursor: 0, entries: new Map<string, ChangeEntry>() };
            ledger.entries.set(row.id, { cursor: ++ledger.cursor, kind: 'artifact', entityId: row.id,
                changedAt: Date.now(), hint: null });
            accountChanges.set(accountId, ledger);
        }
    };
    let pendingBeforeUpdate: (() => Promise<void>) | null = null;
    let pendingAfterCreate: (() => Promise<void>) | null = null;
    const kindProjection = (header: string, supplied: unknown) => {
        let stored = supplied;
        if (params.encryptionMode === 'plain') {
            const decoded = decodePlainArtifactStoredContent(header);
            stored = decoded && typeof decoded === 'object' && !Array.isArray(decoded)
                ? deriveArtifactStoredKindV1(decoded as Readonly<Record<string, unknown>>) : null;
        }
        return projectArtifactStoredKind(stored);
    };
    const approvalProjection = (header: string, input: Record<string, unknown> | null) => {
        if (params.encryptionMode === 'plain') {
            const decoded = decodePlainArtifactStoredContent(header);
            if (decoded && typeof decoded === 'object' && !Array.isArray(decoded))
                return deriveApprovalArtifactQueryHintsV1(decoded as Readonly<Record<string, unknown>>);
        }
        return ApprovalArtifactQueryHintsV1Schema.parse({ approvalState: input?.approvalState ?? null,
            approvalSessionId: input?.approvalSessionId ?? null });
    };

    const accessFor = (row: Artifact, accountId: string): Artifact['access'] | null =>
        row.ownerAccountId === accountId ? 'owner' : grants.get(row.id)?.get(principalKey({ kind: 'account', accountId }))?.accessLevel ?? null;
    const readableRow = (row: Artifact, accountId: string): Artifact | null => {
        const access = accessFor(row, accountId);
        // Grant seeding publishes no recipient key envelope. As on the Home,
        // semantic E2EE access alone never substitutes the owner's key bytes.
        return access && (access === 'owner' || row.encryptionMode === 'plain') ? { ...row, access } : null;
    };
    const writableRow = (row: Artifact | undefined, accountId: string): boolean => {
        const readable = row ? readableRow(row, accountId) : null;
        return readable !== null && readable.access !== 'view';
    };
    const recipientCensus = (row: Artifact, access: Artifact['access']) => {
        const plain = row.encryptionMode === 'plain';
        return ArtifactAccessRecipientCensusResponseV1Schema.parse({
            artifactId: row.id, ownerAccountId: row.ownerAccountId, access,
            encryptionMode: row.encryptionMode,
            dataEncryptionKey: plain ? null : row.dataEncryptionKey,
            callerDataEncryptionKey: plain ? null : row.dataEncryptionKey,
            provenanceDataEncryptionKey: plain ? null : row.provenanceDataEncryptionKey ?? null,
            callerProvenanceDataEncryptionKey: plain ? null : row.provenanceDataEncryptionKey ?? null,
            // No Account content-key binding is published in this boundary.
            // Local key possession is not server recipient readiness.
            recipients: [row.ownerAccountId, ...directAccountRecipients(row.id)].sort().map(recipientAccountId => ({ recipientAccountId,
                contentKey: { status: 'unavailable', reason: plain ? 'plain_account' : 'encryption_setup_required' },
                contentPublicKeyFingerprint: null, encryptedDataKey: null,
                encryptedProvenanceDataKey: null, recipientContentPublicKeyFingerprint: null })),
        });
    };

    const create = (ownerAccountId: string, input: Record<string, unknown> | null): Response => {
        const { id, header, body, dataEncryptionKey, provenance, provenanceDataEncryptionKey } = input ?? {};
        if (typeof id !== 'string' || typeof header !== 'string' || typeof body !== 'string'
            || typeof dataEncryptionKey !== 'string') {
            return json({ error: 'Invalid parameters' }, 400);
        }
        // Re-creating an id the Account already holds returns the stored row
        // unchanged, as the Home's idempotent create does.
        const existing = rows.get(id);
        if (existing) return existing.ownerAccountId === ownerAccountId ? json(existing)
            : json({ error: 'Artifact with this ID already exists for another account' }, 409);
        const now = Date.now();
        const row: Artifact = {
            ownerAccountId, access: 'owner', encryptionMode: params.encryptionMode, publicAudience: 'none',
            id, header, headerVersion: 1, body, bodyVersion: 1, dataEncryptionKey, seq: 0, createdAt: now, updatedAt: now,
            ...(typeof provenance === 'string' || provenance === null ? { provenance } : {}),
            ...(typeof provenanceDataEncryptionKey === 'string' || provenanceDataEncryptionKey === null ? { provenanceDataEncryptionKey } : {}),
            ...kindProjection(header, input?.kind),
            ...approvalProjection(header, input),
        };
        rows.set(id, row);
        publish(row);
        return json(projectArtifactBoundaryReadRow(row));
    };

    const update = async (callerAccountId: string, artifactId: string, input: Record<string, unknown> | null): Promise<Response> => {
        const { header, expectedHeaderVersion, body, expectedBodyVersion, provenance, provenanceDataEncryptionKey } = input ?? {};
        const headerChange = typeof header === 'string' && isVersion(expectedHeaderVersion)
            ? { bytes: header, expected: expectedHeaderVersion } : null;
        const bodyChange = typeof body === 'string' && isVersion(expectedBodyVersion)
            ? { bytes: body, expected: expectedBodyVersion } : null;
        const kindOnly = header === undefined && body === undefined && input?.kind !== undefined && isVersion(expectedHeaderVersion);
        if ((header !== undefined && !headerChange) || (body !== undefined && !bodyChange)
            || (!headerChange && !bodyChange && !kindOnly)
            || (input?.kind !== undefined && !ArtifactStoredKindV1Schema.safeParse(input.kind).success)) {
            return json({ error: 'Invalid parameters' }, 400);
        }
        if (!writableRow(rows.get(artifactId), callerAccountId)) return json({ error: 'Artifact not found' }, 404);
        const hook = pendingBeforeUpdate;
        pendingBeforeUpdate = null;
        await hook?.();
        const current = rows.get(artifactId);
        if (!current || !writableRow(current, callerAccountId)) return json({ error: 'Artifact not found' }, 404);
        if ((headerChange && headerChange.expected !== current.headerVersion) || (kindOnly && expectedHeaderVersion !== current.headerVersion)
            || (bodyChange && bodyChange.expected !== current.bodyVersion)) {
            return json({
                success: false,
                error: 'version-mismatch',
                ...(headerChange ? { currentHeaderVersion: current.headerVersion, currentHeader: current.header } : {}),
                ...(bodyChange ? { currentBodyVersion: current.bodyVersion, currentBody: current.body } : {}),
            });
        }
        const classification = headerChange || input?.kind !== undefined ? kindProjection(headerChange?.bytes ?? current.header, input?.kind) : null;
        if (kindOnly && classification && classification.kind === current.kind
            && Object.hasOwn(classification, 'kindHint') === Object.hasOwn(current, 'kindHint')
            && classification.kindHint === current.kindHint) return json({ success: true });
        const next: Artifact = {
            ...current,
            ...(headerChange ? { header: headerChange.bytes, headerVersion: headerChange.expected + 1 } : {}),
            ...(bodyChange ? { body: bodyChange.bytes, bodyVersion: bodyChange.expected + 1 } : {}),
            ...(typeof provenance === 'string' || provenance === null ? { provenance } : {}),
            ...(typeof provenanceDataEncryptionKey === 'string' || provenanceDataEncryptionKey === null ? { provenanceDataEncryptionKey } : {}),
            ...classification,
            ...(headerChange ? approvalProjection(headerChange.bytes, input) : {}),
            seq: kindOnly ? current.seq : current.seq + 1,
            updatedAt: kindOnly ? current.updatedAt : Math.max(Date.now(), current.updatedAt + 1),
        };
        if (classification && !Object.hasOwn(classification, 'kindHint')) delete next.kindHint;
        rows.set(artifactId, next);
        publish(next);
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
            const changesRoute = url.pathname === '/v2/cursor' || url.pathname === '/v2/changes';
            if (!changesRoute && url.pathname !== ARTIFACTS_PATH && !url.pathname.startsWith(`${ARTIFACTS_PATH}/`)) return null;
            // Mirror the Home preHandler: capture this request's authenticated
            // Account once, before any row access or acknowledgement hook.
            const callerAccountId = params.ownerAccountId();
            if (!callerAccountId) return Promise.resolve(json({ error: 'Missing authorization header' }, 401));
            if (changesRoute) {
                if (method !== 'GET') return null;
                const ledger = accountChanges.get(callerAccountId);
                const currentCursor = ledger?.cursor ?? 0;
                if (url.pathname === '/v2/cursor') return Promise.resolve(json(CurrentCursorResponseSchema.parse({ cursor: currentCursor, changesFloor: 0 })));
                const after = Number(url.searchParams.get('after') ?? 0);
                const limit = Number(url.searchParams.get('limit') ?? 200);
                if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) {
                    return Promise.resolve(json({ error: 'invalid_params' }, 400));
                }
                if (after > currentCursor) return Promise.resolve(json(CursorGoneErrorSchema.parse({ error: 'cursor-gone', currentCursor }), 410));
                const page = [...(ledger?.entries.values() ?? [])].filter(entry => entry.cursor > after)
                    .sort((left, right) => left.cursor - right.cursor).slice(0, limit);
                const nextCursor = page.at(-1)?.cursor ?? after;
                const changes = url.searchParams.has('sessionId') ? [] : page;
                return Promise.resolve(json(ChangesResponseSchema.parse({ changes, nextCursor })));
            }
            if (url.pathname === `${ARTIFACTS_PATH}/read` && method === 'POST') {
                const input = ArtifactReadBatchHttpInputV1Schema.safeParse(parseBody(init));
                if (!input.success) return Promise.resolve(json({ error: 'Invalid parameters' }, 400));
                return Promise.resolve(createArtifactReadBatchHttpResponse(input.data, artifactId => {
                    const row = rows.get(artifactId);
                    if (!row || !accessFor(row, callerAccountId)) return {
                        artifactId, ok: false, error: 'artifact_not_found', status: 404, retryable: false,
                    };
                    const readable = readableRow(row, callerAccountId);
                    if (!readable) return {
                        artifactId, ok: false, error: 'artifact_content_unavailable', status: 409, retryable: false,
                    };
                    return { artifactId, ok: true, artifact: readable,
                        recipientCensus: readable.encryptionMode === 'plain' ? null : recipientCensus(readable, readable.access) };
                }));
            }
            if (url.pathname === `${ARTIFACTS_PATH}/query-hints/batch` && method === 'POST') {
                const input = ArtifactKindWriteBatchInputV1Schema.safeParse(parseBody(init));
                if (!input.success) return Promise.resolve(json({ error: 'Invalid parameters' }, 400));
                return (async () => {
                    const items = [];
                    for (const { artifactId, ...hint } of input.data.items) {
                        const response = await update(callerAccountId, artifactId, hint);
                        const result: unknown = await response.json();
                        items.push(result && typeof result === 'object' && Reflect.get(result, 'success') === true
                            ? { artifactId, success: true as const }
                            : { artifactId, success: false as const, error: result && typeof result === 'object'
                                && typeof Reflect.get(result, 'error') === 'string' ? String(Reflect.get(result, 'error')) : 'artifact_update_failed' });
                    }
                    return json(ArtifactKindWriteBatchResponseV1Schema.parse({ items }));
                })();
            }
            if (url.pathname === ARTIFACTS_PATH && method === 'GET') {
                const inventory = [...rows.values()].flatMap(row => {
                    const readable = readableRow(row, callerAccountId);
                    return readable ? [readable] : [];
                });
                return Promise.resolve(createArtifactListHttpResponse(url, inventory));
            }
            if (path === ARTIFACTS_PATH) {
                if (method !== 'POST') return null;
                const response = create(callerAccountId, parseBody(init));
                if (!response.ok) return Promise.resolve(response);
                const hook = pendingAfterCreate;
                pendingAfterCreate = null;
                return Promise.resolve(hook?.()).then(() => response);
            }
            if (!path.startsWith(`${ARTIFACTS_PATH}/`)) return null;
            if (params.admitMemoryDecisionSource && method === 'POST') {
                const isCreate = url.pathname === `${ARTIFACTS_PATH}/memory-decision/create`;
                const target = /^\/v1\/artifacts\/([^/]+)\/memory-decision$/.exec(url.pathname);
                if (isCreate || target) {
                    const input = parseBody(init);
                    const source = CoordinationMessageRefV1Schema.safeParse(input?.memoryDecisionSource);
                    if (!source.success || !params.admitMemoryDecisionSource(source.data)) return Promise.resolve(json({ error: 'memory_decision_source_unavailable' }, 404));
                    if (!isCreate) return update(callerAccountId, decodeURIComponent(target![1]!), input);
                    const response = create(callerAccountId, input);
                    if (!response.ok) return Promise.resolve(response);
                    const hook = pendingAfterCreate;
                    pendingAfterCreate = null;
                    return Promise.resolve(hook?.()).then(() => response);
                }
            }
            const recipientTarget = /^\/v1\/artifacts\/([^/]+)\/access\/recipients$/.exec(url.pathname);
            if (recipientTarget && method === 'GET') {
                const row = rows.get(decodeURIComponent(recipientTarget[1]!));
                const access = row ? accessFor(row, callerAccountId) : null;
                if (!row || !access) return Promise.resolve(json({ error: 'artifact_not_found' }, 404));
                const plain = row.encryptionMode === 'plain';
                if (!plain && access !== 'owner') return Promise.resolve(json({ error: 'artifact_content_unavailable' }, 409));
                return Promise.resolve(json(recipientCensus(row, access)));
            }
            const grantsTarget = /^\/v1\/artifacts\/([^/]+)\/access\/grants$/.exec(url.pathname);
            if (grantsTarget && method === 'GET') {
                const row = rows.get(decodeURIComponent(grantsTarget[1]!));
                const access = row ? accessFor(row, callerAccountId) : null;
                return Promise.resolve(row && access ? json(ArtifactAccessGrantsListResponseV1Schema.parse({
                    artifactId: row.id, ownerAccountId: row.ownerAccountId, access, grants: [...(grants.get(row.id)?.values() ?? [])],
                })) : json({ error: 'artifact_not_found' }, 404));
            }
            if (grantsTarget && method === 'PUT') {
                const row = rows.get(decodeURIComponent(grantsTarget[1]!));
                if (!row || row.ownerAccountId !== callerAccountId) return Promise.resolve(json({ error: 'artifact_access_forbidden' }, 403));
                const input = ArtifactAccessGrantSetInputV1Schema.safeParse(parseBody(init));
                if (!input.success || input.data.artifactId !== row.id) return Promise.resolve(json({ error: 'Invalid parameters' }, 400));
                const selected = grants.get(row.id) ?? new Map<string, ArtifactAccessGrantRowV1>();
                const key = principalKey(input.data.principal);
                const previous = selected.get(key);
                const changed = previous?.accessLevel !== input.data.accessLevel;
                selected.set(key, { principal: input.data.principal, accessLevel: input.data.accessLevel,
                    createdByAccountId: previous?.createdByAccountId ?? callerAccountId, createdAt: previous?.createdAt ?? Date.now(),
                    display: { name: null, username: null } });
                grants.set(row.id, selected);
                if (changed) publish(row);
                return Promise.resolve(json(ArtifactAccessGrantMutationResponseV1Schema.parse({ artifactId: row.id,
                    ownerAccountId: row.ownerAccountId, access: 'owner', grants: [...selected.values()], changed })));
            }
            if (method === 'DELETE') {
                const target = /^\/v1\/artifacts\/([^/]+)(?:\/revision\/(\d+)\/(\d+))?$/.exec(url.pathname);
                const encodedArtifactId = target?.[1];
                if (!target || !encodedArtifactId) return null;
                const artifactId = decodeURIComponent(encodedArtifactId);
                if (!artifactId || artifactId.includes('/')) return null;
                const row = rows.get(artifactId);
                if (!row || row.ownerAccountId !== callerAccountId) return Promise.resolve(json({ error: 'Artifact not found' }, 404));
                if (target[2] !== undefined && (row.headerVersion !== Number(target[2]) || row.bodyVersion !== Number(target[3]))) {
                    return Promise.resolve(json({ error: 'version-mismatch' }, 409));
                }
                rows.delete(artifactId);
                publish(row);
                grants.delete(artifactId);
                return Promise.resolve(json({ success: true }));
            }
            const artifactId = decodeURIComponent(url.pathname.slice(ARTIFACTS_PATH.length + 1));
            if (!artifactId || artifactId.includes('/')) return null;
            if (method === 'GET') {
                const row = rows.get(artifactId);
                if (!row || !accessFor(row, callerAccountId)) return Promise.resolve(json({ error: 'Artifact not found' }, 404));
                const readable = readableRow(row, callerAccountId);
                return Promise.resolve(readable ? json(readable) : json({ error: 'artifact_content_unavailable' }, 409));
            }
            if (method === 'POST') return update(callerAccountId, artifactId, parseBody(init));
            return null;
        },
        read(artifactId: string): Artifact | null {
            const row = rows.get(artifactId);
            return row ? { ...row } : null;
        },
        replaceStoredRow(artifact: Artifact): void {
            const row = { ...artifact, ...(artifact.kind === undefined ? kindProjection(artifact.header, undefined) : {}) };
            rows.set(artifact.id, row);
            publish(row);
        },
        seedAccountGrant(artifactId: string, accountId: string, accessLevel: ArtifactAccessLevelV1): void {
            const row = rows.get(artifactId);
            if (!row || row.ownerAccountId === accountId) throw new Error('An Account grant needs an existing Artifact and a non-owner recipient');
            const selected = grants.get(artifactId) ?? new Map<string, ArtifactAccessGrantRowV1>();
            const key = principalKey({ kind: 'account', accountId });
            selected.set(key, { principal: { kind: 'account', accountId }, accessLevel,
                createdByAccountId: row.ownerAccountId, createdAt: selected.get(key)?.createdAt ?? Date.now(),
                display: { name: null, username: null } });
            grants.set(artifactId, selected);
            publish(row, [accountId]);
        },
        readGrants(artifactId: string): readonly ArtifactAccessGrantRowV1[] {
            return [...(grants.get(artifactId)?.values() ?? [])];
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
            for (const row of rows.values()) publish(row);
            rows.clear();
            grants.clear();
            pendingBeforeUpdate = null;
            pendingAfterCreate = null;
        },
    });
}

/** Real qualified client operations above the shared HTTP/CAS boundary. */
export async function createPlainArtifactHomeFixture(serverUrl: string, options?: Readonly<{
    accountId?: string;
    accountSettingsVersion?: number;
    /** Models the current authenticated Account instead of a retained legacy bearer. */
    currentAccount?: boolean;
    /** Optional real wire payload for feature-gated consumers using this Home fixture. */
    serverFeatures?: unknown;
    admitMemoryDecisionSource?: (source: CoordinationMessageRefV1) => boolean;
    /** Additional real Home HTTP routes needed by the consumer under test. */
    handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>;
    /** Public catalogs leave the Home; the caller supplies their HTTP boundary. */
    handleExternalRequest?: (url: string, init?: RequestInit) => Promise<Response | null>;
}>) {
    // Match the app entry's readiness graph before a captured Account lists
    // Artifacts. Keep the real foreground-acquisition owner in these journeys.
    await import('@/sync/syncEngine');
    const [{ TokenStorage }, { upsertServerProfileOnly, setActiveServer, getActiveServerSnapshot }, { storage }, { setRuntimeFetch, resetRuntimeFetch }, applied] = await Promise.all([
        import('@/auth/storage/tokenStorage'), import('@/sync/domains/server/serverRuntime'),
        import('@/sync/domains/state/storage'), import('@/utils/system/runtimeFetch'),
        import('@/sync/runtime/orchestration/appliedActiveServerRuntime'),
    ]);
    const accountId = options?.accountId ?? 'artifact-account';
    const token = `header.${encodeBase64(Buffer.from(JSON.stringify({ sub: accountId, ...(options?.currentAccount ? {
        provenance: AuthTokenProvenanceSchema.parse({ v: 1, kind: 'account', authority: 'present_user' }), tokenEpoch: 0,
    } : {}) })), 'base64url')}.signature`;
    const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'plain',
        admitMemoryDecisionSource: options?.admitMemoryDecisionSource });
    const requests: Readonly<{ path: string; method: string; projection?: 'headers' }>[] = [];
    setRuntimeFetch(async (input, init) => {
        const url = new URL(String(input));
        const path = `${url.pathname}${url.search}`;
        if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return json({});
        if (url.pathname === '/v1/features') return json(options?.serverFeatures ?? {});
        if (url.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 0 });
        if (url.pathname === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture({
            version: 0, updatedAt: 0, settingsVersion: options?.accountSettingsVersion,
        }));
        if (url.origin !== new URL(serverUrl).origin) {
            const response = await options?.handleExternalRequest?.(url.href, init);
            if (response) return response;
            throw new Error(`Unexpected Home ${url.origin}`);
        }
        const projection = url.pathname === `${ARTIFACTS_PATH}/read` && parseBody(init)?.projection === 'headers' ? 'headers' as const : undefined;
        requests.push({ path, method: init?.method ?? 'GET', ...(projection ? { projection } : {}) });
        const additional = await options?.handleRequest?.(path, init);
        if (additional) return additional;
        return await boundary.handle(path, init) ?? json({ error: 'not_found' }, 404);
    });
    const previousState = storage.getState();
    const previousApplied = applied.getAppliedActiveServerSnapshot();
    const previousAvailable = applied.isAppliedActiveServerRuntimeAvailable();
    let credentialWrite: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> = null;
    const restoreFixtureState = () => {
        resetRuntimeFetch();
        storage.setState(previousState, true);
        applied.publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
    };
    let home: Awaited<ReturnType<typeof upsertServerProfileOnly>>;
    try {
        home = await upsertServerProfileOnly({ serverUrl });
        credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(serverUrl, { serverId: home.id }, { token });
        if (!credentialWrite) throw new Error('Artifact Home credentials could not be stored');
        await setActiveServer({ serverId: home.id, scope: 'device' });
        // Explicit fixture inputs model an admitted plain Account/Home. This is
        // not a cold Sync bootstrap; credentials still traverse the real owner.
        storage.setState({ settingsScope: { serverId: home.id, accountId }, profileScope: { serverId: home.id, accountId },
            artifacts: {}, artifactsLoaded: false, artifactBrowserLoaded: false, artifactInboxLoaded: false, artifactInboxPartial: false,
            artifactInventoryKindsLoaded: [], artifactInventoryKindsPartial: [],
            artifactSkillRevisions: {}, artifactInventoryUnreadyCount: 0 });
        applied.publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
    } catch (error) {
        try { await credentialWrite?.rollback(); } finally { restoreFixtureState(); }
        throw error;
    }
    const fixtureCredentialWrite = credentialWrite;
    return {
        home, boundary, requests,
        /** Hydrate this focused Home from its real Account Settings wire reader, as Sync does. */
        async hydrateAccountSettings() {
            const [{ captureLazyActionAccountContext }, { readAccountSettingsBaseline }, { settingsParse }] = await Promise.all([
                import('@/sync/ops/actions/actionAccountContext'),
                import('@/sync/engine/settings/accountSettingsBaseline'),
                import('@/sync/domains/settings/settings'),
            ]);
            const account = await captureLazyActionAccountContext(home.id);
            try {
                const { accountMode, encryption } = await account.resolveAccountEncryption();
                const baseline = await readAccountSettingsBaseline({ request: account.request,
                    credentials: account.credentials, accountMode, encryption });
                account.assertCurrent();
                storage.setState({ settingsScope: account.accountLifetime.scope,
                    settings: settingsParse(baseline.raw), settingsVersion: baseline.version });
            } finally { account.dispose(); }
        },
        async dispose() {
            try { await fixtureCredentialWrite.rollback(); } finally { restoreFixtureState(); }
        },
    };
}
