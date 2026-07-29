import { createHash } from 'node:crypto';

import {
    MAX_SESSION_SUBAGENT_CUSTODY_RECORDS,
    MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS,
    MAX_SESSION_SUBAGENT_CUSTODY_RETIRED_GENERATIONS,
    SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS,
    SessionSubagentCustodyListQueryV1Schema,
    SessionSubagentCustodyMutationRequestV1Schema,
    SessionSubagentCustodyRecordV1Schema,
    SessionSubagentCustodyRetirementRequestV1Schema,
    createSessionSubagentCustodyKeyV1,
    createSessionSubagentCustodyPlainContentFingerprintV1,
    isSessionSubagentStatusTransitionAllowed,
    isStoredContentKindAllowedForSessionByStoragePolicy,
    type SessionSubagentCustodyContentV1,
    type SessionSubagentCustodyMutationRequestV1,
    type SessionSubagentCustodyRecordV1,
    type SessionSubagentCustodyListQueryV1,
    type SessionSubagentCustodyRetirementRequestV1,
} from '@happier-dev/protocol';
import { readEncryptionFeatureEnv } from '@/app/features/catalog/readFeatureEnv';
import { resolveEncryptionWriteRejectionCode, type EncryptionPolicyRejectionCode } from '@/app/session/encryptionRejectionCodes';
import { checkSessionAccess } from '@/app/share/accessControl';
import { inTx, type Tx } from '@/storage/inTx';
import { isPrismaErrorCode } from '@/storage/prisma';

const RECEIPT_PRUNE_BATCH_SIZE = 256;

export type MutateSessionSubagentCustodyParams = Readonly<{
    actorUserId: string;
    sessionId: string;
    request: SessionSubagentCustodyMutationRequestV1;
}>;

export type MutateSessionSubagentCustodyResult =
    | { ok: true; replayed: boolean; record: SessionSubagentCustodyRecordV1 }
    | { ok: false; error: 'invalid-params' | 'session-not-found' | 'generation-retired' | 'idempotency-conflict' | 'capacity-exceeded' | 'cas-conflict' | 'terminal-regression' | 'internal'; code?: EncryptionPolicyRejectionCode };

type CustodyRow = Readonly<{
    id: string;
    subagentId: string;
    custodyKey: string;
    groupId: string | null;
    status: string;
    revision: number;
    content: unknown;
    createdAt: Date;
    updatedAt: Date;
    terminalAt: Date | null;
}>;

export type ListSessionSubagentCustodyResult =
    | { ok: true; records: SessionSubagentCustodyRecordV1[] }
    | { ok: false; error: 'invalid-params' | 'session-not-found' | 'generation-retired' | 'internal' };

export type RetireSessionSubagentCustodyGenerationResult =
    | { ok: true }
    | { ok: false; error: 'invalid-params' | 'session-not-found' | 'retirement-capacity-exceeded' | 'internal' };

type ReceiptRow = Readonly<{
    id: string;
    expiresAt: Date;
    requestDigest: string;
    resultSubagentId: string;
    resultGroupId: string | null;
    resultStatus: string;
    resultRevision: number;
    resultUpdatedAt: Date;
}>;

function toPublicRecord(row: CustodyRow): SessionSubagentCustodyRecordV1 | null {
    const parsed = SessionSubagentCustodyRecordV1Schema.safeParse({
        subagentId: row.subagentId,
        groupId: row.groupId,
        status: row.status,
        revision: row.revision,
        updatedAt: row.updatedAt.getTime(),
    });
    return parsed.success ? parsed.data : null;
}

function receiptRecord(row: ReceiptRow): SessionSubagentCustodyRecordV1 | null {
    return toPublicRecord({
        id: '',
        subagentId: row.resultSubagentId,
        custodyKey: '',
        groupId: row.resultGroupId,
        status: row.resultStatus,
        revision: row.resultRevision,
        content: null,
        createdAt: row.resultUpdatedAt,
        updatedAt: row.resultUpdatedAt,
        terminalAt: null,
    });
}

