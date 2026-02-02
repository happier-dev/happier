import { getDbProviderFromEnv } from "../sources/storage/prisma";

export type LightDevPlan = {
    migrateDeployArgs: string[];
    startLightArgs: string[];
};

export function buildLightDevPlan(env: NodeJS.ProcessEnv): LightDevPlan {
    const provider = getDbProviderFromEnv(env, "pglite");
    if (provider !== "pglite" && provider !== "sqlite") {
        throw new Error(`Unsupported HAPPY_DB_PROVIDER/HAPPIER_DB_PROVIDER for light dev plan: ${provider}`);
    }
    return {
        migrateDeployArgs: ["-s", provider === "sqlite" ? "migrate:sqlite:deploy" : "migrate:light:deploy"],
        startLightArgs: ["-s", "start:light"],
    };
}
