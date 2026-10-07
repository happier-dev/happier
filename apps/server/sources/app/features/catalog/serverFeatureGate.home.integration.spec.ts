import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { setHomeSettings } from "@/app/home/settings/homeSettings";
import { readRequestHomeEnv } from "@/app/home/settings/requestHomeEnv";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import { listSessionsForAccount, SessionListUnavailableQueryError } from "@/app/session/listing/service";
import { createV2SessionListServerTiming } from "@/app/session/listing/timing";
import { createTeamInTx } from "@/app/teams/lifecycle";
import { HOME_GOVERNANCE_POLICY_ID } from "@/app/home/governance/governancePolicy";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { isServerFeatureEnabledForHome } from "./serverFeatureGate";

/**
 * Plan `2026-09-26-home-owner-console` R1 / §3.8: a feature switch the Home owner stores reaches every
 * service, socket and worker decision, not only `/v1/features` and the gated route families. Each case
 * stores the switch through the canonical settings owner and asks the real service.
 */
const FOLLOWING = "HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED";
const TEAMS = "HAPPIER_FEATURE_TEAMS__ENABLED";

let harness: LightSqliteHarness;
const touchedEnv = new Map<string, string | undefined>();

function setDeploymentEnv(key: string, value: string | undefined): void {
    if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
}

async function createAccount(homeRole: "owner" | "member"): Promise<string> {
    const created = await db.account.create({
        data: { publicKey: randomUUID(), encryptionMode: "plain", homeRole, status: "active" },
        select: { id: true },
    });
    return created.id;
}

async function storeSwitches(values: Readonly<Record<string, boolean>>): Promise<void> {
    const owner = await createAccount("owner");
    const current = await db.homeSettings.findUnique({ where: { id: "home" }, select: { revision: true } });
    const written = await setHomeSettings({
        actorAccountId: owner,
        write: { expectedRevision: current?.revision ?? 0, values },
    });
    expect(written.status).toBe("applied");
}

function listFollowing(userId: string) {
    return listSessionsForAccount({
        userId,
        authentication: createPresentUserSessionAccessAuthentication(),
        source: {
            kind: "query",
            query: {
                v: 1,
                storage: "active",
                includeInactive: true,
                scope: "following",
                attention: "any",
                audiences: [],
                tagIds: [],
                limit: 10,
            },
        },
        rowRepresentabilityWhere: {},
        timing: createV2SessionListServerTiming({}),
    });
}

async function createTeam(actorAccountId: string) {
    await db.homeGovernancePolicy.upsert({
        where: { id: HOME_GOVERNANCE_POLICY_ID },
        create: { id: HOME_GOVERNANCE_POLICY_ID, revision: 1, teamCreationPolicy: "self_service" },
        update: { teamCreationPolicy: "self_service" },
    });
    return await inTx(async (tx) => await createTeamInTx(tx, { actorAccountId, name: "Acme", requestKey: randomUUID() }));
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-feature-readers-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
    // The deployment leaves both switches unset, so the Home value decides.
    setDeploymentEnv(FOLLOWING, undefined);
    setDeploymentEnv(TEAMS, undefined);
}, 180_000);
afterAll(async () => {
    for (const [key, value] of touchedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    await harness?.close();
});
afterEach(async () => {
    setDeploymentEnv(FOLLOWING, undefined);
    setDeploymentEnv(TEAMS, undefined);
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
});

describe("Home feature switches reach service readers", () => {
    it("keeps an initially empty Home configuration resolved for its request while a new request sees changes", async () => {
        const previousPublicUrl = process.env.HAPPIER_PUBLIC_SERVER_URL;
        setDeploymentEnv("HAPPIER_PUBLIC_SERVER_URL", "https://home.test");
        try {
            const request = {};
            const env = await readRequestHomeEnv(request);
            expect(await isServerFeatureEnabledForHome("teams", { env })).toBe(true);

            await storeSwitches({ [TEAMS]: false });

            expect(await isServerFeatureEnabledForHome("teams", { env })).toBe(true);
            expect(await isServerFeatureEnabledForHome("teams", { request })).toBe(true);
            expect(await isServerFeatureEnabledForHome("teams", { request: {} })).toBe(false);
        } finally {
            setDeploymentEnv("HAPPIER_PUBLIC_SERVER_URL", previousPublicUrl);
        }
    });

    it("refuses a following-scope Session list once the Home turns sessions.following off", async () => {
        const viewer = await createAccount("member");
        await expect(listFollowing(viewer)).resolves.toBeTruthy();

        await storeSwitches({ [FOLLOWING]: false });

        await expect(listFollowing(viewer)).rejects.toBeInstanceOf(SessionListUnavailableQueryError);
    });

    it("answers teams_unavailable from a Team lifecycle operation inside its transaction once the Home turns teams off", async () => {
        const founder = await createAccount("member");
        await storeSwitches({ [TEAMS]: false });

        const result = await createTeam(founder);

        expect(result).toEqual({ ok: false, error: "teams_unavailable" });
    });

    it("answers the same Home decision from every source: a request, a transaction, a job, and an injected env as given", async () => {
        expect(await isServerFeatureEnabledForHome("teams")).toBe(true);
        await storeSwitches({ [TEAMS]: false });

        expect(await isServerFeatureEnabledForHome("teams")).toBe(false);
        expect(await isServerFeatureEnabledForHome("teams", { request: {} })).toBe(false);
        expect(await isServerFeatureEnabledForHome("teams", { env: process.env, request: {} })).toBe(false);
        expect(await inTx(async (tx) => await isServerFeatureEnabledForHome("teams", { tx }))).toBe(false);
        // An injected environment (a test or a fixed composition) is used as given, never overlaid.
        expect(await isServerFeatureEnabledForHome("teams", { env: { [TEAMS]: "1" } })).toBe(true);
    });

    it("keeps an explicit deployment value as the lock over a stored switch", async () => {
        const founder = await createAccount("member");
        await storeSwitches({ [TEAMS]: false, [FOLLOWING]: false });
        setDeploymentEnv(TEAMS, "1");
        setDeploymentEnv(FOLLOWING, "1");

        expect((await createTeam(founder)).ok).toBe(true);
        await expect(listFollowing(founder)).resolves.toBeTruthy();
        expect(await inTx(async (tx) => await isServerFeatureEnabledForHome("teams", { tx }))).toBe(true);
    });
});
