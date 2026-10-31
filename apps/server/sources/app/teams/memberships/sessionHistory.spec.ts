import { describe, expect, it } from "vitest";
import { SessionHistoryAccess } from "@/storage/enums.generated";
import { mintSessionAccessStartsAt, sessionHistoryAccessOf } from "./sessionHistory";

describe("Session-history horizon minting", () => {
    it("mints no lower horizon for all-existing admission", () => {
        expect(mintSessionAccessStartsAt(SessionHistoryAccess.all_existing, new Date("2026-04-01T10:00:00.000Z")))
            .toBeNull();
    });

    it("mints exactly the activation instant for from-membership admission", () => {
        const activationNow = new Date("2026-04-01T10:00:00.123Z");
        const minted = mintSessionAccessStartsAt(SessionHistoryAccess.from_membership, activationNow);

        // The cutoff must be the transaction's own activation time, not a rounded or
        // derived value: Lane 04 compares it strictly against grant `effectiveAt`, so
        // losing sub-second precision would silently admit or deny a boundary grant.
        expect(minted?.getTime()).toBe(activationNow.getTime());
    });

    it("projects the stored cutoff back to its semantic mode", () => {
        expect(sessionHistoryAccessOf(null)).toBe(SessionHistoryAccess.all_existing);
        expect(sessionHistoryAccessOf(new Date("2026-04-01T10:00:00.000Z")))
            .toBe(SessionHistoryAccess.from_membership);
    });

});
