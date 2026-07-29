import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import {
    QualifiedConnectedAccountGroupMemberDeleteV4Schema,
    QualifiedConnectedAccountGroupRefSchema,
    QualifiedConnectedAccountConfigurationTargetV4Schema,
    QualifiedConnectedAccountRefSchema,
    QualifiedConnectedAccountServiceRefSchema,
    QualifiedConnectedServiceUsageSourceV4Schema,
    encodeQualifiedConnectedAccountV4StructuredQueryValue,
    type QualifiedConnectedAccountGroupV4,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import {
    createLightSqliteHarness,
    type LightSqliteHarness,
} from "@/testkit/lightSqliteHarness";
import {
    withAuthenticatedTestApp,
} from "@/app/api/testkit/sqliteFastify";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import {
    upsertProviderAccountUsageRecord,
} from "../providerAccountUsage";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "./registerQualifiedConnectedAccountCredentialRoutesV4";

const service = {
    pluginId: "example.connected-accounts",
    localId: "novel-service",
} as const;
const ref = {
    service,
    accountId: "provider/account",
} as const;
const groupRef = {
    service,
    groupId: "primary",
} as const;
const source = {
    ref,
    bindingKind: "account",
} as const;

describe("qualified Connected Account V4 route family (integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-qualified-connected-account-v4-routes-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.connectedServiceUsageSource.deleteMany().catch(() => {});
        await db.providerAccountUsageRecord.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroupMember.deleteMany().catch(() => {});
        await db.connectedServiceAuthGroup.deleteMany().catch(() => {});
        await db.serviceAccountToken.deleteMany().catch(() => {});
        await db.account.deleteMany().catch(() => {});
    });

    it("rejects record-id operations when the record has no qualified account source", async () => {
        const account = await db.account.create({
            data: { publicKey: null, encryptionMode: "plain" },
            select: { id: true },
        });
        const recordKey = createProviderAccountUsageRecordKey({
            accountSubjectId: "unlinked-subject",
        });
        const snapshot = createUsageSnapshot({
            fetchedAt: Date.now(),
            recordKey,
        });
        await upsertProviderAccountUsageRecord({
            accountId: account.id,
            recordId: snapshot.recordId,
            recordKey,
            payloadMode: "plain_json_v1",
            status: "ok",
            snapshot,
            fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs,
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const encodedRecordId =
                    encodeURIComponent(snapshot.recordId);
                const read = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record"
                        + `?recordId=${encodedRecordId}`,
                    headers,
                });
                expect(read.statusCode).toBe(404);

                const refresh = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record/refresh",
                    headers,
                    payload: { recordId: snapshot.recordId },
                });
                expect(refresh.statusCode).toBe(404);

                const remove = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record"
                        + `?recordId=${encodedRecordId}`,
                    headers,
                });
                expect(remove.statusCode).toBe(404);
            },
        );

        await expect(db.providerAccountUsageRecord.findFirstOrThrow({
            where: {
                accountId: account.id,
                recordId: snapshot.recordId,
            },
            select: { refreshRequestedAt: true },
        })).resolves.toEqual({ refreshRequestedAt: null });
    });

    it("serves every advertised operation through the canonical qualified repositories", async () => {
        harness.resetEnv({
            HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
            HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
            HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
                "none",
        });
        const account = await db.account.create({
            data: {
                publicKey: null,
                encryptionMode: "plain",
            },
            select: { id: true },
        });
        const headers = { "x-test-user-id": account.id };

        await withAuthenticatedTestApp(
            registerQualifiedConnectedAccountCredentialRoutesV4,
            async (app) => {
                const createdCredential = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/credential",
                    headers,
                    payload: {
                        ref,
                        authenticationModeId: "api-key",
                        expectedCredentialRevision: null,
                        content: {
                            t: "plain",
                            v: { token: "credential-secret" },
                        },
                        metadata: {
                            providerIdentity: {
                                accountId: "acct-v4",
                                email: "account@example.com",
                            },
                            scopes: ["account.read"],
                        },
                        initialConfiguration: {
                            expectedConfigurationRevision: null,
                            replacementContentEnvelope: {
                                t: "plain",
                                v: { region: "eu" },
                            },
                        },
                    },
                });
                expect(createdCredential.statusCode).toBe(200);
                const createdCredentialBody = createdCredential.json() as {
                    credentialRevision: string;
                    configurationRevision: string;
                };

                const encodedService =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountServiceRefSchema,
                        service,
                    );
                const listedAccounts = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/accounts?service="
                        + encodeURIComponent(encodedService),
                    headers,
                });
                expect(listedAccounts.statusCode).toBe(200);
                expect(listedAccounts.json()).toMatchObject({
                    service,
                    accounts: [{
                        ref,
                        credentialRevision:
                            createdCredentialBody.credentialRevision,
                        configurationRevision:
                            createdCredentialBody.configurationRevision,
                    }],
                });

                const encodedRef =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountRefSchema,
                        ref,
                    );
                const readCredential = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(readCredential.statusCode).toBe(200);
                expect(readCredential.json()).toMatchObject({
                    ref,
                    credentialRevision:
                        createdCredentialBody.credentialRevision,
                    configurationRevision:
                        createdCredentialBody.configurationRevision,
                    content: {
                        t: "plain",
                        v: { token: "credential-secret" },
                    },
                });

                const configurationTarget = {
                    kind: "account",
                    ref,
                } as const;
                const encodedTarget =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountConfigurationTargetV4Schema,
                        configurationTarget,
                    );
                const readConfiguration = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/configuration?target="
                        + encodeURIComponent(encodedTarget),
                    headers,
                });
                expect(readConfiguration.statusCode).toBe(200);
                expect(readConfiguration.json()).toMatchObject({
                    target: configurationTarget,
                    credentialRevision:
                        createdCredentialBody.credentialRevision,
                    configurationRevision:
                        createdCredentialBody.configurationRevision,
                    configurationContent: {
                        t: "plain",
                        v: { region: "eu" },
                    },
                });

                const patchedConfiguration = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/configuration",
                    headers,
                    payload: {
                        target: configurationTarget,
                        expectedCredentialRevision:
                            createdCredentialBody.credentialRevision,
                        expectedConfigurationRevision:
                            createdCredentialBody.configurationRevision,
                        replacementContentEnvelope: {
                            t: "plain",
                            v: { region: "us" },
                        },
                    },
                });
                expect(patchedConfiguration.statusCode).toBe(200);
                const patchedConfigurationBody =
                    patchedConfiguration.json() as {
                        credentialRevision: string;
                        configurationRevision: string;
                    };
                expect(
                    patchedConfigurationBody.configurationRevision,
                ).not.toBe(createdCredentialBody.configurationRevision);

                const patchedHealth = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/credential/health",
                    headers,
                    payload: {
                        ref,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        expectedConfigurationRevision:
                            patchedConfigurationBody.configurationRevision,
                        health: {
                            v: 1,
                            status: "needs_reauth",
                            reconnectRequired: true,
                        },
                    },
                });
                expect(patchedHealth.statusCode).toBe(200);

                const acquiredLease = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/credential/refresh-lease",
                    headers,
                    payload: {
                        ref,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        ownerId: "daemon:one",
                        ttlMs: 30_000,
                    },
                });
                expect(acquiredLease.statusCode).toBe(200);
                expect(acquiredLease.json()).toMatchObject({
                    acquired: true,
                    ownerId: "daemon:one",
                    credentialRevision:
                        patchedConfigurationBody.credentialRevision,
                });

                const createdGroup = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/groups",
                    headers,
                    payload: {
                        service,
                        group: {
                            groupId: groupRef.groupId,
                            displayName: "Primary",
                        },
                    },
                });
                expect(createdGroup.statusCode).toBe(200);
                let group =
                    createdGroup.json()
                        .group as QualifiedConnectedAccountGroupV4;

                const listedGroups = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/groups?service="
                        + encodeURIComponent(encodedService),
                    headers,
                });
                expect(listedGroups.statusCode).toBe(200);
                expect(listedGroups.json()).toMatchObject({
                    groups: [{ ref: groupRef }],
                });

                const addedMember = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/group/members",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        priority: 10,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(addedMember.statusCode).toBe(200);
                group = addedMember.json().group;

                const staleActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation - 1,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(staleActive.statusCode).toBe(409);
                expect(staleActive.json()).toEqual({
                    error: "connect_group_generation_conflict",
                    generation: group.generation,
                });

                const setActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(setActive.statusCode).toBe(200);
                group = setActive.json().group;

                const staleSourceActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        expectedSource: {
                            connectedAccountId: ref.accountId,
                            credentialRevision:
                                "csr_abcdefghijklmnopqrstuv",
                            configurationRevision:
                                patchedConfigurationBody
                                    .configurationRevision,
                        },
                    },
                });
                expect(staleSourceActive.statusCode).toBe(409);
                expect(staleSourceActive.json()).toEqual({
                    error: "connect_group_source_revision_conflict",
                });

                const currentSourceActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        expectedSource: {
                            connectedAccountId: ref.accountId,
                            credentialRevision:
                                patchedConfigurationBody
                                    .credentialRevision,
                            configurationRevision:
                                patchedConfigurationBody
                                    .configurationRevision,
                        },
                    },
                });
                expect(currentSourceActive.statusCode).toBe(200);
                group = currentSourceActive.json().group;

                const patchedGroup = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        displayName: "Renamed",
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(patchedGroup.statusCode).toBe(200);
                group = patchedGroup.json().group;

                const patchedRuntimeState = await app.inject({
                    method: "PATCH",
                    url:
                        "/v4/connect/qualified/group/runtime-state",
                    headers,
                    payload: {
                        service,
                        groupId: groupRef.groupId,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        runtimeState: {
                            state: { status: "ready" },
                            memberStates: [{
                                connectedAccountId: ref.accountId,
                                state: {
                                    lastObservedAtMs: 1,
                                    quotaExhaustedUntilMs:
                                        Date.now() + 60_000,
                                },
                            }],
                        },
                    },
                });
                expect(patchedRuntimeState.statusCode).toBe(200);
                group = patchedRuntimeState.json().group;

                const runtimeBlockerResetAtMs =
                    group.members[0].state.quotaExhaustedUntilMs as number;
                const blockedActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(blockedActive.statusCode).toBe(409);
                expect(blockedActive.json()).toEqual({
                    error: "connect_group_profile_runtime_cooldown",
                    resetAtMs: runtimeBlockerResetAtMs,
                });

                const overriddenActive = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/group/active-account",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        expectedGeneration: group.generation,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                        overrideRuntimeCooldown: true,
                    },
                });
                expect(overriddenActive.statusCode).toBe(200);
                group = overriddenActive.json().group;

                const updatedMember = await app.inject({
                    method: "PATCH",
                    url: "/v4/connect/qualified/group/member",
                    headers,
                    payload: {
                        group: groupRef,
                        connectedAccountId: ref.accountId,
                        priority: 20,
                        enabled: true,
                        expectedRuntimeStateRevision:
                            group.runtimeStateRevision,
                    },
                });
                expect(updatedMember.statusCode).toBe(200);
                group = updatedMember.json().group;

                const encodedGroup =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountGroupRefSchema,
                        groupRef,
                    );
                const readGroup = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedRuntimeStateRevision="
                        + group.runtimeStateRevision,
                    headers,
                });
                expect(readGroup.statusCode).toBe(200);
                expect(readGroup.json()).toMatchObject({
                    group: {
                        ref: groupRef,
                        displayName: "Renamed",
                        activeConnectedAccountId: ref.accountId,
                        state: { status: "ready" },
                        members: [{
                            connectedAccountId: ref.accountId,
                            priority: 20,
                        }],
                    },
                });

                const memberDelete = {
                    group: groupRef,
                    connectedAccountId: ref.accountId,
                    expectedRuntimeStateRevision:
                        group.runtimeStateRevision,
                };
                const encodedMemberDelete =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedAccountGroupMemberDeleteV4Schema,
                        memberDelete,
                    );
                const deletedMember = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group/member?mutation="
                        + encodeURIComponent(encodedMemberDelete),
                    headers,
                });
                expect(deletedMember.statusCode).toBe(200);
                group = deletedMember.json().group;

                const deletedGroup = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/group?group="
                        + encodeURIComponent(encodedGroup)
                        + "&expectedRuntimeStateRevision="
                        + group.runtimeStateRevision,
                    headers,
                });
                expect(deletedGroup.statusCode).toBe(200);
                expect(deletedGroup.json()).toEqual({ success: true });

                const recordKey =
                    createProviderAccountUsageRecordKey({
                        accountSubjectId: "acct-v4",
                    });
                const snapshot = createUsageSnapshot({
                    fetchedAt: Date.now(),
                    recordKey,
                    planLabel: "V4 plan",
                });
                const writtenUsage = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage",
                    headers,
                    payload: {
                        source,
                        expectedCredentialRevision:
                            patchedConfigurationBody.credentialRevision,
                        expectedConfigurationRevision:
                            patchedConfigurationBody.configurationRevision,
                        recordId: snapshot.recordId,
                        recordKey: snapshot.recordKey,
                        payloadMode: "plain_json_v1",
                        status: "ok",
                        snapshot,
                        fetchedAt: snapshot.fetchedAtMs,
                        staleAfterMs: snapshot.staleAfterMs,
                    },
                });
                expect(writtenUsage.statusCode).toBe(200);
                expect(writtenUsage.json()).toEqual({
                    success: true,
                    source: { status: "linked" },
                });

                const encodedSource =
                    encodeQualifiedConnectedAccountV4StructuredQueryValue(
                        QualifiedConnectedServiceUsageSourceV4Schema,
                        source,
                    );
                const resolvedSource = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/sources/resolve?source="
                        + encodeURIComponent(encodedSource),
                    headers,
                });
                expect(resolvedSource.statusCode).toBe(200);
                expect(resolvedSource.json()).toMatchObject({
                    source,
                    recordId: snapshot.recordId,
                    providerAccountId: "acct-v4",
                });

                const readUsageRecord = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(readUsageRecord.statusCode).toBe(200);
                expect(readUsageRecord.json()).toMatchObject({
                    content: {
                        t: "plain",
                        v: { recordId: snapshot.recordId },
                    },
                    sources: [source],
                });

                await db.connectedServiceUsageSource.updateMany({
                    where: {
                        accountId: account.id,
                        providerAccountUsageRecordId:
                            snapshot.recordId,
                    },
                    data: { bindingKind: "unsupported" },
                });
                const unsupportedSourceRecord =
                    await app.inject({
                        method: "GET",
                        url:
                            "/v4/connect/qualified/provider-account-usage/record?recordId="
                            + encodeURIComponent(snapshot.recordId),
                        headers,
                    });
                expect(unsupportedSourceRecord.statusCode).toBe(404);
                await db.connectedServiceUsageSource.updateMany({
                    where: {
                        accountId: account.id,
                        providerAccountUsageRecordId:
                            snapshot.recordId,
                    },
                    data: { bindingKind: "account" },
                });

                const readQuota = await app.inject({
                    method: "GET",
                    url:
                        "/v4/connect/qualified/quotas?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(readQuota.statusCode).toBe(200);
                expect(readQuota.json()).toMatchObject({
                    ref,
                    content: {
                        t: "plain",
                        v: {
                            ref,
                            planLabel: "V4 plan",
                        },
                    },
                });

                const refreshedQuota = await app.inject({
                    method: "POST",
                    url: "/v4/connect/qualified/quotas/refresh",
                    headers,
                    payload: { ref },
                });
                expect(refreshedQuota.statusCode).toBe(200);

                const refreshedUsageRecord = await app.inject({
                    method: "POST",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record/refresh",
                    headers,
                    payload: { recordId: snapshot.recordId },
                });
                expect(refreshedUsageRecord.statusCode).toBe(200);

                const deletedQuota = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/quotas?ref="
                        + encodeURIComponent(encodedRef),
                    headers,
                });
                expect(deletedQuota.statusCode).toBe(200);

                const deletedUsageRecord = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/provider-account-usage/record?recordId="
                        + encodeURIComponent(snapshot.recordId),
                    headers,
                });
                expect(deletedUsageRecord.statusCode).toBe(404);
                expect(deletedUsageRecord.json()).toEqual({
                    error: "provider_account_usage_not_found",
                });

                const deletedCredential = await app.inject({
                    method: "DELETE",
                    url:
                        "/v4/connect/qualified/credential?ref="
                        + encodeURIComponent(encodedRef)
                        + "&expectedCredentialRevision="
                        + encodeURIComponent(
                            patchedConfigurationBody.credentialRevision,
                        )
                        + "&cleanupGroupReferences=false",
                    headers,
                });
                expect(deletedCredential.statusCode).toBe(200);
                expect(deletedCredential.json()).toEqual({
                    success: true,
                });
            },
        );
    });
});
