import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
    CredentialAccessDeclarationDigestSchema,
    CredentialAccessSelectedAuthorityDigestSchema,
    CredentialAccessSelectedRawAccessDigestSchema,
    GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
    PluginCredentialAccessSlotIdSchema,
    PluginInstallReviewPrincipalDigestSchema,
    PluginPermissionInstalledGenerationIdSchema,
    type PluginPermissionSubjectV1,
} from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPluginPermissionGrantOperations } from "./operations";

const accountId = "account-plugin-permission-subjects";
const pluginId = "happier.voice.subject-contract";
const authoritySource = {
    kind: "machine_installation",
    machineId: "machine-plugin-permission-subjects",
    installationId: "installation-plugin-permission-subjects",
} as const;
const credentialSubject = {
    kind: "credential_access_disclosure",
    contribution: { pluginId, localId: "conversation" },
    credentialSlotId: PluginCredentialAccessSlotIdSchema.parse("api-key"),
    purpose: "voice-session",
    accessDeclarationDigest: CredentialAccessDeclarationDigestSchema.parse("a".repeat(64)),
    selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema.parse("c".repeat(64)),
    selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema.parse("d".repeat(64)),
    installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse("generation-1"),
    installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse("b".repeat(64)),
} as const satisfies PluginPermissionSubjectV1;
const credentialSubjects = [
    credentialSubject,
    {
        ...credentialSubject,
        contribution: { ...credentialSubject.contribution, localId: "transcription" },
    },
    {
        ...credentialSubject,
        credentialSlotId: PluginCredentialAccessSlotIdSchema.parse("oauth-token"),
    },
    {
        ...credentialSubject,
        purpose: "voice-configuration",
    },
    {
        ...credentialSubject,
        accessDeclarationDigest: CredentialAccessDeclarationDigestSchema.parse("c".repeat(64)),
    },
    {
        ...credentialSubject,
        selectedAuthorityDigest: CredentialAccessSelectedAuthorityDigestSchema.parse("e".repeat(64)),
    },
    {
        ...credentialSubject,
        selectedRawAccessDigest: CredentialAccessSelectedRawAccessDigestSchema.parse("f".repeat(64)),
    },
    {
        ...credentialSubject,
        installedGenerationId: PluginPermissionInstalledGenerationIdSchema.parse("generation-2"),
    },
    {
        ...credentialSubject,
        installReviewPrincipalDigest: PluginInstallReviewPrincipalDigestSchema.parse("d".repeat(64)),
    },
] as const satisfies readonly PluginPermissionSubjectV1[];

