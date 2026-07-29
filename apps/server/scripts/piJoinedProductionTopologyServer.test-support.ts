import { createInterface } from "node:readline";

import { registerAccountEncryptionRoutes } from "@/app/api/routes/account/registerAccountEncryptionRoutes";
import { connectConnectedServicesV3Routes } from "@/app/api/routes/connect/connectRoutes.connectedServicesV3";
import {
    registerQualifiedConnectedAccountCredentialRoutesV4,
} from "@/app/api/routes/connect/qualifiedConnectedAccounts/registerQualifiedConnectedAccountCredentialRoutesV4";
import { createAuthenticatedTestApp } from "@/app/api/testkit/sqliteFastify";
import { db } from "@/storage/db";
import { createLightSqliteHarness } from "@/testkit/lightSqliteHarness";

const harness = await createLightSqliteHarness({
    tempDirPrefix: "happier-pi-joined-production-topology-",
    initEncrypt: true,
    env: {
        HAPPIER_FEATURE_POLICY_ENV: "",
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: "optional",
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: "plain",
        HAPPIER_FEATURE_ENCRYPTION__PLAIN_ACCOUNT_CREDENTIALS_AT_REST:
            "server_sealed",
    },
});
const account = await db.account.create({
    data: { publicKey: null, encryptionMode: "plain" },
    select: { id: true },
});
const app = createAuthenticatedTestApp();
app.addHook("onRequest", async (request: {
    headers: Record<string, string | string[] | undefined>;
}) => {
    const authorization = request.headers.authorization;
    const bearer = typeof authorization === "string"
        ? authorization.match(/^Bearer (.+)$/u)?.[1]
        : undefined;
    if (bearer) request.headers["x-test-user-id"] = bearer;
});
connectConnectedServicesV3Routes(app);
registerQualifiedConnectedAccountCredentialRoutesV4(app);
registerAccountEncryptionRoutes(app);
const address = await app.listen({ host: "127.0.0.1", port: 0 });

let closed = false;
const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await app.close().catch(() => undefined);
    await db.serviceAccountToken.deleteMany().catch(() => undefined);
    await db.account.deleteMany().catch(() => undefined);
    await harness.close();
};

process.once("SIGTERM", () => {
    void close().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
    void close().finally(() => process.exit(0));
});

process.stdout.write(`${JSON.stringify({
    type: "ready",
    address,
    accountId: account.id,
    dbPath: harness.dbPath,
})}\n`);

try {
    for await (const line of createInterface({
        input: process.stdin,
        crlfDelay: Infinity,
    })) {
        if (line.trim() === "shutdown") break;
    }
} finally {
    await close();
}
