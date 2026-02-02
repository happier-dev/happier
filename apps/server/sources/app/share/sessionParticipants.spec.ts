import { describe, expect, it, vi } from "vitest";

import { getSessionParticipantUserIds } from "./sessionParticipants";

describe("getSessionParticipantUserIds", () => {
    it("returns owner + sharedWithUserIds (deduped)", async () => {
        const tx: any = {
            session: {
                findUnique: vi.fn(async () => ({
                    accountId: "owner",
                    shares: [{ sharedWithUserId: "u2" }, { sharedWithUserId: "u2" }, { sharedWithUserId: "u3" }],
                })),
            },
        };

        const ids = await getSessionParticipantUserIds({ sessionId: "s1", tx });
        expect(tx.session.findUnique).toHaveBeenCalledWith({
            where: { id: "s1" },
            select: { accountId: true, shares: { select: { sharedWithUserId: true } } },
        });
        expect(new Set(ids)).toEqual(new Set(["owner", "u2", "u3"]));
    });
});

