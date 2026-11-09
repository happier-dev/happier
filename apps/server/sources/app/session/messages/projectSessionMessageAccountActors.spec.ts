import { describe, expect, it, vi } from "vitest";

vi.mock("@/storage/blob/files", () => ({
    getPublicUrl: (path: string) => `https://files.test/${path}`,
}));

const warn = vi.fn();
vi.mock("@/utils/logging/log", () => ({ warn: (...args: unknown[]) => warn(...args) }));

const {
    projectAuthenticatedAccountActorsById,
    projectSessionMessageAccountActors,
} = await import("./projectSessionMessageAccountActors");

function accountReceipt(
    actorAccountId: string,
    sessionRelationship: "owner" | "sharedEditor" | "sharedAdmin" = "sharedEditor",
) {
    return { v: 1, issuer: "authenticatedAccount", actorAccountId, sessionRelationship };
}

const MACHINE_RECEIPT = { v: 1, issuer: "authenticatedMachine" };

function createAccountReader(accounts: readonly {
    id: string;
    name: string | null;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
    avatar: unknown;
}[]) {
    const findMany = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        accounts.filter((account) => args.where.id.in.includes(account.id)));
    return { reader: { account: { findMany } } as never, findMany };
}

const ALICE = {
    id: "acc_alice",
    name: "Alice Chen",
    firstName: "Alice",
    lastName: "Chen",
    username: "alice",
    avatar: { path: "avatars/alice.png" },
};

