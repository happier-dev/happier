import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
    afterAll,
    afterEach,
    beforeAll,
    describe,
    expect,
    it,
} from "vitest";

import {
    db,
    initDbMysql,
    initDbPostgres,
} from "@/storage/db";
import { initEncrypt } from "@/modules/encrypt";
import {
    createProviderAccountUsageRecordKey,
    createUsageSnapshot,
} from "../providerAccountUsageTestkit";
import { mutateQualifiedConnectedServiceCredential } from "./credentialRepository";
import {
    createQualifiedConnectedAccountGroup,
    createQualifiedConnectedAccountGroupMember,
    deleteQualifiedConnectedAccountGroupMember,
    updateQualifiedConnectedAccountGroupMember,
} from "./groupRepository";
import { writeQualifiedProviderAccountUsageRecord } from "./usageRepository";

function resolveContractProviderFromEnv(): "postgres" | "mysql" {
    const raw = (
        process.env.HAPPIER_DB_PROVIDER
        ?? process.env.HAPPY_DB_PROVIDER
        ?? "postgres"
    ).toString().trim().toLowerCase();
    if (raw === "postgresql" || raw === "postgres") return "postgres";
    if (raw === "mysql") return "mysql";
    throw new Error(
        `Unsupported contract provider: ${raw}. Set HAPPIER_DB_PROVIDER=postgres|mysql (or HAPPY_DB_PROVIDER=postgres|mysql)`,
    );
}

const provider = resolveContractProviderFromEnv();
const accountPublicKeyPrefix =
    "dbcontract-qualified-member-cas-";
const service = Object.freeze({
    pluginId: "example.connected-accounts",
    localId: "service/with/path",
});

const requireFromHere = createRequire(import.meta.url);

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

