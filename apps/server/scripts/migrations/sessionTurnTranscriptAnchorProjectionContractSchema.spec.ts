import { readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const serverRoot = join(import.meta.dirname, "..", "..");
const expandMigrationId = "20260810200000_expand_session_turn_anchor_projection";
const contractMigrationId = "20260810210000_contract_session_turn_anchor_projection";

describe("SessionTurn transcript-anchor projection migration lifecycle", () => {
    it.each([
        "prisma/migrations",
        "prisma/sqlite/migrations",
        "prisma/mysql/migrations",
    ] as const)("keeps the active %s root at EXPAND until final-contract activation is authorized", (migrationRoot) => {
        const migrationNames = readdirSync(join(serverRoot, migrationRoot), { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name);

        expect(migrationNames).toContain(expandMigrationId);
        expect(migrationNames).not.toContain(contractMigrationId);
    });
});
