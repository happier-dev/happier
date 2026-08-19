import { describe, expect, it } from "vitest";

import {
    buildSessionTurnProjectionIdsSql,
    quoteSessionTurnProjectionIdentifier,
    sessionTurnProjectionPlaceholder,
    type SessionTurnProjectionDialect,
} from "./buildSessionTurnProjectionSql";

/**
 * SQLite, Postgres and MySQL are all first-class here, and they disagree about the two things
 * this statement is made of: how identifiers are quoted and how parameters are referenced.
 * Both disagreements fail SILENTLY in the shapes that matter — a backtick statement is a syntax
 * error only on the dialect nobody ran locally, and a positional `?` bound out of order returns
 * plausible rows for the wrong session. So the matrix is pinned here rather than discovered in
 * whichever deployment happens to run MySQL.
 */

const DIALECTS: readonly SessionTurnProjectionDialect[] = ["postgres", "sqlite", "mysql"];

function placeholdersInTextualOrder(
    sql: string,
    dialect: SessionTurnProjectionDialect,
): string[] {
    if (dialect === "postgres") return sql.match(/\$\d+/g) ?? [];
    return sql.match(/\?/g) ?? [];
}

describe("session turn projection SQL", () => {
    it("quotes identifiers the way each dialect requires", () => {
        expect(quoteSessionTurnProjectionIdentifier("postgres", "SessionMessage")).toBe('"SessionMessage"');
        expect(quoteSessionTurnProjectionIdentifier("sqlite", "SessionMessage")).toBe('"SessionMessage"');
        // MySQL only accepts double quotes under ANSI_QUOTES, which is not the default.
        expect(quoteSessionTurnProjectionIdentifier("mysql", "SessionMessage")).toBe("`SessionMessage`");
    });

    it("refuses an identifier that is not a plain column name", () => {
        expect(() => quoteSessionTurnProjectionIdentifier("mysql", "id`; DROP TABLE x; --")).toThrow();
    });

    it("numbers Postgres parameters and leaves the others positional", () => {
        expect(sessionTurnProjectionPlaceholder("postgres", 3)).toBe("$3");
        expect(sessionTurnProjectionPlaceholder("sqlite", 3)).toBe("?");
        expect(sessionTurnProjectionPlaceholder("mysql", 3)).toBe("?");
    });

    for (const dialect of DIALECTS) {
        describe(dialect, () => {
            it("emits exactly one placeholder per declared parameter, in statement order", () => {
                // The bug this exists for: a helper that builds a fragment once and reuses its
                // text repeats a `?` without declaring a second argument, so every later value
                // binds one slot early. Counting placeholders against `parameterOrder` is what
                // makes that impossible to land.
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: true,
                });
                const placeholders = placeholdersInTextualOrder(built.sql, dialect);
                expect(placeholders).toHaveLength(built.parameterOrder.length);
                if (dialect === "postgres") {
                    // Postgres placeholders must be 1..n in the order they appear.
                    expect(placeholders).toEqual(
                        built.parameterOrder.map((_, index) => `$${index + 1}`),
                    );
                }
            });

            it("binds the session before the paging cursor, so positional values cannot swap", () => {
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: true,
                });
                expect(built.parameterOrder[0]).toBe("sessionId");
                expect(built.parameterOrder).toContain("beforeSeq");
                expect(built.parameterOrder.indexOf("beforeSeq"))
                    .toBeLessThan(built.parameterOrder.indexOf("turnLimit"));
            });

            it("drops the cursor entirely on the newest page", () => {
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(built.parameterOrder).not.toContain("beforeSeq");
                const placeholders = placeholdersInTextualOrder(built.sql, dialect);
                expect(placeholders).toHaveLength(built.parameterOrder.length);
            });

            it("scopes to the main chain by null sidechain, and to a sidechain by value", () => {
                const main = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(main.sql).toContain("IS NULL");
                expect(main.parameterOrder).not.toContain("sidechainId");

                const sidechain = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: "sc-1",
                    hasBeforeSeq: false,
                });
                expect(sidechain.parameterOrder).toContain("sidechainId");
                expect(placeholdersInTextualOrder(sidechain.sql, dialect))
                    .toHaveLength(sidechain.parameterOrder.length);
            });

            it("treats a legacy null role as opening a turn", () => {
                // Everywhere else on this route a null `messageRole` counts as `user`. If it did
                // not open a turn here, every legacy row would shift the turn boundaries and the
                // wrong reply would be paired with the wrong prompt.
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(built.sql).toContain("IS NULL OR");
                expect(built.parameterOrder.filter((name) => name === "userRole").length)
                    .toBeGreaterThanOrEqual(1);
            });

            it("asks for the last reply of each turn for BOTH agent and tool rows", () => {
                // A turn that produced no agent text falls back to tool text for its subtitle,
                // so omitting tool rows would silently blank tool-only turns.
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(built.parameterOrder).toContain("agentRole");
                expect(built.parameterOrder).toContain("toolRole");
                expect(built.sql.match(/ROW_NUMBER\(\) OVER/g) ?? []).toHaveLength(2);
            });

            it("bounds the reply lookups to the requested turns, not the whole session", () => {
                // Without this the projection returns the last reply of EVERY turn ever, which
                // is the over-fetch it exists to remove.
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(built.sql.match(/turn_no IN \(SELECT turn_no FROM recent\)/g) ?? [])
                    .toHaveLength(3);
            });

            it("states the window frame instead of relying on the dialect default", () => {
                const built = buildSessionTurnProjectionIdsSql({
                    dialect,
                    sidechainId: null,
                    hasBeforeSeq: false,
                });
                expect(built.sql).toContain("ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW");
            });
        });
    }
});
