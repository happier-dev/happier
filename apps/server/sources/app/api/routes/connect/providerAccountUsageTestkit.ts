import { createHash } from "node:crypto";

import Fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { createAppCloseTracker } from "../../testkit/appLifecycle";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

export type ProviderAccountUsageRecordKeyV1 = Readonly<{
    providerId: string;
    accountSubjectId: string;
    subjectKind: string;
    quotaScope: string;
    quotaScopeId?: string;
}>;

export function createProviderAccountUsageTestApp() {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
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

function canonicalKeyJson(key: ProviderAccountUsageRecordKeyV1): string {
    return JSON.stringify({
        providerId: key.providerId,
        accountSubjectId: key.accountSubjectId,
        subjectKind: key.subjectKind,
        quotaScope: key.quotaScope,
        ...(key.quotaScopeId ? { quotaScopeId: key.quotaScopeId } : {}),
    });
}

export function buildProviderAccountUsageTestRecordId(key: ProviderAccountUsageRecordKeyV1): string {
    return `paug_v1_${createHash("sha256").update(canonicalKeyJson(key)).digest("base64url")}`;
}

export function createUsageSnapshot(params: Readonly<{
    fetchedAt: number;
    recordKey?: ProviderAccountUsageRecordKeyV1;
    planLabel?: string | null;
    accountLabel?: string | null;
    diagnostics?: readonly unknown[];
}> = { fetchedAt: Date.now() }) {
    const recordKey = params.recordKey ?? {
        providerId: "codex",
        accountSubjectId: "acct_secret_provider_subject",
        subjectKind: "account",
        quotaScope: "account",
    };
    const recordId = buildProviderAccountUsageTestRecordId(recordKey);
    return {
        v: 1,
        recordId,
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: "providerSubject",
            id: recordKey.accountSubjectId,
        },
        aliases: [
            {
                kind: "connectedServiceProfile",
                providerId: recordKey.providerId,
                serviceId: "openai-codex",
                profileId: "work",
                accountSubjectId: recordKey.accountSubjectId,
            },
            {
                kind: "nativeCli",
                providerId: recordKey.providerId,
                localCredentialRef: "codex-home-main",
                accountSubjectId: recordKey.accountSubjectId,
            },
        ],
        observedAtMs: params.fetchedAt,
        fetchedAtMs: params.fetchedAt,
        staleAfterMs: 60_000,
        source: "runtimeSignal",
        confidence: "confirmed",
        planLabel: params.planLabel ?? null,
        accountLabel: params.accountLabel ?? null,
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
    };
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

export function createLegacyQuotaSnapshot(params: Readonly<{ fetchedAt: number }>) {
    return {
        v: 1,
        serviceId: "openai-codex",
        profileId: "work",
        fetchedAt: params.fetchedAt,
        staleAfterMs: 60_000,
        planLabel: "team",
        accountLabel: "work",
        providerId: "codex",
        activeAccountId: "acct_legacy_connected_subject",
        fetchedAtMs: params.fetchedAt,
        staleAtMs: params.fetchedAt + 60_000,
        source: "provider_api",
        confidence: "exact",
        meters: [
            {
                meterId: "weekly",
                label: "Weekly",
                used: 42,
                limit: 100,
                remaining: 58,
                remainingPct: 58,
                usedPct: 42,
                unit: "credits",
                utilizationPct: 42,
                resetsAt: null,
                status: "ok",
                limitScope: "account",
                confidence: "exact",
                details: { limitCategory: "usage_limit" },
            },
        ],
    };
}
