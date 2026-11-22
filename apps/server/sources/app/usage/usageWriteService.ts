import { recordTeamCredentialAdmissionCountersInTx, refreshTeamCredentialUsageCountersInTx } from '@/app/teams/credentials/teamCredentialUsageCounters';
import { createHash, randomUUID } from "node:crypto";
import { BUNDLED_AGENT_CONTRIBUTION_IDENTITIES, isBundledAgentId } from '@happier-dev/agents/agent-ids';
import { parseQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { resolveBundledAgentIdFromContributionIdentity } from '@happier-dev/agents';
import { isDeepStrictEqual } from "node:util";
import type { UsageEventIngestRequest, UsageNativeAccountingSubject, UsageNativeHistoryDeleteRequest, UsageObservationCost, UsageObservationTokens } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { UsageEventIngestRequestSchema, UsageNativeAccountingSubjectSchema, readUsageAccountingMetadata } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import type { Prisma, UsageEvent } from "@prisma/client";
import { buildUsageEphemeral, eventRouter } from "@/app/events/eventRouter";
import { publishTeamCredentialUsageChangedInTx } from "./teamCredentialUsageInvalidation";
import { usageReportWritesCounter } from "@/app/monitoring/metrics/index";
import { afterTx, inTx, TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { db } from "@/storage/db";
import { requireDbProviderFromEnv } from "@/storage/prisma";
import { jsonPathEquals } from "@/storage/jsonPathFilter";
import { AsyncLock } from "@/utils/runtime/lock";
import { LegacyUsageReportDataSchema, legacyUsageReportAgentId, legacyUsageReportCanonicalOrder, readLegacyUsageReportKey } from "./legacyUsageReportSchema";
import {
    normalizeLegacyUsageCost,
    normalizeLegacyUsageTokens,
    subtractUsageCost,
    subtractUsageTokens,
    usageHasAnyValue,
} from "./usageMetrics";

export type LegacyUsageReportInput = Readonly<{
    accountId: string;
    key: string;
    sessionId: string | null;
    tokens: Record<string, number> & { total: number };
    cost: Record<string, number> & { total: number };
}>;

export type RecordLegacyUsageReportResult =
    | {
        ok: true;
        changed: boolean;
        report: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
        };
        usageEventId: string | null;
      }
    | {
        ok: false;
        error: 'invalid-params' | 'session-not-found';
      };

type UsageReportWriteMetric = Readonly<{
    scope: "account" | "session";
    result: "created" | "updated" | "unchanged" | "session_not_found";
}>;

type AccountLegacyUsageWriteLockState = {
    readonly lock: AsyncLock;
    refs: number;
};

const accountLegacyUsageWriteLocks = new Map<string, AccountLegacyUsageWriteLockState>();

async function inAccountLegacyUsageWriteLock<T>(
    params: Readonly<{ accountId: string; key: string }>,
    run: () => Promise<T>,
): Promise<T> {
    const lockKey = `${params.accountId}\0${params.key}`;
    let state = accountLegacyUsageWriteLocks.get(lockKey);
    if (!state) {
        state = { lock: new AsyncLock(), refs: 0 };
        accountLegacyUsageWriteLocks.set(lockKey, state);
    }
    state.refs += 1;
    try {
        return await state.lock.inLock(run);
    } finally {
        state.refs -= 1;
        if (state.refs === 0 && accountLegacyUsageWriteLocks.get(lockKey) === state) {
            accountLegacyUsageWriteLocks.delete(lockKey);
        }
    }
}

export type RecordUsageEventResult =
    | {
        ok: true;
        event: {
            id: string;
            createdAt: Date;
        };
      }
    | {
        ok: false;
        error: 'session-not-found' | 'machine-not-found' | 'invalid-params' | 'native-link-not-found';
      };

/** Internal-only authority for Team credential usage. Public Account ingest never accepts this shape. */
export type TeamCredentialUsageWriteAuthority =
    | Readonly<{
        kind: "teamCredentialAdmission";
        requestingAccountId: string;
        resourceId: string;
        externalApiKeyId: string | null;
        sourceCredentialId: string | null;
        workerMachineId: string | null;
        brokerMachineId: string | null;
        deliveryMode: "brokered" | "direct" | "external_api";
        executionRunId: string | null;
        groupIds: readonly string[];
    }>
    | Readonly<{
        kind: "teamCredentialExternalTerminal";
        admissionUsageEventId: string;
        requestingAccountId: string;
        resourceId: string;
        brokerMachineId: string;
    }>;

type SessionUsageAttribution = Readonly<{
    resourceId: string | null;
    actorAccountId: string | null;
    deliveryMode: string | null;
    sourceCredentialId: string | null;
    brokerMachineId: string | null;
    executionRunId: string | null;
}>;

const emptySessionUsageAttribution = (): SessionUsageAttribution => ({
    resourceId: null,
    actorAccountId: null,
    deliveryMode: null,
    sourceCredentialId: null,
    brokerMachineId: null,
    executionRunId: null,
});

// Lane 10 intentionally changes source schema/migration bytes without regenerating Prisma outputs.
// Keep temporary generated-client field access confined to this one provider-aware persistence seam.
async function accessUsageEventExecutionRunIdInTx(
    tx: Tx,
    operation: Readonly<
        | { kind: "read"; eventId: string }
        | { kind: "writeOnce"; eventId: string; executionRunId: string | null }
    >,
): Promise<string | null> {
    if (operation.kind === "writeOnce" && operation.executionRunId === null) return null;
    if (operation.kind === "writeOnce" && operation.executionRunId !== null) {
        const provider = requireDbProviderFromEnv(process.env, "postgres");
        const changed = provider === "mysql"
            ? await tx.$executeRaw`UPDATE UsageEvent SET executionRunId = ${operation.executionRunId} WHERE id = ${operation.eventId} AND executionRunId IS NULL`
            : await tx.$executeRaw`UPDATE "UsageEvent" SET "executionRunId" = ${operation.executionRunId} WHERE "id" = ${operation.eventId} AND "executionRunId" IS NULL`;
        if (changed === 1) return operation.executionRunId;
    }
    const provider = requireDbProviderFromEnv(process.env, "postgres");
    const rows = provider === "mysql"
        ? await tx.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT executionRunId FROM UsageEvent WHERE id = ${operation.eventId}
        `
        : await tx.$queryRaw<Array<{ executionRunId: string | null }>>`
            SELECT "executionRunId" FROM "UsageEvent" WHERE "id" = ${operation.eventId}
        `;
    const currentExecutionRunId = rows[0]?.executionRunId ?? null;
    if (operation.kind === "writeOnce" && currentExecutionRunId !== operation.executionRunId) {
        throw new Error("usage event execution run attribution changed during write");
    }
    return currentExecutionRunId;
}

async function resolveSessionUsageAttributionInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string; turnId: string | null }>,
): Promise<SessionUsageAttribution> {
    if (!params.turnId) return emptySessionUsageAttribution();
    const turn = await tx.sessionTurn.findUnique({
        where: { sessionId_turnId: { sessionId: params.sessionId, turnId: params.turnId } },
        select: {
            id: true,
            session: { select: { accountId: true } },
            usageActorAccountId: true,
            teamCredentialResourceId: true,
            credentialDeliveryMode: true,
        },
    });
    const turnAttribution = turn && turn.session.accountId === params.accountId
        ? {
            resourceId: turn.teamCredentialResourceId,
            actorAccountId: turn.usageActorAccountId,
            deliveryMode: turn.credentialDeliveryMode,
            executionRunId: null,
        }
        : null;
    // The authoritative turn witness carries no Team attribution, and every
    // admission row is written with a resource and actor, so no admission could
    // agree with it. Reading them would only re-derive the same nulls.
    if (turnAttribution && turnAttribution.resourceId === null) {
        return { ...turnAttribution, sourceCredentialId: null, brokerMachineId: null };
    }
    const admissions = await tx.usageEvent.findMany({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            turnId: params.turnId,
            source: "team_credential_admission",
            requestCount: { gt: 0 },
            ...(turnAttribution?.resourceId
                ? { teamCredentialResourceId: turnAttribution.resourceId }
                : {}),
        },
        select: {
            id: true,
            teamCredentialResourceId: true,
            teamCredentialActorAccountId: true,
            credentialDeliveryMode: true,
            teamCredentialSourceCredentialId: true,
            brokerMachineId: true,
            executionRunId: true,
        },
    });
    const first = admissions[0];
    if (!first) {
        return turnAttribution
            ? { ...turnAttribution, sourceCredentialId: null, brokerMachineId: null }
            : emptySessionUsageAttribution();
    }
    const admissionAttributionAgrees = admissions.every((candidate) => (
        candidate.teamCredentialResourceId === first.teamCredentialResourceId
        && candidate.teamCredentialActorAccountId === first.teamCredentialActorAccountId
        && candidate.credentialDeliveryMode === first.credentialDeliveryMode
    ));
    const sourceCredentialAgrees = admissions.every((candidate) => (
        candidate.teamCredentialSourceCredentialId === first.teamCredentialSourceCredentialId
    ));
    const brokerMachineAgrees = admissions.every((candidate) => (
        candidate.brokerMachineId === first.brokerMachineId
    ));
    const executionRunId = admissions.every((candidate) => candidate.executionRunId === first.executionRunId)
        ? first.executionRunId ?? null
        : null;
    if (!turnAttribution) {
        return admissionAttributionAgrees
            ? {
                resourceId: first.teamCredentialResourceId,
                actorAccountId: first.teamCredentialActorAccountId,
                deliveryMode: first.credentialDeliveryMode,
                sourceCredentialId: sourceCredentialAgrees ? first.teamCredentialSourceCredentialId : null,
                brokerMachineId: brokerMachineAgrees ? first.brokerMachineId : null,
                executionRunId,
            }
            : emptySessionUsageAttribution();
    }
    const matchingAdmissionsAgree = admissionAttributionAgrees
        && first.teamCredentialActorAccountId === turnAttribution.actorAccountId
        && first.credentialDeliveryMode === turnAttribution.deliveryMode;
    return {
        ...turnAttribution,
        sourceCredentialId: matchingAdmissionsAgree && sourceCredentialAgrees
            ? first.teamCredentialSourceCredentialId
            : null,
        brokerMachineId: matchingAdmissionsAgree && brokerMachineAgrees ? first.brokerMachineId : null,
        executionRunId: matchingAdmissionsAgree ? executionRunId : null,
    };
}

async function copyAdmissionGroupAttributionInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string; turnId: string; resourceId: string; usageEventId: string }>,
): Promise<void> {
    const admissions = await tx.usageEvent.findMany({
        where: {
            accountId: params.accountId,
            sessionId: params.sessionId,
            turnId: params.turnId,
            teamCredentialResourceId: params.resourceId,
            source: "team_credential_admission",
            requestCount: { gt: 0 },
        },
        select: { teamCredentialGroupAttributions: { select: { teamGroupId: true } } },
    });
    const admittedGroupIds = new Set(
        admissions.flatMap((admission) =>
            admission.teamCredentialGroupAttributions.map(({ teamGroupId }) => teamGroupId),
        ),
    );
    // One idempotent write per admitted Group, deliberately. The external-key
    // writer reaches this function with a `usageEvent.upsert` result, so two
    // concurrent reports carrying the same idempotency key arrive here with the
    // SAME `usageEventId`; the composite-key upsert is what makes the second one
    // a no-op instead of a unique-constraint violation that aborts a usage
    // transaction. A set-oriented `createMany` would need `skipDuplicates`,
    // which SQLite does not support, and a caught P2002 cannot be swallowed
    // inside a PostgreSQL transaction. N is the Groups containing the requester
    // on that resource.
    for (const teamGroupId of admittedGroupIds) {
        await tx.usageEventTeamCredentialGroupAttribution.upsert({
            where: { usageEventId_teamGroupId: { usageEventId: params.usageEventId, teamGroupId } },
            create: { usageEventId: params.usageEventId, teamGroupId },
            update: {},
        });
    }
}

export function buildTeamCredentialAdmissionIdempotencyKey(params: Readonly<{
    storageAccountId: string;
    resourceId: string;
    actorAccountId: string;
    externalApiKeyId: string | null;
    requestIdentity: string;
    source: string;
}>): string {
    const rawKey = JSON.stringify([
        params.storageAccountId,
        params.resourceId,
        params.actorAccountId,
        params.externalApiKeyId,
        params.requestIdentity,
        params.source,
    ]);
    const digest = createHash("sha256").update(rawKey).digest("hex");
    return `usage_event:v2:${digest}`;
}

type TeamCredentialAdmissionUsageIdentity = Readonly<{
    accountId: string;
    sessionId: string | null;
    turnId: string | null;
    externalKey: string;
    modelId?: string | null;
    authority: Omit<Extract<TeamCredentialUsageWriteAuthority, { kind: "teamCredentialAdmission" }>, "groupIds">;
}>;

type TeamCredentialAdmissionUsageEventRow = Readonly<{
    id: string;
    accountId: string;
    sessionId: string | null;
    turnId: string | null;
    externalKey: string | null;
    source: string;
    requestCount: number;
    modelId: string | null;
    machineId: string | null;
    brokerMachineId: string | null;
    teamCredentialResourceId: string | null;
    teamCredentialActorAccountId: string | null;
    teamCredentialExternalApiKeyId: string | null;
    teamCredentialSourceCredentialId: string | null;
    credentialDeliveryMode: string | null;
    executionRunId: string | null;
}>;

function isSameTeamCredentialAdmissionUsageIdentity(
    event: TeamCredentialAdmissionUsageEventRow,
    params: TeamCredentialAdmissionUsageIdentity,
): boolean {
    return event.accountId === params.accountId
        && event.sessionId === params.sessionId
        && event.turnId === params.turnId
        && event.externalKey === params.externalKey
        && event.source === "team_credential_admission"
        && event.requestCount === 1
        && event.modelId === (params.modelId ?? null)
        && event.machineId === params.authority.workerMachineId
        && event.brokerMachineId === params.authority.brokerMachineId
        && event.teamCredentialResourceId === params.authority.resourceId
        && event.teamCredentialActorAccountId === params.authority.requestingAccountId
        && event.teamCredentialExternalApiKeyId === params.authority.externalApiKeyId
        && event.teamCredentialSourceCredentialId === params.authority.sourceCredentialId
        && event.credentialDeliveryMode === params.authority.deliveryMode
        && event.executionRunId === params.authority.executionRunId;
}

/**
 * Reads an already-recorded admission through the writer's exact idempotency
 * identity. Admission calls this before evaluating today's limits so a retry
 * cannot be reclassified as a new denied request after its first dispatch.
 */
export async function resolveExistingTeamCredentialAdmissionUsageEventInTx(
    tx: Tx,
    params: TeamCredentialAdmissionUsageIdentity,
): Promise<Readonly<{ id: string; groupIds: readonly string[] }> | null> {
    const idempotencyKey = buildTeamCredentialAdmissionIdempotencyKey({
        storageAccountId: params.accountId,
        resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId,
        externalApiKeyId: params.authority.externalApiKeyId,
        requestIdentity: params.externalKey,
        source: "team_credential_admission",
    });
    const event = await tx.usageEvent.findUnique({
        where: { idempotencyKey },
        select: {
            id: true,
            accountId: true,
            sessionId: true,
            turnId: true,
            externalKey: true,
            source: true,
            requestCount: true,
            modelId: true,
            machineId: true,
            brokerMachineId: true,
            teamCredentialResourceId: true,
            teamCredentialActorAccountId: true,
            teamCredentialExternalApiKeyId: true,
            teamCredentialSourceCredentialId: true,
            credentialDeliveryMode: true,
            teamCredentialGroupAttributions: { select: { teamGroupId: true } },
        },
    });
    if (!event) return null;
    const eventWithExecutionRunId = {
        ...event,
        executionRunId: await accessUsageEventExecutionRunIdInTx(tx, { kind: "read", eventId: event.id }),
    };
    if (!isSameTeamCredentialAdmissionUsageIdentity(eventWithExecutionRunId, params)) {
        throw new Error("conflicting team credential usage admission fact");
    }
    return {
        id: event.id,
        groupIds: event.teamCredentialGroupAttributions.map(({ teamGroupId }) => teamGroupId).sort(),
    };
}

function toUsageEventCreateInput(
    accountId: string,
    request: UsageEventIngestRequest,
    attribution: SessionUsageAttribution = emptySessionUsageAttribution(),
    idempotencyKey = buildUsageEventIdempotencyKey(accountId, request),
    overlap?: NormalizedUsageOverlap,
) {
    return {
        accountId,
        sessionId: request.sessionId || request.subject?.linkedSessionId || null,
        observedAt: new Date(request.observedAt),
        agentId: request.agentId,
        backendMode: request.backendMode ?? null,
        modelId: request.modelId ?? null,
        projectKey: request.projectKey ?? null,
        workspaceId: request.workspaceId ?? null,
        machineId: request.subject?.machineId ?? readStoredNativeSubject(request.metadata)?.machineId ?? request.machineId ?? null,
        source: request.source,
        scope: request.scope,
        externalKey: request.externalKey ?? null,
        idempotencyKey,
        turnId: request.turnId ?? null,
        teamCredentialResourceId: attribution.resourceId,
        teamCredentialActorAccountId: attribution.actorAccountId,
        credentialDeliveryMode: attribution.deliveryMode,
        teamCredentialSourceCredentialId: attribution.sourceCredentialId,
        brokerMachineId: attribution.brokerMachineId,
        requestCount: 0,
        isCumulative: request.isCumulative,
        inputTokens: request.tokens.input,
        outputTokens: request.tokens.output,
        reasoningTokens: request.tokens.reasoning,
        cacheReadTokens: request.tokens.cacheRead,
        cacheWriteTokens: request.tokens.cacheWrite,
        totalTokens: request.tokens.total,
        reportedCostUsd: request.cost.reportedUsd,
        estimatedCostUsd: request.cost.estimatedUsd,
        invoiceCostUsd: request.cost.invoiceUsd ?? null,
        billingContext: request.cost.billingContext ?? null,
        costSource: request.cost.costSource ?? null,
        currency: request.cost.currency,
        costBreakdown: request.cost.breakdown ? JSON.stringify(request.cost.breakdown) : null,
        contextUsedTokens: request.context?.usedTokens ?? null,
        contextWindowTokens: request.context?.windowTokens ?? null,
        metadata: accountingMetadataForWrite(request, overlap),
    } satisfies Prisma.UsageEventUncheckedCreateInput;
}

function buildUsageEventIdempotencyKey(
    accountId: string,
    request: Readonly<{ sessionId?: string | null; subject?: UsageNativeAccountingSubject; source: string; externalKey?: string | null }>,
): string | null {
    if (!request.externalKey) {
        return null;
    }

    const rawKey = request.subject
        ? JSON.stringify([accountId, 'native', nativeSubjectKey(request.subject), request.source, request.externalKey])
        : JSON.stringify([accountId, request.sessionId, request.source, request.externalKey]);
    return hashUsageEventIdempotencyKey(rawKey);
}

function hashUsageEventIdempotencyKey(rawKey: string): string {
    const digest = createHash("sha256").update(rawKey).digest("hex");
    return `usage_event:v1:${digest}`;
}

function buildLegacyUsageEventIdempotencyKey(
    accountId: string,
    request: Pick<UsageEventIngestRequest, "sessionId" | "subject" | "source" | "externalKey">,
): string | null {
    if (request.subject || !request.externalKey) {
        return null;
    }

    return JSON.stringify([accountId, request.sessionId, request.source, request.externalKey]);
}

function nativeSubjectKey(subject: UsageNativeAccountingSubject): string {
    return JSON.stringify([subject.machineId, subject.agent.pluginId, subject.agent.localId, subject.sourceRootKey, subject.nativeSessionKey]);
}

function readStoredNativeSubject(metadata: unknown): UsageNativeAccountingSubject | null {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
    const parsed = UsageNativeAccountingSubjectSchema.safeParse(Reflect.get(metadata, 'accountingSubject'));
    return parsed.success ? parsed.data : null;
}

type NormalizedUsageOverlap = Readonly<{ nativeSessionKey: string; inferenceId?: string }>;

function normalizeUsageOverlap(accountId: string, request: UsageEventIngestRequest,
    subject: UsageNativeAccountingSubject | null): NormalizedUsageOverlap | undefined {
    const runtime = request.subject ? null : readUsageAccountingMetadata(request.metadata);
    const evidence = request.accounting ?? runtime;
    const machineId = subject?.machineId ?? request.machineId;
    if (!evidence?.nativeSessionKey || !machineId || (!request.subject && runtime?.path !== 'runtime')) return undefined;
    const agent = subject?.agent ?? (isBundledAgentId(request.agentId)
        ? BUNDLED_AGENT_CONTRIBUTION_IDENTITIES[request.agentId]
        : parseQualifiedPluginContributionKey(request.agentId));
    if (!agent) return undefined;
    return {
        nativeSessionKey: createHash('sha256').update(JSON.stringify([
            accountId, machineId, agent.pluginId, agent.localId, evidence.nativeSessionKey,
        ])).digest('hex'),
        ...(evidence.responseKey ? { inferenceId: evidence.responseKey } : {}),
    };
}

function accountingMetadataForWrite(request: UsageEventIngestRequest, overlap?: NormalizedUsageOverlap): Record<string, unknown> | null {
    const metadata = { ...request.metadata };
    delete metadata.usageAttribution;
    delete metadata.replayObservationId;
    if (request.attribution) metadata.usageAttribution = request.attribution;
    const subject = request.subject ?? readStoredNativeSubject(request.metadata);
    const runtime = readUsageAccountingMetadata(request.metadata);
    const { nativeSessionKey: _declaredSession, responseKey: _declaredResponse, ...runtimeEvidence } = runtime ?? {};
    if (runtime?.nativeSessionKey || runtime?.responseKey) metadata.usageAccounting = { ...runtimeEvidence, ...overlap };
    if (!subject) return Object.keys(metadata).length ? metadata : null;
    const inferenceId = request.subject ? request.accounting?.inferenceKey : runtime?.inferenceId;
    const evidence = request.subject ? (request.accounting ? {
        status: request.accounting.status,
        ...(request.accounting.historyComplete !== undefined ? { historyComplete: request.accounting.historyComplete } : {}),
        ...(request.accounting.asOfMs !== undefined ? { asOfMs: request.accounting.asOfMs } : {}),
        ...(request.accounting.counterEpoch !== undefined ? { counterEpoch: request.accounting.counterEpoch } : {}),
        ...(request.accounting.inputIncludesCache !== undefined ? { inputIncludesCache: request.accounting.inputIncludesCache } : {}),
        ...(request.accounting.outputIncludesReasoning !== undefined ? { outputIncludesReasoning: request.accounting.outputIncludesReasoning } : {}),
    } : undefined) : runtime ? runtimeEvidence : undefined;
    return {
        ...(request.subject ? {} : metadata),
        accountingSubject: subject,
        captureOrigin: request.subject ? 'native' : 'runtime',
        usageAccounting: {
            ...evidence,
            path: request.subject ? 'native' : 'runtime',
            status: evidence?.status ?? 'available',
            nativeSessionId: nativeSubjectKey(subject),
            ...(inferenceId !== undefined ? { inferenceId } : {}),
            ...overlap,
        },
    };
}

async function reconcileRuntimeUsageReplayInTx(tx: Tx, existing: UsageEvent, request: UsageEventIngestRequest,
    attribution: SessionUsageAttribution, replaySubject?: UsageNativeAccountingSubject, overlap?: NormalizedUsageOverlap): Promise<boolean> {
    const previousAccounting = readUsageAccountingMetadata(existing.metadata);
    const declaredAccounting = readUsageAccountingMetadata(request.metadata);
    const accounting = declaredAccounting && { ...declaredAccounting, ...overlap };
    const metadata = existing.metadata;
    if (replaySubject && previousAccounting?.path === 'runtime' && metadata && typeof metadata === 'object'
        && !Array.isArray(metadata) && !readStoredNativeSubject(metadata)) {
        // Enrich only identity evidence. The admitted measurements, attribution and source position are the original fact.
        const changed = await tx.usageEvent.updateMany({
            where: { id: existing.id, observedAt: existing.observedAt, metadata: { equals: metadata } },
            data: { metadata: {
                ...metadata,
                accountingSubject: replaySubject,
                captureOrigin: 'runtime',
                usageAccounting: {
                    ...previousAccounting,
                    status: accounting?.status ?? previousAccounting.status,
                    nativeSessionId: nativeSubjectKey(replaySubject),
                    ...(accounting?.inferenceId ? { inferenceId: accounting.inferenceId } : {}),
                    ...overlap,
                },
            } },
        });
        if (changed.count === 0) throw new TransactionReplayRequiredError('usage-runtime-order-changed');
        emitUsageEventAfterTransaction(tx, existing.accountId, request, overlap);
        return true;
    }
    const previous = previousAccounting?.path === 'runtime' ? previousAccounting.runtimeEventOrder : undefined;
    const order = accounting?.path === 'runtime' ? accounting.runtimeEventOrder : undefined;
    if (!previous || !order || previous.runtimeIncarnationId !== order.runtimeIncarnationId
        || order.sequence >= previous.sequence || request.observedAt > existing.observedAt.getTime()) return false;
    if ((['nativeSessionKey', 'inferenceId', 'counterEpoch', 'inputIncludesCache', 'outputIncludesReasoning'] as const)
        .some(key => !isDeepStrictEqual(previousAccounting?.[key], accounting?.[key]))
        || (!overlap && previousAccounting?.nativeSessionId !== accounting?.nativeSessionId)) return false;
    const next = toUsageEventCreateInput(existing.accountId, request, attribution, existing.idempotencyKey);
    if (Object.entries(next).some(([key, value]) => key !== 'observedAt' && key !== 'metadata'
        && !isDeepStrictEqual(Reflect.get(existing, key), value))) return false;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !('usageAccounting' in metadata)) return false;
    const rawAccounting = metadata.usageAccounting;
    if (!rawAccounting || typeof rawAccounting !== 'object' || Array.isArray(rawAccounting)) return false;
    // Replay keeps the original fact, including its attribution. Only the
    // earliest witnessed position and its real source instant can move back.
    const changed = await tx.usageEvent.updateMany({ where: {
        id: existing.id, observedAt: existing.observedAt, metadata: { equals: metadata },
    }, data: {
        observedAt: new Date(request.observedAt),
        metadata: { ...metadata, usageAccounting: { ...rawAccounting, runtimeEventOrder: order } },
    } });
    // ReadCommitted writers can race on the same duplicate. Reuse the owning
    // transaction's replay policy rather than replace a newer minimum order.
    if (changed.count === 0) throw new TransactionReplayRequiredError('usage-runtime-order-changed');
    emitUsageEventAfterTransaction(tx, existing.accountId, request, overlap);
    return true;
}

/**
 * The subject Machine is the Account's own, or the Machine its Session is bound to
 * (a Can-use member's Session hosted on another person's Machine).
 */
async function ensureNativeSubjectOwnedInTx(tx: Tx, accountId: string, subject: UsageNativeAccountingSubject,
    sessionId: string | undefined): Promise<boolean> {
    if (await tx.machine.findFirst({ where: { id: subject.machineId, accountId }, select: { id: true } })) return true;
    return sessionId !== undefined && Boolean(await tx.accessKey.findUnique({ where: { accountId_machineId_sessionId: {
        accountId, machineId: subject.machineId, sessionId } }, select: { sessionId: true } }));
}

async function hasNativeSessionLinkWitnessInTx(tx: Tx, accountId: string, subject: UsageNativeAccountingSubject,
    externalIdentityTag?: string): Promise<boolean> {
    if (!subject.linkedSessionId) return true;
    const session = await readOwnedUsageSessionInTx(tx, { accountId, sessionId: subject.linkedSessionId }, externalIdentityTag !== undefined);
    if (!session) return false;
    const candidate = await tx.usageEvent.findFirst({
        where: {
            accountId,
            sessionId: subject.linkedSessionId,
            machineId: subject.machineId,
            AND: [
                { metadata: jsonPathEquals(['captureOrigin'], 'runtime') },
                { metadata: jsonPathEquals(['accountingSubject', 'kind'], 'native') },
                { metadata: jsonPathEquals(['accountingSubject', 'machineId'], subject.machineId) },
                { metadata: jsonPathEquals(['accountingSubject', 'agent', 'pluginId'], subject.agent.pluginId) },
                { metadata: jsonPathEquals(['accountingSubject', 'agent', 'localId'], subject.agent.localId) },
                { metadata: jsonPathEquals(['accountingSubject', 'sourceRootKey'], subject.sourceRootKey) },
                { metadata: jsonPathEquals(['accountingSubject', 'nativeSessionKey'], subject.nativeSessionKey) },
            ],
        },
        select: { id: true },
    });
    return candidate !== null || (externalIdentityTag !== undefined && session.externalIdentityTag === externalIdentityTag);
}

export async function deleteNativeUsageHistory(accountId: string, request: UsageNativeHistoryDeleteRequest): Promise<Readonly<{ ok: true; deletedEventCount: number } | { ok: false; error: 'machine-not-found' }>> {
    return inTx(async (tx) => {
        if (!(await tx.machine.findFirst({ where: { id: request.machineId, accountId }, select: { id: true } }))) return { ok: false, error: 'machine-not-found' };
        const candidates = await tx.usageEvent.findMany({
            where: { accountId, machineId: request.machineId, observedAt: {
                ...(request.dateRange?.startMs !== undefined ? { gte: new Date(request.dateRange.startMs) } : {}),
                ...(request.dateRange?.endMs !== undefined ? { lte: new Date(request.dateRange.endMs) } : {}),
            } },
            select: { id: true, metadata: true, sessionId: true, teamCredentialResourceId: true, observedAt: true },
        });
        const ids = candidates.filter(({ metadata }) => {
            const subject = readStoredNativeSubject(metadata);
            return subject?.machineId === request.machineId && subject.sourceRootKey === request.sourceRootKey && metadata && typeof metadata === 'object' && Reflect.get(metadata, 'captureOrigin') === 'native';
        }).map(({ id }) => id);
        const deleted = ids.length ? await tx.usageEvent.deleteMany({ where: { accountId, id: { in: ids } } }) : { count: 0 };
        if (deleted.count > 0) await refreshTeamCredentialUsageCountersInTx(tx, {
            resourceIds: candidates.flatMap(row => row.teamCredentialResourceId ? [row.teamCredentialResourceId] : []),
            sessionIds: candidates.flatMap(row => {
                const sessionId = row.sessionId ?? readStoredNativeSubject(row.metadata)?.linkedSessionId;
                return sessionId ? [sessionId] : [];
            }),
            changedObservedAts: candidates.map(row => row.observedAt),
        });
        if (deleted.count > 0) afterTx(tx, () => eventRouter.emitEphemeral({
            userId: accountId,
            payload: buildUsageEphemeral(null, 'native_history_deleted', { total: 0 }, { total: 0 }, undefined, { sessionId: null }),
            recipientFilter: { type: 'user-scoped-only' },
        }));
        return { ok: true, deletedEventCount: deleted.count };
    });
}

function readOwnedUsageSessionInTx(
    tx: Tx,
    params: Readonly<{ accountId: string; sessionId: string }>,
    includeExternalIdentityTag = false,
) {
    return tx.session.findFirst({
        where: {
            id: params.sessionId,
            accountId: params.accountId,
        },
        select: { id: true, externalIdentityTag: includeExternalIdentityTag },
    });
}

async function ensureSessionOwnedByAccount(tx: Tx, params: Readonly<{ accountId: string; sessionId: string }>): Promise<boolean> {
    return Boolean(await readOwnedUsageSessionInTx(tx, params));
}

function buildLegacyDeltaRequest(
    params: Readonly<{
        key: string;
        sessionId: string | null;
        nextUsage: PrismaJson.UsageReportData;
        previousUsage: PrismaJson.UsageReportData | null;
        observedAtMs: number;
    }>,
): UsageEventIngestRequest | null {
    const nextTokens = normalizeLegacyUsageTokens(params.nextUsage.tokens);
    const previousTokens = normalizeLegacyUsageTokens(params.previousUsage?.tokens ?? {});

    const nextCost = normalizeLegacyUsageCost(params.nextUsage.cost);
    const previousCost = normalizeLegacyUsageCost(params.previousUsage?.cost ?? {});
    const treatAsReset = (nextTokens.total !== null && previousTokens.total !== null && nextTokens.total < previousTokens.total)
        || (nextCost.reportedUsd !== null && previousCost.reportedUsd !== null && nextCost.reportedUsd < previousCost.reportedUsd);
    const deltaTokens = treatAsReset ? nextTokens : subtractUsageTokens(nextTokens, previousTokens);
    const deltaCost = treatAsReset ? nextCost : subtractUsageCost(nextCost, previousCost);

    if (!usageHasAnyValue(deltaTokens, deltaCost)) {
        return null;
    }

    return {
        sessionId: params.sessionId ?? '',
        observedAt: params.observedAtMs,
        agentId: legacyUsageReportAgentId,
        backendMode: null,
        modelId: null,
        projectKey: null,
        workspaceId: null,
        machineId: null,
        source: 'legacy_usage_report',
        scope: 'turn_delta',
        externalKey: params.sessionId ? `${params.key}:${params.observedAtMs}` : null,
        turnId: null,
        isCumulative: false,
        tokens: deltaTokens,
        cost: deltaCost,
        context: undefined,
        metadata: {
            legacyKey: params.key,
            usageAccounting: { path: 'legacy', status: 'unknown', historyComplete: false, asOfMs: params.observedAtMs },
        },
    };
}

function knownUsageMeasurements(values: Readonly<Record<string, number | null | undefined>>): Record<string, number> {
    return Object.fromEntries(Object.entries(values).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

function toLegacyUsageEphemeralTokens(tokens: UsageObservationTokens): Record<string, number> {
    return knownUsageMeasurements(tokens);
}

function toLegacyUsageEphemeralCost(cost: UsageObservationCost): Record<string, number> {
    return knownUsageMeasurements({ total: cost.reportedUsd, reportedUsd: cost.reportedUsd,
        estimatedUsd: cost.estimatedUsd, invoiceUsd: cost.invoiceUsd });
}

function emitUsageEventAfterTransaction(
    tx: Tx,
    accountId: string,
    request: UsageEventIngestRequest,
    overlap?: NormalizedUsageOverlap,
): void {
    afterTx(tx, () => {
        eventRouter.emitEphemeral({
            userId: accountId,
            payload: buildUsageEphemeral(
                request.sessionId ?? request.subject?.linkedSessionId ?? null,
                `${request.agentId}:${request.modelId ?? 'unknown'}`,
                toLegacyUsageEphemeralTokens(request.tokens),
                toLegacyUsageEphemeralCost(request.cost),
                request.attribution?.source.kind === 'provider' ? {
                    providerConnectionId: request.attribution.source.providerConnectionId,
                    ...(request.machineId ? { machineId: request.machineId } : {}),
                } : undefined,
                // Native subjects and admitted opaque streams can change
                // the fold for an unlinked capture as well as this Session.
                request.sessionId && !overlap && !request.subject && request.metadata?.accountingSubject === undefined
                    ? { sessionId: request.sessionId, observedFromMs: request.observedAt }
                    : { sessionId: null },
            ),
            recipientFilter: { type: 'user-scoped-only' },
        });
    });
}

/** A Session observation attributed to a Team credential resource is also that resource's usage. */
async function publishAttributedUsageChangedInTx(
    tx: Tx,
    attribution: Readonly<{ resourceId: string | null; actorAccountId: string | null }>,
): Promise<void> {
    if (!attribution.resourceId || !attribution.actorAccountId) return;
    await publishTeamCredentialUsageChangedInTx(tx, {
        resourceId: attribution.resourceId,
        actorAccountId: attribution.actorAccountId,
    });
}

export async function recordUsageEvent(
    accountId: string,
    incoming: UsageEventIngestRequest,
): Promise<RecordUsageEventResult> {
    if (!UsageEventIngestRequestSchema.safeParse(incoming).success) return { ok: false, error: 'invalid-params' };
    const { nativeSessionLink, ...event } = incoming;
    return await inTx(async (tx) => {
        let request = event;
        if (request.sessionId && !(await ensureSessionOwnedByAccount(tx, { accountId, sessionId: request.sessionId }))) {
            return { ok: false, error: 'session-not-found' };
        }
        let subject = request.subject ?? readStoredNativeSubject(request.metadata);
        if (request.metadata?.accountingSubject !== undefined && !subject) return { ok: false, error: 'invalid-params' };
        if (subject) {
            if (request.agentId !== subject.agent.localId && request.agentId !== `${subject.agent.pluginId}/${subject.agent.localId}`) return { ok: false, error: 'invalid-params' };
            if (request.machineId && request.machineId !== subject.machineId) return { ok: false, error: 'invalid-params' };
            if (!(await ensureNativeSubjectOwnedInTx(tx, accountId, subject, request.sessionId ?? subject.linkedSessionId))) return { ok: false, error: 'machine-not-found' };
            if (request.subject?.linkedSessionId && !(await hasNativeSessionLinkWitnessInTx(tx, accountId, subject))) return { ok: false, error: 'native-link-not-found' };
            if (request.subject && !subject.linkedSessionId && nativeSessionLink?.externalIdentityTag
                && resolveBundledAgentIdFromContributionIdentity(subject.agent) === 'codex') {
                const candidate = { ...subject, linkedSessionId: nativeSessionLink.sessionId };
                if (await hasNativeSessionLinkWitnessInTx(tx, accountId, candidate, nativeSessionLink.externalIdentityTag)) {
                    subject = candidate;
                    request = { ...request, subject };
                }
            }
            if (request.sessionId && subject.linkedSessionId && subject.linkedSessionId !== request.sessionId) return { ok: false, error: 'invalid-params' };
        }
        const attribution = request.sessionId ? await resolveSessionUsageAttributionInTx(tx, {
            accountId,
            sessionId: request.sessionId,
            turnId: request.turnId ?? null,
        }) : emptySessionUsageAttribution();

        const refreshCounters = async (previous?: Pick<UsageEvent, 'sessionId' | 'teamCredentialResourceId' | 'observedAt'>) => {
            await refreshTeamCredentialUsageCountersInTx(tx, {
                changedObservedAts: [new Date(request.observedAt), ...(previous ? [previous.observedAt] : [])],
                resourceIds: [attribution.resourceId, previous?.teamCredentialResourceId]
                    .filter((id): id is string => Boolean(id)),
                sessionIds: [request.sessionId, subject?.linkedSessionId, previous?.sessionId]
                    .filter((id): id is string => Boolean(id)),
            });
        };
        const overlap = normalizeUsageOverlap(accountId, request, subject);
        if (request.externalKey) {
            const machineId = subject?.machineId ?? request.machineId;
            const runtimeAccounting = !request.subject && request.metadata?.replayObservationId === request.externalKey
                ? readUsageAccountingMetadata(request.metadata) : null;
            const replay = request.sessionId && machineId && runtimeAccounting?.path === 'runtime'
                && runtimeAccounting.nativeSessionId ? runtimeAccounting : null;
            const runtimeOverlap = request.sessionId && !replay ? overlap : undefined;
            const idempotencyKey = runtimeOverlap
                ? hashUsageEventIdempotencyKey(JSON.stringify([accountId, 'runtime-overlap', machineId,
                    request.sessionId, runtimeOverlap.nativeSessionKey, request.source,
                    runtimeOverlap.inferenceId ?? request.externalKey]))
                : replay
                    ? hashUsageEventIdempotencyKey(JSON.stringify([accountId, 'runtime', machineId, request.agentId,
                        request.sessionId, replay.nativeSessionId, request.source, request.externalKey]))
                    : buildUsageEventIdempotencyKey(accountId, request);
            // Remove the raw-key candidate after all pre-hash UsageEvent rows have aged out.
            const legacyIdempotencyKey = replay || runtimeOverlap ? null : buildLegacyUsageEventIdempotencyKey(accountId, request);
            const where = { idempotencyKey: { in: [idempotencyKey, legacyIdempotencyKey]
                .filter((key): key is string => key !== null) } };
            // The former runtime producer used the bound inference as its write key.
            const formerBoundKey = replay?.inferenceId && subject
                ? buildUsageEventIdempotencyKey(accountId, { ...request, externalKey: replay.inferenceId })
                : null;
            let existing: UsageEvent | null;
            if (formerBoundKey && subject) {
                const matching = await tx.usageEvent.findMany({ where: { OR: [where, {
                    idempotencyKey: formerBoundKey, agentId: request.agentId, machineId: subject.machineId,
                    metadata: jsonPathEquals(['usageAccounting', 'nativeSessionId'], nativeSubjectKey(subject)),
                }] } });
                existing = matching.find(row => row.idempotencyKey === idempotencyKey) ?? matching[0] ?? null;
            } else {
                existing = await tx.usageEvent.findFirst({ where });
            }
            if (existing) {
                // A native reader can observe late settlement of the same inference.
                // Its stable subject/key identifies one fact, not an append-only delta.
                if (request.subject) {
                    const next = toUsageEventCreateInput(accountId, request, attribution, idempotencyKey, overlap);
                    if (Object.entries(next).some(([key, value]) => !isDeepStrictEqual(Reflect.get(existing, key), value))) {
                        await tx.usageEvent.update({ where: { id: existing.id }, data: next });
                        await refreshCounters(existing);
                        emitUsageEventAfterTransaction(tx, accountId, request, overlap);
                    }
                } else if (await reconcileRuntimeUsageReplayInTx(tx, existing, request, attribution,
                    replay || runtimeOverlap ? subject ?? undefined : undefined, request.sessionId ? overlap : undefined)) {
                    await refreshCounters(existing);
                }
                return { ok: true, event: { id: existing.id, createdAt: existing.createdAt } };
            }

            const next = toUsageEventCreateInput(accountId, request, attribution, idempotencyKey, overlap);
            const created = await tx.usageEvent.upsert({
                where: {
                    idempotencyKey: idempotencyKey ?? "",
                },
                update: request.subject ? next : {},
                create: next,
            });
            if (!request.subject) await reconcileRuntimeUsageReplayInTx(tx, created, request, attribution,
                replay || runtimeOverlap ? subject ?? undefined : undefined, runtimeOverlap);
            await accessUsageEventExecutionRunIdInTx(tx, {
                kind: "writeOnce",
                eventId: created.id,
                executionRunId: attribution.executionRunId,
            });
            if (created && attribution.resourceId && attribution.actorAccountId && request.turnId && request.sessionId) {
                await copyAdmissionGroupAttributionInTx(tx, {
                    accountId,
                    sessionId: request.sessionId,
                    turnId: request.turnId,
                    resourceId: attribution.resourceId,
                    usageEventId: created.id,
                });
            }
            emitUsageEventAfterTransaction(tx, accountId, request, overlap);
            await refreshCounters();
            await publishAttributedUsageChangedInTx(tx, attribution);
            return { ok: true, event: { id: created.id, createdAt: created.createdAt } };
        }

        const created = await tx.usageEvent.create({
            data: toUsageEventCreateInput(accountId, request, attribution, undefined, overlap),
            select: { id: true, createdAt: true },
        });
        await accessUsageEventExecutionRunIdInTx(tx, {
            kind: "writeOnce",
            eventId: created.id,
            executionRunId: attribution.executionRunId,
        });
        if (attribution.resourceId && attribution.actorAccountId && request.turnId && request.sessionId) {
            await copyAdmissionGroupAttributionInTx(tx, {
                accountId,
                sessionId: request.sessionId,
                turnId: request.turnId,
                resourceId: attribution.resourceId,
                usageEventId: created.id,
            });
        }
        emitUsageEventAfterTransaction(tx, accountId, request, overlap);
        await refreshCounters();
        await publishAttributedUsageChangedInTx(tx, attribution);

        return { ok: true, event: created };
    });
}

/**
 * Writes the immutable request-count fact used by Team credential admission.
 * Entitlement and limit evaluation remain in the admission owner; this helper
 * deliberately has no public route and accepts only a server-created authority.
 */
export async function recordTeamCredentialAdmissionUsageEventInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        sessionId: string | null;
        turnId: string | null;
        observedAt: Date;
        externalKey: string;
        modelId?: string | null;
        authority: Extract<TeamCredentialUsageWriteAuthority, { kind: "teamCredentialAdmission" }>;
    }>,
): Promise<Readonly<{ id: string; created: boolean }>> {
    if (params.sessionId && !(await ensureSessionOwnedByAccount(tx, { accountId: params.accountId, sessionId: params.sessionId }))) {
        throw new Error("team credential usage session not found");
    }
    const source = "team_credential_admission";
    if (params.authority.externalApiKeyId !== null) {
        const externalApiKey = await tx.teamCredentialExternalApiKey.findFirst({
            where: {
                id: params.authority.externalApiKeyId,
                resourceId: params.authority.resourceId,
                membership: {
                    accountId: params.authority.requestingAccountId,
                    status: "active",
                },
            },
            select: { id: true },
        });
        if (!externalApiKey) throw new Error("team credential usage external key authority mismatch");
    }
    const idempotencyKey = buildTeamCredentialAdmissionIdempotencyKey({
        storageAccountId: params.accountId,
        resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId,
        externalApiKeyId: params.authority.externalApiKeyId,
        requestIdentity: params.externalKey,
        source,
    });
    const candidateId = randomUUID();
    const event = await tx.usageEvent.upsert({
        where: { idempotencyKey },
        update: {},
        create: {
            id: candidateId,
            accountId: params.accountId,
            sessionId: params.sessionId,
            observedAt: params.observedAt,
            agentId: "team_credential_broker",
            backendMode: null,
            modelId: params.modelId ?? null,
            projectKey: null,
            workspaceId: null,
            machineId: params.authority.workerMachineId,
            source,
            scope: "turn_delta",
            externalKey: params.externalKey,
            idempotencyKey,
            turnId: params.turnId,
            teamCredentialResourceId: params.authority.resourceId,
            teamCredentialActorAccountId: params.authority.requestingAccountId,
            teamCredentialExternalApiKeyId: params.authority.externalApiKeyId,
            teamCredentialSourceCredentialId: params.authority.sourceCredentialId,
            brokerMachineId: params.authority.brokerMachineId,
            credentialDeliveryMode: params.authority.deliveryMode,
            requestCount: 1,
            isCumulative: false,
            inputTokens: null,
            outputTokens: null,
            reasoningTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
            totalTokens: null,
            reportedCostUsd: null,
            estimatedCostUsd: null,
            invoiceCostUsd: null,
            billingContext: null,
            costSource: null,
            currency: "USD",
            costBreakdown: null,
            contextUsedTokens: null,
            contextWindowTokens: null,
            metadata: null,
        },
        select: {
            id: true,
            accountId: true,
            sessionId: true,
            turnId: true,
            externalKey: true,
            source: true,
            requestCount: true,
            modelId: true,
            machineId: true,
            brokerMachineId: true,
            teamCredentialResourceId: true,
            teamCredentialActorAccountId: true,
            teamCredentialExternalApiKeyId: true,
            teamCredentialSourceCredentialId: true,
            credentialDeliveryMode: true,
        },
    });
    const created = event.id === candidateId;
    if (created) {
        await accessUsageEventExecutionRunIdInTx(tx, {
            kind: "writeOnce",
            eventId: event.id,
            executionRunId: params.authority.executionRunId,
        });
    }
    if (!created) {
        const eventWithExecutionRunId = {
            ...event,
            executionRunId: await accessUsageEventExecutionRunIdInTx(tx, { kind: "read", eventId: event.id }),
        };
        if (!isSameTeamCredentialAdmissionUsageIdentity(eventWithExecutionRunId, params)) {
            throw new Error("conflicting team credential usage admission fact");
        }
        return { id: event.id, created: false };
    }
    const groupIds = Array.from(new Set(params.authority.groupIds.filter((id) => id.trim().length > 0)));
    if (groupIds.length > 0) {
        for (const teamGroupId of groupIds) {
            await tx.usageEventTeamCredentialGroupAttribution.upsert({
                where: { usageEventId_teamGroupId: { usageEventId: event.id, teamGroupId } },
                create: { usageEventId: event.id, teamGroupId },
                update: {},
            });
        }
    }
    if (params.authority.externalApiKeyId !== null) {
        const updatedKey = await tx.teamCredentialExternalApiKey.updateMany({
            where: {
                id: params.authority.externalApiKeyId,
                resourceId: params.authority.resourceId,
                membership: { accountId: params.authority.requestingAccountId, status: "active" },
            },
            data: { lastUsedAt: params.observedAt },
        });
        if (updatedKey.count !== 1) {
            throw new Error("team credential external key changed during usage admission");
        }
    }
    await recordTeamCredentialAdmissionCountersInTx(tx, {
        usageEventId: event.id, resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId, sessionId: params.sessionId,
        turnId: params.turnId, observedAt: params.observedAt,
        deliveryMode: params.authority.deliveryMode, groupIds,
    });
    await publishTeamCredentialUsageChangedInTx(tx, {
        resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId,
    });
    return { id: event.id, created: true };
}

/**
 * Records the optional public-external terminal measurement. Normal Sessions
 * never call this owner: their Agent observation remains the sole terminal
 * token/cost fact. Correlation is re-derived from the immutable admission row.
 */
export async function recordTeamCredentialExternalTerminalUsageEventInTx(
    tx: Tx,
    params: Readonly<{
        accountId: string;
        requestId: string;
        completedAt: Date;
        outcome: "succeeded" | "failed" | "cancelled";
        measurement: "reported" | "unavailable";
        modelId: string | null;
        tokens: UsageObservationTokens | null;
        cost: UsageObservationCost | null;
        authority: Extract<TeamCredentialUsageWriteAuthority, { kind: "teamCredentialExternalTerminal" }>;
    }>,
): Promise<Readonly<{ id: string; created: boolean }>> {
    const admission = await tx.usageEvent.findFirst({
        where: {
            id: params.authority.admissionUsageEventId,
            accountId: params.accountId,
            teamCredentialResourceId: params.authority.resourceId,
            teamCredentialActorAccountId: params.authority.requestingAccountId,
            brokerMachineId: params.authority.brokerMachineId,
            externalKey: params.requestId,
            source: "team_credential_admission",
            requestCount: 1,
            teamCredentialExternalApiKeyId: { not: null },
        },
        select: {
            id: true,
            teamCredentialExternalApiKeyId: true,
            teamCredentialSourceCredentialId: true,
            machineId: true,
            credentialDeliveryMode: true,
            teamCredentialGroupAttributions: { select: { teamGroupId: true } },
        },
    });
    if (!admission) throw new Error("team credential terminal usage admission mismatch");
    if (params.measurement === "reported" && params.tokens === null) {
        throw new Error("team credential reported terminal usage requires tokens");
    }
    const tokens = params.tokens ?? {
        input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null,
    };
    const tokenValues = [tokens.input, tokens.output, tokens.reasoning, tokens.cacheRead, tokens.cacheWrite, tokens.total];
    if (tokenValues.some((value) => value !== null && (!Number.isSafeInteger(value) || value < 0))) {
        throw new Error("invalid team credential terminal token usage");
    }
    const cost = params.cost;
    const costValues = cost ? [cost.reportedUsd, cost.estimatedUsd, cost.invoiceUsd] : [];
    if (costValues.some((value) => value != null && (!Number.isFinite(value) || value < 0))) {
        throw new Error("invalid team credential terminal cost usage");
    }
    const source = "team_credential_external_terminal";
    const idempotencyKey = buildTeamCredentialAdmissionIdempotencyKey({
        storageAccountId: params.accountId,
        resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId,
        externalApiKeyId: admission.teamCredentialExternalApiKeyId,
        requestIdentity: params.requestId,
        source,
    });
    const existing = await tx.usageEvent.findUnique({ where: { idempotencyKey } });
    const expected = {
        accountId: params.accountId,
        observedAt: params.completedAt,
        modelId: params.modelId,
        machineId: admission.machineId,
        externalKey: params.requestId,
        teamCredentialResourceId: params.authority.resourceId,
        teamCredentialActorAccountId: params.authority.requestingAccountId,
        teamCredentialExternalApiKeyId: admission.teamCredentialExternalApiKeyId,
        teamCredentialSourceCredentialId: admission.teamCredentialSourceCredentialId,
        brokerMachineId: params.authority.brokerMachineId,
        credentialDeliveryMode: admission.credentialDeliveryMode,
        inputTokens: tokens.input,
        outputTokens: tokens.output,
        reasoningTokens: tokens.reasoning,
        cacheReadTokens: tokens.cacheRead,
        cacheWriteTokens: tokens.cacheWrite,
        totalTokens: tokens.total,
        reportedCostUsd: cost?.reportedUsd ?? null,
        estimatedCostUsd: cost?.estimatedUsd ?? null,
        invoiceCostUsd: cost?.invoiceUsd ?? null,
        billingContext: cost?.billingContext ?? null,
        costSource: cost?.costSource ?? null,
        currency: cost?.currency ?? "USD",
        costBreakdown: cost?.breakdown ? JSON.stringify(cost.breakdown) : null,
        metadata: { v: 1, admissionUsageEventId: admission.id, outcome: params.outcome, measurement: params.measurement },
    };
    if (existing) {
        const comparable = {
            accountId: existing.accountId,
            observedAt: existing.observedAt,
            modelId: existing.modelId,
            machineId: existing.machineId,
            externalKey: existing.externalKey,
            teamCredentialResourceId: existing.teamCredentialResourceId,
            teamCredentialActorAccountId: existing.teamCredentialActorAccountId,
            teamCredentialExternalApiKeyId: existing.teamCredentialExternalApiKeyId,
            teamCredentialSourceCredentialId: existing.teamCredentialSourceCredentialId,
            brokerMachineId: existing.brokerMachineId,
            credentialDeliveryMode: existing.credentialDeliveryMode,
            inputTokens: existing.inputTokens,
            outputTokens: existing.outputTokens,
            reasoningTokens: existing.reasoningTokens,
            cacheReadTokens: existing.cacheReadTokens,
            cacheWriteTokens: existing.cacheWriteTokens,
            totalTokens: existing.totalTokens,
            reportedCostUsd: existing.reportedCostUsd,
            estimatedCostUsd: existing.estimatedCostUsd,
            invoiceCostUsd: existing.invoiceCostUsd,
            billingContext: existing.billingContext,
            costSource: existing.costSource,
            currency: existing.currency,
            costBreakdown: existing.costBreakdown,
            metadata: existing.metadata,
        };
        if (!isDeepStrictEqual(comparable, expected)) {
            throw new Error("conflicting team credential terminal usage fact");
        }
        return { id: existing.id, created: false };
    }
    const created = await tx.usageEvent.create({
        data: {
            ...expected,
            sessionId: null,
            agentId: "team_credential_broker",
            backendMode: null,
            projectKey: null,
            workspaceId: null,
            source,
            scope: "turn_delta",
            idempotencyKey,
            turnId: null,
            requestCount: 0,
            isCumulative: false,
            contextUsedTokens: null,
            contextWindowTokens: null,
        },
        select: { id: true },
    });
    // This branch owns a freshly created event, so its attribution rows cannot
    // collide with a concurrent writer the way the shared-`usageEventId`
    // admission upsert above deliberately tolerates. One statement writes them.
    if (admission.teamCredentialGroupAttributions.length > 0) {
        await tx.usageEventTeamCredentialGroupAttribution.createMany({
            data: admission.teamCredentialGroupAttributions.map(({ teamGroupId }) => ({
                usageEventId: created.id,
                teamGroupId,
            })),
        });
    }
    await refreshTeamCredentialUsageCountersInTx(tx, { resourceIds: [params.authority.resourceId],
        changedObservedAts: [params.completedAt],
    });
    await publishTeamCredentialUsageChangedInTx(tx, {
        resourceId: params.authority.resourceId,
        actorAccountId: params.authority.requestingAccountId,
    });
    return { id: created.id, created: true };
}

export async function recordLegacyUsageReport(
    params: LegacyUsageReportInput,
): Promise<RecordLegacyUsageReportResult> {
    const accountId = params.accountId.trim();
    const key = params.key.trim();
    const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim() ? params.sessionId : null;
    const scope = sessionId ? "session" : "account";
    let writeMetric: UsageReportWriteMetric | null = null;

    if (!accountId || !key || typeof params.tokens.total !== 'number' || typeof params.cost.total !== 'number') {
        return { ok: false, error: 'invalid-params' };
    }

    const write = async (): Promise<RecordLegacyUsageReportResult> => await inTx<RecordLegacyUsageReportResult>(async (tx) => {
        if (sessionId && !(await ensureSessionOwnedByAccount(tx, { accountId, sessionId }))) {
            writeMetric = { scope: "session", result: "session_not_found" };
            return { ok: false, error: 'session-not-found' };
        }

        let previous: {
            id: string;
            createdAt: Date;
            updatedAt: Date;
            data: Prisma.JsonValue;
        } | null = null;
        let removedDuplicateAccountReports = false;
        let duplicateAccountReportIds: string[] = [];

        if (sessionId) {
            previous = await tx.usageReport.findUnique({
                where: {
                    accountId_sessionId_key: {
                        accountId,
                        sessionId,
                        key,
                    },
                },
                select: { id: true, createdAt: true, updatedAt: true, data: true },
            });
        } else {
            const existingReports = await tx.usageReport.findMany({
                where: {
                    accountId,
                    sessionId: null,
                    key,
                },
                orderBy: legacyUsageReportCanonicalOrder,
                select: { id: true, createdAt: true, updatedAt: true, data: true },
            });
            const [survivor, ...duplicates] = existingReports;
            previous = survivor ?? null;
            duplicateAccountReportIds = duplicates.map(report => report.id);
        }

        if (duplicateAccountReportIds.length > 0) {
            await tx.usageReport.deleteMany({ where: { accountId, sessionId: null, key,
                id: { in: duplicateAccountReportIds } } });
            removedDuplicateAccountReports = true;
        }

        const usageData: PrismaJson.UsageReportData = {
            tokens: params.tokens,
            cost: params.cost,
        };

        if (previous && isDeepStrictEqual(previous.data, usageData)) {
            writeMetric = { scope, result: removedDuplicateAccountReports ? "updated" : "unchanged" };
            return {
                ok: true,
                changed: removedDuplicateAccountReports,
                report: {
                    id: previous.id,
                    createdAt: previous.createdAt,
                    updatedAt: previous.updatedAt,
                },
                usageEventId: null,
            };
        }

        const now = new Date();
        const report = sessionId
            ? await tx.usageReport.upsert({
                where: {
                    accountId_sessionId_key: {
                        accountId,
                        sessionId,
                        key,
                    },
                },
                update: {
                    data: usageData,
                    updatedAt: now,
                },
                create: {
                    accountId,
                    sessionId,
                    key,
                    data: usageData,
                },
                select: {
                    id: true,
                    createdAt: true,
                    updatedAt: true,
                },
            })
            : await (async () => {
                if (previous) {
                    return await tx.usageReport.update({
                        where: { id: previous.id },
                        data: {
                            data: usageData,
                            updatedAt: now,
                        },
                        select: {
                            id: true,
                            createdAt: true,
                            updatedAt: true,
                        },
                    });
                }
                return await tx.usageReport.create({
                    data: {
                        accountId,
                        sessionId: null,
                        key,
                        data: usageData,
                    },
                    select: {
                        id: true,
                        createdAt: true,
                        updatedAt: true,
                    },
                });
            })();

        const previousData = LegacyUsageReportDataSchema.safeParse(previous?.data);
        if (previous && previousData.success) {
            const bridges = await tx.usageEvent.findMany({
                where: { accountId, sessionId, source: 'legacy_usage_report' }, select: { metadata: true },
            });
            if (!bridges.some((bridge) => readLegacyUsageReportKey(bridge.metadata) === key)) {
                // A retained predecessor counter predates the append-only bridge.
                // Preserve it before writing the next delta; queries then retire
                // the raw-format read adapter for this key rather than add both.
                const baseline = buildLegacyDeltaRequest({ key, sessionId,
                    nextUsage: previousData.data, previousUsage: null,
                    observedAtMs: previous.updatedAt.getTime(),
                });
                if (baseline) {
                    await tx.usageEvent.create({ data: toUsageEventCreateInput(accountId, baseline) });
                }
            }
        }
        const deltaRequest = buildLegacyDeltaRequest({
            key,
            sessionId,
            nextUsage: usageData,
            previousUsage: previousData.success ? previousData.data : null,
            observedAtMs: report.updatedAt.getTime(),
        });

        let usageEventId: string | null = null;
        if (deltaRequest) {
            const created = await tx.usageEvent.create({
                data: toUsageEventCreateInput(accountId, deltaRequest),
                select: { id: true },
            });
            usageEventId = created.id;
        }


        if (sessionId) {
            await refreshTeamCredentialUsageCountersInTx(tx, { sessionIds: [sessionId], changedObservedAts: [] });
            afterTx(tx, () => {
                const usageEvent = buildUsageEphemeral(
                    sessionId,
                    key,
                    params.tokens,
                    params.cost,
                    undefined,
                    // Bridging a retained legacy report can also add its older baseline.
                    { sessionId },
                );
                eventRouter.emitEphemeral({
                    userId: accountId,
                    payload: usageEvent,
                    recipientFilter: { type: 'user-scoped-only' },
                });
            });
        }

        writeMetric = { scope, result: previous ? "updated" : "created" };
        return {
            ok: true,
            changed: true,
            report,
            usageEventId,
        };
    }, {
        // Sessionless reports read absence before inserting distinct report/delta rows.
        // The nullable sessionId unique key permits both inserts; the process-local
        // lock does not cover another server. SSI protects that absent-baseline predicate.
        isolationLevel: "Serializable",
    });
    const result = sessionId
        ? await write()
        : await inAccountLegacyUsageWriteLock({ accountId, key }, write);

    if (writeMetric) {
        usageReportWritesCounter.inc(writeMetric);
    }

    return result;
}
