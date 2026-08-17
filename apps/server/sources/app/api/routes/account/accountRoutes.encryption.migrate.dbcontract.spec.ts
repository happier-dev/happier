import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Fastify from "fastify";
import {
    serializerCompiler,
    validatorCompiler,
    ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";
import tweetnacl from "tweetnacl";
import * as privacyKit from "privacy-kit";

import {
    ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES,
    ARTIFACT_PLAIN_DATA_KEY_MARKER,
    attachAccountEncryptionMigrateProofSignatureV1,
    buildAccountStoredContentCompatibilityHttpHeadersV1,
    createPlainSessionOwnerMetadataEnvelopeV1,
    createAccountEncryptionMigrateProofSigningInputV1,
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodeSessionOwnerMetadataEnvelopeV1,
    encodePlainArtifactStoredContent,
    sealSessionOwnerMetadataEnvelopeV1,
    type AccountEncryptionMigrateRequest,
    type AccountEncryptionMigrateUnsignedRequest,
} from "@happier-dev/protocol";

import {
    db,
    initDbMysql,
    initDbPostgres,
} from "@/storage/db";
import { initEncrypt } from "@/modules/encrypt";
import { enableErrorHandlers } from "@/app/api/utils/enableErrorHandlers";
import {
    deriveAccountEncryptionMigrationKeyFingerprints,
} from "@/app/encryption/accountEncryptionTransition";
import {
    captureAccountStoredContentCompatibilityForHttpRequest,
} from "@/app/clientCompatibility/accountStoredContentCompatibility";
import {
    mutateConnectedServiceCredential,
} from "../connect/credentials/mutation";
import {
    mutateQualifiedConnectedServiceCredential,
    readQualifiedConnectedAccountConfiguration,
    readQualifiedConnectedServiceCredential,
    readQualifiedConnectedServiceCredentialForLegacyProjection,
} from "../connect/qualifiedConnectedAccounts/credentialRepository";
import {
    resolveLegacyServiceAccountTokenIdentityFields,
} from "../connect/qualifiedConnectedAccounts/identity";
import {
    writeQualifiedProviderAccountUsageRecord,
} from "../connect/qualifiedConnectedAccounts/usageRepository";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../connect/providerAccountUsageTestkit";
import { registerAccountEncryptionMigrateRoutes } from "./registerAccountEncryptionMigrateRoutes";

type NativeDbProvider = "postgres" | "mysql";
type StaleFence =
    | "legacy_credential"
    | "qualified_credential"
    | "qualified_configuration"
    | "automation";

const SOURCE_LEGACY_CREDENTIAL_BYTES =
    "native-db-legacy-credential-before";
const SOURCE_SETTINGS = "native-db-settings-before";
const SOURCE_MACHINE_METADATA =
    "native-db-machine-metadata-before";
const SOURCE_TODO_BYTES = "native-db-todo-before";
const SOURCE_ARTIFACT_HEADER =
    "native-db-artifact-header-before";
const SOURCE_ARTIFACT_BODY =
    "native-db-artifact-body-before";
const SOURCE_AUTOMATION_TEMPLATE = JSON.stringify({
    kind: "happier_automation_template_encrypted_v1",
    payloadCiphertext: "native-db-automation-before",
});
const TARGET_AUTOMATION_TEMPLATE = JSON.stringify({
    kind: "happier_automation_template_plain_v1",
    payload: { prompt: "native-db-automation-after" },
});
const SESSION_OWNER_MATERIAL = {
    type: "legacy",
    secret: new Uint8Array(32).fill(43),
} as const;
const SOURCE_SESSION_OWNER_METADATA =
    sealSessionOwnerMetadataEnvelopeV1({
        material: SESSION_OWNER_MATERIAL,
        ownerMetadata: { v: 1 },
        randomBytes: (length) =>
            new Uint8Array(length).fill(47),
    });
const TARGET_SESSION_OWNER_METADATA =
    createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });

const requireFromHere = createRequire(import.meta.url);
const createdAccountIds = new Set<string>();

function resolveContractProviderFromEnv(): NativeDbProvider {
    const raw = (
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres"
    ).toString().trim().toLowerCase();
    if (raw === "postgresql" || raw === "postgres") {
        return "postgres";
    }
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

const provider = resolveContractProviderFromEnv();

function encodePlainStoredJson(value: unknown): string {
    return Buffer.from(
        JSON.stringify({ t: "plain", v: value }),
        "utf8",
    ).toString("base64");
}

function createPlainCredentialRecord(params: Readonly<{
    profileId: string;
    token: string;
}>) {
    return {
        v: 1 as const,
        serviceId: "anthropic" as const,
        profileId: params.profileId,
        createdAt: 1,
        updatedAt: 2,
        expiresAt: null,
        kind: "token" as const,
        oauth: null,
        token: {
            token: params.token,
            providerAccountId: "native-db-provider-account",
            providerEmail: "native-db@example.com",
            raw: null,
        },
    };
}

function createTestApp() {
    const app = Fastify({
        logger: false,
        bodyLimit:
            ACCOUNT_ENCRYPTION_MIGRATE_REQUEST_MAX_UTF8_BYTES
            + 2_000_000,
    });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed =
        app.withTypeProvider<ZodTypeProvider>() as any;

    typed.decorate(
        "authenticate",
        async (request: any, reply: any) => {
            const userId =
                request.headers["x-test-user-id"];
            if (
                typeof userId !== "string"
                || userId.length === 0
            ) {
                return reply
                    .code(401)
                    .send({ error: "Unauthorized" });
            }
            request.userId = userId;
            captureAccountStoredContentCompatibilityForHttpRequest(request);
        },
    );
    typed.addHook(
        "preValidation",
        async (request: any) => {
            if (
                request.method !== "POST"
                || request.url
                    !== "/v1/account/encryption/migrate"
                || !request.body
                || typeof request.body !== "object"
                || !("machines" in request.body)
                || "expectedAccountVersion" in request.body
            ) {
                return;
            }
            const accountId =
                request.headers["x-test-user-id"];
            if (typeof accountId !== "string") return;
            const account =
                await db.account.findUniqueOrThrow({
                    where: { id: accountId },
                    select: {
                        seq: true,
                        publicKey: true,
                        contentPublicKey: true,
                    },
                });
            const fingerprints =
                deriveAccountEncryptionMigrationKeyFingerprints(
                    account,
                );
            Object.assign(request.body, {
                expectedAccountVersion: account.seq,
                expectedSigningKeyFingerprint:
                    fingerprints.signingKeyFingerprint,
                expectedContentKeyFingerprint:
                    fingerprints.contentKeyFingerprint,
            });
        },
    );
    enableErrorHandlers(typed);
    registerAccountEncryptionMigrateRoutes(typed);
    return typed;
}

async function executeMysqlDdl(sql: string): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        throw new Error("Missing DATABASE_URL for MySQL DDL");
    }
    const prismaCliPath =
        requireFromHere.resolve("prisma/build/index.js");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(
            process.execPath,
            [
                prismaCliPath,
                "db",
                "execute",
                "--stdin",
                "--url",
                databaseUrl,
            ],
            {
                cwd: process.cwd(),
                env: process.env,
                stdio: ["pipe", "ignore", "pipe"],
            },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(
                `Prisma MySQL DDL execution exited with code ${code}: ${stderr.trim()}`,
            ));
        });
        child.stdin.end(sql);
    });
}

