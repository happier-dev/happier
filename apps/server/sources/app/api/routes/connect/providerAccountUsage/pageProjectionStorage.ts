import type { TransactionClient } from '@/storage/prisma';
import type { ProviderAccountUsagePageProjectionDemandV1Schema, ProviderAccountUsagePageProjectionWriteV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import type { z } from 'zod/mini';
import type { Prisma } from '@prisma/client';
import { StoredProviderAccountUsagePageProjectionV1Schema, ProviderAccountUsagePageProjectionMetadataV1Schema,
    type ProviderAccountUsagePageProjectionCoverageV1Schema, type ProviderAccountUsagePageProjectionPrefixReadV1Schema } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { ProviderAccountUsagePayloadInvariantError } from './types';
import { readProviderAccountUsageRecordWithCurrentGuard, updateProviderAccountUsageRecordMetadataIfCurrent } from './recordStorage';
import { isAccountScopedBlobCiphertextForKind } from '@happier-dev/protocol/crypto/accountScopedCipherEnvelope';
import { log } from '@/utils/logging/log';

type ProjectionStorage = Pick<TransactionClient, 'providerAccountUsageRecord' | 'providerAccountUsageHistory'>;
type ProjectionWrite = z.infer<typeof ProviderAccountUsagePageProjectionWriteV1Schema>;
type StoredProjection = z.infer<typeof StoredProviderAccountUsagePageProjectionV1Schema>;

export async function readProviderAccountUsagePageProjection(
    params: Readonly<{ accountId: string; recordId: string; projection?: z.infer<typeof ProviderAccountUsagePageProjectionDemandV1Schema>;
        heldProjection?: z.infer<typeof ProviderAccountUsagePageProjectionCoverageV1Schema> }>,
    storage: ProjectionStorage,
    admittedRecord?: Readonly<{ metadata?: unknown }>,
): Promise<{ projection: StoredProjection | null; complete: boolean; prefix?: z.infer<typeof ProviderAccountUsagePageProjectionPrefixReadV1Schema> }> {
    const missing = (reason: 'absent' | 'range' | 'prefix') => {
        // The HTTP null is deliberately unchanged. Record only the admission
        // branch: protected content and Account credentials never enter logs.
        log({ module: 'provider-account-usage', event: 'page_projection_read',
            recordId: params.recordId, range: params.projection?.range, reason });
        return { projection: null, complete: false };
    };
    const row = admittedRecord ?? await storage.providerAccountUsageRecord.findUnique({
        where: { accountId_recordId: { accountId: params.accountId, recordId: params.recordId } }, select: { metadata: true },
    });
    const metadata = row?.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('pageProjection' in metadata) || !metadata.pageProjection) return missing('absent');
    const parsed = ProviderAccountUsagePageProjectionMetadataV1Schema.safeParse(metadata.pageProjection);
    if (!parsed.success || !parsed.data) throw new ProviderAccountUsagePayloadInvariantError('Invalid B page projection');
    if (parsed.data.recordId !== params.recordId) throw new ProviderAccountUsagePayloadInvariantError('Invalid B page projection');
    const projection = parsed.data;
    // A document read validates its own stored range. A demand read additionally
    // checks coverage for the caller's range; both use this same prefix owner.
    const demand = params.projection ?? projection.demand;
    if (projection.demand.range.startAtMs > demand.range.startAtMs) return missing('range');
    // A changed prefix needs a full backfill. Appending only a tail would lose
    // a late/backdated accepted observation or retain a removed witness.
    if (!await hasAcceptedPrefix(params, projection, storage)) return missing('prefix');
    const frontier = projection.frontier;
    // The accepted prefix already proves the count through its frontier. Only
    // an observation after that frontier can make the requested range incomplete.
    // Bound the timestamp at the frontier as well as the tie-break predicate so
    // the existing record/time index can seek directly to the remaining tail.
    const tail = await storage.providerAccountUsageHistory.findFirst({ where: {
        accountId: params.accountId, recordId: params.recordId,
        observedAt: { gte: new Date(Math.max(projection.demand.range.startAtMs, frontier?.observedAtMs ?? projection.demand.range.startAtMs)),
            lt: new Date(Math.max(projection.demand.range.endAtMs, demand.range.endAtMs)) },
        ...(frontier ? { OR: [
            { observedAt: { gt: new Date(frontier.observedAtMs) } },
            { observedAt: new Date(frontier.observedAtMs), id: { gt: frontier.id } },
        ] } : {}),
    }, orderBy: [{ observedAt: 'asc' }, { id: 'asc' }], select: { id: true } });
    const complete = tail === null;
    const held = params.heldProjection;
    // Revalidate the caller's actual prefix, not merely the current writer's
    // frontier. Backdated/removed witnesses require the ordinary full read.
    const prefix = held && held.contentMode === projection.content.t
        && held.demand.range.startAtMs === projection.demand.range.startAtMs
        && held.observationCount <= projection.observationCount
        && (held.demand.range.endAtMs === projection.demand.range.endAtMs
            && sameCoverage(held, projection.observationCount, frontier
                ? { id: frontier.id, observedAt: new Date(frontier.observedAtMs) } : null)
            || await hasAcceptedPrefix(params, held, storage))
        ? { held, complete: complete && held.observationCount === projection.observationCount,
            published: { demand: projection.demand, frontier: projection.frontier,
                observationCount: projection.observationCount, contentMode: projection.content.t } }
        : undefined;
    return { projection, complete, ...(prefix ? { prefix } : {}) };
}

