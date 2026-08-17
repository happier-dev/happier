import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    initializeSessionTurnTranscriptAnchorProjectionProtocolActivation,
    isSessionTurnTranscriptAnchorProjectionProtocolActive,
    resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests,
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION,
} from "./sessionTurnTranscriptAnchorProjectionProtocolContract";

const FINAL_CONTRACT_MARKER_KEY = "session.turn.transcript-anchor-projection.final-contract.v1";
const FINAL_CONTRACT_MARKER_VALUE = SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION;

describe("SessionTurn transcript-anchor projection database contract", () => {
    beforeEach(() => {
        resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests();
    });

    it("activates only after the independently persisted final marker, finished CONTRACT migration, and a zero-v0 audit", async () => {
        const query = vi.fn().mockResolvedValue([
            { migration_name: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION },
        ]);
        const findUnique = vi.fn().mockResolvedValue({
            value: FINAL_CONTRACT_MARKER_VALUE,
        });
        const count = vi.fn().mockResolvedValue(0);

        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation({
            $queryRawUnsafe: query,
            simpleCache: { findUnique },
            sessionTurn: { count },
        })).resolves.toBe(true);
        expect(isSessionTurnTranscriptAnchorProjectionProtocolActive()).toBe(true);
        expect(findUnique).toHaveBeenCalledWith({
            where: { key: FINAL_CONTRACT_MARKER_KEY },
            select: { value: true },
        });
        expect(count).toHaveBeenCalledWith({
            where: { transcriptAnchorProjectionVersion: { not: 1 } },
        });
    });

    it("re-blocks activation when a v0 row reappears after a previously successful activation", async () => {
        const query = vi.fn().mockResolvedValue([
            { migration_name: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION },
        ]);
        const count = vi.fn()
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(1);
        const database = {
            $queryRawUnsafe: query,
            simpleCache: {
                findUnique: vi.fn().mockResolvedValue({
                    value: FINAL_CONTRACT_MARKER_VALUE,
                }),
            },
            sessionTurn: { count },
        };

        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation(database)).resolves.toBe(true);
        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation(database)).resolves.toBe(false);
        expect(isSessionTurnTranscriptAnchorProjectionProtocolActive()).toBe(false);
    });

    it("does not activate when CONTRACT migration application is the only proof", async () => {
        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation({
            $queryRawUnsafe: vi.fn().mockResolvedValue([
                { migration_name: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION },
            ]),
            simpleCache: { findUnique: vi.fn().mockResolvedValue(null) },
            sessionTurn: { count: vi.fn().mockResolvedValue(0) },
        })).resolves.toBe(false);
        expect(isSessionTurnTranscriptAnchorProjectionProtocolActive()).toBe(false);
    });

    it("fails closed when the migration, exact marker, or zero-v0 audit cannot be proven", async () => {
        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation({
            $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("ledger unavailable")),
            simpleCache: { findUnique: vi.fn() },
            sessionTurn: { count: vi.fn() },
        })).resolves.toBe(false);

        await expect(initializeSessionTurnTranscriptAnchorProjectionProtocolActivation({
            $queryRawUnsafe: vi.fn().mockResolvedValue([
                { migration_name: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION },
            ]),
            simpleCache: { findUnique: vi.fn().mockResolvedValue({ value: "wrong-contract" }) },
            sessionTurn: { count: vi.fn().mockResolvedValue(0) },
        })).resolves.toBe(false);
        expect(isSessionTurnTranscriptAnchorProjectionProtocolActive()).toBe(false);
    });

});
