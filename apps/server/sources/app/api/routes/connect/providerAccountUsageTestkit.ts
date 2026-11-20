import Fastify from "fastify";
import { vi } from "vitest";
import type { Tx } from "@/storage/inTx";
import * as storage from "@/storage/prisma";
import { observeSqliteRequests } from "@/testkit/observeSqliteRequests";
import type { ZodTypeProvider } from "fastify-type-provider-zod";

import { buildProviderAccountUsageRecordId, ProviderAccountUsageSnapshotV1Schema, type ProviderAccountUsageRecordKeyV1 } from '@happier-dev/protocol/connect/account-usage-primitives';
import { ConnectedServiceQuotaSnapshotV1Schema } from '@happier-dev/protocol/connect/connected-service-schemas';

import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { enableSchemaValidation } from "../../utils/enableSchemaValidation";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

export function createProviderAccountUsageTestApp() {
    const app = Fastify();
    enableSchemaValidation(app);
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-test-user-id"];
        if (typeof userId !== "string" || !userId) {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    return trackApp(typed);
}

export async function closeProviderAccountUsageTrackedApps(): Promise<void> {
    await closeTrackedApps();
}

export function createProviderAccountUsageRecordKey(
    overrides: Partial<ProviderAccountUsageRecordKeyV1> = {},
): ProviderAccountUsageRecordKeyV1 {
    return {
        providerId: "codex",
        accountSubjectId: "acct_provider_subject",
        subjectKind: "account",
        quotaScope: "account",
        ...overrides,
    };
}

export function createUsageSnapshot(params: Readonly<{
    fetchedAt: number;
    recordKey?: ProviderAccountUsageRecordKeyV1;
    serviceId?: string;
    profileId?: string;
    planLabel?: string | null;
    accountLabel?: string | null;
    diagnostics?: readonly unknown[];
    recoveryCredits?: unknown;
}> = { fetchedAt: Date.now() }) {
    const recordKey = params.recordKey ?? createProviderAccountUsageRecordKey();
    const serviceId = params.serviceId ?? "openai-codex";
    const profileId = params.profileId ?? "work";
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: recordKey.subjectKind === "unknown" ? "provisionalLocalSubject" : "providerSubject",
            id: recordKey.accountSubjectId,
            ...(recordKey.subjectKind === "unknown" ? { mergeKey: `${serviceId}:${profileId}` } : {}),
        },
        observedAtMs: params.fetchedAt,
        fetchedAtMs: params.fetchedAt,
        staleAfterMs: 60_000,
        source: "runtimeSignal",
        confidence: "confirmed",
        planLabel: params.planLabel ?? null,
        accountLabel: params.accountLabel ?? null,
        ...(params.recoveryCredits ? { recoveryCredits: params.recoveryCredits } : {}),
        meters: [
            {
                meterId: "weekly",
                label: "Weekly",
                used: 82,
                limit: 100,
                remaining: 18,
                remainingPct: 18,
                usedPct: 82,
                unit: "credits",
                utilizationPct: 82,
                resetsAt: null,
                status: "ok",
                limitScope: "account",
                confidence: "exact",
                details: { limitCategory: "usage_limit" },
            },
        ],
        ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    });
}

export function createV3ProviderAccountUsagePayload(params: Readonly<{
    snapshot: ReturnType<typeof createUsageSnapshot>;
    fingerprint?: string;
    status?: "ok" | "unavailable" | "estimated" | "error";
}>) {
    return {
        content: { t: "plain", v: params.snapshot },
        metadata: {
            fetchedAt: params.snapshot.fetchedAtMs,
            staleAfterMs: params.snapshot.staleAfterMs,
            status: params.status ?? "ok",
            ...(params.fingerprint ? { materialFingerprint: params.fingerprint } : {}),
        },
    };
}

export function createLegacyQuotaSnapshot(params: Readonly<{
    fetchedAt: number;
    serviceId?: string;
    profileId?: string;
    providerId?: string;
    activeAccountId?: string;
    planLabel?: string | null;
    remaining?: number;
}>) {
    const serviceId = params.serviceId ?? "openai-codex";
    const profileId = params.profileId ?? "work";
    const remaining = params.remaining ?? 58;
    return ConnectedServiceQuotaSnapshotV1Schema.parse({
        v: 1,
        serviceId,
        profileId,
        fetchedAt: params.fetchedAt,
        staleAfterMs: 60_000,
        planLabel: params.planLabel ?? "team",
        accountLabel: "work",
        providerId: params.providerId ?? "codex",
        activeAccountId: params.activeAccountId ?? "acct_legacy_connected_subject",
        fetchedAtMs: params.fetchedAt,
        staleAtMs: params.fetchedAt + 60_000,
        source: "provider_api",
        confidence: "exact",
        meters: [
            {
                meterId: "weekly",
                label: "Weekly",
                used: 100 - remaining,
                limit: 100,
                remaining,
                remainingPct: remaining,
                usedPct: 100 - remaining,
                unit: "credits",
                utilizationPct: 100 - remaining,
                resetsAt: null,
                status: "ok",
                limitScope: "account",
                confidence: "exact",
                details: { limitCategory: "usage_limit" },
            },
        ],
    });
}


/** Observe the actual SQLite history query and the later access to its captured payload. */
export function observeProviderAccountUsageHistory(
    onRead: (transactionId: string | undefined) => void,
    onDecode: (snapshotActive: boolean) => void,
): () => void {
    const snapshot = storage.withSqliteReadSnapshot;
    let snapshotActive = false;
    const factory = vi.spyOn(storage, "withSqliteReadSnapshot").mockImplementation(async function <T>(
        read: (reader: Tx) => Promise<T>, options?: Parameters<typeof snapshot>[1],
    ): Promise<T> {
        snapshotActive = true;
        try { return await snapshot(read, options); }
        finally { snapshotActive = false; }
    });
    const stop = observeSqliteRequests({ after(request, result) {
        const entries: unknown[] = request.model === "ProviderAccountUsageHistory" && request.action === "findMany" && Array.isArray(result)
            ? result : request.model === "ProviderAccountUsageRecord" && result !== null && typeof result === "object"
                && "history" in result && Array.isArray(result.history) ? result.history : [];
        for (const entry of entries) {
            if (entry === null || typeof entry !== "object" || !("payload" in entry)) continue;
            const payload = entry.payload;
            Object.defineProperty(entry, "payload", { get() {
                onDecode(snapshotActive);
                return payload;
            } });
        }
        if (entries.some(entry => entry !== null && typeof entry === "object" && "payload" in entry)) onRead(request.transactionId);
    } });
    return () => { stop(); factory.mockRestore(); };
}