describe("plugin permission strict subject durable storage", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-plugin-permission-subjects-",
            initAuth: false,
        });
    }, 120_000);

    afterAll(async () => {
        await harness.close();
    });

    afterEach(async () => {
        harness.resetEnv();
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_events").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grants").catch(() => undefined);
        await db.$executeRawUnsafe("DELETE FROM plugin_permission_grant_requests").catch(() => undefined);
        await harness.resetDbTables([
            () => db.machine.deleteMany(),
            () => db.account.deleteMany(),
        ]);
    });

    it("round-trips general and credential subjects through request, grant, revoke, audit, and active identity indexes", async () => {
        await db.account.create({
            data: {
                id: accountId,
                publicKey: "pk-plugin-permission-subjects",
                encryptionMode: "plain",
            },
        });
        await db.machine.create({
            data: {
                id: authoritySource.machineId,
                accountId,
                metadata: "{}",
                installationId: authoritySource.installationId,
            },
        });

        let nextId = 0;
        let now = 1;
        const operations = createPluginPermissionGrantOperations(undefined, {
            createId: (prefix) => `${prefix}-${++nextId}`,
            now: () => now++,
        });
        const request = (subject: PluginPermissionSubjectV1) => operations.request({
            accountId,
            userId: accountId,
            publisher: authoritySource,
            input: {
                pluginId,
                capability: "credentials.materialize.raw",
                targetScope: { kind: "account" },
                subject,
                requester: { kind: "plugin", pluginId },
                reason: "Exercise strict permission subject persistence.",
            },
        });

        const generalRequest = await request(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1);
        const credentialRequests = [];
        for (const subject of credentialSubjects) {
            credentialRequests.push(await request(subject));
        }
        const credentialRequest = credentialRequests[0]!;
        const credentialRetry = await request(credentialSubject);

        expect(credentialRetry).toEqual(credentialRequest);
        const pendingIdentityRows = await db.$queryRaw<Array<{
            subject_json: string;
            active_identity_key: string | null;
        }>>`
            SELECT subject_json, active_identity_key
            FROM plugin_permission_grant_requests
            WHERE account_id = ${accountId}
            ORDER BY subject_json ASC
        `;
        expect(pendingIdentityRows).toHaveLength(1 + credentialSubjects.length);
        expect(new Set(pendingIdentityRows.map((row) => row.active_identity_key)).size)
            .toBe(1 + credentialSubjects.length);
        expect(pendingIdentityRows.every((row) => row.active_identity_key !== null)).toBe(true);

        const generalGrant = await operations.grant({
            accountId,
            userId: accountId,
            input: { requestId: generalRequest.pendingRequest.id },
        });
        const credentialGrants = [];
        for (const pending of credentialRequests) {
            credentialGrants.push(await operations.grant({
                accountId,
                userId: accountId,
                input: { requestId: pending.pendingRequest.id },
            }));
        }
        const credentialGrant = credentialGrants[0]!;
        await expect(operations.grant({
            accountId,
            userId: accountId,
            input: { requestId: credentialRequest.pendingRequest.id },
        })).resolves.toEqual(credentialGrant);

        const activeGrantRows = await db.$queryRaw<Array<{
            id: string;
            subject_json: string;
            active_identity_key: string | null;
        }>>`
            SELECT id, subject_json, active_identity_key
            FROM plugin_permission_grants
            WHERE account_id = ${accountId}
            ORDER BY subject_json ASC
        `;
        expect(activeGrantRows).toHaveLength(1 + credentialSubjects.length);
        expect(new Set(activeGrantRows.map((row) => row.active_identity_key)).size)
            .toBe(1 + credentialSubjects.length);
        expect(activeGrantRows.every((row) => row.active_identity_key !== null)).toBe(true);

        await expect(operations.list({
            accountId,
            input: {
                subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
                includeRevoked: false,
                includeResolvedRequests: false,
                limit: 50,
            },
        })).resolves.toMatchObject({ grants: [{ id: generalGrant.grant.id }], pendingRequests: [] });
        for (const [index, subject] of credentialSubjects.entries()) {
            await expect(operations.list({
                accountId,
                input: {
                    subject,
                    includeRevoked: false,
                    includeResolvedRequests: false,
                    limit: 50,
                },
            })).resolves.toMatchObject({
                grants: [{ id: credentialGrants[index]!.grant.id, subject }],
                pendingRequests: [],
            });
        }

        const revoked = await operations.revoke({
            accountId,
            userId: accountId,
            input: { grantId: credentialGrant.grant.id },
        });
        expect(revoked.grant).toMatchObject({
            id: credentialGrant.grant.id,
            subject: credentialSubject,
            status: "revoked",
        });

        const postRevokeRows = await db.$queryRaw<Array<{ id: string; active_identity_key: string | null }>>`
            SELECT id, active_identity_key
            FROM plugin_permission_grants
            WHERE account_id = ${accountId}
            ORDER BY id ASC
        `;
        expect(postRevokeRows).toHaveLength(1 + credentialSubjects.length);
        expect(postRevokeRows.find((row) => row.id === generalGrant.grant.id)?.active_identity_key)
            .toEqual(expect.any(String));
        expect(postRevokeRows.find((row) => row.id === credentialGrant.grant.id)?.active_identity_key)
            .toBeNull();
        for (const retainedGrant of credentialGrants.slice(1)) {
            expect(postRevokeRows.find((row) => row.id === retainedGrant.grant.id)?.active_identity_key)
                .toEqual(expect.any(String));
        }

        const replacementRequest = await request(credentialSubject);
        expect(replacementRequest.pendingRequest.id).not.toBe(credentialRequest.pendingRequest.id);
        const replacementGrant = await operations.grant({
            accountId,
            userId: accountId,
            input: { requestId: replacementRequest.pendingRequest.id },
        });
        await expect(operations.list({
            accountId,
            input: {
                subject: credentialSubject,
                includeRevoked: false,
                includeResolvedRequests: false,
                limit: 50,
            },
        })).resolves.toMatchObject({
            grants: [{ id: replacementGrant.grant.id, subject: credentialSubject, status: "active" }],
            pendingRequests: [],
        });

        const auditRows = await db.$queryRaw<Array<{ event_kind: string; subject_json: string }>>`
            SELECT event_kind, subject_json
            FROM plugin_permission_grant_events
            WHERE account_id = ${accountId}
            ORDER BY created_at ASC
        `;
        expect(auditRows).toHaveLength(2 * credentialSubjects.length + 5);
        expect(auditRows.filter((row) => (
            row.subject_json === JSON.stringify(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1)
        )).map((row) => row.event_kind)).toEqual(["requested", "granted"]);
        expect(auditRows.filter((row) => (
            row.subject_json === JSON.stringify(credentialSubject)
        )).map((row) => row.event_kind)).toEqual(["requested", "granted", "revoked", "requested", "granted"]);
        for (const subject of credentialSubjects.slice(1)) {
            expect(auditRows.filter((row) => (
                row.subject_json === JSON.stringify(subject)
            )).map((row) => row.event_kind)).toEqual(["requested", "granted"]);
        }

        for (const [table, indexName] of [
            ["plugin_permission_grants", "plugin_permission_grants_active_identity_key"],
            ["plugin_permission_grant_requests", "plugin_permission_requests_active_identity_key"],
        ] as const) {
            const indexes = await db.$queryRawUnsafe<Array<{ name: string; unique: bigint }>>(
                `PRAGMA index_list('${table}')`,
            );
            expect(indexes).toEqual(expect.arrayContaining([
                expect.objectContaining({ name: indexName, unique: 1n }),
            ]));
            const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(
                `PRAGMA index_info('${indexName}')`,
            );
            expect(columns.map((column) => column.name)).toEqual(["account_id", "active_identity_key"]);
        }
    });
});
