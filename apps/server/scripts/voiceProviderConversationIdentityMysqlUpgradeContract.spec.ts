import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
    resolveMysqlVoiceIdentityMigrationSequence,
} from "./voiceProviderConversationIdentityMysqlUpgradeContract";

describe("MySQL voice identity legacy-upgrade contract sequencing", () => {
    it("splits the real migration assets immediately around the W0.10 target", () => {
        const migrationsDir = join(process.cwd(), "prisma", "mysql", "migrations");
        const migrationNames = readdirSync(migrationsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);
        const sequence = resolveMysqlVoiceIdentityMigrationSequence({
            migrationNames,
            targetMigration: MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
        });

        expect(sequence.preTarget.at(-1)).toBe("20260701123000_add_session_runtime_activity_projection");
        expect(sequence.target).toBe(MYSQL_VOICE_IDENTITY_TARGET_MIGRATION);
        expect(sequence.remaining.at(0)).toBe("20260713210000_add_session_subagent_custody");
        for (const migrationName of [...sequence.preTarget, sequence.target, ...sequence.remaining]) {
            expect(existsSync(join(migrationsDir, migrationName, "migration.sql")), migrationName).toBe(true);
        }
    });

    it("fails closed when the target migration is missing or duplicated", () => {
        expect(() => resolveMysqlVoiceIdentityMigrationSequence({
            migrationNames: ["20260710150000_before", "20260711100000_after"],
            targetMigration: MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
        })).toThrow(/exactly once/);
        expect(() => resolveMysqlVoiceIdentityMigrationSequence({
            migrationNames: [MYSQL_VOICE_IDENTITY_TARGET_MIGRATION, MYSQL_VOICE_IDENTITY_TARGET_MIGRATION],
            targetMigration: MYSQL_VOICE_IDENTITY_TARGET_MIGRATION,
        })).toThrow(/exactly once/);
    });
});