async function installGroupRevisionTrigger(params: Readonly<{
    operation: "create" | "update" | "delete";
    groupDbId: string;
}>): Promise<() => Promise<void>> {
    if (!/^[A-Za-z0-9_-]+$/.test(params.groupDbId)) {
        throw new Error("Expected a SQL-safe generated group row id");
    }
    const suffix = randomUUID().replace(/-/g, "");
    const triggerName = `qca_member_cas_${suffix}`;
    const triggerOperation =
        params.operation === "create"
            ? "INSERT"
            : params.operation.toUpperCase();
    const rowAlias =
        params.operation === "delete" ? "OLD" : "NEW";

    if (provider === "mysql") {
        await executeMysqlDdl(`
            CREATE TRIGGER \`${triggerName}\`
            AFTER ${triggerOperation}
            ON \`ConnectedServiceAuthGroupMember\`
            FOR EACH ROW
            UPDATE \`ConnectedServiceAuthGroup\`
            SET \`runtimeStateRevision\` =
                \`runtimeStateRevision\` + 1
            WHERE \`id\` = '${params.groupDbId}'
                AND ${rowAlias}.\`groupDbId\` =
                    '${params.groupDbId}'
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
            UPDATE "ConnectedServiceAuthGroup"
            SET "runtimeStateRevision" =
                "runtimeStateRevision" + 1
            WHERE "id" = '${params.groupDbId}';
            RETURN ${rowAlias};
        END;
        $trigger$
    `);
    try {
        await db.$executeRawUnsafe(`
            CREATE TRIGGER "${triggerName}"
            AFTER ${triggerOperation}
            ON "ConnectedServiceAuthGroupMember"
            FOR EACH ROW
            WHEN (${rowAlias}."groupDbId" = '${params.groupDbId}')
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
            ON "ConnectedServiceAuthGroupMember"
        `);
        await db.$executeRawUnsafe(
            `DROP FUNCTION IF EXISTS "${functionName}"()`,
        );
    };
}

describe("qualified group member CAS database contract", () => {
    let dbConnected = false;
    let previousMasterSecret: string | undefined;

    beforeAll(async () => {
        if (!process.env.DATABASE_URL) {
            throw new Error(
                "Missing DATABASE_URL (required for db contract tests).",
            );
        }
        previousMasterSecret = process.env.HANDY_MASTER_SECRET;
        process.env.HANDY_MASTER_SECRET =
            previousMasterSecret
            ?? "qualified-connected-account-db-contract";
        await initEncrypt();
        if (provider === "mysql") {
            await initDbMysql();
        } else {
            initDbPostgres();
        }
        await db.$connect();
        dbConnected = true;
    });

    afterEach(async () => {
        await db.account.deleteMany({
            where: {
                publicKey: { startsWith: accountPublicKeyPrefix },
            },
        });
    });

    afterAll(async () => {
        if (dbConnected) {
            await db.$disconnect();
        }
        if (previousMasterSecret === undefined) {
            delete process.env.HANDY_MASTER_SECRET;
        } else {
            process.env.HANDY_MASTER_SECRET =
                previousMasterSecret;
        }
    });

    it.each(["create", "update", "delete"] as const)(
        "rolls back a losing %s member CAS on the provider database",
        async (operation) => {
            const unique = randomUUID().replace(/-/g, "");
            const account = await db.account.create({
                data: {
                    publicKey: `${accountPublicKeyPrefix}${unique}`,
                    encryptionMode: "plain",
                },
                select: { id: true },
            });
            const ref = {
                service,
                accountId: `member-${operation}-${unique}`,
            };
            const providerAccountId =
                `provider-${operation}-${unique}`;
            const credential =
                await mutateQualifiedConnectedServiceCredential({
                    accountId: account.id,
                    ref,
                    expectedCredentialRevision: null,
                    authenticationModeId: "api-key",
                    content: {
                        t: "plain",
                        v: { token: "credential" },
                    },
                    metadata: {
                        displayName: "CAS contract account",
                        scopes: ["account.read"],
                        providerIdentity: {
                            accountId: providerAccountId,
                        },
                    },
                });
            if (credential.status !== "written") {
                throw new Error("Expected credential create");
            }
            const groupRef = {
                service,
                groupId: `group-${operation}-${unique}`,
            };
            const createdGroup =
                await createQualifiedConnectedAccountGroup({
                    accountId: account.id,
                    service,
                    group: { groupId: groupRef.groupId },
                });
            if (createdGroup.status !== "written") {
                throw new Error("Expected group create");
            }
            let group = createdGroup.group;
            if (operation !== "create") {
                const createdMember =
                    await createQualifiedConnectedAccountGroupMember({
                        accountId: account.id,
                        mutation: {
                            group: groupRef,
                            connectedAccountId: ref.accountId,
                            priority: 10,
                            expectedRuntimeStateRevision:
                                group.runtimeStateRevision,
                        },
                    });
                if (createdMember.status !== "written") {
                    throw new Error("Expected member create");
                }
                group = createdMember.group;
            }
            if (operation === "delete") {
                const recordKey =
                    createProviderAccountUsageRecordKey({
                        accountSubjectId: providerAccountId,
                    });
                const snapshot = createUsageSnapshot({
                    fetchedAt: Date.now(),
                    recordKey,
                });
                const usageWrite =
                    await writeQualifiedProviderAccountUsageRecord({
                        accountId: account.id,
                        source: {
                            ref,
                            bindingKind: "group_member",
                            groupId: groupRef.groupId,
                            groupGeneration: group.generation,
                        },
                        expectedCredentialRevision:
                            credential.credentialRevision,
                        expectedConfigurationRevision: null,
                        recordId: snapshot.recordId,
                        recordKey: snapshot.recordKey,
                        payloadMode: "plain_json_v1",
                        status: "ok",
                        snapshot,
                        fetchedAt: snapshot.fetchedAtMs,
                        staleAfterMs: snapshot.staleAfterMs,
                    });
                expect(usageWrite.sourceOutcome).toEqual({
                    status: "linked",
                });
            }

            const storedGroup =
                await db.connectedServiceAuthGroup.findFirstOrThrow({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    select: { id: true },
                });
            const before = await Promise.all([
                db.connectedServiceAuthGroup.findUniqueOrThrow({
                    where: { id: storedGroup.id },
                    select: {
                        generation: true,
                        runtimeStateRevision: true,
                        activeConnectedAccountId: true,
                    },
                }),
                db.connectedServiceAuthGroupMember.findMany({
                    where: { groupDbId: storedGroup.id },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        priority: true,
                        enabled: true,
                        stateJson: true,
                    },
                }),
                db.connectedServiceUsageSource.findMany({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        sourceKey: true,
                        credentialId: true,
                    },
                }),
            ]);
            expect(before[1]).toHaveLength(
                operation === "create" ? 0 : 1,
            );
            expect(before[2]).toHaveLength(
                operation === "delete" ? 1 : 0,
            );

            const uninstallTrigger =
                await installGroupRevisionTrigger({
                    operation,
                    groupDbId: storedGroup.id,
                });
            try {
                const result = operation === "create"
                    ? await createQualifiedConnectedAccountGroupMember({
                        accountId: account.id,
                        mutation: {
                            group: groupRef,
                            connectedAccountId: ref.accountId,
                            priority: 20,
                            expectedRuntimeStateRevision:
                                group.runtimeStateRevision,
                        },
                    })
                    : operation === "update"
                        ? await updateQualifiedConnectedAccountGroupMember({
                            accountId: account.id,
                            mutation: {
                                group: groupRef,
                                connectedAccountId: ref.accountId,
                                priority: 20,
                                expectedRuntimeStateRevision:
                                    group.runtimeStateRevision,
                            },
                        })
                        : await deleteQualifiedConnectedAccountGroupMember({
                            accountId: account.id,
                            mutation: {
                                group: groupRef,
                                connectedAccountId: ref.accountId,
                                expectedRuntimeStateRevision:
                                    group.runtimeStateRevision,
                            },
                        });

                expect(result).toEqual({
                    status: "superseded",
                    runtimeStateRevision:
                        group.runtimeStateRevision,
                });
            } finally {
                await uninstallTrigger();
            }

            await expect(Promise.all([
                db.connectedServiceAuthGroup.findUniqueOrThrow({
                    where: { id: storedGroup.id },
                    select: {
                        generation: true,
                        runtimeStateRevision: true,
                        activeConnectedAccountId: true,
                    },
                }),
                db.connectedServiceAuthGroupMember.findMany({
                    where: { groupDbId: storedGroup.id },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        priority: true,
                        enabled: true,
                        stateJson: true,
                    },
                }),
                db.connectedServiceUsageSource.findMany({
                    where: {
                        accountId: account.id,
                        groupId: groupRef.groupId,
                    },
                    orderBy: { id: "asc" },
                    select: {
                        id: true,
                        sourceKey: true,
                        credentialId: true,
                    },
                }),
            ])).resolves.toEqual(before);
        },
    );
});
