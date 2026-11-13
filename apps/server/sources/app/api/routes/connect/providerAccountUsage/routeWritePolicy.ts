import type {
    ProviderAccountUsageRecordId,
    ProviderAccountUsageRecordKeyV1,
    ProviderAccountUsageSnapshotV1,
    SealedProviderAccountUsageSnapshotV1,
} from "@happier-dev/protocol";
import {
    compareConnectedServiceQuotaObservationRecency,
    isConnectedServiceQuotaObservationAtOrBeforeNow,
    mergeProviderAccountSubscription,
    getProviderAccountUsageRefreshErrorAt,
    isProviderAccountUsageRefreshRequestSettled,
} from "@happier-dev/protocol";
import { isPrismaErrorCode, type TransactionClient } from "@/storage/prisma";

import { IN_TX_OPERATION_LABELS, inTx } from "@/storage/inTx";
import { resolveEffectiveAccountEncryptionModeFromAccountRow } from "@/app/encryption/accountEncryptionMode";
import {
    createProviderAccountUsageRecord,
    readProviderAccountUsageRecord,
    updateProviderAccountUsageRecordIfCurrent,
} from "./recordStorage";
import type { ProviderAccountUsagePayloadMode, ProviderAccountUsageStatus } from "./types";
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
    refreshErrorAt?: number;
    snapshot?: ProviderAccountUsageSnapshotV1;
    sealedPayload?: SealedProviderAccountUsageSnapshotV1;
    client?: ProviderAccountUsagePolicyClient;
}>;

type ProviderAccountUsageWritePolicyOverrides = Partial<Omit<ProviderAccountUsageWritePolicyParams, "client">> & Readonly<{
    refreshRequestedAt?: number;
}>;

function normalizeFingerprint(value: string | undefined): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isUniqueConstraintError(error: unknown): boolean {
    return isPrismaErrorCode(error, "P2002");
}

function buildWriteParams(
    params: ProviderAccountUsageWritePolicyParams,
    overrides: ProviderAccountUsageWritePolicyOverrides = {},
) {
    const merged = { ...params, ...overrides };
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
        ...((merged.materialFingerprint || merged.refreshErrorAt !== undefined) ? { metadata: {
            ...(merged.materialFingerprint ? { materialFingerprint: merged.materialFingerprint } : {}),
            ...(merged.refreshErrorAt !== undefined ? { refreshErrorAt: merged.refreshErrorAt } : {}),
        } } : {}),
        ...(merged.refreshRequestedAt !== undefined ? { refreshRequestedAt: merged.refreshRequestedAt } : {}),
    };
}

