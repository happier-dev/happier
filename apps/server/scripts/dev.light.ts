import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
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

export async function runLightDev(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const nextEnv: NodeJS.ProcessEnv = { ...env };
    applyLightDefaultEnv(nextEnv);

    const dataDir = nextEnv.HAPPY_SERVER_LIGHT_DATA_DIR!;
    const filesDir = nextEnv.HAPPY_SERVER_LIGHT_FILES_DIR!;
    const dbDir = nextEnv.HAPPY_SERVER_LIGHT_DB_DIR!;
    const plan = buildLightDevPlan(nextEnv);

    // Ensure dirs exist for light flavor.
    await mkdir(dataDir, { recursive: true });
    await mkdir(filesDir, { recursive: true });
    await mkdir(dbDir, { recursive: true });

    // Apply migrations (idempotent).
    await run('yarn', plan.migrateDeployArgs, nextEnv);

    // Run the light flavor.
    await run('yarn', plan.startLightArgs, nextEnv);
}

export async function main(): Promise<void> {
    await runLightDev(process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