function requestDigest(request: SessionSubagentCustodyMutationRequestV1): string {
    const canonicalize = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonicalize);
        if (value && typeof value === 'object') {
            return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalize(child)]));
        }
        return value;
    };
    // CAS state is transport coordination, not operation meaning. A host retry after
    // adapter recreation must still find the immutable receipt for the same intent.
    const semanticRequest = {
        operationId: request.operationId,
        scope: request.scope,
        custodyKey: request.custodyKey,
        subagentId: request.subagentId,
        groupId: request.groupId,
        status: request.status,
        contentFingerprint: request.contentFingerprint,
        content: { t: request.content.t },
    };
    return createHash('sha256').update(JSON.stringify(canonicalize(semanticRequest)), 'utf8').digest('hex');
}

function identityDigest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function storagePolicyRejection(params: Readonly<{
    encryptionMode: unknown;
    content: SessionSubagentCustodyContentV1;
}>): EncryptionPolicyRejectionCode | null {
    const sessionEncryptionMode = params.encryptionMode === 'plain' ? 'plain' : 'e2ee';
    const storagePolicy = readEncryptionFeatureEnv(process.env).storagePolicy;
    const writeKind = params.content.t === 'plain' ? 'plain' : 'encrypted';
    if (isStoredContentKindAllowedForSessionByStoragePolicy(storagePolicy, sessionEncryptionMode, writeKind)) return null;
    return resolveEncryptionWriteRejectionCode({ storagePolicy, sessionEncryptionMode, writeKind });
}

function hasValidContentFingerprint(request: SessionSubagentCustodyMutationRequestV1): boolean {
    if (request.content.t === 'encrypted') return request.contentFingerprint.startsWith('hmac-sha256:');
    return request.contentFingerprint === createSessionSubagentCustodyPlainContentFingerprintV1(request.content.v);
}

function hasValidCustodyKey(params: Readonly<{
    sessionId: string;
    request: SessionSubagentCustodyMutationRequestV1 | SessionSubagentCustodyListQueryV1;
}>): boolean {
    const scope = 'scope' in params.request
        ? params.request.scope
        : {
            pluginId: params.request.pluginId,
            contributionId: params.request.contributionId,
            immutableGenerationId: params.request.immutableGenerationId,
        };
    return params.request.custodyKey === createSessionSubagentCustodyKeyV1({ ...scope, sessionId: params.sessionId });
}

async function pruneExpiredReceipts(tx: Tx, params: Readonly<{
    accountId: string;
    sessionId: string;
    now: Date;
}>): Promise<void> {
    const expired = await tx.sessionSubagentCustodyReceipt.findMany({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            expiresAt: { lte: params.now },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
        take: RECEIPT_PRUNE_BATCH_SIZE,
    });
    if (expired.length === 0) return;
    await tx.sessionSubagentCustodyReceipt.deleteMany({
        where: { id: { in: expired.map((row) => row.id) } },
    });
}

