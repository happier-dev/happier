import {
    SESSION_DRAFT_SOCKET_EVENT,
    SessionDraftAddressV1Schema,
    SessionDraftStoredContentEnvelopeV1Schema,
    canonicalSessionDraftAddressV1,
    type SessionDraftAddressV1,
    type SessionDraftExpectedRevisionV1,
    type SessionDraftListResponseV1,
    type SessionDraftMutateResponseV1,
    type SessionDraftReadResponseV1,
    type SessionDraftRecordV1,
    type SessionDraftStoredContentEnvelopeV1,
    type AccountEncryptionMigrateSessionDraftsDirective,
} from '@happier-dev/protocol';

import { markAccountChanged } from '@/app/changes/markAccountChanged';
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from '@/app/encryption/accountEncryptionMode';
import { eventRouter } from '@/app/events/eventRouter';
import { mutateAccountScopedKvRowsInTx, type AccountScopedKvRow } from '@/app/kv/accountScopedKv';
import {
    ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES,
    ACCOUNT_SESSION_DRAFT_KV_PREFIX,
} from '@/app/kv/reservedAccountScopedKvRow';
import { db } from '@/storage/db';
import { afterTx, inTx, type Tx } from '@/storage/inTx';
import { sessionDraftContentMatchesAddress } from './sessionDraftAddressBinding';

export type SessionDraftMutationServiceResult = SessionDraftMutateResponseV1
    | Readonly<{ status: 'sessionUnavailable' }>
    | Readonly<{ status: 'invalidContentMode' }>
    | Readonly<{ status: 'invalidAddressBinding' }>;

export type SessionDraftAccountMigrationResult =
    | Readonly<{ status: 'updated'; records: SessionDraftRecordV1[] }>
    | Readonly<{ status: 'requiresUpgrade' }>
    | Readonly<{ status: 'incomplete' }>
    | Readonly<{ status: 'versionMismatch'; address: Extract<SessionDraftAddressV1, { kind: 'newSession' }>; currentRevision: number }>;

export const SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX = 'session-draft:';

export function sessionDraftPhysicalKey(address: SessionDraftAddressV1): string | null {
    const key = `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}${canonicalSessionDraftAddressV1(address)}`;
    return new TextEncoder().encode(key).byteLength <= ACCOUNT_SCOPED_KV_MAX_PERSISTED_KEY_UTF8_BYTES
        ? key
        : null;
}

function requireSessionDraftPhysicalKey(address: SessionDraftAddressV1): string {
    const key = sessionDraftPhysicalKey(address);
    if (!key) throw new Error('Session draft address exceeds the persisted key boundary');
    return key;
}

function parsePhysicalKey(key: string): SessionDraftAddressV1 | null {
    if (!key.startsWith(ACCOUNT_SESSION_DRAFT_KV_PREFIX)) return null;
    const logical = key.slice(ACCOUNT_SESSION_DRAFT_KV_PREFIX.length);
    if (logical.startsWith('new-session/')) {
        const parsed = SessionDraftAddressV1Schema.safeParse({ kind: 'newSession', draftId: logical.slice('new-session/'.length) });
        return parsed.success ? parsed.data : null;
    }
    if (!logical.startsWith('session/')) return null;
    try {
        const parsed = SessionDraftAddressV1Schema.safeParse({ kind: 'session', sessionId: decodeURIComponent(logical.slice('session/'.length)) });
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

function encodeContent(content: SessionDraftStoredContentEnvelopeV1 | null): Uint8Array<ArrayBuffer> | null {
    return content === null ? null : new TextEncoder().encode(JSON.stringify(content));
}

function decodeContent(value: Uint8Array | null): SessionDraftStoredContentEnvelopeV1 | null {
    if (value === null) return null;
    const parsed = SessionDraftStoredContentEnvelopeV1Schema.safeParse(JSON.parse(new TextDecoder().decode(value)));
    if (!parsed.success) throw new Error('Stored session draft content is malformed');
    return parsed.data;
}

function mapRow(row: AccountScopedKvRow, address?: SessionDraftAddressV1): SessionDraftRecordV1 {
    const resolvedAddress = address ?? parsePhysicalKey(row.key);
    if (!resolvedAddress) throw new Error('Stored session draft key is malformed');
    return {
        address: resolvedAddress,
        revision: row.version,
        content: decodeContent(row.value),
        createdAt: row.createdAt.getTime(),
        updatedAt: row.updatedAt.getTime(),
    };
}

async function resolveAddressMode(tx: Tx, accountId: string, address: SessionDraftAddressV1): Promise<'plain' | 'e2ee' | null> {
    if (address.kind === 'newSession') {
        const account = await tx.account.findUnique({
            where: { id: accountId },
            select: { publicKey: true, encryptionMode: true },
        });
        return account ? resolveEffectiveAccountEncryptionModeFromAccountRow(account) : null;
    }
    const session = await tx.session.findFirst({
        where: {
            id: address.sessionId,
            OR: [
                { accountId },
                { shares: { some: { sharedWithUserId: accountId } } },
            ],
        },
        select: { encryptionMode: true },
    });
    if (!session) return null;
    return session.encryptionMode === 'plain' ? 'plain' : 'e2ee';
}

function contentMatchesMode(content: SessionDraftStoredContentEnvelopeV1 | null, mode: 'plain' | 'e2ee'): boolean {
    return content === null || (mode === 'plain' ? content.t === 'plain' : content.t === 'encrypted');
}

async function publishDraftMutationInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; address: SessionDraftAddressV1; record: SessionDraftRecordV1 }>,
): Promise<void> {
    const status = params.record.content === null ? 'deleted' as const : 'present' as const;
    const hint = {
        v: 1 as const,
        sessionDraft: true as const,
        address: params.address,
        revision: params.record.revision,
        status,
    };
    await markAccountChanged(tx, {
        accountId: params.accountId,
        kind: 'account',
        entityId: `${SESSION_DRAFT_ACCOUNT_CHANGE_ENTITY_PREFIX}${canonicalSessionDraftAddressV1(params.address)}`,
        hint,
    });
    afterTx(tx, () => {
        eventRouter.emitEphemeral({
            userId: params.accountId,
            payload: { type: SESSION_DRAFT_SOCKET_EVENT, ...hint },
            recipientFilter: { type: 'user-scoped-only' },
        });
    });
}

export async function tombstoneSessionDraftForLifecycleInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string }>,
): Promise<boolean> {
    const parsedAddress = SessionDraftAddressV1Schema.safeParse({ kind: 'session', sessionId: params.sessionId });
    if (!parsedAddress.success) return false;
    const address = parsedAddress.data;
    const key = sessionDraftPhysicalKey(address);
    if (!key) return false;
    const current = await tx.userKVStore.findUnique({
        where: { accountId_key: { accountId: params.accountId, key } },
        select: { key: true, value: true, version: true, createdAt: true, updatedAt: true },
    });
    if (!current || current.value === null) return false;
    const mutation = await mutateAccountScopedKvRowsInTx(tx, {
        accountId: params.accountId,
        mutations: [{ key, value: null, expectedVersion: current.version }],
    });
    if (mutation.status !== 'updated') {
        throw new Error('Session draft lifecycle tombstone lost its transactional revision');
    }
    const record = mapRow(mutation.rows[0]!, address);
    await publishDraftMutationInTx(tx, { accountId: params.accountId, address, record });
    return true;
}

export async function migrateNewSessionDraftsForAccountModeInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        toMode: 'plain' | 'e2ee';
        directive?: AccountEncryptionMigrateSessionDraftsDirective;
    }>,
): Promise<SessionDraftAccountMigrationResult> {
    const rows = await tx.userKVStore.findMany({
        where: {
            accountId: params.accountId,
            key: { startsWith: `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}new-session/` },
            value: { not: null },
        },
        orderBy: { key: 'asc' },
        select: { key: true, value: true, version: true, createdAt: true, updatedAt: true },
    });
    if (!params.directive) {
        return rows.length === 0 ? { status: 'updated', records: [] } : { status: 'requiresUpgrade' };
    }

    const incomingByKey = new Map<string, AccountEncryptionMigrateSessionDraftsDirective['items'][number]>();
    for (const item of params.directive.items) {
        const key = requireSessionDraftPhysicalKey(item.address);
        if (incomingByKey.has(key)) return { status: 'incomplete' };
        if (!contentMatchesMode(item.content, params.toMode)) return { status: 'incomplete' };
        if (!sessionDraftContentMatchesAddress(item.content, item.address)) return { status: 'incomplete' };
        incomingByKey.set(key, item);
    }
    if (incomingByKey.size !== rows.length) return { status: 'incomplete' };
    for (const row of rows) {
        const item = incomingByKey.get(row.key);
        if (!item) return { status: 'incomplete' };
        if (item.expectedRevision !== row.version) {
            return { status: 'versionMismatch', address: item.address, currentRevision: row.version };
        }
    }
    if (rows.length === 0) return { status: 'updated', records: [] };

    const requireIncomingItem = (key: string): AccountEncryptionMigrateSessionDraftsDirective['items'][number] => {
        const item = incomingByKey.get(key);
        if (!item) throw new Error('Validated session draft migration coverage became incomplete');
        return item;
    };

    const mutation = await mutateAccountScopedKvRowsInTx(tx, {
        accountId: params.accountId,
        mutations: rows.map((row) => {
            const item = requireIncomingItem(row.key);
            return { key: row.key, value: encodeContent(item.content), expectedVersion: item.expectedRevision };
        }),
    });
    if (mutation.status === 'conflict') {
        for (const current of mutation.rows) {
            const item = incomingByKey.get(current.key);
            if (item && item.expectedRevision !== current.version) {
                return { status: 'versionMismatch', address: item.address, currentRevision: current.version };
            }
        }
        return { status: 'incomplete' };
    }
    const records: SessionDraftRecordV1[] = [];
    for (const row of mutation.rows) {
        const item = requireIncomingItem(row.key);
        const record = mapRow(row, item.address);
        records.push(record);
        await publishDraftMutationInTx(tx, {
            accountId: params.accountId,
            address: item.address,
            record,
        });
    }
    return { status: 'updated', records };
}