async function writeProviderAccountUsageRecordWithPolicyInClient(
    params: ProviderAccountUsageWritePolicyParams & Readonly<{ client: ProviderAccountUsagePolicyClient }>,
): Promise<"written" | "noop" | "stale"> {
    const nowMs = Date.now();
    if (!isConnectedServiceQuotaObservationAtOrBeforeNow({ observedAtMs: params.fetchedAt, nowMs })) {
        throw new ProviderAccountUsagePayloadInvariantError("Provider account usage observation time must not be in the future");
    }
    const snapshotErrorAt = params.snapshot ? getProviderAccountUsageRefreshErrorAt(params.snapshot) : undefined;
    if (params.refreshErrorAt !== undefined && (
        !Number.isSafeInteger(params.refreshErrorAt) || params.refreshErrorAt < 0 || params.refreshErrorAt > nowMs
        || params.status !== "error"
        || (params.payloadMode === "plain_json_v1" && snapshotErrorAt !== params.refreshErrorAt)
    )) {
        throw new ProviderAccountUsagePayloadInvariantError("Provider account usage refresh error must match a recorded failure outcome at or before now");
    }
    const account = await params.client.account.findUnique({
        where: { id: params.accountId },
        select: { publicKey: true, encryptionMode: true },
    });
    const expectedMode = params.payloadMode === "plain_json_v1" ? "plain" : "e2ee";
    if (!account || resolveEffectiveAccountEncryptionModeFromAccountRow(account) !== expectedMode) {
        throw new ProviderAccountUsagePayloadInvariantError("Provider account usage payload mode does not match account storage mode");
    }
    const incomingFingerprint = normalizeFingerprint(params.materialFingerprint);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const existing = await readProviderAccountUsageRecord({
            accountId: params.accountId,
            recordId: params.recordId,
        }, params.client);

        if (!existing) {
            try {
                await createProviderAccountUsageRecord(buildWriteParams(
                    params,
                    incomingFingerprint ? { materialFingerprint: incomingFingerprint } : {},
                ), params.client);
                return "written";
            } catch (error) {
                if (isUniqueConstraintError(error)) continue;
                throw error;
            }
        }

        const existingFingerprint = normalizeFingerprint(existing.metadata?.materialFingerprint);
        const existingFetchedAt = existing.fetchedAt ?? null;
        const isNewer = existingFetchedAt === null || compareConnectedServiceQuotaObservationRecency({
            existingObservedAtMs: existingFetchedAt,
            incomingObservedAtMs: params.fetchedAt,
            nowMs,
        }) === "incoming_newer";
        const existingErrorAt = existing.metadata?.refreshErrorAt;
        const advancesFailure = params.refreshErrorAt !== undefined
            && (params.refreshErrorAt > (existingFetchedAt ?? -1)
                || (params.refreshErrorAt === existingFetchedAt && params.fetchedAt === existingFetchedAt))
            && params.refreshErrorAt > (existingErrorAt ?? -1);
        const nextFetchedAt = isNewer ? params.fetchedAt : (existingFetchedAt ?? params.fetchedAt);
        const refreshErrorAt = advancesFailure ? params.refreshErrorAt
            : existingErrorAt !== undefined && (existingErrorAt > nextFetchedAt || (!isNewer && existingErrorAt === nextFetchedAt))
                ? existingErrorAt : undefined;
        const clearsRefreshRequest = isProviderAccountUsageRefreshRequestSettled({
            refreshRequestedAt: existing.refreshRequestedAt,
            fetchedAt: nextFetchedAt,
            refreshErrorAt,
        });

        const previousSubscription = existing.sealedPayload?.subscription;
        const incomingSubscription = params.sealedPayload?.subscription;
        const sealedSubscription = incomingSubscription && (!previousSubscription || incomingSubscription.observedAtMs > previousSubscription.observedAtMs)
            ? incomingSubscription
            : previousSubscription;
        const plainSubscription = mergeProviderAccountSubscription(existing.snapshot?.subscription, params.snapshot?.subscription);
        const subscriptionAdvanced = sealedSubscription !== previousSubscription
            || JSON.stringify(plainSubscription) !== JSON.stringify(existing.snapshot?.subscription);

        const sameFingerprint = incomingFingerprint !== undefined && existingFingerprint === incomingFingerprint;
        if (!isNewer && !subscriptionAdvanced && !advancesFailure && !clearsRefreshRequest) {
            return sameFingerprint ? "noop" : "stale";
        }
        const baseSnapshot = isNewer ? params.snapshot : existing.snapshot;
        const errorSnapshot = advancesFailure ? params.snapshot : existing.snapshot;
        const snapshot = baseSnapshot ? {
            ...baseSnapshot,
            ...(plainSubscription ? { subscription: plainSubscription } : {}),
            ...(refreshErrorAt !== undefined && errorSnapshot ? {
                state: "error_last_known_good" as const,
                diagnostics: errorSnapshot.diagnostics,
            } : {}),
        } : undefined;
        // Sealed payloads cannot be merged. Preserve the newest observation ciphertext;
        // the separately authenticated metadata records the refresh failure outcome.
        const baseSealedPayload = isNewer || (advancesFailure && params.fetchedAt === existingFetchedAt)
            ? params.sealedPayload : existing.sealedPayload;
        const sealedPayload = baseSealedPayload && sealedSubscription
            ? { ...baseSealedPayload, subscription: sealedSubscription }
            : baseSealedPayload;
        const nextWrite = buildWriteParams(params, {
            fetchedAt: nextFetchedAt,
            staleAfterMs: isNewer ? params.staleAfterMs : (existing.staleAfterMs ?? params.staleAfterMs),
            status: refreshErrorAt !== undefined ? "error" : isNewer || existing.status === "refresh_requested" ? params.status : existing.status,
            snapshot,
            sealedPayload,
            materialFingerprint: isNewer || (advancesFailure && params.fetchedAt === existingFetchedAt) ? incomingFingerprint : existingFingerprint,
            refreshErrorAt,
            ...(!clearsRefreshRequest && existing.refreshRequestedAt !== undefined ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        });

        const updated = await updateProviderAccountUsageRecordIfCurrent(nextWrite, {
            fetchedAt: existing.fetchedAt,
            metadata: existing.metadata,
            ...(existing.refreshRequestedAt !== undefined ? { refreshRequestedAt: existing.refreshRequestedAt } : {}),
        }, params.client);
        if (updated) return "written";
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
    }), { diagnostics: { operation: IN_TX_OPERATION_LABELS.providerAccountUsageWrite } });
}