describe("projectSessionMessageAccountActors", () => {
    it("reuses the same safe profile projection for directly authenticated domain authors", async () => {
        const { reader, findMany } = createAccountReader([ALICE]);
        await expect(projectAuthenticatedAccountActorsById(reader, ["acc_alice", "acc_gone", null]))
            .resolves.toEqual([{
                v: 1,
                accountId: "acc_alice",
                profile: {
                    name: "Alice Chen",
                    firstName: "Alice Chen",
                    lastName: null,
                    username: "alice",
                    avatarUrl: "https://files.test/avatars/alice.png",
                },
            }, {
                v: 1,
                accountId: "acc_gone",
                profile: null,
            }, null]);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("projects the exact admitted Account with its current display profile", async () => {
        const { reader } = createAccountReader([ALICE]);
        await expect(projectSessionMessageAccountActors(reader, [{
            messageRole: "user",
            inputAdmissionReceipt: accountReceipt("acc_alice"),
            authorAccountId: "acc_alice",
        }])).resolves.toEqual([{
            v: 1,
            accountId: "acc_alice",
            profile: {
                name: "Alice Chen",
                firstName: "Alice Chen",
                lastName: null,
                username: "alice",
                avatarUrl: "https://files.test/avatars/alice.png",
            },
        }]);
    });

    it("preserves a readable profile while marking the resource relationship as former", async () => {
        const { reader } = createAccountReader([ALICE]);
        await expect(projectAuthenticatedAccountActorsById(reader, ["acc_alice"], ["former"]))
            .resolves.toEqual([{
                v: 1,
                accountId: "acc_alice",
                accessibility: "former",
                profile: {
                    name: "Alice Chen",
                    firstName: "Alice Chen",
                    lastName: null,
                    username: "alice",
                    avatarUrl: "https://files.test/avatars/alice.png",
                },
            }]);
    });

    it("retains known actor evidence from retired receipt fields without accepting Account-column disagreement", async () => {
        const { reader } = createAccountReader([ALICE]);
        const receipt = {
            ...accountReceipt("acc_alice"), retired: true,
            admittedTarget: { homeId: "home", accountId: "acc_alice", sessionId: "session", machineId: "machine", installationId: "installation", retired: true },
        };
        const actors = await projectSessionMessageAccountActors(reader, [
            { messageRole: "user", inputAdmissionReceipt: receipt, authorAccountId: "acc_alice" },
            { messageRole: "user", inputAdmissionReceipt: receipt, authorAccountId: "acc_mallory" },
            { messageRole: "agent", inputAdmissionReceipt: receipt, authorAccountId: null },
        ]);
        expect(actors.map((actor) => actor?.accountId ?? null)).toEqual(["acc_alice", null, null]);
        expect(actors[0]).not.toHaveProperty("inputAdmissionReceipt");
    });

    it("never discloses the admission relationship of a Team/Group-derived editor", async () => {
        const { reader } = createAccountReader([ALICE]);
        const [actor] = await projectSessionMessageAccountActors(reader, [{
            messageRole: "user",
            inputAdmissionReceipt: accountReceipt("acc_alice", "sharedAdmin"),
            authorAccountId: "acc_alice",
        }]);
        expect(actor).not.toHaveProperty("sessionRelationship");
        expect(Object.keys(actor!).sort()).toEqual(["accountId", "profile", "v"]);
    });

    it("retains the historical actor with a null profile after Account deletion", async () => {
        const { reader } = createAccountReader([]);
        await expect(projectSessionMessageAccountActors(reader, [{
            messageRole: "user",
            inputAdmissionReceipt: accountReceipt("acc_gone"),
            // `onDelete: SetNull` legitimately nulls the projection while the receipt survives.
            authorAccountId: null,
        }])).resolves.toEqual([{ v: 1, accountId: "acc_gone", profile: null }]);
    });

    it("emits explicit null for machine, legacy, malformed, and non-user rows", async () => {
        const { reader, findMany } = createAccountReader([ALICE]);
        await expect(projectSessionMessageAccountActors(reader, [
            { messageRole: "user", inputAdmissionReceipt: MACHINE_RECEIPT, authorAccountId: null },
            { messageRole: "user", inputAdmissionReceipt: null, authorAccountId: null },
            { messageRole: "user", inputAdmissionReceipt: { v: 2, issuer: "authenticatedAccount", actorAccountId: "acc_alice" }, authorAccountId: null },
            { messageRole: "agent", inputAdmissionReceipt: accountReceipt("acc_alice"), authorAccountId: null },
            { messageRole: null, inputAdmissionReceipt: accountReceipt("acc_alice"), authorAccountId: null },
        ])).resolves.toEqual([null, null, null, null, null]);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("fails closed and reports when a stored projection disagrees with the receipt", async () => {
        warn.mockClear();
        const { reader } = createAccountReader([ALICE]);
        await expect(projectSessionMessageAccountActors(reader, [{
            messageRole: "user",
            inputAdmissionReceipt: accountReceipt("acc_alice"),
            authorAccountId: "acc_mallory",
        }])).resolves.toEqual([null]);
        expect(warn).toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain("acc_mallory");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("acc_alice");
    });

    it("resolves repeated and multiple actors with one bounded unique-id lookup", async () => {
        const bob = { id: "acc_bob", name: null, firstName: null, lastName: null, username: "bob", avatar: null };
        const { reader, findMany } = createAccountReader([ALICE, bob]);
        const actors = await projectSessionMessageAccountActors(reader, [
            { messageRole: "user", inputAdmissionReceipt: accountReceipt("acc_alice"), authorAccountId: "acc_alice" },
            { messageRole: "user", inputAdmissionReceipt: accountReceipt("acc_bob"), authorAccountId: "acc_bob" },
            { messageRole: "user", inputAdmissionReceipt: accountReceipt("acc_alice"), authorAccountId: "acc_alice" },
            { messageRole: "agent", inputAdmissionReceipt: MACHINE_RECEIPT, authorAccountId: null },
        ]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(findMany.mock.calls[0]![0].where.id.in.slice().sort()).toEqual(["acc_alice", "acc_bob"]);
        expect(actors.map((actor) => actor?.accountId ?? null)).toEqual([
            "acc_alice",
            "acc_bob",
            "acc_alice",
            null,
        ]);
        expect(actors[1]!.profile).toEqual({
            name: null,
            firstName: null,
            lastName: null,
            username: "bob",
            avatarUrl: null,
        });
    });

    it("performs no lookup at all when a page has no Account-authored rows", async () => {
        const { reader, findMany } = createAccountReader([ALICE]);
        await expect(projectSessionMessageAccountActors(reader, [])).resolves.toEqual([]);
        expect(findMany).not.toHaveBeenCalled();
    });
});
