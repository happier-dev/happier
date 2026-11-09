import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FeatureDecision, HomeRoleV1 } from "@happier-dev/protocol";
import { readServerEnabledBit } from "@happier-dev/protocol";

import { resolveFeaturesFromEnv } from "@/app/features/registry";
import { db } from "@/storage/db";
import { inTx } from "@/storage/inTx";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { readHomeConfigEnv, readHomeSettingsProjectionInTx, setHomeSettings } from "./homeSettings";

/**
 * U6 deciding checks (plan §3.8, invariant I9): a Home feature switch reaches the unchanged
 * resolvers through the overlay, dependency closure and build-policy denies still run after it,
 * and the console's projection explains every bit with the engine's typed reason.
 */
const WORKFLOWS = "HAPPIER_FEATURE_WORKFLOWS__ENABLED";

let sequence = 0;
let harness: LightSqliteHarness;
const touchedEnv = new Map<string, string | undefined>();

function setDeploymentEnv(key: string, value: string): void {
    if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
    process.env[key] = value;
}

async function createAccount(homeRole: HomeRoleV1): Promise<string> {
    sequence += 1;
    const created = await db.account.create({
        data: { publicKey: `home-feature-switches-${sequence}`, homeRole, status: "active" },
        select: { id: true },
    });
    return created.id;
}

async function readProjection(actorAccountId: string) {
    const read = await inTx(async (tx) => await readHomeSettingsProjectionInTx(tx, { actorAccountId }));
    if (read.status !== "ok") throw new Error(`projection read failed: ${read.status}`);
    return read.projection;
}

function decisionOf(decisions: readonly FeatureDecision[] | undefined, featureId: string): FeatureDecision | undefined {
    return decisions?.find((decision) => decision.featureId === featureId);
}

beforeAll(async () => {
    harness = await createLightSqliteHarness({
        tempDirPrefix: "happier-home-feature-switches-",
        initAuth: false,
        initEncrypt: true,
        initFiles: false,
    });
});
afterAll(async () => await harness.close());
afterEach(async () => {
    for (const [key, value] of touchedEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    touchedEnv.clear();
    await db.homeAdministrationEvent.deleteMany({});
    await db.homeSettings.deleteMany({});
    await db.account.deleteMany({});
});

describe("Home feature switches", () => {
    it("turns Workflows off through the overlay and publishes the released alias with one typed decision", async () => {
        const owner = await createAccount("owner");
        const written = await setHomeSettings({
            actorAccountId: owner,
            write: { expectedRevision: 0, values: { [WORKFLOWS]: false } },
        });
        expect(written.status).toBe("applied");

        const payload = resolveFeaturesFromEnv(await readHomeConfigEnv(process.env));
        expect(readServerEnabledBit(payload, "automations")).toBe(false);
        expect(readServerEnabledBit(payload, "workflows")).toBe(false);

        const projection = await readProjection(owner);
        expect(decisionOf(projection.featureDecisions, "automations")).toBeUndefined();
        expect(decisionOf(projection.featureDecisions, "workflows")).toMatchObject({
            state: "disabled",
            blockedBy: "server",
        });
        // Only server-represented features are Home decisions.
        expect(decisionOf(projection.featureDecisions, "execution.runs")).toBeUndefined();

        const entry = projection.entries.find((candidate) => candidate.key === WORKFLOWS);
        expect(entry).toMatchObject({
            value: false,
            source: "home",
            fixed: false,
            declaration: { type: "boolean", section: "features", family: "workflows", featureId: "workflows", default: true },
        });
    });

    it("keeps an explicit deployment value as the lock: projected fixed, the stored switch has no effect", async () => {
        const owner = await createAccount("owner");
        await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { [WORKFLOWS]: false } } });
        setDeploymentEnv("HAPPIER_FEATURE_AUTOMATIONS__ENABLED", "1");

        const payload = resolveFeaturesFromEnv(await readHomeConfigEnv(process.env));
        expect(readServerEnabledBit(payload, "automations")).toBe(true);
        expect(readServerEnabledBit(payload, "workflows")).toBe(true);

        const projection = await readProjection(owner);
        expect(projection.entries.find((candidate) => candidate.key === WORKFLOWS)).toMatchObject({
            value: true,
            source: "deployment",
            fixed: true,
        });
        expect(decisionOf(projection.featureDecisions, "workflows")).toMatchObject({ state: "enabled", blockedBy: null });
    });

    it("never lets a Home switch lift a build-policy deny", async () => {
        const owner = await createAccount("owner");
        await setHomeSettings({ actorAccountId: owner, write: { expectedRevision: 0, values: { [WORKFLOWS]: true } } });
        setDeploymentEnv("HAPPIER_BUILD_FEATURES_DENY", "automations");

        const payload = resolveFeaturesFromEnv(await readHomeConfigEnv(process.env));
        expect(readServerEnabledBit(payload, "automations")).toBe(false);
        expect(readServerEnabledBit(payload, "workflows")).toBe(false);

        const projection = await readProjection(owner);
        expect(decisionOf(projection.featureDecisions, "automations")).toBeUndefined();
        expect(decisionOf(projection.featureDecisions, "workflows")).toMatchObject({
            blockedBy: "build_policy",
        });
    });
});
