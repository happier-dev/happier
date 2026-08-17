import type {
    ConnectedServiceUsageSourceV1,
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    SealedConnectedServiceQuotaSnapshotV1,
    SealedProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";
import { readAccountScopedCiphertextKindByte } from "@happier-dev/protocol";
import { isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

import { inTx } from "@/storage/inTx";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import {
    createProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    updateProviderAccountUsageRecordIfCurrent,
} from "./recordStorage";
import type {
    LegacyQuotaCompatibilityProjection,
    ProviderAccountUsagePayloadMode,
    ProviderAccountUsageStatus,
} from "./types";
import { ProviderAccountUsagePayloadInvariantError } from "./types";

type ProviderAccountUsagePolicyClient = Pick<typeof import("@/storage/db").db, "account" | "providerAccountUsageRecord">
    | Pick<TransactionClient, "account" | "providerAccountUsageRecord">;

export type ProviderAccountUsageWritePolicyParams = Readonly<{
    accountId: string;
    recordId: ProviderAccountUsageRecordId;
    recordKey: ProviderAccountUsageRecordKeyV1;
    payloadMode: ProviderAccountUsagePayloadMode;
    status: Exclude<ProviderAccountUsageStatus, "refresh_requested">;
    fetchedAt: number;
    staleAfterMs: number;
    materialFingerprint?: string;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    legacyQuotaCompatibility?: Readonly<{
        source: Extract<
            ConnectedServiceUsageSourceV1,
            Readonly<{ bindingKind: "profile" }>
        >;
        sealed: SealedConnectedServiceQuotaSnapshotV1;
    }>;
    client?: ProviderAccountUsagePolicyClient;
}>;

type ProviderAccountUsageWritePolicyOverrides = Partial<Omit<ProviderAccountUsageWritePolicyParams, "client">> & Readonly<{
    refreshRequestedAt?: number;
    legacyQuotaCompatibilityProjections?: readonly LegacyQuotaCompatibilityProjection[];
}>;

function normalizeFingerprint(value: string | undefined): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function shouldClearRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt >= refreshRequestedAt;
}

function shouldPreserveRefreshRequest(refreshRequestedAt: number | undefined, fetchedAt: number): boolean {
    return refreshRequestedAt !== undefined && fetchedAt < refreshRequestedAt;
}

function isUniqueConstraintError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002");
}

function buildWriteParams(
    params: ProviderAccountUsageWritePolicyParams,
    overrides: ProviderAccountUsageWritePolicyOverrides = {},
) {
    const merged = { ...params, ...overrides };
    const metadata = {
        ...(merged.materialFingerprint
            ? { materialFingerprint: merged.materialFingerprint }
            : {}),
        ...(merged.legacyQuotaCompatibilityProjections?.length
            ? {
                legacyQuotaCompatibilityProjections:
                    merged.legacyQuotaCompatibilityProjections,
            }
            : {}),
    };
    return {
        accountId: merged.accountId,
        recordId: merged.recordId,
        recordKey: merged.recordKey,
        payloadMode: merged.payloadMode,
        status: merged.status,
        fetchedAt: merged.fetchedAt,
        staleAfterMs: merged.staleAfterMs,
        ...(merged.snapshot ? { snapshot: merged.snapshot } : {}),
        ...(merged.sealedPayload ? { sealedPayload: merged.sealedPayload } : {}),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
        ...(merged.refreshRequestedAt !== undefined ? { refreshRequestedAt: merged.refreshRequestedAt } : {}),
    };
}

function buildIncomingLegacyQuotaProjection(
    params: ProviderAccountUsageWritePolicyParams,
): LegacyQuotaCompatibilityProjection | null {
    return params.legacyQuotaCompatibility
        ? {
            source: params.legacyQuotaCompatibility.source,
            providerAccountUsageFetchedAt: params.fetchedAt,
            sealed: params.legacyQuotaCompatibility.sealed,
        }
        : null;
}

function legacyQuotaProjectionSourceKey(
    projection: LegacyQuotaCompatibilityProjection,
): string {
    return JSON.stringify([
        projection.source.serviceId,
        projection.source.profileId,
    ]);
}

function mergeLegacyQuotaProjection(
    existing: readonly LegacyQuotaCompatibilityProjection[],
    incoming: LegacyQuotaCompatibilityProjection,
): readonly LegacyQuotaCompatibilityProjection[] {
    const incomingKey = legacyQuotaProjectionSourceKey(incoming);
    return [
        ...existing.filter(
            (projection) =>
                legacyQuotaProjectionSourceKey(projection) !== incomingKey,
        ),
        incoming,
    ].sort((left, right) =>
        legacyQuotaProjectionSourceKey(left).localeCompare(
            legacyQuotaProjectionSourceKey(right),
        ));
}

function sameLegacyQuotaProjections(
    left: readonly LegacyQuotaCompatibilityProjection[],
    right: readonly LegacyQuotaCompatibilityProjection[],
): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function isHistoricalPauAliasReseal(params: Readonly<{
    existing: SealedProviderAccountUsageSnapshotV1 | undefined;
    incoming: SealedProviderAccountUsageSnapshotV1 | undefined;
}>): boolean {
    return Boolean(
        params.existing
        && params.incoming
        && params.existing.ciphertext !== params.incoming.ciphertext
        && readAccountScopedCiphertextKindByte(
            params.existing.ciphertext,
        ) === 5
        && readAccountScopedCiphertextKindByte(
            params.incoming.ciphertext,
        ) === 6,
    );
}

