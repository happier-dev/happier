import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AccountStatusV1, HomeRoleV1 } from "@happier-dev/protocol";

import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import {
    assertHomeOwnershipSurvivesTransitionInTx,
    authorizeHomeGovernanceMutationInTx,
    countActiveHomeOwnersInTx,
} from "./homeCapabilities";

let sequence = 0;

async function createAccount(
    homeRole: HomeRoleV1,
    status: AccountStatusV1 = "active",
): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-governance-${sequence}`, homeRole, status },
        select: { id: true },
    });
    return created.id;
}

/**
 * One realistic demotion: guard inside the same serializable transaction that
 * performs the write, exactly as every governance mutation must.
 */
async function demoteOwner(accountId: string): Promise<string> {
    return await inTx(async (tx) => {
        const guard = await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: accountId,
            nextHomeRole: "member",
        });
        if (guard.status !== "allowed") return guard.status === "rejected" ? guard.code : guard.status;
        await tx.account.update({ where: { id: accountId }, data: { homeRole: "member" } });
        return "applied";
    }, { isolationLevel: "Serializable" });
}

let harness: LightSqliteHarness;

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-governance-",
        initAuth: false,
        initEncrypt: false,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.account.deleteMany({});
});

describe("Home last-active-owner invariant", () => {
    it("refuses every transition that would remove the final active owner", async () => {
        const owner = await createAccount("owner");

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: owner,
            nextHomeRole: "member",
        }))).resolves.toEqual({ status: "rejected", code: "home_owner_transfer_required" });

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: owner,
            nextStatus: "suspended",
        }))).resolves.toEqual({ status: "rejected", code: "home_owner_transfer_required" });

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: owner,
            nextStatus: "disabled",
        }))).resolves.toEqual({ status: "rejected", code: "home_owner_transfer_required" });

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: owner,
            removesAccount: true,
        }))).resolves.toEqual({ status: "rejected", code: "home_owner_transfer_required" });
    });

    it("allows removing one owner only while another owner is active", async () => {
        const first = await createAccount("owner");
        const second = await createAccount("owner");

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: first,
            removesAccount: true,
        }))).resolves.toEqual({ status: "allowed" });

        await db.account.update({ where: { id: second }, data: { status: "suspended" } });

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: first,
            removesAccount: true,
        }))).resolves.toEqual({ status: "rejected", code: "home_owner_transfer_required" });
    });

    it("does not protect ownership the target never held", async () => {
        await createAccount("owner");
        const member = await createAccount("member");
        const retiredOwner = await createAccount("owner", "disabled");

        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: member,
            nextStatus: "disabled",
        }))).resolves.toEqual({ status: "allowed" });
        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: retiredOwner,
            removesAccount: true,
        }))).resolves.toEqual({ status: "allowed" });
    });

    it("reports an absent target instead of inventing an ownership verdict", async () => {
        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: "missing-account",
            removesAccount: true,
        }))).resolves.toEqual({ status: "target_not_found" });
    });

    it("leaves an unowned bootstrap Home free to change any Account", async () => {
        const member = await createAccount("member");
        await expect(inTx(async (tx) => await countActiveHomeOwnersInTx(tx))).resolves.toBe(0);
        await expect(inTx(async (tx) => await assertHomeOwnershipSurvivesTransitionInTx(tx, {
            targetAccountId: member,
            nextStatus: "suspended",
        }))).resolves.toEqual({ status: "allowed" });
    });

    it("cannot let two concurrent demotions both commit", async () => {
        const first = await createAccount("owner");
        const second = await createAccount("owner");

        const outcomes = await Promise.all([demoteOwner(first), demoteOwner(second)]);

        expect(outcomes.filter((outcome) => outcome === "applied")).toHaveLength(1);
        expect(outcomes).toContain("home_owner_transfer_required");
        await expect(db.account.count({ where: { homeRole: "owner", status: "active" } })).resolves.toBe(1);
    });
});

describe("Home governance mutation authorization", () => {
    it("refuses an admin every owner transition even when another owner is active", async () => {
        const admin = await createAccount("admin");
        const firstOwner = await createAccount("owner");
        await createAccount("owner");
        const member = await createAccount("member");

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "set_home_role", targetAccountId: firstOwner, nextHomeRole: "admin" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "set_home_role", targetAccountId: member, nextHomeRole: "owner" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "set_home_role", targetAccountId: member, nextHomeRole: "admin" },
        }))).resolves.toMatchObject({ status: "authorized" });
    });

    it("refuses an admin the lifecycle of an owner Account even with two active owners", async () => {
        const admin = await createAccount("admin");
        const owner = await createAccount("owner");
        await createAccount("owner");
        const member = await createAccount("member");

        for (const nextStatus of ["suspended", "active"] as const) {
            await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
                actorAccountId: admin,
                request: { operation: "set_account_status", targetAccountId: owner, nextStatus },
            }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
        }

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "set_account_status", targetAccountId: member, nextStatus: "suspended" },
        }))).resolves.toMatchObject({ status: "authorized" });
    });

    it("keeps Account erasure and authentication policy owner-only", async () => {
        const admin = await createAccount("admin");
        const owner = await createAccount("owner");
        const member = await createAccount("member");

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "erase_account", targetAccountId: member },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: admin,
            request: { operation: "set_authentication_policy" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: owner,
            request: { operation: "erase_account", targetAccountId: member },
        }))).resolves.toMatchObject({ status: "authorized" });
    });

    it("refuses an ordinary member and an inactive administrator", async () => {
        const member = await createAccount("member");
        const suspendedOwner = await createAccount("owner", "suspended");
        const target = await createAccount("member");

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: member,
            request: { operation: "view" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: suspendedOwner,
            request: { operation: "set_account_status", targetAccountId: target, nextStatus: "suspended" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });
    });

    it("rejects an absent actor or target without disclosing the other", async () => {
        const owner = await createAccount("owner");

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: "missing-actor",
            request: { operation: "view" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_governance_forbidden" });

        await expect(inTx(async (tx) => await authorizeHomeGovernanceMutationInTx(tx, {
            actorAccountId: owner,
            request: { operation: "set_account_status", targetAccountId: "missing-target", nextStatus: "suspended" },
        }))).resolves.toMatchObject({ status: "rejected", code: "home_account_not_found" });
    });
});