async function mutateInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    sessionId: string;
    request: SessionSubagentCustodyMutationRequestV1;
    digest: string;
    now: Date;
}>): Promise<MutateSessionSubagentCustodyResult> {
    const { tx, actorUserId, sessionId, request, digest, now } = params;
    if (!await checkSessionAccess(actorUserId, sessionId, tx)) return { ok: false, error: 'session-not-found' };
    const session = await tx.session.findUnique({ where: { id: sessionId }, select: { encryptionMode: true } });
    if (!session) return { ok: false, error: 'session-not-found' };
    if (!hasValidCustodyKey({ sessionId, request })) return { ok: false, error: 'invalid-params' };
    const retiredGeneration = await tx.sessionSubagentCustodyRetiredGeneration.findUnique({
        where: {
            accountId_pluginId_immutableGenerationId: {
                accountId: actorUserId,
                pluginId: request.scope.pluginId,
                immutableGenerationId: request.scope.immutableGenerationId,
            },
        },
        select: { id: true },
    });
    if (retiredGeneration) return { ok: false, error: 'generation-retired' };

    if (!hasValidContentFingerprint(request)) return { ok: false, error: 'invalid-params' };

    const rejectionCode = storagePolicyRejection({ encryptionMode: session.encryptionMode, content: request.content });
    if (rejectionCode) return { ok: false, error: 'invalid-params', code: rejectionCode };

    await pruneExpiredReceipts(tx, { accountId: actorUserId, sessionId, now });
    const receiptKey = {
        accountId: actorUserId,
        sessionId,
        custodyKey: request.custodyKey,
        operationId: request.operationId,
    };
    let existingReceipt = await tx.sessionSubagentCustodyReceipt.findUnique({
        where: { accountId_sessionId_custodyKey_operationId: receiptKey },
    }) as ReceiptRow | null;
    if (existingReceipt && existingReceipt.expiresAt <= now) {
        await tx.sessionSubagentCustodyReceipt.deleteMany({ where: { id: existingReceipt.id, expiresAt: { lte: now } } });
        existingReceipt = null;
    }
    if (existingReceipt) {
        if (existingReceipt.requestDigest !== digest) return { ok: false, error: 'idempotency-conflict' };
        const record = receiptRecord(existingReceipt);
        return record ? { ok: true, replayed: true, record } : { ok: false, error: 'internal' };
    }

    const receiptCount = await tx.sessionSubagentCustodyReceipt.count({
        where: { accountId: actorUserId, sessionId, custodyKey: request.custodyKey, expiresAt: { gt: now } },
    });
    if (receiptCount >= MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS) return { ok: false, error: 'capacity-exceeded' };
    const aggregateReceiptCount = await tx.sessionSubagentCustodyReceipt.count({
        where: { accountId: actorUserId, sessionId, expiresAt: { gt: now } },
    });
    if (aggregateReceiptCount >= MAX_SESSION_SUBAGENT_CUSTODY_RECEIPTS) return { ok: false, error: 'capacity-exceeded' };

    const recordKey = {
        accountId: actorUserId,
        sessionId,
        custodyKey: request.custodyKey,
        subagentKey: identityDigest(request.subagentId),
    };
    const existing = await tx.sessionSubagentCustody.findUnique({
        where: { accountId_sessionId_custodyKey_subagentKey: recordKey },
    }) as CustodyRow | null;

    let stored: CustodyRow;
    if (!existing) {
        if (request.expectedRevision !== null) return { ok: false, error: 'cas-conflict' };
        const recordCount = await tx.sessionSubagentCustody.count({
            where: { accountId: actorUserId, sessionId, custodyKey: request.custodyKey },
        });
        if (recordCount >= MAX_SESSION_SUBAGENT_CUSTODY_RECORDS) return { ok: false, error: 'capacity-exceeded' };
        const aggregateRecordCount = await tx.sessionSubagentCustody.count({
            where: { accountId: actorUserId, sessionId },
        });
        if (aggregateRecordCount >= MAX_SESSION_SUBAGENT_CUSTODY_RECORDS) return { ok: false, error: 'capacity-exceeded' };
        stored = await tx.sessionSubagentCustody.create({
            data: {
                ...recordKey,
                ...request.scope,
                subagentId: request.subagentId,
                groupId: request.groupId,
                status: request.status,
                revision: 0,
                content: request.content,
                terminalAt: ['completed', 'failed', 'aborted'].includes(request.status) ? now : null,
            },
        }) as CustodyRow;
    } else {
        if (request.expectedRevision !== existing.revision) return { ok: false, error: 'cas-conflict' };
        if (!isSessionSubagentStatusTransitionAllowed(existing.status, request.status)) {
            return { ok: false, error: 'terminal-regression' };
        }
        const nextRevision = existing.revision + 1;
        const terminalAt = ['completed', 'failed', 'aborted'].includes(request.status)
            ? (existing.terminalAt ?? now)
            : null;
        const updated = await tx.sessionSubagentCustody.updateMany({
            where: { ...recordKey, revision: existing.revision },
            data: { groupId: request.groupId, status: request.status, revision: nextRevision, content: request.content, terminalAt },
        });
        if (updated.count !== 1) return { ok: false, error: 'cas-conflict' };
        const reread = await tx.sessionSubagentCustody.findUnique({
            where: { accountId_sessionId_custodyKey_subagentKey: recordKey },
        }) as CustodyRow | null;
        if (!reread || reread.revision !== nextRevision) return { ok: false, error: 'internal' };
        stored = reread;
    }

    const record = toPublicRecord(stored);
    if (!record) return { ok: false, error: 'internal' };
    await tx.sessionSubagentCustodyReceipt.create({
        data: {
            ...receiptKey,
            ...request.scope,
            requestDigest: digest,
            resultSubagentId: record.subagentId,
            resultGroupId: record.groupId,
            resultStatus: record.status,
            resultRevision: record.revision,
            resultUpdatedAt: new Date(record.updatedAt),
            expiresAt: new Date(now.getTime() + SESSION_SUBAGENT_CUSTODY_RECEIPT_RETENTION_MS),
        },
    });
    return { ok: true, replayed: false, record };
}

