import { getDbProviderFromEnv } from "../sources/storage/prisma";

type LightDbProvider = "sqlite" | "pglite";
type LightMigrateMode = "always" | "skip";

export type LightDevPlan = Readonly<{
    provider: LightDbProvider;
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
    const provider = getDbProviderFromEnv(env, "sqlite");
    if (provider !== "pglite" && provider !== "sqlite") {
        throw new Error(`Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER for light dev plan: ${provider}`);
    }

    const migrateMode = resolveMigrateMode(env);
    const shouldRunMigrateDeploy = migrateMode === "always";

    return {
        provider,
        migrateMode,
        migrateDeployArgs: shouldRunMigrateDeploy
            ? ["-s", provider === "sqlite" ? "migrate:sqlite:deploy" : "migrate:light:deploy"]
            : null,
        shouldRunMigrateDeploy,
        startLightArgs: ["-s", "start:light"],
    };
}