function sqlString(value: string): string {
    if (value.includes("\0")) {
        throw new Error("NUL is not valid in SQL test literals");
    }
    return `'${value.split("'").join("''")}'`;
}

type MigrationFixture = Awaited<
    ReturnType<typeof createMigrationFixture>
>;

async function installFinalAccountMutationOrderingTrigger(
    fixture: MigrationFixture,
): Promise<() => Promise<void>> {
    const suffix = randomUUID().split("-").join("");
    const triggerName =
        `account_migrate_last_${suffix}`;
    const accountId = sqlString(fixture.account.id);
    const machineId = sqlString(fixture.machine.id);
    const machineMetadata =
        sqlString(fixture.target.machineMetadata);
    const todoKey = sqlString(fixture.todo.key);
    const artifactId = sqlString(fixture.artifact.id);
    const automationId =
        sqlString(fixture.automation.id);
    const automationTemplate =
        sqlString(fixture.target.automationTemplate);
    const activeSessionId =
        sqlString(fixture.sessions.active.id);
    const archivedSessionId =
        sqlString(fixture.sessions.archived.id);
    const targetSessionOwnerMetadata =
        sqlString(
            encodeSessionOwnerMetadataEnvelopeV1(
                TARGET_SESSION_OWNER_METADATA,
            ),
        );
    const qualifiedRowId =
        sqlString(fixture.qualifiedRowId);
    const sourceConfigurationRevisionValue =
        fixture.qualified.configurationRevision;
    if (sourceConfigurationRevisionValue === null) {
        throw new Error(
            "Configured qualified fixture requires a configuration revision",
        );
    }
    const sourceConfigurationRevision =
        sqlString(sourceConfigurationRevisionValue);

    if (provider === "mysql") {
        await executeMysqlDdl(`
            CREATE TRIGGER \`${triggerName}\`
            BEFORE UPDATE ON \`Account\`
            FOR EACH ROW
            BEGIN
                IF NEW.\`id\` = ${accountId}
                    AND OLD.\`encryptionMode\` = 'e2ee'
                    AND NEW.\`encryptionMode\` = 'plain'
                    AND OLD.\`settingsVersion\` = 1
                    AND EXISTS (
                        SELECT 1 FROM \`Machine\`
                        WHERE \`id\` = ${machineId}
                            AND \`metadata\` =
                                ${machineMetadata}
                            AND \`metadataVersion\` = 3
                            AND \`daemonStateVersion\` = 4
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`UserKVStore\`
                        WHERE \`accountId\` = ${accountId}
                            AND \`key\` = ${todoKey}
                            AND \`version\` = 5
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`Artifact\`
                        WHERE \`id\` = ${artifactId}
                            AND \`headerVersion\` = 6
                            AND \`bodyVersion\` = 7
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`ServiceAccountToken\`
                        WHERE \`accountId\` = ${accountId}
                            AND \`vendor\` = 'anthropic'
                            AND \`profileId\` = 'legacy'
                            AND \`token\` <>
                                CONVERT(
                                    ${sqlString(SOURCE_LEGACY_CREDENTIAL_BYTES)}
                                    USING utf8mb4
                                )
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`ServiceAccountToken\`
                        WHERE \`id\` = ${qualifiedRowId}
                            AND \`configuration_revision\`
                                <> ${sourceConfigurationRevision}
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`Automation\`
                        WHERE \`id\` = ${automationId}
                            AND \`templateCiphertext\` =
                                ${automationTemplate}
                            AND \`templateVersion\` = 1
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`Session\`
                        WHERE \`id\` = ${activeSessionId}
                            AND \`metadataLayoutVersion\` = 1
                            AND \`metadataVersion\` = 8
                            AND \`agentStateVersion\` = 9
                            AND \`ownerMetadata\` =
                                ${targetSessionOwnerMetadata}
                            AND \`archivedAt\` IS NULL
                    )
                    AND EXISTS (
                        SELECT 1 FROM \`Session\`
                        WHERE \`id\` = ${archivedSessionId}
                            AND \`metadataLayoutVersion\` = 1
                            AND \`metadataVersion\` = 10
                            AND \`agentStateVersion\` = 11
                            AND \`ownerMetadata\` =
                                ${targetSessionOwnerMetadata}
                            AND \`archivedAt\` IS NOT NULL
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM \`ConnectedServiceUsageSource\`
                        WHERE \`accountId\` = ${accountId}
                    )
                    AND NOT EXISTS (
                        SELECT 1
                        FROM \`ProviderAccountUsageRecord\`
                        WHERE \`accountId\` = ${accountId}
                    )
                THEN
                    SIGNAL SQLSTATE '45000'
                        SET MESSAGE_TEXT =
                            'intentional final Account mutation failure';
                END IF;
            END
        `);
        return async () => {
            await executeMysqlDdl(
                `DROP TRIGGER IF EXISTS \`${triggerName}\``,
            );
        };
    }

    const functionName = `${triggerName}_fn`;
    await db.$executeRawUnsafe(`
        CREATE FUNCTION "${functionName}"()
        RETURNS trigger
        LANGUAGE plpgsql
        AS $trigger$
        BEGIN
            IF NEW."id" = ${accountId}
                AND OLD."encryptionMode" = 'e2ee'
                AND NEW."encryptionMode" = 'plain'
                AND OLD."settingsVersion" = 1
                AND EXISTS (
                    SELECT 1 FROM "Machine"
                    WHERE "id" = ${machineId}
                        AND "metadata" = ${machineMetadata}
                        AND "metadataVersion" = 3
                        AND "daemonStateVersion" = 4
                )
                AND EXISTS (
                    SELECT 1 FROM "UserKVStore"
                    WHERE "accountId" = ${accountId}
                        AND "key" = ${todoKey}
                        AND "version" = 5
                )
                AND EXISTS (
                    SELECT 1 FROM "Artifact"
                    WHERE "id" = ${artifactId}
                        AND "headerVersion" = 6
                        AND "bodyVersion" = 7
                )
                AND EXISTS (
                    SELECT 1 FROM "ServiceAccountToken"
                    WHERE "accountId" = ${accountId}
                        AND "vendor" = 'anthropic'
                        AND "profileId" = 'legacy'
                        AND "token" <>
                            convert_to(
                                ${sqlString(SOURCE_LEGACY_CREDENTIAL_BYTES)},
                                'UTF8'
                            )
                )
                AND EXISTS (
                    SELECT 1 FROM "ServiceAccountToken"
                    WHERE "id" = ${qualifiedRowId}
                        AND "configuration_revision"
                            <> ${sourceConfigurationRevision}
                )
                AND EXISTS (
                    SELECT 1 FROM "Automation"
                    WHERE "id" = ${automationId}
                        AND "templateCiphertext" =
                            ${automationTemplate}
                        AND "templateVersion" = 1
                )
                AND EXISTS (
                    SELECT 1 FROM "Session"
                    WHERE "id" = ${activeSessionId}
                        AND "metadataLayoutVersion" = 1
                        AND "metadataVersion" = 8
                        AND "agentStateVersion" = 9
                        AND "ownerMetadata" =
                            ${targetSessionOwnerMetadata}
                        AND "archivedAt" IS NULL
                )
                AND EXISTS (
                    SELECT 1 FROM "Session"
                    WHERE "id" = ${archivedSessionId}
                        AND "metadataLayoutVersion" = 1
                        AND "metadataVersion" = 10
                        AND "agentStateVersion" = 11
                        AND "ownerMetadata" =
                            ${targetSessionOwnerMetadata}
                        AND "archivedAt" IS NOT NULL
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM "ConnectedServiceUsageSource"
                    WHERE "accountId" = ${accountId}
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM "ProviderAccountUsageRecord"
                    WHERE "accountId" = ${accountId}
                )
            THEN
                RAISE EXCEPTION
                    'intentional final Account mutation failure';
            END IF;
            RETURN NEW;
        END;
        $trigger$
    `);
    try {
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            BEFORE UPDATE ON "Account"
            FOR EACH ROW
            EXECUTE FUNCTION "${functionName}"()
        `);
    } catch (error) {
        await db.$executeRawUnsafe(
            `DROP FUNCTION IF EXISTS "${functionName}"()`,
        );
        throw error;
    }
    return async () => {
        await db.$executeRawUnsafe(`
            DROP TRIGGER IF EXISTS "${triggerName}"
            ON "Account"
        `);
        await db.$executeRawUnsafe(
            `DROP FUNCTION IF EXISTS "${functionName}"()`,
        );
    };
}

async function createMigrationFixture() {
    const unique = randomUUID().split("-").join("");
    const signing = tweetnacl.sign.keyPair();
    const content = tweetnacl.box.keyPair();
    const contentPublicKeySig = tweetnacl.sign.detached(
        Buffer.concat([
            Buffer.from("Happy content key v1\u0000", "utf8"),
            Buffer.from(content.publicKey),
        ]),
        signing.secretKey,
    );
    const account = await db.account.create({
        data: {
            publicKey: Buffer.from(
                signing.publicKey,
            ).toString("hex"),
            contentPublicKey:
                new Uint8Array(content.publicKey),
            contentPublicKeySig:
                new Uint8Array(contentPublicKeySig),
            encryptionMode: "e2ee",
            settings: SOURCE_SETTINGS,
            settingsVersion: 0,
        },
        select: { id: true, publicKey: true },
    });
    createdAccountIds.add(account.id);

    const legacy =
        await mutateConnectedServiceCredential({
            accountId: account.id,
            serviceId: "anthropic",
            profileId: "legacy",
            token: new TextEncoder().encode(
                SOURCE_LEGACY_CREDENTIAL_BYTES,
            ),
            metadata: {
                v: 2,
                format: "account_scoped_v1",
                kind: "token",
                providerAccountId:
                    "native-db-provider-account",
                providerEmail: "native-db@example.com",
            },
            expiresAt: null,
            storageMode: "sealed",
            incomingIdentity: {
                providerAccountId:
                    "native-db-provider-account",
                providerEmail: "native-db@example.com",
            },
            allowProviderIdentityChange: false,
            expectedCredentialRevision: null,
        });
    if (legacy.status !== "written") {
        throw new Error(
            "Failed to create legacy Connected Service fixture",
        );
    }

    const qualifiedRef = {
        service: {
            pluginId: "example.native-db-contract",
            localId: "account-migration",
        },
        accountId: `provider-${unique}`,
    } as const;
    const qualified =
        await mutateQualifiedConnectedServiceCredential({
            accountId: account.id,
            ref: qualifiedRef,
            expectedCredentialRevision: null,
            authenticationModeId: "api-key",
            content: {
                t: "encrypted",
                c: "native-db-qualified-credential-before",
            },
            metadata: {
                displayName: "Native DB account",
                scopes: ["account.read"],
                providerIdentity: {
                    accountId:
                        "native-db-qualified-subject",
                },
            },
            initialConfiguration: {
                expectedConfigurationRevision: null,
                replacementContentEnvelope: {
                    t: "encrypted",
                    c:
                        "native-db-qualified-configuration-before",
                },
            },
        });
    if (
        qualified.status !== "written"
        || qualified.configurationRevision === null
    ) {
        throw new Error(
            "Failed to create qualified Connected Service fixture",
        );
    }
    const qualifiedRow =
        await db.serviceAccountToken.findFirstOrThrow({
            where: {
                accountId: account.id,
                vendor: null,
                profileId: null,
            },
            select: { id: true },
        });

    const usageSnapshot = createUsageSnapshot({
        fetchedAt: Date.now(),
        recordKey: createProviderAccountUsageRecordKey({
            accountSubjectId:
                "native-db-qualified-subject",
        }),
    });
    await writeQualifiedProviderAccountUsageRecord({
        accountId: account.id,
        source: {
            ref: qualifiedRef,
            bindingKind: "account",
        },
        expectedCredentialRevision:
            qualified.credentialRevision,
        expectedConfigurationRevision:
            qualified.configurationRevision,
        recordId: usageSnapshot.recordId,
        recordKey: usageSnapshot.recordKey,
        payloadMode: "sealed_account_scoped_v1",
        sealedPayload: {
            format: "account_scoped_v1",
            ciphertext: "native-db-usage-before",
        },
        status: "ok",
        fetchedAt: usageSnapshot.fetchedAtMs,
        staleAfterMs: usageSnapshot.staleAfterMs,
        materialFingerprint: "native-db-usage",
    });

    const machine = await db.machine.create({
        data: {
            id: `machine-${unique}`,
            accountId: account.id,
            metadata: SOURCE_MACHINE_METADATA,
            metadataVersion: 2,
            daemonState:
                "native-db-daemon-state-before",
            daemonStateVersion: 3,
            dataEncryptionKey:
                new Uint8Array([1, 2, 3]),
        },
        select: { id: true },
    });
    const todo = await db.userKVStore.create({
        data: {
            accountId: account.id,
            key: "todo.index",
            value: new TextEncoder().encode(
                SOURCE_TODO_BYTES,
            ),
            version: 4,
        },
        select: { key: true },
    });
    const artifact = await db.artifact.create({
        data: {
            id: randomUUID(),
            accountId: account.id,
            header: new TextEncoder().encode(
                SOURCE_ARTIFACT_HEADER,
            ),
            headerVersion: 5,
            body: new TextEncoder().encode(
                SOURCE_ARTIFACT_BODY,
            ),
            bodyVersion: 6,
            dataEncryptionKey:
                new Uint8Array([4, 5, 6]),
        },
        select: { id: true },
    });
    const activeSession = await db.session.create({
        data: {
            accountId: account.id,
            tag: `native-db-active-${unique}`,
            metadata: "native-db-active-shared-before",
            metadataVersion: 8,
            metadataLayoutVersion: 1,
            ownerMetadata:
                encodeSessionOwnerMetadataEnvelopeV1(
                    SOURCE_SESSION_OWNER_METADATA,
                ),
            agentState: "native-db-active-agent-before",
            agentStateVersion: 9,
            archivedAt: null,
        },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
            seq: true,
        },
    });
    const archivedSession = await db.session.create({
        data: {
            accountId: account.id,
            tag: `native-db-archived-${unique}`,
            metadata: "native-db-archived-shared-before",
            metadataVersion: 10,
            metadataLayoutVersion: 1,
            ownerMetadata:
                encodeSessionOwnerMetadataEnvelopeV1(
                    SOURCE_SESSION_OWNER_METADATA,
                ),
            agentState: "native-db-archived-agent-before",
            agentStateVersion: 11,
            archivedAt: new Date(1_700_000_200_000),
        },
        select: {
            id: true,
            metadata: true,
            metadataVersion: true,
            metadataLayoutVersion: true,
            ownerMetadata: true,
            agentState: true,
            agentStateVersion: true,
            archivedAt: true,
            seq: true,
        },
    });
    const automation = await db.automation.create({
        data: {
            accountId: account.id,
            name: "Native DB migration automation",
            scheduleKind: "interval",
            everyMs: 60_000,
            timezone: null,
            scheduleExpr: null,
            targetType: "new_session",
            templateCiphertext:
                SOURCE_AUTOMATION_TEMPLATE,
        },
        select: {
            id: true,
            templateVersion: true,
        },
    });
    const sourceAccountVersion = (
        await db.account.findUniqueOrThrow({
            where: { id: account.id },
            select: { seq: true },
        })
    ).seq;

    return {
        account,
        sourceAccountVersion,
        legacyRevision: legacy.credentialRevision,
        qualified,
        qualifiedRef,
        qualifiedRowId: qualifiedRow.id,
        machine,
        todo,
        artifact,
        sessions: {
            active: activeSession,
            archived: archivedSession,
        },
        automation,
        target: {
            machineMetadata: encodePlainStoredJson({
                host: "native-db-host-after",
            }),
            machineDaemonState: encodePlainStoredJson({
                status: "running",
            }),
            machineDataKey: encodePlainStoredJson(null),
            todoValue: encodePlainStoredJson({
                undoneOrder: [],
                completedOrder: [],
            }),
            artifactHeader:
                encodePlainArtifactStoredContent({
                    title: "Native DB artifact",
                }),
            artifactBody:
                encodePlainArtifactStoredContent({
                    body: "Native DB artifact body",
                }),
            automationTemplate:
                TARGET_AUTOMATION_TEMPLATE,
        },
    };
}

function buildMigrationRequest(
    fixture: MigrationFixture,
    staleFence?: StaleFence,
) {
    return {
        toMode: "plain" as const,
        expectedSettingsVersion: 0,
        settingsContent: {
            t: "plain" as const,
            v: {
                schemaVersion: 2,
                source: "native-db-contract",
            },
        },
        connectedServices: {
            action: "migrate" as const,
            credentials: [{
                serviceId: "anthropic" as const,
                profileId: "legacy",
                expectedCredentialRevision:
                    staleFence === "legacy_credential"
                        ? "csr_0123456789ABCDEFGHJKMNPQRS"
                        : fixture.legacyRevision,
                kind: "plain" as const,
                record: createPlainCredentialRecord({
                    profileId: "legacy",
                    token:
                        "native-db-legacy-credential-after",
                }),
            }],
            qualifiedCredentials: [{
                ref: fixture.qualifiedRef,
                expectedCredentialRevision:
                    staleFence
                        === "qualified_credential"
                        ? "csr_0123456789ABCDEFGHJKMNPQRS"
                        : fixture.qualified
                            .credentialRevision,
                expectedConfigurationRevision:
                    staleFence
                        === "qualified_configuration"
                        ? "configuration-stale"
                        : fixture.qualified
                            .configurationRevision,
                authenticationModeId: "api-key",
                replacementCredentialContentEnvelope: {
                    t: "plain" as const,
                    v: {
                        token:
                            "native-db-qualified-credential-after",
                    },
                },
                replacementConfigurationContentEnvelope: {
                    t: "plain" as const,
                    v: {
                        endpoint:
                            "https://native-db.example.test",
                    },
                },
                metadata: {
                    displayName: "Native DB account",
                    scopes: ["account.read"],
                    providerIdentity: {
                        accountId:
                            "native-db-qualified-subject",
                    },
                },
            }],
        },
        automations: {
            action: "migrate" as const,
            templates: [{
                automationId: fixture.automation.id,
                expectedTemplateVersion:
                    staleFence === "automation"
                        ? fixture.automation
                            .templateVersion + 1
                        : fixture.automation
                            .templateVersion,
                templateCiphertext:
                    fixture.target.automationTemplate,
            }],
        },
        machines: {
            action: "migrate" as const,
            items: [{
                machineId: fixture.machine.id,
                expectedMetadataVersion: 2,
                expectedDaemonStateVersion: 3,
                metadata:
                    fixture.target.machineMetadata,
                daemonState:
                    fixture.target.machineDaemonState,
                dataEncryptionKey:
                    fixture.target.machineDataKey,
                contentPublicKeyFingerprint: null,
            }],
        },
        todos: {
            action: "migrate" as const,
            items: [{
                key: fixture.todo.key,
                expectedVersion: 4,
                value: fixture.target.todoValue,
            }],
        },
        artifacts: {
            action: "migrate" as const,
            items: [{
                artifactId: fixture.artifact.id,
                expectedHeaderVersion: 5,
                expectedBodyVersion: 6,
                header:
                    fixture.target.artifactHeader,
                body: fixture.target.artifactBody,
                dataEncryptionKey:
                    ARTIFACT_PLAIN_DATA_KEY_MARKER,
            }],
        },
        sessions: {
            action: "migrate" as const,
            items: [
                fixture.sessions.active,
                fixture.sessions.archived,
            ].map((session) => ({
                sessionId: session.id,
                expectedMetadataLayoutVersion:
                    1 as const,
                expectedMetadataVersion:
                    session.metadataVersion,
                expectedAgentStateVersion:
                    session.agentStateVersion,
                expectedOwnerMetadata:
                    SOURCE_SESSION_OWNER_METADATA,
                ownerMetadata:
                    TARGET_SESSION_OWNER_METADATA,
            })),
        },
        reviewComments: {
            action: "assert_empty" as const,
        },
        sessionOrganization: {
            action: "assert_empty" as const,
        },
        pets: {
            action: "assert_empty" as const,
        },
    };
}

function normalizeBytes(
    value: Uint8Array | null,
): string | null {
    return value === null
        ? null
        : Buffer.from(value).toString("base64");
}

async function readFixtureState(
    fixture: MigrationFixture,
) {
    const [
        account,
        machine,
        todo,
        artifact,
        sessions,
        automation,
        credentials,
        snapshots,
        changes,
        usageRecords,
        usageSources,
    ] = await Promise.all([
        db.account.findUniqueOrThrow({
            where: { id: fixture.account.id },
            select: {
                seq: true,
                encryptionMode: true,
                encryptionModeUpdatedAt: true,
                publicKey: true,
                contentPublicKey: true,
                contentPublicKeySig: true,
                settings: true,
                settingsVersion: true,
            },
        }),
        db.machine.findUniqueOrThrow({
            where: { id: fixture.machine.id },
            select: {
                metadata: true,
                metadataVersion: true,
                daemonState: true,
                daemonStateVersion: true,
                dataEncryptionKey: true,
                contentPublicKeyFingerprint: true,
                seq: true,
            },
        }),
        db.userKVStore.findUniqueOrThrow({
            where: {
                accountId_key: {
                    accountId: fixture.account.id,
                    key: fixture.todo.key,
                },
            },
            select: {
                value: true,
                version: true,
            },
        }),
        db.artifact.findUniqueOrThrow({
            where: { id: fixture.artifact.id },
            select: {
                header: true,
                headerVersion: true,
                body: true,
                bodyVersion: true,
                dataEncryptionKey: true,
                seq: true,
            },
        }),
        db.session.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                metadata: true,
                metadataVersion: true,
                metadataLayoutVersion: true,
                ownerMetadata: true,
                agentState: true,
                agentStateVersion: true,
                archivedAt: true,
                seq: true,
            },
        }),
        db.automation.findUniqueOrThrow({
            where: { id: fixture.automation.id },
            select: {
                templateCiphertext: true,
                templateVersion: true,
            },
        }),
        db.serviceAccountToken.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                token: true,
                metadata: true,
                configurationRevision: true,
                configurationContent: true,
                refreshLeaseOwnerMachineId: true,
                refreshLeaseExpiresAt: true,
            },
        }),
        db.accountSettingsSnapshot.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { version: "asc" },
            select: {
                version: true,
                settingsDbValue: true,
                encryptionMode: true,
                contentKind: true,
            },
        }),
        db.accountChange.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { cursor: "asc" },
            select: {
                cursor: true,
                kind: true,
                entityId: true,
                hint: true,
            },
        }),
        db.providerAccountUsageRecord.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                recordId: true,
                payloadMode: true,
                status: true,
                snapshot: true,
                sealedPayload: true,
            },
        }),
        db.connectedServiceUsageSource.findMany({
            where: { accountId: fixture.account.id },
            orderBy: { id: "asc" },
            select: {
                id: true,
                sourceKey: true,
                credentialId: true,
                providerAccountUsageRecordId: true,
                bindingKind: true,
            },
        }),
    ]);
    return {
        account: {
            ...account,
            encryptionModeUpdatedAt:
                account.encryptionModeUpdatedAt.getTime(),
            contentPublicKey:
                normalizeBytes(account.contentPublicKey),
            contentPublicKeySig:
                normalizeBytes(account.contentPublicKeySig),
        },
        machine: {
            ...machine,
            dataEncryptionKey:
                normalizeBytes(machine.dataEncryptionKey),
        },
        todo: {
            ...todo,
            value: normalizeBytes(todo.value),
        },
        artifact: {
            ...artifact,
            header: normalizeBytes(artifact.header),
            body: normalizeBytes(artifact.body),
            dataEncryptionKey:
                normalizeBytes(
                    artifact.dataEncryptionKey,
                ),
        },
        sessions: sessions.map((session) => ({
            ...session,
            archivedAt:
                session.archivedAt?.getTime() ?? null,
        })),
        automation,
        credentials: credentials.map((credential) => ({
            ...credential,
            token: normalizeBytes(credential.token),
            configurationContent:
                normalizeBytes(
                    credential.configurationContent,
                ),
            refreshLeaseExpiresAt:
                credential.refreshLeaseExpiresAt
                    ?.getTime() ?? null,
        })),
        snapshots,
        changes,
        usageRecords,
        usageSources,
    };
}

async function injectMigration(
    app: ReturnType<typeof createTestApp>,
    accountId: string,
    payload: unknown,
) {
    return await app.inject({
        method: "POST",
        url: "/v1/account/encryption/migrate",
        headers: {
            "content-type": "application/json",
            "x-test-user-id": accountId,
            ...buildAccountStoredContentCompatibilityHttpHeadersV1(
                CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
            ),
        },
        payload,
    });
}

function signPlainToE2eeMigrationRequest(
    params: Readonly<{
        accountId: string;
        signingSecretKey: Uint8Array;
        request:
            AccountEncryptionMigrateUnsignedRequest;
    }>,
): AccountEncryptionMigrateRequest {
    const signingInput =
        createAccountEncryptionMigrateProofSigningInputV1({
            request: params.request,
            accountId: params.accountId,
            sourceMode: "plain",
        });
    return attachAccountEncryptionMigrateProofSignatureV1({
        request: params.request,
        signature: privacyKit.encodeBase64(
            new Uint8Array(
                tweetnacl.sign.detached(
                    signingInput,
                    params.signingSecretKey,
                ),
            ),
        ),
    });
}

async function cleanupCreatedAccounts(): Promise<void> {
    const accountIds = [...createdAccountIds];
    createdAccountIds.clear();
    if (accountIds.length === 0) return;
    const where = { accountId: { in: accountIds } };
    await db.connectedServiceUsageSource.deleteMany({
        where,
    });
    await db.providerAccountUsageRecord.deleteMany({
        where,
    });
    await db.connectedServiceAuthGroupMember.deleteMany({
        where,
    });
    await db.connectedServiceAuthGroup.deleteMany({
        where,
    });
    await db.serviceAccountToken.deleteMany({ where });
    await db.automation.deleteMany({ where });
    await db.artifact.deleteMany({ where });
    await db.userKVStore.deleteMany({ where });
    await db.machine.deleteMany({ where });
    await db.session.deleteMany({ where });
    await db.accountChange.deleteMany({ where });
    await db.accountSettingsSnapshot.deleteMany({ where });
    await db.account.deleteMany({
        where: { id: { in: accountIds } },
    });
}

describe(
    "Account encryption migration native database contract",
    () => {
        let app: ReturnType<typeof createTestApp>;
        let dbConnected = false;
        let previousMasterSecret: string | undefined;
        const previousEnv = {
            storagePolicy:
                process.env
                    .HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY,
            allowOptOut:
                process.env
                    .HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT,
            settingsAtRest:
                process.env
                    .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST,
            credentialsAtRest:
                process.env
                    .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST,
            artifactsAtRest:
                process.env
                    .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST,
        };

        beforeAll(async () => {
            if (!process.env.DATABASE_URL) {
                throw new Error(
                    "Missing DATABASE_URL (required for db contract tests).",
                );
            }
            previousMasterSecret =
                process.env.HANDY_MASTER_SECRET;
            process.env.HANDY_MASTER_SECRET =
                previousMasterSecret
                ?? "account-encryption-migrate-db-contract";
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY =
                "optional";
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT =
                "1";
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST =
                "none";
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST =
                "none";
            process.env
                .HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST =
                "none";
            await initEncrypt();
            if (provider === "mysql") {
                await initDbMysql();
            } else {
                initDbPostgres();
            }
            await db.$connect();
            dbConnected = true;
            app = createTestApp();
            await app.ready();
        });

        afterEach(async () => {
            await cleanupCreatedAccounts();
        });

        afterAll(async () => {
            await app?.close();
            await cleanupCreatedAccounts();
            if (dbConnected) {
                await db.$disconnect();
            }
            if (previousMasterSecret === undefined) {
                delete process.env.HANDY_MASTER_SECRET;
            } else {
                process.env.HANDY_MASTER_SECRET =
                    previousMasterSecret;
            }
            const restore = (
                key: string,
                value: string | undefined,
            ) => {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            };
            restore(
                "HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY",
                previousEnv.storagePolicy,
            );
            restore(
                "HAPPIER_FEATURE_ENCRYPTION__ALLOW_ACCOUNT_OPTOUT",
                previousEnv.allowOptOut,
            );
            restore(
                "HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_SETTINGS_AT_REST",
                previousEnv.settingsAtRest,
            );
            restore(
                "HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST",
                previousEnv.credentialsAtRest,
            );
            restore(
                "HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_ARTIFACTS_AT_REST",
                previousEnv.artifactsAtRest,
            );
        });

        it(
            "atomically migrates every required domain, records Settings history, and removes cross-mode usage residue",
            async () => {
                const fixture =
                    await createMigrationFixture();
                const response = await injectMigration(
                    app,
                    fixture.account.id,
                    buildMigrationRequest(fixture),
                );

                expect(
                    response.statusCode,
                    response.body,
                ).toBe(200);
                const body = response.json() as {
                    accountVersion: number;
                    settingsVersion: number;
                };
                expect(body).toMatchObject({
                    success: true,
                    mode: "plain",
                    settingsVersion: 1,
                });

                const state =
                    await readFixtureState(fixture);
                expect(state.account).toMatchObject({
                    seq: body.accountVersion,
                    encryptionMode: "plain",
                    settingsVersion: 1,
                    publicKey: fixture.account.publicKey,
                });
                expect(state.account.settings).not.toBe(
                    SOURCE_SETTINGS,
                );
                expect(state.machine).toMatchObject({
                    metadata:
                        fixture.target.machineMetadata,
                    metadataVersion: 3,
                    daemonState:
                        fixture.target.machineDaemonState,
                    daemonStateVersion: 4,
                });
                expect(state.todo).toEqual({
                    value: Buffer.from(
                        fixture.target.todoValue,
                        "base64",
                    ).toString("base64"),
                    version: 5,
                });
                expect(state.artifact).toMatchObject({
                    header: Buffer.from(
                        fixture.target.artifactHeader,
                        "base64",
                    ).toString("base64"),
                    headerVersion: 6,
                    body: Buffer.from(
                        fixture.target.artifactBody,
                        "base64",
                    ).toString("base64"),
                    bodyVersion: 7,
                    dataEncryptionKey:
                        Buffer.from(
                            ARTIFACT_PLAIN_DATA_KEY_MARKER,
                            "base64",
                        ).toString("base64"),
                });
                for (const source of [
                    fixture.sessions.active,
                    fixture.sessions.archived,
                ]) {
                    expect(
                        state.sessions.find(
                            (session) =>
                                session.id === source.id,
                        ),
                    ).toEqual({
                        ...source,
                        ownerMetadata:
                            encodeSessionOwnerMetadataEnvelopeV1(
                                TARGET_SESSION_OWNER_METADATA,
                            ),
                        archivedAt:
                            source.archivedAt?.getTime()
                            ?? null,
                    });
                }
                expect(state.automation).toEqual({
                    templateCiphertext:
                        fixture.target.automationTemplate,
                    templateVersion: 1,
                });
                expect(state.snapshots).toEqual([
                    {
                        version: 0,
                        settingsDbValue: SOURCE_SETTINGS,
                        encryptionMode: "e2ee",
                        contentKind: "encrypted",
                    },
                    {
                        version: 1,
                        settingsDbValue:
                            state.account.settings,
                        encryptionMode: "plain",
                        contentKind: "plain",
                    },
                ]);
                expect(state.usageRecords).toEqual([]);
                expect(state.usageSources).toEqual([]);

                const legacyIdentity =
                    resolveLegacyServiceAccountTokenIdentityFields(
                        {
                            serviceId: "anthropic",
                            profileId: "legacy",
                            credentialKind: "token",
                        },
                    );
                const legacy =
                    await readQualifiedConnectedServiceCredentialForLegacyProjection(
                        {
                            accountId: fixture.account.id,
                            ref: {
                                service: {
                                    pluginId:
                                        legacyIdentity
                                            .servicePluginId,
                                    localId:
                                        legacyIdentity
                                            .serviceLocalId,
                                },
                                accountId:
                                    legacyIdentity
                                        .connectedAccountId,
                            },
                        },
                    );
                expect(legacy).toMatchObject({
                    status: "resolved",
                    credential: {
                        content: {
                            t: "plain",
                            v: {
                                token: {
                                    token:
                                        "native-db-legacy-credential-after",
                                },
                            },
                        },
                    },
                });
                const qualified =
                    await readQualifiedConnectedServiceCredential({
                        accountId: fixture.account.id,
                        ref: fixture.qualifiedRef,
                    });
                expect(qualified).toMatchObject({
                    status: "resolved",
                    credential: {
                        content: {
                            t: "plain",
                            v: {
                                token:
                                    "native-db-qualified-credential-after",
                            },
                        },
                    },
                });
                const configuration =
                    await readQualifiedConnectedAccountConfiguration(
                        {
                            accountId: fixture.account.id,
                            target: {
                                kind: "account",
                                ref: fixture.qualifiedRef,
                            },
                        },
                );
                expect(configuration).toMatchObject({
                    configurationContent: {
                        t: "plain",
                        v: {
                            endpoint:
                                "https://native-db.example.test",
                        },
                    },
                });
                if (!configuration || "status" in configuration) {
                    throw new Error(
                        "Expected migrated qualified configuration",
                    );
                }
                expect(
                    configuration.configurationRevision,
                ).not.toBe(
                    fixture.qualified
                        .configurationRevision,
                );

                const finalChange =
                    state.changes.at(-1);
                expect(finalChange).toEqual({
                    cursor: body.accountVersion,
                    kind: "account",
                    entityId: "self",
                    hint: {
                        settingsVersion: 1,
                        sourceAccountVersion:
                            fixture.sourceAccountVersion,
                        accountEncryptionMigrationReplayBinding:
                            expect.stringMatching(
                                /^aemrsb1_/u,
                            ),
                    },
                });
            },
        );

        it.each([
            "legacy_credential",
            "qualified_credential",
            "qualified_configuration",
            "automation",
        ] as const)(
            "rolls back every source byte and cursor when the %s CAS is stale",
            async (staleFence) => {
                const fixture =
                    await createMigrationFixture();
                const before =
                    await readFixtureState(fixture);

                const response = await injectMigration(
                    app,
                    fixture.account.id,
                    buildMigrationRequest(
                        fixture,
                        staleFence,
                    ),
                );

                expect(
                    response.statusCode,
                    response.body,
                ).toBe(400);
                expect(response.json()).toEqual({
                    error: "invalid-params",
                    reason:
                        "migration_inventory_changed",
                });
                await expect(
                    readFixtureState(fixture),
                ).resolves.toEqual(before);
            },
        );

        it(
            "prepares every domain before the final Account mode write and rolls back a database-boundary failure there",
            async () => {
                const fixture =
                    await createMigrationFixture();
                const before =
                    await readFixtureState(fixture);
                const removeTrigger =
                    await installFinalAccountMutationOrderingTrigger(
                        fixture,
                    );
                try {
                    const response =
                        await injectMigration(
                            app,
                            fixture.account.id,
                            buildMigrationRequest(
                                fixture,
                            ),
                        );
                    // The trigger raises only when every domain,
                    // Settings, usage cleanup, and CAS update is
                    // already visible inside the transaction.
                    // A mode write attempted earlier would commit and
                    // return 200 instead.
                    expect(
                        response.statusCode,
                        response.body,
                    ).toBe(500);
                    expect(response.json()).toEqual({
                        error: "internal",
                    });
                } finally {
                    await removeTrigger();
                }
                await expect(
                    readFixtureState(fixture),
                ).resolves.toEqual(before);
            },
        );

        it(
            "keeps truly keyless first-key attachment and same-mode retries fail-closed without mutation",
            async () => {
                const unique =
                    randomUUID().split("-").join("");
                const keyless =
                    await db.account.create({
                        data: {
                            publicKey: null,
                            encryptionMode: "plain",
                            settings: null,
                            settingsVersion: 0,
                        },
                        select: {
                            id: true,
                            seq: true,
                        },
                    });
                createdAccountIds.add(keyless.id);
                const signing =
                    tweetnacl.sign.keyPair();
                const content = tweetnacl.box.keyPair();
                const contentBinding =
                    tweetnacl.sign.detached(
                        Buffer.concat([
                            Buffer.from(
                                "Happy content key v1\u0000",
                                "utf8",
                            ),
                            Buffer.from(
                                content.publicKey,
                            ),
                        ]),
                        signing.secretKey,
                    );
                const unsigned:
                    AccountEncryptionMigrateUnsignedRequest =
                    {
                        toMode: "e2ee",
                        expectedAccountVersion:
                            keyless.seq,
                        expectedSigningKeyFingerprint:
                            null,
                        expectedContentKeyFingerprint:
                            null,
                        expectedSettingsVersion: 0,
                        settingsContent: null,
                        connectedServices: {
                            action: "assert_empty",
                        },
                        automations: {
                            action: "assert_empty",
                        },
                        machines: {
                            action: "assert_empty",
                        },
                        todos: {
                            action: "assert_empty",
                        },
                        artifacts: {
                            action: "assert_empty",
                        },
                        sessions: {
                            action: "assert_empty",
                        },
                        reviewComments: {
                            action: "assert_empty",
                        },
                        sessionOrganization: {
                            action: "assert_empty",
                        },
                        pets: {
                            action: "assert_empty",
                        },
                        keyProof: {
                            v: 1,
                            publicKey:
                                privacyKit.encodeBase64(
                                    new Uint8Array(
                                        signing.publicKey,
                                    ),
                                ),
                            contentPublicKey:
                                privacyKit.encodeBase64(
                                    new Uint8Array(
                                        content.publicKey,
                                    ),
                                ),
                            contentPublicKeySig:
                                privacyKit.encodeBase64(
                                    new Uint8Array(
                                        contentBinding,
                                    ),
                                ),
                        },
                    };
                const keylessResponse =
                    await injectMigration(
                        app,
                        keyless.id,
                        signPlainToE2eeMigrationRequest({
                            accountId: keyless.id,
                            signingSecretKey:
                                signing.secretKey,
                            request: unsigned,
                        }),
                    );
                expect(
                    keylessResponse.statusCode,
                    keylessResponse.body,
                ).toBe(400);
                expect(keylessResponse.json()).toEqual({
                    error: "invalid-params",
                    reason: "key_proof_required",
                });

                const sameMode =
                    await db.account.create({
                        data: {
                            publicKey: null,
                            username:
                                `native-db-same-${unique}`,
                            encryptionMode: "plain",
                            settings: null,
                            settingsVersion: 0,
                        },
                        select: {
                            id: true,
                            seq: true,
                        },
                    });
                createdAccountIds.add(sameMode.id);
                const sameModeResponse =
                    await injectMigration(
                        app,
                        sameMode.id,
                        {
                            toMode: "plain",
                            expectedAccountVersion:
                                sameMode.seq,
                            expectedSigningKeyFingerprint:
                                null,
                            expectedContentKeyFingerprint:
                                null,
                            expectedSettingsVersion: 0,
                            settingsContent: null,
                            connectedServices: {
                                action: "assert_empty",
                            },
                            automations: {
                                action: "assert_empty",
                            },
                            machines: {
                                action: "assert_empty",
                            },
                            todos: {
                                action: "assert_empty",
                            },
                            artifacts: {
                                action: "assert_empty",
                            },
                            sessions: {
                                action: "assert_empty",
                            },
                            reviewComments: {
                                action: "assert_empty",
                            },
                            sessionOrganization: {
                                action: "assert_empty",
                            },
                            pets: {
                                action: "assert_empty",
                            },
                        },
                    );
                expect(
                    sameModeResponse.statusCode,
                    sameModeResponse.body,
                ).toBe(400);
                expect(sameModeResponse.json()).toEqual({
                    error: "invalid-params",
                    reason:
                        "migration_inventory_changed",
                });

                await expect(
                    db.account.findMany({
                        where: {
                            id: {
                                in: [
                                    keyless.id,
                                    sameMode.id,
                                ],
                            },
                        },
                        orderBy: { id: "asc" },
                        select: {
                            id: true,
                            seq: true,
                            encryptionMode: true,
                            publicKey: true,
                            settings: true,
                            settingsVersion: true,
                        },
                    }),
                ).resolves.toEqual([
                    {
                        id: keyless.id,
                        seq: 0,
                        encryptionMode: "plain",
                        publicKey: null,
                        settings: null,
                        settingsVersion: 0,
                    },
                    {
                        id: sameMode.id,
                        seq: 0,
                        encryptionMode: "plain",
                        publicKey: null,
                        settings: null,
                        settingsVersion: 0,
                    },
                ].sort((left, right) =>
                    left.id.localeCompare(right.id)));
                await expect(
                    db.accountSettingsSnapshot.count({
                        where: {
                            accountId: {
                                in: [
                                    keyless.id,
                                    sameMode.id,
                                ],
                            },
                        },
                    }),
                ).resolves.toBe(0);
            },
        );

        it(
            "rejects an oversized complete request before any database read or mutation",
            async () => {
                const templateCiphertext =
                    "x".repeat(220_000);
                const response = await injectMigration(
                    app,
                    "missing-native-db-oversized-account",
                    {
                        toMode: "plain",
                        expectedAccountVersion: 0,
                        expectedSigningKeyFingerprint:
                            null,
                        expectedContentKeyFingerprint:
                            null,
                        expectedSettingsVersion: 0,
                        settingsContent: null,
                        connectedServices: {
                            action: "assert_empty",
                        },
                        automations: {
                            action: "migrate",
                            templates: Array.from(
                                { length: 40 },
                                (_, index) => ({
                                    automationId:
                                        `oversized-${index}`,
                                    expectedTemplateVersion:
                                        0,
                                    templateCiphertext,
                                }),
                            ),
                        },
                        machines: {
                            action: "assert_empty",
                        },
                        todos: {
                            action: "assert_empty",
                        },
                        artifacts: {
                            action: "assert_empty",
                        },
                        sessions: {
                            action: "assert_empty",
                        },
                        reviewComments: {
                            action: "assert_empty",
                        },
                        sessionOrganization: {
                            action: "assert_empty",
                        },
                        pets: {
                            action: "assert_empty",
                        },
                    },
                );

                expect(
                    response.statusCode,
                    response.body,
                ).toBe(400);
                expect(response.json()).toEqual({
                    error: "migration_too_large",
                });
            },
        );
    },
);
