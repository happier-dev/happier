import { spawnSync } from "node:child_process";
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { db } from "@/storage/db";
import { readCurrentServerIdentityId } from "@/app/serverIdentity/serverIdentity";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { redeemHomeClaimCode } from "./homeClaimCode";

/**
 * The composed proof for the deployment-local owner claim.
 *
 * Each case runs the real server executable as a real process, with real
 * arguments, against the real temporary SQLite Home this harness created. The
 * argument parsing, the claim service, the transaction, the change publication,
 * the printed payload and the process exit status are all the production ones —
 * nothing here is substituted, so a passing case means an operator running this
 * command on a real deployment gets this outcome.
 *
 * `claimHomeOwnerCommand.integration.spec.ts` owns the exhaustive result-status
 * and invalidation contract against the same real database. This file only adds
 * what that one structurally cannot: that the executables actually reach it.
 */
const ENTRYPOINT_TIMEOUT_MS = 180_000;

type EntrypointRun = Readonly<{
    status: number | null;
    stdout: string;
    stderr: string;
}>;

let harness: LightSqliteHarness;
let sequence = 0;

/**
 * Runs one server executable exactly as `yarn start`/`yarn start:light` do.
 *
 * `HAPPIER_MANAGED_RELAY_PURPOSE` is cleared so this behaves as an ordinary
 * self-hosted Home rather than a managed Personal Home, which is the deployment
 * the operator command exists for.
 */
function runEntrypoint(entrypoint: string, args: readonly string[]): EntrypointRun {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(harness.envBase)) {
        if (typeof value === "string") env[key] = value;
    }
    delete env.HAPPIER_MANAGED_RELAY_PURPOSE;
    delete env.HAPPY_MANAGED_RELAY_PURPOSE;

    const result = spawnSync(
        process.execPath,
        ["./scripts/runTsx.mjs", "--tsconfig", "./tsconfig.json", entrypoint, ...args],
        {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: ENTRYPOINT_TIMEOUT_MS,
        },
    );
    return {
        status: result.status,
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
    };
}

/**
 * Extract the single structured command result from the process output. The
 * server logger may also write diagnostic lines to stdout.
 */
function readClaimOutput(run: EntrypointRun): Record<string, unknown> {
    const results = run.stdout.split("\n").flatMap((line) => {
        if (!line.trim().startsWith("{")) return [];
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || !('v' in value) || value.v !== 1 || !('command' in value)) return [];
        if (value.command !== 'claim-home-owner' && value.command !== 'print-home-claim-code') return [];
        return [value];
    });
    expect(results, `missing or duplicate command result. stderr: ${run.stderr}`).toHaveLength(1);
    return results[0]!;
}

async function createAccount(
    options: Readonly<{ homeRole?: "owner" | "admin" | "member"; status?: "active" | "suspended" | "disabled" }> = {},
): Promise<string> {
    sequence += 1;
    const account = await db.account.create({
        data: {
            publicKey: `pk_claim_entrypoint_${sequence}`,
            encryptionMode: "plain",
            homeRole: options.homeRole ?? "member",
            status: options.status ?? "active",
        },
        select: { id: true },
    });
    return account.id;
}

async function readHomeRole(accountId: string): Promise<string> {
    const account = await db.account.findUniqueOrThrow({
        where: { id: accountId },
        select: { homeRole: true },
    });
    return account.homeRole;
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-claim-entrypoint-",
    });
}, 180_000);
afterAll(async () => await harness.close());
afterEach(async () => {
    await db.simpleCache.deleteMany({ where: { key: "home.owner-claim-code.v1" } });
    await db.homeAdministrationEvent.deleteMany({});
    await db.accountChange.deleteMany({});
    await db.account.deleteMany({});
});

