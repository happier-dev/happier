import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
    buildProviderAccountUsageRecordId,
    ProviderAccountUsageSnapshotV1Schema,
    type ConnectedServiceUsageSourceV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createProviderAccountUsageRecordKey,
} from "../providerAccountUsageTestkit";
import * as providerAccountUsageStorage from "./index";
import {
    linkConnectedServiceUsageSource,
    ConnectedServiceUsageSourceOwnershipError,
    deleteConnectedServiceUsageSourcesForGroup,
    deleteConnectedServiceUsageSourcesForGroupMember,
    readConnectedServiceQuotaView,
    readExactConnectedServiceUsageSource,
    readConnectedServiceUsageSource,
    requestConnectedServiceQuotaRefresh,
    requestProviderAccountUsageRefresh,
    ProviderAccountUsagePayloadInvariantError,
    readProviderAccountUsageRecord,
    unlinkConnectedServiceUsageSource,
    upsertConnectedServiceUsageSource,
    upsertProviderAccountUsageRecord,
    writeProviderAccountUsageRecord,
    writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource,
} from "./index";
import { writeProviderAccountUsageRecordWithPolicy } from "./routeWritePolicy";
import { mutateConnectedServiceCredential } from "../credentials/mutation";

async function createProfileBinding(params: Readonly<{
    accountId: string;
    serviceId?: string;
    profileId?: string;
    providerAccountId?: string | null;
    providerOrganizationId?: string;
}>): Promise<void> {
    await db.serviceAccountToken.create({
        data: {
            accountId: params.accountId,
            vendor: params.serviceId ?? "openai-codex",
            profileId: params.profileId ?? "work",
            token: Buffer.from(`token:${params.serviceId ?? "openai-codex"}:${params.profileId ?? "work"}`, "utf8"),
            metadata: {
                kind: "oauth",
                ...(params.providerOrganizationId ? { providerOrganizationId: params.providerOrganizationId } : {}),
                ...(params.providerAccountId === null
                    ? {}
                    : { providerAccountId: params.providerAccountId ?? "acct_provider_subject" }),
            },
        },
    });
}

async function createGroupMemberBinding(params: Readonly<{
    accountId: string;
    serviceId?: string;
    profileId?: string;
    groupId?: string;
    generation?: number;
}>): Promise<void> {
    const serviceId = params.serviceId ?? "openai-codex";
    const profileId = params.profileId ?? "work";
    const groupId = params.groupId ?? "team";
    const generation = params.generation ?? 7;

    await createProfileBinding({
        accountId: params.accountId,
        serviceId,
        profileId,
    });

    const group = await db.connectedServiceAuthGroup.create({
        data: {
            accountId: params.accountId,
            vendor: serviceId,
            groupId,
            displayName: "Team",
            policyJson: "{}",
            activeProfileId: profileId,
            generation,
        },
        select: { id: true },
    });

    await db.connectedServiceAuthGroupMember.create({
        data: {
            groupDbId: group.id,
            accountId: params.accountId,
            vendor: serviceId,
            groupId,
            profileId,
            priority: 1,
            enabled: true,
        },
    });
}

function createUsageSnapshot(params: Readonly<{
    fetchedAt: number;
    recordKey?: ReturnType<typeof createProviderAccountUsageRecordKey>;
    planLabel?: string | null;
    accountLabel?: string | null;
}>): ReturnType<typeof ProviderAccountUsageSnapshotV1Schema.parse> {
    const recordKey = params.recordKey ?? createProviderAccountUsageRecordKey();
    return ProviderAccountUsageSnapshotV1Schema.parse({
        v: 1,
        recordId: buildProviderAccountUsageRecordId(recordKey),
        recordKey,
        providerId: recordKey.providerId,
        accountSubject: {
            kind: recordKey.subjectKind === "unknown" ? "provisionalLocalSubject" : "providerSubject",
            id: recordKey.accountSubjectId,
            ...(recordKey.subjectKind === "unknown" ? { mergeKey: "openai-codex:work" } : {}),
        },
        observedAtMs: params.fetchedAt,
        fetchedAtMs: params.fetchedAt,
        staleAfterMs: 60_000,
        source: "runtimeSignal",
        confidence: "confirmed",
        state: "loaded_data",
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
    });
}

