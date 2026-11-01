import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsRoot = join(import.meta.dirname, "..", "..", "prisma", "sqlite", "migrations");

async function readMigration(name: string): Promise<string> {
    return await readFile(join(migrationsRoot, name, "migration.sql"), "utf8");
}

describe("auth credential reader support migration", () => {
    it("defaults existing and older-writer rows to unsupported while retaining auth data", async () => {
        const db = new DatabaseSync(":memory:");
        try {
            db.exec(await readMigration("20260122190000_baseline"));
            db.exec(await readMigration("20260223120000_add_auth_pairing_session"));
            db.exec(`
                INSERT INTO "Account" ("id", "publicKey", "updatedAt")
                VALUES ('account', 'account-public', CURRENT_TIMESTAMP);
                INSERT INTO "TerminalAuthRequest" ("id", "publicKey", "supportsV2", "response", "updatedAt")
                VALUES ('terminal', 'terminal-public', 1, 'opaque-response', CURRENT_TIMESTAMP);
                INSERT INTO "AuthPairingSession" ("id", "accountId", "secretHash", "requestedPublicKey", "expiresAt", "updatedAt")
                VALUES ('pairing', 'account', 'secret-hash', 'phone-public', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            `);
            db.exec(await readMigration("20261017120000_add_auth_credential_reader_support"));
            expect(db.prepare(`SELECT "supportsV2", "supportsTokenOnly", "response" FROM "TerminalAuthRequest"`).get()).toMatchObject({
                supportsV2: 1, supportsTokenOnly: 0, response: "opaque-response",
            });
            expect(db.prepare(`SELECT "supportsCredentialVariants", "secretHash", "requestedPublicKey" FROM "AuthPairingSession"`).get()).toMatchObject({
                supportsCredentialVariants: 0, secretHash: "secret-hash", requestedPublicKey: "phone-public",
            });
            db.exec(`
                INSERT INTO "TerminalAuthRequest" ("id", "publicKey", "updatedAt")
                VALUES ('legacy-terminal', 'legacy-terminal-public', CURRENT_TIMESTAMP);
                INSERT INTO "AuthPairingSession" ("id", "accountId", "secretHash", "expiresAt", "updatedAt")
                VALUES ('legacy-pairing', 'account', 'legacy-secret', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
            `);
            expect(db.prepare(`SELECT "supportsTokenOnly" FROM "TerminalAuthRequest" WHERE "id" = 'legacy-terminal'`).get()).toMatchObject({ supportsTokenOnly: 0 });
            expect(db.prepare(`SELECT "supportsCredentialVariants" FROM "AuthPairingSession" WHERE "id" = 'legacy-pairing'`).get()).toMatchObject({ supportsCredentialVariants: 0 });
        } finally {
            db.close();
        }
    });
});