describe.each(["./sources/main.light.ts", "./sources/main.ts"])("Home owner claim through %s", (entrypoint) => {
    it("claims the named Account and persists its role and governance refresh", async () => {
        const target = await createAccount();
        const admin = await createAccount({ homeRole: "admin" });

        const run = runEntrypoint(entrypoint, [`--claim-home-owner=${target}`]);

        expect(run.status, `stderr: ${run.stderr}`).toBe(0);
        const output = readClaimOutput(run);
        expect(output).toMatchObject({
            v: 1,
            command: "claim-home-owner",
            intent: "initial_claim",
            targetAccountId: target,
            result: { status: "claimed", ownerAccountId: target },
        });
        expect(output.homeServerIdentityId).toMatch(/^srv_/);
        expect(output.homeServerIdentityId).toBe(await readCurrentServerIdentityId());

        // The decisive assertion: the Home the operator pointed at actually has
        // its owner now, written by the process they ran.
        expect(await readHomeRole(target)).toBe("owner");
        expect(await db.accountChange.findMany({
            where: { accountId: { in: [target, admin] } },
            select: { accountId: true, kind: true, entityId: true, cursor: true },
        })).toEqual(expect.arrayContaining([
            { accountId: target, kind: "account", entityId: "self", cursor: 1 },
            { accountId: admin, kind: "account", entityId: "home-governance", cursor: 1 },
        ]));
        expect(await db.accountChange.count()).toBe(2);
    }, ENTRYPOINT_TIMEOUT_MS);

    it("records the explicit recovery intent while enforcing the same rules", async () => {
        const target = await createAccount();

        const run = runEntrypoint(entrypoint, [
            "--claim-home-owner",
            target,
            "--recover-lost-owner",
        ]);

        expect(run.status, `stderr: ${run.stderr}`).toBe(0);
        expect(readClaimOutput(run)).toMatchObject({
            intent: "lost_owner_recovery",
            result: { status: "claimed", ownerAccountId: target },
        });
        expect(await readHomeRole(target)).toBe("owner");
    }, ENTRYPOINT_TIMEOUT_MS);

    it("refuses an owned Home with a nonzero status and changes nothing", async () => {
        const existingOwner = await createAccount({ homeRole: "owner" });
        const target = await createAccount();

        const run = runEntrypoint(entrypoint, [`--claim-home-owner=${target}`]);

        // A refusal must be unmistakable to a provisioning script.
        expect(run.status).toBe(1);
        expect(readClaimOutput(run)).toMatchObject({
            result: { status: "already_owned", activeOwnerCount: 1 },
        });
        expect(await readHomeRole(target)).toBe("member");
        expect(await readHomeRole(existingOwner)).toBe("owner");
        expect(await db.accountChange.count()).toBe(0);
    }, ENTRYPOINT_TIMEOUT_MS);

});

describe.each(["./sources/main.light.ts", "./sources/main.ts"])("Home claim code through %s", (entrypoint) => {
    it("prints a one-time code that the app redeems for the owner claim", async () => {
        const claimant = await createAccount();

        const run = runEntrypoint(entrypoint, ["--print-home-claim-code"]);

        expect(run.status, `stderr: ${run.stderr}`).toBe(0);
        const output = readClaimOutput(run) as { result: { status: string; code: string; expiresAt: string } };
        expect(output).toMatchObject({ v: 1, command: "print-home-claim-code", result: { status: "minted" } });
        expect(output.result.code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/);
        expect(Date.parse(output.result.expiresAt) - Date.now()).toBeGreaterThan(14 * 60 * 1000);
        // Only the hash is stored.
        const stored = await db.simpleCache.findUniqueOrThrow({ where: { key: "home.owner-claim-code.v1" } });
        expect(stored.value).not.toContain(output.result.code.replace(/-/g, ""));

        await expect(redeemHomeClaimCode({ accountId: claimant, code: output.result.code }))
            .resolves.toEqual({ status: "claimed" });
        expect(await readHomeRole(claimant)).toBe("owner");
    }, ENTRYPOINT_TIMEOUT_MS);

    it("prints no code for an owned Home and exits nonzero", async () => {
        await createAccount({ homeRole: "owner" });

        const run = runEntrypoint(entrypoint, ["--print-home-claim-code"]);

        expect(run.status).toBe(1);
        expect(readClaimOutput(run)).toEqual({ v: 1, command: "print-home-claim-code", result: { status: "already_owned" } });
        await expect(db.simpleCache.count({ where: { key: "home.owner-claim-code.v1" } })).resolves.toBe(0);
    }, ENTRYPOINT_TIMEOUT_MS);
});
