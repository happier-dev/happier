import { beforeEach, describe, expect, it, vi } from "vitest";

// Substitute only the database and logger process boundaries; delivery and settlement logic stay real.
const boundary = vi.hoisted(() => ({ findUnique: vi.fn(), transaction: vi.fn(), log: vi.fn() }));
vi.mock("@/storage/db", () => ({ db: { account: { findUnique: boundary.findUnique }, $transaction: boundary.transaction } }));
vi.mock("@/utils/logging/log", () => ({ log: boundary.log }));

import { deliverTeamInvitationEmail, type DeliverTeamInvitationEmailInput } from "./emailDelivery";

const input = {
    invitationId: "invitation-1", inviterAccountId: "inviter-1",
    recipient: { address: "recipient@example.com", normalizedEmail: "recipient@example.com" },
    joinUrl: "https://home.example/join/private-bearer", homeName: "Home", teamName: "Team",
    role: "member", historyAccess: "from_membership", expiresAt: new Date("2027-01-01T00:00:00Z"),
} satisfies DeliverTeamInvitationEmailInput;

describe("invitation email failure diagnostics", () => {
    beforeEach(() => { vi.resetAllMocks(); boundary.findUnique.mockResolvedValue(null); });

    it.each(["inviter read", "mail transport"])("retains the safe %s cause without claiming delivery or replaying", async phase => {
        const privateDetails = "private-bearer recipient@example.com";
        const error = Object.assign(new Error(privateDetails), { code: "ECONNRESET" });
        if (phase === "inviter read") boundary.findUnique.mockRejectedValueOnce(error);
        const deliver = vi.fn(async () => { throw error; });

        await expect(deliverTeamInvitationEmail({ delivery: { isReady: async () => true, deliver } }, input)).resolves.toBeNull();

        expect(deliver).toHaveBeenCalledTimes(phase === "inviter read" ? 0 : 1);
        expect(boundary.transaction).not.toHaveBeenCalled();
        expect(boundary.log).toHaveBeenCalledWith(expect.objectContaining({
            module: "teams", level: "warn", failureCause: expect.objectContaining({ errorCode: "ECONNRESET" }),
        }), expect.any(String));
        expect(JSON.stringify(boundary.log.mock.calls)).not.toContain(privateDetails);
    });
});