export async function readSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV1;
}>): Promise<SessionDraftReadResponseV1> {
    const mode = await inTx((tx) => resolveAddressMode(tx, params.accountId, params.address));
    if (!mode) return { status: 'absent' };
    const key = sessionDraftPhysicalKey(params.address);
    if (!key) return { status: 'absent' };
    const row = await db.userKVStore.findUnique({
        where: { accountId_key: { accountId: params.accountId, key } },
        select: { key: true, value: true, version: true, createdAt: true, updatedAt: true },
    });
    if (!row) return { status: 'absent' };
    const record = mapRow(row, params.address);
    return record.content === null ? { status: 'deleted', record } : { status: 'present', record };
}

export async function listSessionDrafts(params: Readonly<{
    accountId: string;
    after?: string;
    limit?: number;
}>): Promise<SessionDraftListResponseV1> {
    const limit = params.limit ?? 50;
    const collected: SessionDraftRecordV1[] = [];
    let afterPhysicalKey = params.after ? `${ACCOUNT_SESSION_DRAFT_KV_PREFIX}${params.after}` : undefined;
    while (collected.length <= limit) {
        const rows = await db.userKVStore.findMany({
            where: {
                accountId: params.accountId,
                key: {
                    startsWith: ACCOUNT_SESSION_DRAFT_KV_PREFIX,
                    ...(afterPhysicalKey ? { gt: afterPhysicalKey } : {}),
                },
                value: { not: null },
            },
            orderBy: { key: 'asc' },
            take: 100,
            select: { key: true, value: true, version: true, createdAt: true, updatedAt: true },
        });
        if (rows.length === 0) break;
        afterPhysicalKey = rows[rows.length - 1]!.key;
        const candidates = rows.map((row) => ({ row, address: parsePhysicalKey(row.key) })).filter(
            (candidate): candidate is { row: AccountScopedKvRow; address: SessionDraftAddressV1 } => candidate.address !== null,
        );
        const sessionIds = candidates.flatMap(({ address }) => address.kind === 'session' ? [address.sessionId] : []);
        const reachableSessions = sessionIds.length === 0 ? new Set<string>() : new Set((await db.session.findMany({
            where: {
                id: { in: sessionIds },
                OR: [
                    { accountId: params.accountId },
                    { shares: { some: { sharedWithUserId: params.accountId } } },
                ],
            },
            select: { id: true },
        })).map((session) => session.id));
        for (const { row, address } of candidates) {
            if (address.kind === 'session' && !reachableSessions.has(address.sessionId)) continue;
            collected.push(mapRow(row, address));
            if (collected.length > limit) break;
        }
        if (collected.length > limit || rows.length < 100) break;
    }
    const items = collected.slice(0, limit);
    const nextAfter = collected.length > limit && items.length > 0
        ? canonicalSessionDraftAddressV1(items[items.length - 1]!.address)
        : undefined;
    return { items, ...(nextAfter ? { nextAfter } : {}) };
}

export async function mutateSessionDraft(params: Readonly<{
    accountId: string;
    address: SessionDraftAddressV1;
    expectedRevision: SessionDraftExpectedRevisionV1;
    content: SessionDraftStoredContentEnvelopeV1 | null;
}>): Promise<SessionDraftMutationServiceResult> {
    return await inTx(async (tx) => {
        const mode = await resolveAddressMode(tx, params.accountId, params.address);
        if (!mode) return { status: 'sessionUnavailable' };
        if (!contentMatchesMode(params.content, mode)) return { status: 'invalidContentMode' };
        if (!sessionDraftContentMatchesAddress(params.content, params.address)) return { status: 'invalidAddressBinding' };
        const key = sessionDraftPhysicalKey(params.address);
        if (!key) return { status: 'sessionUnavailable' };

        const mutation = await mutateAccountScopedKvRowsInTx(tx, {
            accountId: params.accountId,
            mutations: [{
                key,
                value: encodeContent(params.content),
                expectedVersion: params.expectedRevision === 'absent' ? -1 : params.expectedRevision,
            }],
        });
        if (mutation.status === 'conflict') {
            const current = mutation.rows[0];
            return { status: 'conflict', current: current ? mapRow(current, params.address) : { status: 'absent' } };
        }

        const record = mapRow(mutation.rows[0]!, params.address);
        await publishDraftMutationInTx(tx, { accountId: params.accountId, address: params.address, record });
        return { status: 'updated', record };
    });
}