export async function mutateSessionSubagentCustody(params: MutateSessionSubagentCustodyParams): Promise<MutateSessionSubagentCustodyResult> {
    const parsed = SessionSubagentCustodyMutationRequestV1Schema.safeParse(params.request);
    if (!params.actorUserId || !params.sessionId || !parsed.success) return { ok: false, error: 'invalid-params' };
    const request = parsed.data;
    const digest = requestDigest(request);
    try {
        return await inTx((tx) => mutateInTx({ tx, actorUserId: params.actorUserId, sessionId: params.sessionId, request, digest, now: new Date() }));
    } catch (error) {
        if (isPrismaErrorCode(error, 'P2002')) {
            try {
                const receipt = await inTx(async (tx) => {
                    if (!await checkSessionAccess(params.actorUserId, params.sessionId, tx)) return undefined;
                    return tx.sessionSubagentCustodyReceipt.findUnique({
                        where: {
                            accountId_sessionId_custodyKey_operationId: {
                                accountId: params.actorUserId,
                                sessionId: params.sessionId,
                                custodyKey: request.custodyKey,
                                operationId: request.operationId,
                            },
                        },
                    }) as Promise<ReceiptRow | null>;
                });
                if (receipt === undefined) return { ok: false, error: 'session-not-found' };
                if (!receipt || receipt.expiresAt <= new Date()) return { ok: false, error: 'cas-conflict' };
                if (receipt.requestDigest !== digest) return { ok: false, error: 'idempotency-conflict' };
                const record = receiptRecord(receipt);
                return record ? { ok: true, replayed: true, record } : { ok: false, error: 'internal' };
            } catch {
                return { ok: false, error: 'internal' };
            }
        }
        return { ok: false, error: 'internal' };
    }
}

