import { describe, expect, it } from "vitest";
import { buildLightDevPlan } from "./dev.lightPlan";

describe('buildLightDevPlan', () => {
    it('uses the canonical provider-dispatching migration step by default', () => {
        const plan = buildLightDevPlan({});
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:deploy']);
        expect(plan.startLightArgs).toEqual(['-s', 'start:light']);
    });

    it('uses the canonical migration step when HAPPY_DB_PROVIDER=sqlite', () => {
        const plan = buildLightDevPlan({ HAPPY_DB_PROVIDER: 'sqlite' });
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:deploy']);
    });

    it("uses the canonical migration step for pglite", () => {
        const pglitePlan = buildLightDevPlan({ HAPPY_DB_PROVIDER: "pglite", HAPPIER_DB_PROVIDER: "pglite" });
        expect(pglitePlan.shouldRunMigrateDeploy).toBe(true);
        expect(pglitePlan.migrateDeployArgs).toEqual(['-s', 'migrate:deploy']);
    });

    it("routes external providers independently of the light preset", () => {
        expect(buildLightDevPlan({ HAPPIER_DB_PROVIDER: "postgres" }).migrateDeployArgs)
            .toEqual(["-s", "migrate:deploy"]);
        expect(buildLightDevPlan({ HAPPIER_DB_PROVIDER: "mysql" }).migrateDeployArgs)
            .toEqual(["-s", "migrate:deploy"]);
    });

    it("runs migrations for explicit always and legacy auto modes", () => {
        const alwaysPlan = buildLightDevPlan({ HAPPIER_STACK_MIGRATE_MODE: "always" });
        expect(alwaysPlan.shouldRunMigrateDeploy).toBe(true);
        expect(alwaysPlan.migrateDeployArgs).toEqual(['-s', 'migrate:deploy']);

        const autoPlan = buildLightDevPlan({ HAPPIER_STACK_MIGRATE_MODE: "auto" });
        expect(autoPlan.shouldRunMigrateDeploy).toBe(true);
        expect(autoPlan.migrateDeployArgs).toEqual(['-s', 'migrate:deploy']);
    });

    it("skips migrations only when the Stack planner explicitly admits skip", () => {
        const skipPlan = buildLightDevPlan({ HAPPIER_STACK_MIGRATE_MODE: "skip" });
        expect(skipPlan.shouldRunMigrateDeploy).toBe(false);
        expect(skipPlan.migrateDeployArgs).toBeNull();
    });
});
