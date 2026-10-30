import { setImmediate } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Persistent database access is the boundary; policy, lifecycle admission,
// provider registration and GitHub eligibility all execute their real logic.
const boundary = vi.hoisted(() => ({
    account: vi.fn(),
    identity: vi.fn(),
}));
vi.mock("@/storage/db", async () => {
    const { createDbTransactionMock, inTxPostgresControlStatementMock } = await import("@/app/api/testkit/dbMocks");
    const database = {
        ...inTxPostgresControlStatementMock,
        account: { findUnique: (...args: unknown[]) => boundary.account(...args) },
        accountIdentity: { findFirst: (...args: unknown[]) => boundary.identity(...args) },
    };
    const { wrapDb } = createDbTransactionMock(() => database);
    return { db: wrapDb(database) };
});

import { enforceLoginEligibility } from "./enforceLoginEligibility";

const env = {
    AUTH_REQUIRED_LOGIN_PROVIDERS: "github",
    AUTH_GITHUB_ALLOWED_USERS: "octocat",
};
const identity = {
    id: "identity-a", providerLogin: "octocat", token: null,
    eligibilityStatus: "eligible", eligibilityCheckedAt: null, eligibilityNextCheckAt: null,
};

describe("enforceLoginEligibility provider cache", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        boundary.account.mockResolvedValue({ id: "account-a", status: "active" });
        boundary.identity.mockResolvedValue(identity);
    });

    it("coalesces provider work while checking current lifecycle before every cached admission", async () => {
        let releaseIdentity: (() => void) | undefined;
        let signalIdentity!: () => void;
        const started = new Promise<void>((resolve) => { signalIdentity = resolve; });
        boundary.identity.mockImplementationOnce(() => new Promise((resolve) => {
            releaseIdentity = () => resolve(identity);
            signalIdentity();
        }));
        const first = enforceLoginEligibility({ accountId: "account-a", env });
        try {
            await Promise.race([started, first.then(() => {
                throw new Error("Eligibility settled before reaching the held provider identity read");
            })]);
            const second = enforceLoginEligibility({ accountId: "account-a", env });
            await setImmediate();
            expect(boundary.identity).toHaveBeenCalledTimes(1);
            releaseIdentity?.();
            await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
            await expect(enforceLoginEligibility({ accountId: "account-a", env })).resolves.toEqual({ ok: true });
            expect(boundary.identity).toHaveBeenCalledTimes(1);
        } finally {
            releaseIdentity?.();
            await first;
        }

        boundary.account.mockResolvedValue({ id: "account-a", status: "suspended" });
        await expect(enforceLoginEligibility({ accountId: "account-a", env })).resolves.toEqual({
            ok: false, statusCode: 403, error: "account-disabled",
        });
    });

    it("fails closed on a current database failure despite a hot provider result and permits recovery", async () => {
        await expect(enforceLoginEligibility({ accountId: "account-b", env })).resolves.toEqual({ ok: true });
        boundary.account.mockRejectedValueOnce(new Error("database unavailable"));
        await expect(enforceLoginEligibility({ accountId: "account-b", env })).resolves.toEqual({
            ok: false, statusCode: 503, error: "upstream_error",
        });
        await expect(enforceLoginEligibility({ accountId: "account-b", env })).resolves.toEqual({ ok: true });
    });
});