async function writeProviderAccountUsageRecordWithPolicyInClient(
    params: ProviderAccountUsageWritePolicyParams & Readonly<{ client: ProviderAccountUsagePolicyClient }>,
): Promise<"written" | "noop" | "stale"> {
    const account = await params.client.account.findUnique({
        where: { id: params.accountId },
        select: {
            publicKey: true,
            encryptionMode: true,
            contentPublicKey: true,
            contentPublicKeySig: true,
        },
    });
    const expectedMode = params.payloadMode === "plain_json_v1" ? "plain" : "e2ee";
    const currentness = account
        ? deriveAccountEncryptionCurrentnessFromRow(account)
        : null;
    if (
        currentness?.status !== "ready"
        || currentness.currentness.encryptionMode !== expectedMode
    ) {
        throw new ProviderAccountUsagePayloadInvariantError("Provider account usage payload mode does not match account storage mode");
    }
    const incomingFingerprint = normalizeFingerprint(params.materialFingerprint);
    const incomingLegacyQuotaProjection =
        buildIncomingLegacyQuotaProjection(params);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await readProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
        }, params.client);

        if (!existing) {
            try {
                await createProviderAccountUsageRecord(buildWriteParams(
                    params,
                    {
                        ...(incomingFingerprint
                            ? { materialFingerprint: incomingFingerprint }
                            : {}),
                        ...(incomingLegacyQuotaProjection
                            ? {
                                legacyQuotaCompatibilityProjections: [
                                    incomingLegacyQuotaProjection,
                                ],
                            }
                            : {}),
                    },
                ), params.client);
                return "written";
            } catch (error) {
                if (isUniqueConstraintError(error)) continue;
                throw error;
            }
        }

        const existingFingerprint = normalizeFingerprint(existing.metadata?.materialFingerprint);
        const existingFetchedAt = existing.fetchedAt ?? null;
        const isNewer = existingFetchedAt === null || params.fetchedAt > existingFetchedAt;
        const clearsRefreshRequest = shouldClearRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);
        const preservesRefreshRequest = shouldPreserveRefreshRequest(existing.refreshRequestedAt, params.fetchedAt);
        const existingLegacyQuotaProjections =
            existing.metadata?.legacyQuotaCompatibilityProjections ?? [];
        const nextLegacyQuotaProjections =
            isNewer
                ? incomingLegacyQuotaProjection
                    ? [incomingLegacyQuotaProjection]
                    : []
                : incomingLegacyQuotaProjection
                    ? mergeLegacyQuotaProjection(
                        existingLegacyQuotaProjections,
                        incomingLegacyQuotaProjection,
                    )
                    : existingLegacyQuotaProjections;
        const compatibilityProjectionChanged =
            !sameLegacyQuotaProjections(
                existingLegacyQuotaProjections,
                nextLegacyQuotaProjections,
            );
        const historicalAliasReseal =
            existingFingerprint === incomingFingerprint
            && existingFetchedAt === params.fetchedAt
            && params.payloadMode === "sealed_account_scoped_v1"
            && isHistoricalPauAliasReseal({
                existing: existing.sealedPayload,
                incoming: params.sealedPayload,
            });

        let nextWrite;
        let result: "written" | "noop" | "stale";
        if (!incomingFingerprint) {
            if (!isNewer) return "stale";
            nextWrite = buildWriteParams(params, {
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        } else if (existingFingerprint === incomingFingerprint) {
            if (
                !isNewer
                && !clearsRefreshRequest
                && !compatibilityProjectionChanged
                && !historicalAliasReseal
            ) return "noop";
            const preservedStatus = existing.status === "refresh_requested" ? params.status : existing.status;
            nextWrite = buildWriteParams(params, {
                status: isNewer ? params.status : preservedStatus,
                fetchedAt: isNewer ? params.fetchedAt : (existing.fetchedAt ?? params.fetchedAt),
                staleAfterMs: isNewer ? params.staleAfterMs : (existing.staleAfterMs ?? params.staleAfterMs),
                snapshot: params.payloadMode === "plain_json_v1"
                    ? (isNewer ? params.snapshot : existing.snapshot)
                    : undefined,
                sealedPayload: params.payloadMode === "sealed_account_scoped_v1"
                    ? (
                        isNewer || historicalAliasReseal
                            ? params.sealedPayload
                            : existing.sealedPayload
                    )
                    : undefined,
                materialFingerprint: incomingFingerprint,
                legacyQuotaCompatibilityProjections:
                    nextLegacyQuotaProjections,
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        } else {
            if (!isNewer) return "stale";
            nextWrite = buildWriteParams(params, {
                materialFingerprint: incomingFingerprint,
                legacyQuotaCompatibilityProjections:
                    nextLegacyQuotaProjections,
                ...(preservesRefreshRequest ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
            });
            result = "written";
        }

        const updated = await updateProviderAccountUsageRecordIfCurrent(nextWrite, {
            fetchedAt: existing.fetchedAt,
            ...(existing.refreshRequestedAt !== undefined ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        }, params.client);
        if (updated) return result;
    }

    throw new Error("Provider account usage write policy could not commit after concurrent changes");
}

export async function writeProviderAccountUsageRecordWithPolicy(
    params: ProviderAccountUsageWritePolicyParams,
): Promise<"written" | "noop" | "stale"> {
    if (params.client) {
        return await writeProviderAccountUsageRecordWithPolicyInClient({
            ...params,
            client: params.client,
        });
    }
    return await inTx(async (tx) => await writeProviderAccountUsageRecordWithPolicyInClient({
        ...params,
        client: tx,
    }));
}
