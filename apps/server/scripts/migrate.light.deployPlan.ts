export type LightMigrateDeployPlan = {
    dataDir: string;
    prismaDeployArgs: string[];
};

export function requireLightDataDir(env: NodeJS.ProcessEnv): string {
    const raw = env.HAPPY_SERVER_LIGHT_DATA_DIR;
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new Error('Missing HAPPY_SERVER_LIGHT_DATA_DIR (set it or ensure applyLightDefaultEnv sets it)');
    }
    return raw.trim();
}

export function buildLightMigrateDeployPlan(env: NodeJS.ProcessEnv): LightMigrateDeployPlan {
    const dataDir = requireLightDataDir(env);
    return {
        dataDir,
        prismaDeployArgs: ['-s', 'migrate:light:deploy'],
    };
}