export async function listSessionSubagentCustody(params: Readonly<{
    actorUserId: string;
    sessionId: string;
    query: SessionSubagentCustodyListQueryV1;
}>): Promise<ListSessionSubagentCustodyResult> {
    const parsed = SessionSubagentCustodyListQueryV1Schema.safeParse(params.query);
    if (!params.actorUserId || !params.sessionId || !parsed.success) return { ok: false, error: 'invalid-params' };
    if (!hasValidCustodyKey({ sessionId: params.sessionId, request: parsed.data })) return { ok: false, error: 'invalid-params' };
    try {
        const rows = await inTx(async (tx) => {
            if (!await checkSessionAccess(params.actorUserId, params.sessionId, tx)) return null;
            const retiredGeneration = await tx.sessionSubagentCustodyRetiredGeneration.findUnique({
                where: {
                    accountId_pluginId_immutableGenerationId: {
                        accountId: params.actorUserId,
                        pluginId: parsed.data.pluginId,
                        immutableGenerationId: parsed.data.immutableGenerationId,
                    },
                },
                select: { id: true },
            });
            if (retiredGeneration) return 'retired' as const;
            return tx.sessionSubagentCustody.findMany({
                where: {
                    accountId: params.actorUserId,
                    sessionId: params.sessionId,
                    custodyKey: parsed.data.custodyKey,
                    pluginId: parsed.data.pluginId,
                    contributionId: parsed.data.contributionId,
                    immutableGenerationId: parsed.data.immutableGenerationId,
                },
                orderBy: [{ subagentKey: 'asc' }],
                take: MAX_SESSION_SUBAGENT_CUSTODY_RECORDS,
            }) as Promise<CustodyRow[]>;
        });
        if (!rows) return { ok: false, error: 'session-not-found' };
        if (rows === 'retired') return { ok: false, error: 'generation-retired' };
        const records = rows.map(toPublicRecord);
        if (records.some((record) => record === null)) return { ok: false, error: 'internal' };
        return {
            ok: true,
            records: records as SessionSubagentCustodyRecordV1[],
        };
    } catch {
        return { ok: false, error: 'internal' };
    }
}

async function retireInTx(params: Readonly<{
    tx: Tx;
    actorUserId: string;
    request: SessionSubagentCustodyRetirementRequestV1;
}>): Promise<RetireSessionSubagentCustodyGenerationResult> {
    const { tx, actorUserId, request } = params;
    const generationKey = {
        accountId: actorUserId,
        pluginId: request.pluginId,
        immutableGenerationId: request.immutableGenerationId,
    };
    const existing = await tx.sessionSubagentCustodyRetiredGeneration.findUnique({
        where: { accountId_pluginId_immutableGenerationId: generationKey },
        select: { id: true },
    });
    if (!existing) {
        const retiredGenerationCount = await tx.sessionSubagentCustodyRetiredGeneration.count({
            where: { accountId: actorUserId },
        });
        if (retiredGenerationCount >= MAX_SESSION_SUBAGENT_CUSTODY_RETIRED_GENERATIONS) {
            return { ok: false, error: 'retirement-capacity-exceeded' };
        }
        await tx.sessionSubagentCustodyRetiredGeneration.create({
            data: { ...generationKey, capacitySlot: retiredGenerationCount },
        });
    }
    await tx.sessionSubagentCustodyReceipt.deleteMany({ where: generationKey });
    await tx.sessionSubagentCustody.deleteMany({ where: generationKey });
    return { ok: true };
}

/**
 * Durably fences one host-declared immutable plugin generation for exactly
 * the authenticated actor. No server-side generation ordering is inferred;
 * retries join the retained tombstone and stale writes fail closed.
 */
export async function retireSessionSubagentCustodyGeneration(params: Readonly<{
    actorUserId: string;
    request: SessionSubagentCustodyRetirementRequestV1;
}>): Promise<RetireSessionSubagentCustodyGenerationResult> {
    const parsed = SessionSubagentCustodyRetirementRequestV1Schema.safeParse(params.request);
    if (!params.actorUserId || !parsed.success) return { ok: false, error: 'invalid-params' };
    for (let attempt = 0; attempt <= MAX_SESSION_SUBAGENT_CUSTODY_RETIRED_GENERATIONS; attempt += 1) {
        try {
            return await inTx((tx) => retireInTx({
                tx,
                actorUserId: params.actorUserId,
                request: parsed.data,
            }));
        } catch (error) {
            // A concurrent different generation can claim the same next capacity
            // slot. Recount under a new transaction until this exact generation
            // joins its tombstone or the durable cap becomes visible.
            if (isPrismaErrorCode(error, 'P2002')) continue;
            return { ok: false, error: 'internal' };
        }
    }
    return { ok: false, error: 'internal' };
}
