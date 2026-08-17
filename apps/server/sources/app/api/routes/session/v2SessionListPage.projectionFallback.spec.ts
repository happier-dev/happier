import { describe, expect, it, vi } from "vitest";

// The primary attention predicate compares `latestReadyEventSeq` to `lastViewedSessionSeq` through
// a Prisma field reference, which is reached off the client. Only the field handles are needed here.
vi.mock("@/storage/db", () => ({
    db: {
        session: {
            fields: {
                lastViewedSessionSeq: { modelName: "Session", name: "lastViewedSessionSeq" },
            },
        },
    },
}));

import {
    isMissingAttentionProjectionColumnError,
} from "./v2SessionListPage";
import { createV2SessionListAttentionRowsWhere } from "./v2SessionListInitialPage";

function createMissingColumnError(column: string): unknown {
    return {
        code: "P2022",
        message: `The column \`main.Session.${column}\` does not exist in the current database.`,
    };
}

describe("session list projection fallback", () => {
    it("keeps recognising the rollback-turn relation columns the primary projection reaches through", () => {
        for (const column of ["rollbackState", "SessionTurn"]) {
            expect(
                isMissingAttentionProjectionColumnError(createMissingColumnError(column)),
            ).toBe(true);
        }
    });

    it("does not recognise an unrelated database failure", () => {
        expect(isMissingAttentionProjectionColumnError(new Error("connection reset"))).toBe(false);
        expect(
            isMissingAttentionProjectionColumnError({
                code: "P2022",
                message: 'The column `main.Session.tag` does not exist in the current database.',
            }),
        ).toBe(false);
    });

    it("keeps the ready-event attention predicate on shareable publication states", () => {
        const primaryWhere = JSON.stringify(
            createV2SessionListAttentionRowsWhere(),
            (_key, value) => typeof value === "bigint" ? value.toString() : value,
        );
        expect(primaryWhere).toContain("latestReadyEventSeq");
        expect(primaryWhere).not.toContain("server_partial");
    });
});
