import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { applyLightDefaultEnv } from '@/flavors/light/env';
import { buildLightDevPlan } from './dev.lightPlan';

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {
            env: env as Record<string, string>,
            stdio: 'inherit',
            shell: false,
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${cmd} exited with code ${code}`));
        });
    });
}

async function main() {
    const env: NodeJS.ProcessEnv = { ...process.env };
    applyLightDefaultEnv(env);

    const dataDir = env.HAPPY_SERVER_LIGHT_DATA_DIR!;
    const filesDir = env.HAPPY_SERVER_LIGHT_FILES_DIR!;
    const dbDir = env.HAPPY_SERVER_LIGHT_DB_DIR!;
    const plan = buildLightDevPlan();

    // Ensure dirs exist for light flavor.
    await mkdir(dataDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(dbDir, { recursive: true });

    // Apply migrations (idempotent).
    await run('yarn', plan.migrateDeployArgs, env);

    // Run the light flavor.
    await run('yarn', plan.startLightArgs, env);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
