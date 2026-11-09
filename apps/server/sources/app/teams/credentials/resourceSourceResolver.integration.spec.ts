import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { computeCanonicalDomainSeparatedDigest } from "@happier-dev/protocol";
import { ProviderConnectionIdSchema } from "@happier-dev/protocol/providers";
import {
    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
    computeTeamCredentialConnectedAccountSourceVersionV1,
    computeTeamCredentialSourceMemberKeyV1,
} from "@happier-dev/protocol/teams";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import {
    createServiceAccountTokenIdentityFields,
    createQualifiedConnectedAccountGroupDigest,
    createQualifiedConnectedAccountIdentityDigest,
    createQualifiedConnectedAccountServiceDigest,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/identity";
import {
    listTeamCredentialDirectSourceMembersInTx,
    resolveTeamCredentialSourceMemberCurrentnessInTx,
    resolveTeamCredentialResourceSourceInTx,
    resolveTeamCredentialResourceSourcesInTx,
} from "./resourceSourceResolver";

const service = { pluginId: "example.connected-accounts", localId: "service" };
const ref = { service, accountId: "private-account" };
const contributionContractVersion = "artifact-example-1";

function directMetadata(credentialRevision: string) {
    return {
        v: 4 as const,
        storage: "stored_envelope_v1" as const,
        credentialRevision,
        directExportContract: TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
        contributionContractVersion,
        values: { scopes: [] },
    };
}

describe("Team credential source identity", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-team-resource-source-" });
    }, 120_000);

    afterAll(async () => { await harness?.close(); });
    afterEach(async () => { await db.account.deleteMany(); });

    async function createOwner() {
        return await db.account.create({ data: { encryptionMode: "plain", publicKey: null } });
    }

    async function createCredential(accountId: string) {
        return await db.serviceAccountToken.create({
            data: {
                accountId,
                ...createServiceAccountTokenIdentityFields({ ref, authenticationModeId: "api-key" }),
                token: Buffer.from("private-credential"),
                metadata: directMetadata("csr_aaaaaaaaaaaaaaaaaaaaaa"),
            },
        });
    }

    const resolve = (custodianAccountId: string, source: unknown) => inTx((tx) =>
        resolveTeamCredentialResourceSourceInTx(tx, { custodianAccountId, source }));

    it("resolves a page of repeated and distinct source lifetimes with bounded persistence reads", async () => {
        const owner = await createOwner();
        const secondRef = { service, accountId: "second-private-account" };
        const firstCredential = await createCredential(owner.id);
        await db.serviceAccountToken.update({ where: { id: firstCredential.id }, data: {
            metadata: { ...directMetadata("csr_aaaaaaaaaaaaaaaaaaaaaa"), health: { v: 1, status: "needs_reauth", reconnectRequired: true } },
        } });
        const secondCredential = await db.serviceAccountToken.create({
            data: {
                accountId: owner.id,
                ...createServiceAccountTokenIdentityFields({ ref: secondRef, authenticationModeId: "api-key" }),
                token: Buffer.from("second-private-credential"),
                metadata: directMetadata("csr_bbbbbbbbbbbbbbbbbbbbbb"),
            },
        });
        const groupId = "batched-private-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            groupId,
            displayName: "Batched private pool",
            policyJson: "{}",
        } });
        const firstSource = {
            v: 1 as const,
            kind: "connected_account" as const,
            target: { kind: "account" as const, account: ref },
            credentialIncarnation: firstCredential.id,
        };
        const secondSource = {
            v: 1 as const,
            kind: "connected_account" as const,
            target: { kind: "account" as const, account: secondRef },
            credentialIncarnation: secondCredential.id,
        };
        const poolSource = {
            v: 1 as const,
            kind: "connected_pool" as const,
            target: { kind: "group" as const, service, groupId },
            poolIncarnation: pool.id,
        };
        const providerSource = {
            v: 1 as const,
            kind: "provider_connection" as const,
            connectionId: "00000000-0000-4000-8000-000000000001",
            connectionSecurityFingerprint: `connection-security:v1:${"a".repeat(43)}`,
            credentialSlotId: "apiKey",
        };
        const requests = [
            ...Array.from({ length: 8 }, () => ({ custodianAccountId: owner.id, source: firstSource })),
            ...Array.from({ length: 5 }, () => ({ custodianAccountId: owner.id, source: secondSource })),
            ...Array.from({ length: 4 }, () => ({ custodianAccountId: owner.id, source: poolSource })),
            ...Array.from({ length: 3 }, () => ({ custodianAccountId: owner.id, source: providerSource })),
        ];

        const results = await inTx(async (tx) => {
            const credentialReads = vi.fn(
                tx.serviceAccountToken.findMany.bind(tx.serviceAccountToken),
            );
            const poolReads = vi.fn(
                tx.connectedServiceAuthGroup.findMany.bind(
                    tx.connectedServiceAuthGroup,
                ),
            );
            const instrumentedTx = Object.assign(Object.create(tx), {
                serviceAccountToken: Object.assign(
                    Object.create(tx.serviceAccountToken),
                    { findMany: credentialReads },
                ),
                connectedServiceAuthGroup: Object.assign(
                    Object.create(tx.connectedServiceAuthGroup),
                    { findMany: poolReads },
                ),
            });
            const resolved = await resolveTeamCredentialResourceSourcesInTx(
                instrumentedTx,
                requests,
            );
            expect(credentialReads).toHaveBeenCalledTimes(1);
            expect(poolReads).toHaveBeenCalledTimes(1);
            return resolved;
        });

        expect(results).toHaveLength(requests.length);
        expect(results.every((result) => result.status === "current")).toBe(true);
        expect(results.slice(0, 8)).toEqual(Array(8).fill(results[0]));
        expect(results.slice(8, 13)).toEqual(Array(5).fill(results[8]));
        expect(results.slice(13, 17)).toEqual(Array(4).fill(results[13]));
        expect(results[0]).toMatchObject({ status: "current", authenticationFailure: "connected_service_credential_reconnect_required" });
        expect(results[8]).not.toHaveProperty("authenticationFailure");
        await expect(inTx(tx => resolveTeamCredentialSourceMemberCurrentnessInTx(tx, {
            custodianAccountId: owner.id, source: firstSource, deliveryMode: 'direct',
            sourceMemberKey: computeTeamCredentialSourceMemberKeyV1({ kind: 'connected_account', service, connectedAccountId: ref.accountId }),
        }))).resolves.toMatchObject({ status: 'current', directExportSupport: 'supported' });
        await db.serviceAccountToken.update({ where: { id: firstCredential.id }, data: {
            metadata: directMetadata("csr_aaaaaaaaaaaaaaaaaaaaaa"),
        } });
        await expect(resolve(owner.id, firstSource)).resolves.not.toHaveProperty("authenticationFailure");
    });

    it("preserves missing and replaced source semantics in the batched owner", async () => {
        const owner = await createOwner();
        const credential = await createCredential(owner.id);
        const missingRef = { service, accountId: "missing-private-account" };
        const groupId = "batched-stale-pool";
        const pool = await db.connectedServiceAuthGroup.create({ data: {
            accountId: owner.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            groupId,
            displayName: "Stale batched pool",
            policyJson: "{}",
        } });

        const results = await inTx((tx) => resolveTeamCredentialResourceSourcesInTx(tx, [
            {
                custodianAccountId: owner.id,
                source: {
                    v: 1,
                    kind: "connected_account",
                    target: { kind: "account", account: ref },
                    credentialIncarnation: `${credential.id}-replaced`,
                },
            },
            {
                custodianAccountId: owner.id,
                source: {
                    v: 1,
                    kind: "connected_account",
                    target: { kind: "account", account: missingRef },
                    credentialIncarnation: "missing-incarnation",
                },
            },
            {
                custodianAccountId: owner.id,
                source: {
                    v: 1,
                    kind: "connected_pool",
                    target: { kind: "group", service, groupId },
                    poolIncarnation: `${pool.id}-replaced`,
                },
            },
            { custodianAccountId: owner.id, source: { kind: "broken" } },
        ]));

        expect(results).toEqual([
            { status: "unavailable", reason: "source_changed" },
            { status: "unavailable", reason: "source_missing" },
            { status: "unavailable", reason: "source_changed" },
            { status: "unavailable", reason: "invalid_source_binding" },
        ]);
    });

    it("pins the qualified Account lifetime and owning Account without disclosing private source fields", async () => {
        const owner = await createOwner();
        const other = await createOwner();
        const credential = await createCredential(owner.id);
        const source = {
            v: 1, kind: "connected_account", target: { kind: "account", account: ref },
            credentialIncarnation: credential.id,
        };
        await expect(resolve(owner.id, source)).resolves.toEqual({
            status: "current",
            directExportSupport: "supported",
            metadata: { kind: "connected_account", service },
            requestPolicyCurrentness: {
                kind: "connected_account",
                identity: {
                    incarnation: credential.id,
                    credentialRevision: "csr_aaaaaaaaaaaaaaaaaaaaaa",
                    configurationRevision: null,
                    authenticationModeId: "api-key",
                    status: "connected",
                    contributionContractVersion: "artifact-example-1",
                    directExportContract: "happier.team-credential-manual-connected-account-direct.v1",
                },
            },
            usageSourceMemberKey: computeTeamCredentialSourceMemberKeyV1({
                kind: "connected_account",
                service,
                connectedAccountId: ref.accountId,
            }),
        });
        await expect(resolve(other.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await expect(resolve(owner.id, {
            ...source, target: { kind: "account", account: { ...ref, service: { ...service, localId: "other-service" } } },
        })).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await db.serviceAccountToken.update({
            where: { id: credential.id }, data: {
                metadata: directMetadata("csr_bbbbbbbbbbbbbbbbbbbbbb"),
            },
        });
        await expect(resolve(owner.id, source)).resolves.toMatchObject({ status: "current" });
        await db.serviceAccountToken.delete({ where: { id: credential.id } });
        await expect(resolve(owner.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await createCredential(owner.id);
        await expect(resolve(owner.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_changed" });
    });

    it("derives direct currentness from current credential/config/auth facts and rejects OAuth export", async () => {
        const owner = await createOwner();
        const credential = await createCredential(owner.id);
        const source = {
            v: 1, kind: "connected_account", target: { kind: "account", account: ref },
            credentialIncarnation: credential.id,
        };
        const sourceMemberKey = computeTeamCredentialSourceMemberKeyV1({
            kind: "connected_account",
            service,
            connectedAccountId: ref.accountId,
        });
        const resolveCurrentness = () => inTx(tx => resolveTeamCredentialSourceMemberCurrentnessInTx(tx, {
            deliveryMode: 'direct',
            custodianAccountId: owner.id,
            source,
            sourceMemberKey,
        }));

        const first = await resolveCurrentness();
        expect(first).toMatchObject({ status: "current", directExportSupport: "supported" });
        if (first.status !== "current") throw new Error("expected current source");
        expect(first.sourceVersion).toBe(
            computeTeamCredentialConnectedAccountSourceVersionV1({
                sourceAccountId: ref.accountId,
                credentialIncarnation: credential.id,
                sourceMember: {
                    kind: "connected_account",
                    service,
                    connectedAccountId: ref.accountId,
                },
                credentialRevision: "csr_aaaaaaaaaaaaaaaaaaaaaa",
                configurationRevision: null,
                authenticationModeId: "api-key",
                contributionContractVersion: computeCanonicalDomainSeparatedDigest(
                    TEAM_CREDENTIAL_MANUAL_CONNECTED_ACCOUNT_DIRECT_CONTRACT_V1,
                    [contributionContractVersion],
                ),
            }),
        );

        await db.serviceAccountToken.update({
            where: { id: credential.id },
            data: {
                configurationRevision: "cfg-2",
                configurationContent: Buffer.from("configuration-v2"),
            },
        });
        const configurationChanged = await resolveCurrentness();
        expect(configurationChanged).toMatchObject({ status: "current", directExportSupport: "supported" });
        if (configurationChanged.status !== "current") throw new Error("expected current source");
        expect(configurationChanged.sourceVersion).not.toBe(first.sourceVersion);

        await db.serviceAccountToken.update({
            where: { id: credential.id },
            data: {
                authenticationModeId: "oauth",
                metadata: {
                    v: 2,
                    format: "account_scoped_v1",
                    kind: "oauth",
                    credentialRevision: "csr_bbbbbbbbbbbbbbbbbbbbbb",
                },
            },
        });
        await expect(resolveCurrentness()).resolves.toEqual({
            status: "unavailable",
            reason: "unsupported_direct_source",
        });
        await expect(inTx(tx => listTeamCredentialDirectSourceMembersInTx(tx, {
            custodianAccountId: owner.id,
            source,
        }))).resolves.toEqual([]);
    });

    it("pins the Pool incarnation while allowing normal source generation changes", async () => {
        const owner = await createOwner();
        const other = await createOwner();
        const groupId = "private-pool";
        const data = {
            accountId: owner.id,
            servicePluginId: service.pluginId,
            serviceLocalId: service.localId,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            groupId,
            displayName: "Private pool alias",
            policyJson: "{}",
        };
        const pool = await db.connectedServiceAuthGroup.create({ data });
        const source = {
            v: 1, kind: "connected_pool", target: { kind: "group", service, groupId },
            poolIncarnation: pool.id,
        };
        await expect(resolve(owner.id, source)).resolves.toEqual({
            status: "current",
            directExportSupport: "unsupported",
            metadata: { kind: "connected_pool", service },
            requestPolicyCurrentness: {
                kind: "connected_pool",
                snapshot: {
                    incarnation: pool.id,
                    generation: 0,
                    runtimeStateRevision: 0,
                    activeConnectedAccountId: null,
                    members: [],
                },
            },
            usageSourceMemberKey: null,
        });
        await expect(resolve(other.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await expect(resolve(owner.id, {
            ...source, target: { ...source.target, service: { ...service, localId: "other-service" } },
        })).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await db.connectedServiceAuthGroup.update({
            where: { id: pool.id }, data: { generation: { increment: 1 }, runtimeStateRevision: { increment: 1 } },
        });
        await expect(resolve(owner.id, source)).resolves.toMatchObject({ status: "current" });
        await expect(inTx(tx => listTeamCredentialDirectSourceMembersInTx(tx, {
            custodianAccountId: owner.id,
            source,
        }))).resolves.toEqual([]);
        const credential = await createCredential(owner.id);
        await db.connectedServiceAuthGroupMember.create({ data: {
            groupDbId: pool.id,
            accountId: owner.id,
            credentialId: credential.id,
            qualifiedServiceDigest: createQualifiedConnectedAccountServiceDigest(service),
            qualifiedGroupDigest: createQualifiedConnectedAccountGroupDigest({ service, groupId }),
            qualifiedIdentityDigest: createQualifiedConnectedAccountIdentityDigest(ref),
            priority: 10,
            enabled: true,
        } });
        await expect(inTx(tx => listTeamCredentialDirectSourceMembersInTx(tx, {
            custodianAccountId: owner.id,
            source,
        }))).resolves.toEqual([{
            kind: "connected_account",
            service,
            connectedAccountId: ref.accountId,
        }]);
        await expect(resolve(owner.id, source)).resolves.toMatchObject({
            status: "current",
            usageSourceMemberKey: null,
        });
        const exactPoolMemberKey = computeTeamCredentialSourceMemberKeyV1({
            kind: "connected_account",
            service,
            connectedAccountId: ref.accountId,
        });
        await expect(inTx(tx => resolveTeamCredentialSourceMemberCurrentnessInTx(tx, {
            deliveryMode: 'direct',
            custodianAccountId: owner.id,
            source,
            sourceMemberKey: exactPoolMemberKey,
        }))).resolves.toMatchObject({
            status: "current",
            sourceMember: {
                kind: "connected_account",
                service,
                connectedAccountId: ref.accountId,
            },
        });
        await db.connectedServiceAuthGroupMember.update({
            where: { groupDbId_credentialId: { groupDbId: pool.id, credentialId: credential.id } },
            data: { enabled: false },
        });
        await expect(inTx(tx => listTeamCredentialDirectSourceMembersInTx(tx, {
            custodianAccountId: owner.id,
            source,
        }))).resolves.toEqual([]);
        await db.connectedServiceAuthGroup.delete({ where: { id: pool.id } });
        await expect(resolve(owner.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_missing" });
        await db.connectedServiceAuthGroup.create({ data });
        await expect(resolve(owner.id, source)).resolves.toEqual({ status: "unavailable", reason: "source_changed" });
    });

    it("accepts the source-owner-pinned Provider snapshot and rejects malformed source bindings", async () => {
        const owner = await createOwner();
        const providerConnectionId = ProviderConnectionIdSchema.parse("pc_source");
        const source = {
            v: 1, kind: "provider_connection", connectionId: providerConnectionId,
            connectionSecurityFingerprint: "connection-security:v1:source", credentialSlotId: "apiKey",
        };
        await expect(resolve(owner.id, source)).resolves.toEqual({
            status: "current",
            directExportSupport: "supported",
            metadata: {
                kind: "provider_connection",
                connectionId: providerConnectionId,
                connectionSecurityFingerprint: "connection-security:v1:source",
                credentialSlotId: "apiKey",
            },
            requestPolicyCurrentness: {
                kind: "provider_connection",
                connectionId: providerConnectionId,
                connectionSecurityFingerprint: "connection-security:v1:source",
                credentialSlotId: "apiKey",
            },
            usageSourceMemberKey: computeTeamCredentialSourceMemberKeyV1({
                kind: "provider_credential_slot",
                connectionId: providerConnectionId,
                credentialSlotId: "apiKey",
            }),
        });
        await expect(resolve(owner.id, { ...source, sourceOwnerId: owner.id })).resolves.toEqual({
            status: "unavailable", reason: "invalid_source_binding",
        });
    });
});