async function hasAcceptedPrefix(params: Readonly<{ accountId: string; recordId: string }>,
    value: Pick<ProjectionWrite, 'demand' | 'frontier' | 'observationCount'>, storage: ProjectionStorage) {
    const where = { accountId: params.accountId, recordId: params.recordId,
        observedAt: { gte: new Date(value.demand.range.startAtMs), lt: new Date(value.demand.range.endAtMs) },
        ...(value.frontier ? { OR: [
            { observedAt: { lt: new Date(value.frontier.observedAtMs) } },
            { observedAt: new Date(value.frontier.observedAtMs), id: { lte: value.frontier.id } },
        ] } : {}) };
    const [count, last] = await Promise.all([
        storage.providerAccountUsageHistory.count({ where }),
        storage.providerAccountUsageHistory.findFirst({ where, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true, observedAt: true } }),
    ]);
    return sameCoverage(value, count, last);
}

/** Called only after qualified source/Account-mode admission, in that transaction. */
export async function writeProviderAccountUsagePageProjection(
    params: Readonly<{ accountId: string; value: ProjectionWrite }>,
    storage: ProjectionStorage,
): Promise<StoredProjection | null> {
    const { value } = params;
    // Capture the parent before its history. Any later accepted observation or
    // metadata writer changes this same full-content guard before we publish.
    const captured = await readProviderAccountUsageRecordWithCurrentGuard({ accountId: params.accountId, recordId: value.recordId }, storage);
    if (!captured) return null;
    const where = { accountId: params.accountId, recordId: value.recordId,
        observedAt: { gte: new Date(value.demand.range.startAtMs), lt: new Date(value.demand.range.endAtMs) } };
    const [count, last] = await Promise.all([
        storage.providerAccountUsageHistory.count({ where }),
        storage.providerAccountUsageHistory.findFirst({ where, orderBy: [{ observedAt: 'desc' }, { id: 'desc' }], select: { id: true, observedAt: true } }),
    ]);
    if (!sameCoverage(value, count, last)) return null;
    const metadata = captured.rawMetadata && typeof captured.rawMetadata === 'object' && !Array.isArray(captured.rawMetadata) ? captured.rawMetadata : {};
    const retained = 'pageProjection' in metadata ? StoredProviderAccountUsagePageProjectionV1Schema.safeParse(metadata.pageProjection) : null;
    if (retained?.success && retained.data.encoding === value.encoding && retained.data.content.t === value.content.t
        && (retained.data.content.t === 'plain' || isAccountScopedBlobCiphertextForKind({
            kind: 'provider_account_usage_page_projection', ciphertext: retained.data.content.c }))) {
        // Accepted history determines the document. Ciphertext changes when
        // another client seals the same facts; it is not a material revision.
        if (retained.data.recordId === value.recordId
            && retained.data.demand.range.startAtMs === value.demand.range.startAtMs
            && retained.data.demand.range.endAtMs === value.demand.range.endAtMs
            && sameCoverage(retained.data, count, last)) return retained.data;
        const existing = await readProviderAccountUsagePageProjection({ accountId: params.accountId,
            recordId: value.recordId, projection: value.demand }, storage, { metadata: captured.rawMetadata });
        if (existing.complete && existing.projection) return existing.projection;
    }
    const updated = await updateProviderAccountUsageRecordMetadataIfCurrent({
        accountId: params.accountId, recordId: value.recordId,
        metadata: { ...metadata, pageProjection: value } as Prisma.InputJsonValue,
    }, captured.guard, storage);
    return updated ? value : null;
}

function sameCoverage(value: Pick<ProjectionWrite, 'observationCount' | 'frontier'>, count: number, last: { id: string; observedAt: Date } | null) {
    return count === value.observationCount && (last ? last.id === value.frontier?.id
        && last.observedAt.getTime() === value.frontier.observedAtMs : value.frontier === null);
}
