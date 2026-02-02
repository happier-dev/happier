import { describe, expect, it } from "vitest";
import { buildLightDevPlan } from "./dev.lightPlan";

describe('buildLightDevPlan', () => {
    it('uses migrate:light:deploy as the migration step', () => {
        const plan = buildLightDevPlan({});
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:light:deploy']);
        expect(plan.startLightArgs).toEqual(['-s', 'start:light']);
    });

    it('uses migrate:sqlite:deploy when HAPPY_DB_PROVIDER=sqlite', () => {
        const plan = buildLightDevPlan({ HAPPY_DB_PROVIDER: 'sqlite' });
        expect(plan.migrateDeployArgs).toEqual(['-s', 'migrate:sqlite:deploy']);
    });
});
