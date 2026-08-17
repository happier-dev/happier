import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

import { db, initDbMysql, initDbPostgres } from "@/storage/db";
import { createPluginPermissionGrantOperations } from "./operations";

function resolveContractProvider(): "postgres" | "mysql" {
    const raw = (process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? "postgres")
        .trim()
        .toLowerCase();
    if (raw === "postgres" || raw === "postgresql") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(`Unsupported plugin-permission contract provider: ${raw}`);
}

describe("plugin permission strict subject DB contract", () => {
    const provider = resolveContractProvider();

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error("Missing DATABASE_URL for DB contract test");
        if (provider === "mysql") await initDbMysql();
        else initDbPostgres();
        await db.$connect();
    });

    afterAll(async () => {
        await db.$disconnect();
    });

    it("preserves exact general and credential subjects across identity, lifecycle, audit, and indexes", async () => {
        const suffix = randomUUID();
        const accountId = `permission-subject-dbcontract-${suffix}`;
        const pluginId = `happier.voice.dbcontract.${suffix}`;
        const authoritySource = {
            kind: "machine_installation",
            machineId: `machine-${suffix}`,
            installationId: `installation-${suffix}`,
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

        await db.account.create({
            data: {
                id: accountId,
                publicKey: `pk-${suffix}`,
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

        try {
            let nextId = 0;
            let now = 1;
            const operations = createPluginPermissionGrantOperations(undefined, {
                createId: (prefix) => `${prefix}-${suffix}-${++nextId}`,
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
                    reason: "Exercise strict permission subject DB portability.",
                },
            });

            const generalRequest = await request(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1);
            const credentialRequests = [];
            for (const subject of credentialSubjects) {
                credentialRequests.push(await request(subject));
            }
            const credentialRequest = credentialRequests[0]!;
            await expect(request(credentialSubject)).resolves.toEqual(credentialRequest);

            const pendingRows = await db.$queryRaw<Array<{
                active_identity_key: string | null;
                subject_json: string;
            }>>`
                SELECT active_identity_key, subject_json
                FROM plugin_permission_grant_requests
                WHERE account_id = ${accountId}
            `;
            expect(pendingRows).toHaveLength(1 + credentialSubjects.length);
            expect(new Set(pendingRows.map((row) => row.active_identity_key)).size)
                .toBe(1 + credentialSubjects.length);
            expect(pendingRows.every((row) => row.active_identity_key !== null)).toBe(true);

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

            const activeRows = await db.$queryRaw<Array<{
                active_identity_key: string | null;
                subject_json: string;
            }>>`
                SELECT active_identity_key, subject_json
                FROM plugin_permission_grants
                WHERE account_id = ${accountId}
                AND status = 'active'
            `;
            expect(activeRows).toHaveLength(1 + credentialSubjects.length);
            expect(new Set(activeRows.map((row) => row.active_identity_key)).size)
                .toBe(1 + credentialSubjects.length);
            expect(activeRows.every((row) => row.active_identity_key !== null)).toBe(true);

            await operations.revoke({
                accountId,
                userId: accountId,
                input: { grantId: credentialGrant.grant.id },
            });
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
            for (const [index, subject] of credentialSubjects.slice(1).entries()) {
                await expect(operations.list({
                    accountId,
                    input: {
                        subject,
                        includeRevoked: false,
                        includeResolvedRequests: false,
                        limit: 50,
                    },
                })).resolves.toMatchObject({
                    grants: [{ id: credentialGrants[index + 1]!.grant.id, subject }],
                    pendingRequests: [],
                });
            }
            await expect(operations.list({
                accountId,
                input: {
                    subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1,
                    includeRevoked: false,
                    includeResolvedRequests: false,
                    limit: 50,
                },
            })).resolves.toMatchObject({
                grants: [{ id: generalGrant.grant.id, subject: GENERAL_PLUGIN_PERMISSION_SUBJECT_V1 }],
                pendingRequests: [],
            });

            const auditRows = await db.$queryRaw<Array<{ event_kind: string; subject_json: string }>>`
                SELECT event_kind, subject_json
                FROM plugin_permission_grant_events
                WHERE account_id = ${accountId}
                ORDER BY created_at ASC
            `;
            expect(auditRows).toHaveLength(2 * credentialSubjects.length + 5);
            expect(auditRows.filter((row) => row.subject_json === JSON.stringify(credentialSubject))).toHaveLength(5);
            expect(auditRows.filter((row) => row.subject_json === JSON.stringify(GENERAL_PLUGIN_PERMISSION_SUBJECT_V1))).toHaveLength(2);
            for (const subject of credentialSubjects.slice(1)) {
                expect(auditRows.filter((row) => row.subject_json === JSON.stringify(subject))).toHaveLength(2);
            }

            if (provider === "mysql") {
                const indexRows = await db.$queryRaw<Array<{
                    COLUMN_NAME: string;
                    INDEX_NAME: string;
                    NON_UNIQUE: bigint | number;
                    SEQ_IN_INDEX: bigint | number;
                    TABLE_NAME: string;
                }>>`
                    SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
                    FROM information_schema.statistics
                    WHERE table_schema = DATABASE()
                    AND (
                        (table_name = 'plugin_permission_grants'
                            AND index_name = 'plugin_permission_grants_active_identity_key')
                        OR
                        (table_name = 'plugin_permission_grant_requests'
                            AND index_name = 'plugin_permission_requests_active_identity_key')
                    )
                    ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
                `;
                expect(indexRows.map((row) => ({
                    column: row.COLUMN_NAME,
                    index: row.INDEX_NAME,
                    table: row.TABLE_NAME,
                    unique: Number(row.NON_UNIQUE) === 0,
                }))).toEqual([
                    {
                        column: "account_id",
                        index: "plugin_permission_requests_active_identity_key",
                        table: "plugin_permission_grant_requests",
                        unique: true,
                    },
                    {
                        column: "active_identity_key",
                        index: "plugin_permission_requests_active_identity_key",
                        table: "plugin_permission_grant_requests",
                        unique: true,
                    },
                    {
                        column: "account_id",
                        index: "plugin_permission_grants_active_identity_key",
                        table: "plugin_permission_grants",
                        unique: true,
                    },
                    {
                        column: "active_identity_key",
                        index: "plugin_permission_grants_active_identity_key",
                        table: "plugin_permission_grants",
                        unique: true,
                    },
                ]);
            } else {
                const indexRows = await db.$queryRaw<Array<{ indexname: string; indexdef: string }>>`
                    SELECT indexname, indexdef
                    FROM pg_indexes
                    WHERE schemaname = current_schema()
                    AND (
                        (tablename = 'plugin_permission_grants'
                            AND indexname = 'plugin_permission_grants_active_identity_key')
                        OR
                        (tablename = 'plugin_permission_grant_requests'
                            AND indexname = 'plugin_permission_requests_active_identity_key')
                    )
                    ORDER BY indexname ASC
                `;
                expect(indexRows).toEqual([
                    expect.objectContaining({
                        indexname: "plugin_permission_grants_active_identity_key",
                        indexdef: expect.stringMatching(/UNIQUE.*\(account_id, active_identity_key\)/u),
                    }),
                    expect.objectContaining({
                        indexname: "plugin_permission_requests_active_identity_key",
                        indexdef: expect.stringMatching(/UNIQUE.*\(account_id, active_identity_key\)/u),
                    }),
                ]);
            }
        } finally {
            await db.machine.deleteMany({ where: { accountId } }).catch(() => undefined);
            await db.account.delete({ where: { id: accountId } }).catch(() => undefined);
        }
    });
});
