export type LightDevPlan = {
    migrateDeployArgs: string[];
    startLightArgs: string[];
};

export function buildLightDevPlan(): LightDevPlan {
    return {
        migrateDeployArgs: ['-s', 'migrate:light:deploy'],
        startLightArgs: ['-s', 'start:light'],
    };
}
