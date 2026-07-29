import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '../sources/flavors/light/env';
import { buildLightDevPlan } from './dev.lightPlan';
import { runCommand } from './runCommand';

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR!;
    const filesDir = env.HAPPY_SERVER_LIGHT_FILES_DIR!;
    const dbDir = env.HAPPY_SERVER_LIGHT_DB_DIR!;
    const plan = buildLightDevPlan(env);

    // Ensure dirs exist for light flavor.
    await mkdir(dataDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(dbDir, { recursive: true });

    if (plan.shouldRunMigrateDeploy && plan.migrateDeployArgs) {
        console.log(JSON.stringify({ happierStackTransition: 'migration_started' }));
        await runCommand('yarn', plan.migrateDeployArgs, env);
        console.log(JSON.stringify({ happierStackTransition: 'migration_completed' }));
    }

    // Run the light flavor.
    await runCommand('yarn', plan.startLightArgs, env);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