describe("providerAccountUsage storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-provider-account-usage-storage-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        vi.unstubAllGlobals();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroupMember.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroup.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("invalidates every alias only for the credential whose organization changes and retains same-context token rotation", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const writeCredential = (profileId: string, organizationId: string) => mutateConnectedServiceCredential({
            accountId: user.id, serviceId: "claude-subscription", profileId,
            token: Buffer.from(`token:${organizationId}`), storageMode: "plain", expiresAt: null,
            metadata: { v: 3, storage: "plain_json_v1", kind: "oauth", providerAccountId: "same-user", providerOrganizationId: organizationId },
            incomingIdentity: { providerAccountId: "same-user" }, allowProviderIdentityChange: false,
        });
        for (const profileId of ["work", "other"]) await writeCredential(profileId, "org-a");
        const group = await db.connectedServiceAuthGroup.create({ data: {
            accountId: user.id, vendor: "claude-subscription", groupId: "team", displayName: "Team",
            policyJson: "{}", activeProfileId: "work", generation: 1,
        } });
        await db.connectedServiceAuthGroupMember.create({ data: {
            groupDbId: group.id, accountId: user.id, vendor: "claude-subscription", groupId: "team",
            profileId: "work", priority: 1, enabled: true,
        } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey: createProviderAccountUsageRecordKey({
            providerId: "claude", accountSubjectId: "same-user", quotaScope: "organization", quotaScopeId: "org-a",
        }) });
        await writeProviderAccountUsageRecord({ accountId: user.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1", snapshot, status: "ok", fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
        const sources: ConnectedServiceUsageSourceV1[] = [
            { serviceId: "claude-subscription", profileId: "work", bindingKind: "profile" },
            { serviceId: "claude-subscription", profileId: "work", bindingKind: "group_member", groupId: "team", groupGeneration: 1 },
            { serviceId: "claude-subscription", profileId: "other", bindingKind: "profile" },
        ];
        for (const source of sources) await linkConnectedServiceUsageSource({ accountId: user.id, providerAccountUsageRecordId: snapshot.recordId, source });
        await writeCredential("work", "org-a");
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: user.id } })).toBe(3);
        await expect(readConnectedServiceQuotaView({ accountId: user.id, serviceId: "claude-subscription", profileId: "work" })).resolves.not.toBeNull();
        await writeCredential("work", "org-b");
        await expect(readConnectedServiceQuotaView({ accountId: user.id, serviceId: "claude-subscription", profileId: "work" })).resolves.toBeNull();
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: user.id, profileId: "work" } })).toBe(0);
        await expect(readExactConnectedServiceUsageSource({ accountId: user.id, source: sources[2]! })).resolves.not.toBeNull();
        await expect(linkConnectedServiceUsageSource({ accountId: user.id, providerAccountUsageRecordId: snapshot.recordId, source: sources[0]! })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
    });

    it("requires organization proof for organization usage and rejects a legacy account alias once the credential has organization proof", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id, serviceId: "claude-subscription", providerAccountId: "same-user" });
        for (const recordKey of [
            createProviderAccountUsageRecordKey({ providerId: "claude", accountSubjectId: "same-user", quotaScope: "organization", quotaScopeId: "org-a" }),
            createProviderAccountUsageRecordKey({ providerId: "claude", accountSubjectId: "same-user" }),
        ]) {
            const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });
            await writeProviderAccountUsageRecord({ accountId: user.id, recordId: snapshot.recordId, recordKey,
                payloadMode: "plain_json_v1", snapshot, status: "ok", fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
            const source = { serviceId: "claude-subscription", profileId: "work", bindingKind: "profile" } as const;
            if (recordKey.quotaScope === "organization") {
                await expect(linkConnectedServiceUsageSource({ accountId: user.id, providerAccountUsageRecordId: snapshot.recordId, source })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
            } else {
                await linkConnectedServiceUsageSource({ accountId: user.id, providerAccountUsageRecordId: snapshot.recordId, source });
                await db.serviceAccountToken.updateMany({ where: { accountId: user.id }, data: { metadata: { kind: "oauth", providerAccountId: "same-user", providerOrganizationId: "org-a" } } });
                await expect(readConnectedServiceUsageSource({ accountId: user.id, ...source })).resolves.toBeNull();
            }
        }
    });

    it("merges sealed subscription observations independently of quota clocks and preserves them for older writers", async () => {
        const user = await db.account.create({ data: { publicKey: "sealed-subscription", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: 1000 });
        const first = { ciphertext: "first-subscription", observedAtMs: 2000 };
        const latest = { ciphertext: "latest-subscription", observedAtMs: 4000 };
        const write = (fetchedAt: number, subscription?: typeof first) => writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1", status: "ok", fetchedAt, staleAfterMs: 60000,
            sealedPayload: { format: "account_scoped_v1", ciphertext: `quota-${fetchedAt}`, ...(subscription ? { subscription } : {}) },
        });
        await write(1000, first);
        await write(3000);
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: snapshot.recordId }))?.sealedPayload)
            .toEqual({ format: "account_scoped_v1", ciphertext: "quota-3000", subscription: first });
        await write(1000, latest);
        await write(5000, first);
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: snapshot.recordId }))?.sealedPayload)
            .toEqual({ format: "account_scoped_v1", ciphertext: "quota-5000", subscription: latest });
    });

    it("stores plaintext subscription outside the released strict snapshot and preserves it across quota-only writes", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const base = createUsageSnapshot({ fetchedAt: 1000 });
        const subscription = { status: "subscribed", renewal: "off", observedAtMs: 2000, staleAfterMs: 60000, currentPeriodEndAtMs: 8000 } as const;
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id, recordId: base.recordId, recordKey: base.recordKey,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt: 1000, staleAfterMs: 60000,
            snapshot: { ...base, subscription },
        });
        const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: user.id, recordId: base.recordId } } });
        expect(row.snapshot).not.toHaveProperty("subscription");
        expect(row.metadata).toHaveProperty("subscription", subscription);
        await writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id, recordId: base.recordId, recordKey: base.recordKey,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt: 3000, staleAfterMs: 60000,
            snapshot: createUsageSnapshot({ fetchedAt: 3000 }),
        });
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: base.recordId }))?.snapshot?.subscription).toEqual(subscription);
    });

    it("stores recovery details outside the strict snapshot and keeps them tied to their quota observation", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const base = createUsageSnapshot({ fetchedAt: 1000 });
        const recoveryCreditDetails = {
            reset_one: { remainingCount: 2, appliesToProviderLimitIds: ["weekly"], unavailableReason: "paused" as const },
        };
        const write = (fetchedAt: number, details?: typeof recoveryCreditDetails) => writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id, recordId: base.recordId, recordKey: base.recordKey,
            payloadMode: "plain_json_v1", status: "ok", fetchedAt, staleAfterMs: 60000,
            snapshot: { ...createUsageSnapshot({ fetchedAt }), ...(details ? { recoveryCreditDetails: details } : {}) },
        });
        await write(1000, recoveryCreditDetails);
        const row = await db.providerAccountUsageRecord.findUniqueOrThrow({ where: { accountId_recordId: { accountId: user.id, recordId: base.recordId } } });
        expect(row.snapshot).not.toHaveProperty("recoveryCreditDetails");
        expect(row.metadata).toHaveProperty("recoveryCreditDetails", recoveryCreditDetails);
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: base.recordId }))?.snapshot)
            .toMatchObject({ recoveryCreditDetails });
        await expect(write(500)).resolves.toBe("stale");
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: base.recordId }))?.snapshot)
            .toMatchObject({ recoveryCreditDetails });
        await write(3000);
        const refreshed = await readProviderAccountUsageRecord({ accountId: user.id, recordId: base.recordId });
        expect(refreshed?.snapshot).toMatchObject({ fetchedAtMs: 3000 });
        expect(refreshed?.snapshot).not.toHaveProperty("recoveryCreditDetails");
        await expect(write(1000, recoveryCreditDetails)).resolves.toBe("stale");
        expect((await readProviderAccountUsageRecord({ accountId: user.id, recordId: base.recordId }))?.snapshot)
            .not.toHaveProperty("recoveryCreditDetails");
    });

    it("rejects future-dated writes and lets a current observation replace a previously persisted future clock", async () => {
        const nowMs = Date.now();
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey();
        const future = createUsageSnapshot({ fetchedAt: nowMs + 600_000, recordKey, planLabel: "poisoned" });
        const current = createUsageSnapshot({ fetchedAt: nowMs, recordKey, planLabel: "recovered" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: future.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: future,
            status: "ok",
            fetchedAt: future.fetchedAtMs,
            staleAfterMs: future.staleAfterMs,
        });

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id,
            recordId: current.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: current,
            status: "ok",
            fetchedAt: current.fetchedAtMs,
            staleAfterMs: current.staleAfterMs,
        })).resolves.toBe("written");
        await expect(readProviderAccountUsageRecord({ accountId: user.id, recordId: current.recordId }))
            .resolves.toEqual(expect.objectContaining({
                fetchedAt: nowMs,
                snapshot: expect.objectContaining({ planLabel: "recovered" }),
            }));

        const futureOnlyKey = createProviderAccountUsageRecordKey({ accountSubjectId: "acct_future_only" });
        const futureOnly = createUsageSnapshot({ fetchedAt: nowMs + 600_000, recordKey: futureOnlyKey, planLabel: "future-only" });
        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id,
            recordId: futureOnly.recordId,
            recordKey: futureOnlyKey,
            payloadMode: "plain_json_v1",
            snapshot: futureOnly,
            status: "ok",
            fetchedAt: futureOnly.fetchedAtMs,
            staleAfterMs: futureOnly.staleAfterMs,
        })).rejects.toThrow(ProviderAccountUsagePayloadInvariantError);
        await expect(readProviderAccountUsageRecord({ accountId: user.id, recordId: futureOnly.recordId }))
            .resolves.toBeNull();
    });

    it("persists refresh-requested provider usage records without requiring a payload", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey();
        const recordId = buildProviderAccountUsageRecordId(recordKey);
        const refreshRequestedAt = Date.now();

        await expect(writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "refresh_requested",
            refreshRequestedAt,
        })).resolves.toEqual(expect.objectContaining({
            accountId: user.id,
            recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "refresh_requested",
            refreshRequestedAt,
        }));

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId,
        })).resolves.toEqual(expect.objectContaining({
            accountId: user.id,
            recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "refresh_requested",
            refreshRequestedAt,
        }));
    });

    it("rejects a PAU payload mode that disagrees with account mode inside the write transaction", async () => {
        const user = await db.account.create({ data: { publicKey: "pk-pau-mode", encryptionMode: "e2ee" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(0);
    });

    it("deletes only the exact group or member source topology and retains same-profile independent groups", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({ accountId: user.id, profileId: "work", groupId: "left", generation: 3 });
        const rightGroup = await db.connectedServiceAuthGroup.create({
            data: {
                accountId: user.id,
                vendor: "openai-codex",
                groupId: "right",
                displayName: "Right",
                policyJson: "{}",
                activeProfileId: "work",
                generation: 5,
            },
            select: { id: true },
        });
        await db.connectedServiceAuthGroupMember.create({
            data: { groupDbId: rightGroup.id, accountId: user.id, vendor: "openai-codex", groupId: "right", profileId: "work", priority: 1, enabled: true },
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });
        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        for (const [groupId, groupGeneration] of [["left", 3], ["right", 5]] as const) {
            await upsertConnectedServiceUsageSource({
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
                providerAccountUsageRecordId: snapshot.recordId,
                bindingKind: "group_member",
                groupId,
                groupGeneration,
            });
        }

        await expect(deleteConnectedServiceUsageSourcesForGroupMember({
            accountId: user.id, serviceId: "openai-codex", groupId: "left", profileId: "work",
        })).resolves.toBe(1);
        expect(await db.connectedServiceUsageSource.findMany({ where: { accountId: user.id }, select: { groupId: true } }))
            .toEqual([{ groupId: "right" }]);

        await db.connectedServiceAuthGroupMember.deleteMany({ where: { accountId: user.id, vendor: "openai-codex", groupId: "left" } });
        await db.connectedServiceAuthGroup.delete({ where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "left" } } });
        const recreatedLeft = await db.connectedServiceAuthGroup.create({
            data: { accountId: user.id, vendor: "openai-codex", groupId: "left", displayName: "Left recreated", policyJson: "{}", activeProfileId: "work", generation: 0 },
            select: { id: true },
        });
        await db.connectedServiceAuthGroupMember.create({
            data: { groupDbId: recreatedLeft.id, accountId: user.id, vendor: "openai-codex", groupId: "left", profileId: "work", priority: 1, enabled: true },
        });
        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "group_member",
            groupId: "left",
            groupGeneration: 0,
        });
        expect(await db.connectedServiceUsageSource.findMany({
            where: { accountId: user.id },
            orderBy: { groupId: "asc" },
            select: { groupId: true, groupGeneration: true },
        })).toEqual([
            { groupId: "left", groupGeneration: 0 },
            { groupId: "right", groupGeneration: 5 },
        ]);

        await expect(deleteConnectedServiceUsageSourcesForGroup({
            accountId: user.id, serviceId: "openai-codex", groupId: "right",
        })).resolves.toBe(1);
        expect(await db.connectedServiceUsageSource.findMany({ where: { accountId: user.id }, select: { groupId: true, groupGeneration: true } }))
            .toEqual([{ groupId: "left", groupGeneration: 0 }]);
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(1);
    });

    it("requires a stored source row to resolve a connected-service quota view and does not fall back to snapshot aliases", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id });
        const fetchedAt = Date.now();
        const snapshot = createUsageSnapshot({ fetchedAt });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt,
            staleAfterMs: snapshot.staleAfterMs,
        });

        expect(await readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).toBeNull();

        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });

        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            snapshot: expect.objectContaining({
                serviceId: "openai-codex",
                profileId: "work",
                providerId: snapshot.providerId,
            }),
        }));
    });

    it("preserves organization scope and supplemental facts in the connected-service quota view", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id, serviceId: "anthropic", providerAccountId: "acct-user", providerOrganizationId: "org-work" });
        const snapshot = ProviderAccountUsageSnapshotV1Schema.parse({
            ...createUsageSnapshot({
                fetchedAt: Date.now(),
                recordKey: {
                    providerId: "claude", accountSubjectId: "acct-user", subjectKind: "account",
                    quotaScope: "organization", quotaScopeId: "org-work",
                },
            }),
            subscription: { status: "none", renewal: "unknown", observedAtMs: 1000, staleAfterMs: 60000 },
            recoveryCreditDetails: {},
        });
        await upsertProviderAccountUsageRecord({
            accountId: user.id, recordId: snapshot.recordId, recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1", snapshot, status: "ok", fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await upsertConnectedServiceUsageSource({
            accountId: user.id, serviceId: "anthropic", profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId, bindingKind: "profile",
        });
        await expect(readConnectedServiceQuotaView({
            accountId: user.id, serviceId: "anthropic", profileId: "work",
        })).resolves.toMatchObject({
            snapshot: {
                activeAccountId: "acct-user", providerOrganizationId: "org-work",
                subscription: snapshot.subscription, recoveryCreditDetails: {},
            },
        });
    });

    it("upserts provider usage records and source links idempotently", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });
        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });

        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(1);
        expect(await db.connectedServiceUsageSource.count({ where: { accountId: user.id } })).toBe(1);

        const source = await readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        });
        expect(source).toEqual(expect.objectContaining({
            providerAccountUsageRecordId: snapshot.recordId,
            sourceKey: expect.any(String),
        }));
        expect(source?.sourceKey).not.toContain("\u0000");
    });

    it("rejects impossible connected-service usage source identity combinations before storage", async () => {
        const recordKey = createProviderAccountUsageRecordKey();
        const base = {
            accountId: "missing-account",
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: buildProviderAccountUsageRecordId(recordKey),
        };

        await expect(upsertConnectedServiceUsageSource({
            ...base,
            bindingKind: "profile",
            groupId: "team",
            groupGeneration: 7,
        } as unknown as Parameters<typeof upsertConnectedServiceUsageSource>[0])).rejects.toMatchObject({ name: "ZodError" });
        await expect(upsertConnectedServiceUsageSource({
            ...base,
            bindingKind: "group_member",
        } as unknown as Parameters<typeof upsertConnectedServiceUsageSource>[0])).rejects.toMatchObject({ name: "ZodError" });
    });

    it("preserves shared provider usage records when unlinking one connected-service source", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id, profileId: "work" });
        await createProfileBinding({ accountId: user.id, profileId: "backup" });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });
        await upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "backup",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        });

        await expect(unlinkConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBe("removed");

        expect(await readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).toBeNull();
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(1);
        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "backup",
        })).resolves.toEqual(expect.objectContaining({ recordId: snapshot.recordId }));
    });

    it("rejects linking a connected-service source to a provider usage record owned by a different account", async () => {
        const left = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const right = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: right.id });
        const recordKey = createProviderAccountUsageRecordKey();
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await upsertProviderAccountUsageRecord({
            accountId: left.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: right.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
    });

    it("rejects linking a connected-service source to a same-account provider usage record from an incompatible provider", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id, serviceId: "openai-codex" });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "claude",
            accountSubjectId: "acct_claude_subject",
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
    });

    it("rejects linking a connected-service source to a different provider account on the same service", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({
            accountId: user.id,
            serviceId: "openai-codex",
            providerAccountId: "acct_connected_profile",
        });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "codex",
            accountSubjectId: "acct_usage_record",
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
    });

    it("requires stable non-account source links to have an active credential owner proof", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({
            accountId: user.id,
            serviceId: "openai-codex",
            providerAccountId: null,
        });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "codex",
            accountSubjectId: "sub_codex_team",
            subjectKind: "subscription",
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);
    });

    it("rejects stable non-account source links because exact source ownership is unproven", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({
            accountId: user.id,
            serviceId: "openai-codex",
            providerAccountId: "acct_connected_profile",
        });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "codex",
            accountSubjectId: "sub_codex_team",
            subjectKind: "subscription",
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey, planLabel: "subscription-source" });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "profile",
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);

        expect(await db.connectedServiceUsageSource.count({ where: { accountId: user.id } })).toBe(0);
        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
    });

    it("rejects provisional provider usage source links without exact provider-account identity", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            groupId: "team",
            generation: 7,
        });
        const recordKey = createProviderAccountUsageRecordKey({
            providerId: "codex",
            accountSubjectId: "legacy-connected-service:openai-codex:work",
            subjectKind: "unknown",
        });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), recordKey, planLabel: "provisional-source" });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(upsertConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
            providerAccountUsageRecordId: snapshot.recordId,
            bindingKind: "group_member",
            groupId: "team",
            groupGeneration: 7,
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);

        expect(await db.connectedServiceUsageSource.count({ where: { accountId: user.id } })).toBe(0);
        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
    });

    it("does not project a connected-service quota view after a linked credential is replaced with a different provider account", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "original-account" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        await db.serviceAccountToken.update({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "work",
                },
            },
            data: {
                metadata: {
                    kind: "oauth",
                    providerAccountId: "acct_replaced_provider_subject",
                },
            },
        });

        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBeNull();
    });

    it("rejects invalid payload mode combinations", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await expect(upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            sealedPayload: { format: "account_scoped_v1", ciphertext: "sealed-payload" },
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);

        await expect(upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "sealed_account_scoped_v1",
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        })).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
    });

    it("records refresh requests on provider usage records instead of generic quota placeholders", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now() });

        await upsertProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await expect(requestProviderAccountUsageRefresh({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toBe("written");

        const stored = await readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        });
        expect(stored?.refreshRequestedAt).toEqual(expect.any(Number));
        expect(await db.providerAccountUsageRecord.count({ where: { accountId: user.id } })).toBe(1);
    });

    it("supports plan-named write/link wrappers with explicit connected-service source context", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "source-context" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            snapshot: expect.objectContaining({ serviceId: "openai-codex", profileId: "work" }),
        }));
    });

    it("lists active connected-service usage sources for a provider usage record", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id, profileId: "stale" });
        await createGroupMemberBinding({ accountId: user.id, profileId: "work", groupId: "team", generation: 7 });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "durable-sources" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "stale",
                bindingKind: "profile",
            },
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 7,
            },
        });
        await db.serviceAccountToken.delete({
            where: {
                accountId_vendor_profileId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    profileId: "stale",
                },
            },
        });

        const listConnectedServiceUsageSourcesForProviderAccountUsageRecord = (
            providerAccountUsageStorage as Readonly<{
                listConnectedServiceUsageSourcesForProviderAccountUsageRecord?: (params: Readonly<{
                    accountId: string;
                    providerAccountUsageRecordId: string;
                }>) => Promise<readonly unknown[]>;
            }>
        ).listConnectedServiceUsageSourcesForProviderAccountUsageRecord;

        expect(listConnectedServiceUsageSourcesForProviderAccountUsageRecord).toEqual(expect.any(Function));
        await expect(listConnectedServiceUsageSourcesForProviderAccountUsageRecord?.({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
        })).resolves.toEqual([
            expect.objectContaining({
                accountId: user.id,
                serviceId: "openai-codex",
                profileId: "work",
                providerAccountUsageRecordId: snapshot.recordId,
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 7,
            }),
        ]);
    });

    it("prunes superseded generation rows for the same logical group source on upsert (SD-2)", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({ accountId: user.id, profileId: "work", groupId: "team", generation: 3 });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "generation-prune" });
        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 3,
            },
        });

        // The group's generation bumps (a swap happened); relinking the SAME logical
        // source (service + profile + group) mints a new generation-embedding sourceKey.
        // The superseded generation-3 row must be pruned instead of accumulating.
        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "team" } },
            data: { generation: 7 },
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 7,
            },
        });

        const rows = await db.connectedServiceUsageSource.findMany({
            where: { accountId: user.id, serviceId: "openai-codex", profileId: "work", groupId: "team" },
            select: { groupGeneration: true },
        });
        expect(rows).toEqual([{ groupGeneration: 7 }]);
    });

    it("resolves only an exact account-scoped current group source with record identity and freshness", async () => {
        const owner = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const other = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({ accountId: owner.id, profileId: "work", groupId: "team", generation: 7 });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "exact-source" });
        await writeProviderAccountUsageRecord({
            accountId: owner.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        const source = {
            serviceId: "openai-codex",
            profileId: "work",
            bindingKind: "group_member" as const,
            groupId: "team",
            groupGeneration: 7,
        } as const satisfies ConnectedServiceUsageSourceV1;
        await linkConnectedServiceUsageSource({
            accountId: owner.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source,
        });

        await expect(readExactConnectedServiceUsageSource({ accountId: owner.id, source })).resolves.toEqual({
            source,
            recordId: snapshot.recordId,
            providerAccountId: snapshot.recordKey.accountSubjectId,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await expect(readExactConnectedServiceUsageSource({ accountId: other.id, source })).resolves.toBeNull();
        await expect(readExactConnectedServiceUsageSource({
            accountId: owner.id,
            source: { ...source, groupGeneration: 6 },
        })).resolves.toBeNull();
    });

    it("rejects a superseded group-generation source even if its legacy row remains", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({ accountId: user.id, profileId: "work", groupId: "team", generation: 3 });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "superseded-source" });
        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        const staleSource = {
            serviceId: "openai-codex",
            profileId: "work",
            bindingKind: "group_member" as const,
            groupId: "team",
            groupGeneration: 3,
        } as const satisfies ConnectedServiceUsageSourceV1;
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: staleSource,
        });
        await db.connectedServiceAuthGroup.update({
            where: { accountId_vendor_groupId: { accountId: user.id, vendor: "openai-codex", groupId: "team" } },
            data: { generation: 4 },
        });

        await expect(readExactConnectedServiceUsageSource({
            accountId: user.id,
            source: staleSource,
        })).resolves.toBeNull();
    });

    it("keeps per-group source links independent when one profile belongs to multiple groups", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        // One shared credential for profile "work"...
        await createProfileBinding({ accountId: user.id, serviceId: "openai-codex", profileId: "work" });
        // ...that belongs to TWO auth groups.
        for (const groupId of ["alpha", "beta"]) {
            const group = await db.connectedServiceAuthGroup.create({
                data: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId,
                    displayName: groupId,
                    policyJson: "{}",
                    activeProfileId: "work",
                    generation: 3,
                },
                select: { id: true },
            });
            await db.connectedServiceAuthGroupMember.create({
                data: {
                    groupDbId: group.id,
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId,
                    profileId: "work",
                    priority: 1,
                    enabled: true,
                },
            });
        }

        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "multi-group" });
        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });

        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "alpha",
                groupGeneration: 3,
            },
        });
        // The second group's link must NOT clobber the first: pre-fix this overwrote
        // the alpha row because the upsert keyed by (accountId, serviceId, profileId).
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "beta",
                groupGeneration: 3,
            },
        });

        const rows = await db.connectedServiceUsageSource.findMany({
            where: { accountId: user.id, serviceId: "openai-codex", profileId: "work" },
            orderBy: { groupId: "asc" },
            select: { groupId: true, sourceKey: true, bindingKind: true, providerAccountUsageRecordId: true },
        });

        // Both group links persist independently, each keyed by its own sourceKey.
        expect(rows.map((row) => row.groupId)).toEqual(["alpha", "beta"]);
        expect(new Set(rows.map((row) => row.sourceKey)).size).toBe(2);
        expect(rows.every((row) => row.bindingKind === "group_member")).toBe(true);
        expect(rows.every((row) => row.providerAccountUsageRecordId === snapshot.recordId)).toBe(true);

        // The reader still resolves the profile to its (shared) record.
        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toEqual(expect.objectContaining({ recordId: snapshot.recordId }));
    });

    it("keeps settings quota views readable when a group-member source has a stale generation but still matches the credential account", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createGroupMemberBinding({ accountId: user.id, profileId: "work", groupId: "team", generation: 7 });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "stale-generation-view" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "group_member",
                groupId: "team",
                groupGeneration: 7,
            },
        });

        await db.connectedServiceAuthGroup.update({
            where: {
                accountId_vendor_groupId: {
                    accountId: user.id,
                    vendor: "openai-codex",
                    groupId: "team",
                },
            },
            data: { generation: 8 },
        });

        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            snapshot: expect.objectContaining({
                planLabel: "stale-generation-view",
                serviceId: "openai-codex",
                profileId: "work",
            }),
        }));
    });

    it("persists provider-account usage writes only when source linking is unavailable and rejects ownership mismatches", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "persist-on-link-failure" });

        await expect(writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            source: {
                serviceId: "openai-codex",
                profileId: "missing-profile-binding",
                bindingKind: "profile",
            },
        })).resolves.toEqual({
            record: expect.objectContaining({
                recordId: snapshot.recordId,
                recordKey: snapshot.recordKey,
            }),
            source: null,
            sourceOutcome: {
                status: "skipped",
                reason: "binding_unavailable",
            },
        });

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
        }));
        await expect(readConnectedServiceQuotaView({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "missing-profile-binding",
        })).resolves.toBeNull();

        await createProfileBinding({
            accountId: user.id,
            profileId: "unproven-profile",
            providerAccountId: "acct_connected_profile_subject",
        });
        const unprovenRecordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "provisional:unproven-source-subject",
            subjectKind: "unknown",
        });
        const unprovenSnapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: unprovenRecordKey,
            planLabel: "persist-on-unproven-source",
        });

        await expect(writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: user.id,
            recordId: unprovenSnapshot.recordId,
            recordKey: unprovenSnapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot: unprovenSnapshot,
            status: "ok",
            fetchedAt: unprovenSnapshot.fetchedAtMs,
            staleAfterMs: unprovenSnapshot.staleAfterMs,
            source: {
                serviceId: "openai-codex",
                profileId: "unproven-profile",
                bindingKind: "profile",
            },
        })).resolves.toEqual({
            record: expect.objectContaining({
                recordId: unprovenSnapshot.recordId,
                recordKey: unprovenSnapshot.recordKey,
            }),
            source: null,
            sourceOutcome: {
                status: "skipped",
                reason: "ownership_unproven",
            },
        });

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: unprovenSnapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            recordId: unprovenSnapshot.recordId,
            recordKey: unprovenSnapshot.recordKey,
        }));
        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "unproven-profile",
        })).resolves.toBeNull();

        await createProfileBinding({
            accountId: user.id,
            profileId: "other-account-profile",
            providerAccountId: "acct_connected_profile_subject",
        });
        const mismatchedRecordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "acct_usage_subject",
        });
        const mismatchedSnapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey: mismatchedRecordKey,
            planLabel: "persist-on-source-mismatch",
        });

        await expect(writeProviderAccountUsageRecordAndLinkConnectedServiceUsageSource({
            accountId: user.id,
            recordId: mismatchedSnapshot.recordId,
            recordKey: mismatchedSnapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot: mismatchedSnapshot,
            status: "ok",
            fetchedAt: mismatchedSnapshot.fetchedAtMs,
            staleAfterMs: mismatchedSnapshot.staleAfterMs,
            source: {
                serviceId: "openai-codex",
                profileId: "other-account-profile",
                bindingKind: "profile",
            },
        })).rejects.toBeInstanceOf(ConnectedServiceUsageSourceOwnershipError);

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: mismatchedSnapshot.recordId,
        })).resolves.toBeNull();
        await expect(readConnectedServiceUsageSource({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "other-account-profile",
        })).resolves.toBeNull();
    });

    it("preserves a pending refresh request on same-fingerprint writes that predate the refresh", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const initialFetchedAt = Date.now() - 30_000;
        const snapshot = createUsageSnapshot({ fetchedAt: initialFetchedAt, planLabel: "refresh-preservation" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
            metadata: { materialFingerprint: "same-material" },
        });

        await expect(requestProviderAccountUsageRefresh({
            accountId: user.id,
            recordId: snapshot.recordId,
        })).resolves.toBe("written");

        const afterRefresh = await readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        });
        expect(afterRefresh?.refreshRequestedAt).toEqual(expect.any(Number));

        const refreshedAt = afterRefresh?.refreshRequestedAt ?? 0;
        const staleButNewerSnapshot = createUsageSnapshot({
            fetchedAt: refreshedAt - 1_000,
            recordKey: snapshot.recordKey,
            planLabel: "refresh-preservation",
        });

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id,
            recordId: staleButNewerSnapshot.recordId,
            recordKey: staleButNewerSnapshot.recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            fetchedAt: staleButNewerSnapshot.fetchedAtMs,
            staleAfterMs: staleButNewerSnapshot.staleAfterMs,
            materialFingerprint: "same-material",
            snapshot: staleButNewerSnapshot,
        })).resolves.toBe("written");

        expect((await readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        }))?.refreshRequestedAt).toEqual(refreshedAt);
    });

    it("does not stale-overwrite a newer record when a policy writer read an older version", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        const recordKey = createProviderAccountUsageRecordKey();
        const oldSnapshot = createUsageSnapshot({ fetchedAt: 1_000, recordKey, planLabel: "old" });
        const staleSnapshot = createUsageSnapshot({ fetchedAt: 2_000, recordKey, planLabel: "stale-racer" });
        const newerSnapshot = createUsageSnapshot({ fetchedAt: 3_000, recordKey, planLabel: "newer-winner" });

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: oldSnapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: oldSnapshot,
            status: "ok",
            fetchedAt: oldSnapshot.fetchedAtMs,
            staleAfterMs: oldSnapshot.staleAfterMs,
        });

        const laggingRead = await db.providerAccountUsageRecord.findUnique({
            where: {
                accountId_recordId: {
                    accountId: user.id,
                    recordId: oldSnapshot.recordId,
                },
            },
            select: {
                accountId: true,
                recordId: true,
                recordKeyJson: true,
                payloadMode: true,
                status: true,
                snapshot: true,
                sealedPayload: true,
                fetchedAt: true,
                staleAfterMs: true,
                refreshRequestedAt: true,
                metadata: true,
            },
        });
        expect(laggingRead).not.toBeNull();

        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: newerSnapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: newerSnapshot,
            status: "ok",
            fetchedAt: newerSnapshot.fetchedAtMs,
            staleAfterMs: newerSnapshot.staleAfterMs,
        });

        let returnedLaggingRead = false;
        const interleavedClient = {
            account: db.account,
            providerAccountUsageRecord: {
                findUnique: async (args: Parameters<typeof db.providerAccountUsageRecord.findUnique>[0]) => {
                    if (!returnedLaggingRead) {
                        returnedLaggingRead = true;
                        return laggingRead;
                    }
                    return await db.providerAccountUsageRecord.findUnique(args);
                },
                create: db.providerAccountUsageRecord.create.bind(db.providerAccountUsageRecord),
                updateMany: db.providerAccountUsageRecord.updateMany.bind(db.providerAccountUsageRecord),
                upsert: db.providerAccountUsageRecord.upsert.bind(db.providerAccountUsageRecord),
            },
            // Boundary fixture: emulate one lagging Prisma read while all writes still hit the real test database.
        } as unknown as Pick<typeof db, "account" | "providerAccountUsageRecord">;

        await expect(writeProviderAccountUsageRecordWithPolicy({
            accountId: user.id,
            recordId: staleSnapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            snapshot: staleSnapshot,
            status: "ok",
            fetchedAt: staleSnapshot.fetchedAtMs,
            staleAfterMs: staleSnapshot.staleAfterMs,
            client: interleavedClient,
        })).resolves.toBe("stale");

        await expect(readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: newerSnapshot.recordId,
        })).resolves.toEqual(expect.objectContaining({
            snapshot: expect.objectContaining({ planLabel: "newer-winner" }),
            fetchedAt: newerSnapshot.fetchedAtMs,
        }));
    });

    it("refreshes provider usage through the connected-service source relation and returns not_found when no source is linked", async () => {
        const user = await db.account.create({ data: { publicKey: null, encryptionMode: "plain" }, select: { id: true } });
        await createProfileBinding({ accountId: user.id });

        await expect(requestConnectedServiceQuotaRefresh({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBe("not_found");

        const snapshot = createUsageSnapshot({ fetchedAt: Date.now(), planLabel: "refresh-by-source" });
        await writeProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
            recordKey: snapshot.recordKey,
            payloadMode: "plain_json_v1",
            snapshot,
            status: "ok",
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        await linkConnectedServiceUsageSource({
            accountId: user.id,
            providerAccountUsageRecordId: snapshot.recordId,
            source: {
                serviceId: "openai-codex",
                profileId: "work",
                bindingKind: "profile",
            },
        });

        await expect(requestConnectedServiceQuotaRefresh({
            accountId: user.id,
            serviceId: "openai-codex",
            profileId: "work",
        })).resolves.toBe("written");

        expect((await readProviderAccountUsageRecord({
            accountId: user.id,
            recordId: snapshot.recordId,
        }))?.refreshRequestedAt).toEqual(expect.any(Number));
    });
});
