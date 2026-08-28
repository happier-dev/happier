import { requireDbProviderFromEnv } from "../sources/storage/prisma";

type LightMigrateMode = "always" | "skip";

export type LightDevPlan = Readonly<{
    provider: "postgres" | "mysql" | "sqlite" | "pglite";
    migrateMode: LightMigrateMode;
    migrateDeployArgs: string[] | null;
    shouldRunMigrateDeploy: boolean;
    startLightArgs: string[];
}>;

function resolveMigrateMode(env: NodeJS.ProcessEnv): LightMigrateMode {
    return String(env.HAPPIER_STACK_MIGRATE_MODE ?? "").trim().toLowerCase() === "skip"
        ? "skip"
        : "always";
}

export function buildLightDevPlan(env: NodeJS.ProcessEnv): LightDevPlan {
    const provider = requireDbProviderFromEnv(env, "sqlite");
    const migrateMode = resolveMigrateMode(env);
    const shouldRunMigrateDeploy = migrateMode === "always";

    return {
        provider,
        migrateMode,
        migrateDeployArgs: shouldRunMigrateDeploy
            ? ["-s", "migrate:deploy"]
            : null,
        shouldRunMigrateDeploy,
        startLightArgs: ["-s", "start:light"],
    };
}
