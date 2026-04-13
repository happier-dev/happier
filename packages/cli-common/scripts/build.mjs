import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
    cleanupPackageDistBuildArtifacts,
    restorePackageDistFromBackup,
    stagePackageDistBuild,
    swapStagedPackageDistIntoPlace,
    verifyStagedPackageDistExports,
} from './packageDistBuildPhases.mjs';
import { createPackageDistBuildPlan } from './packageDistBuildPlan.mjs';

const buildScriptFilePath = fileURLToPath(import.meta.url);
const buildScriptPackageDir = dirname(dirname(buildScriptFilePath));

function readJson(path) {
    return JSON.parse(readFileSync(path, 'utf8'));
}

function sleepSync(ms) {
    if (!ms || ms <= 0) return;
    const buffer = new SharedArrayBuffer(4);
    const view = new Int32Array(buffer);
    Atomics.wait(view, 0, 0, ms);
}

function isRetryableRmError(error) {
    const code = error && typeof error === 'object' ? error.code : null;
    return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EINTR';
}

export function cleanPackageDistSync(options = {}) {
    const targetDir = String(options.targetDir ?? 'dist').trim() || 'dist';
    const retries = Number.isFinite(options.retries) ? options.retries : 5;
    const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 25;
    const rmSyncImpl = options.rmSyncImpl ?? rmSync;
    const maxAttempts = Math.max(1, retries + 1);

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
            rmSyncImpl(targetDir, { recursive: true, force: true });
            return;
        } catch (error) {
            if (!isRetryableRmError(error) || attempt === maxAttempts - 1) throw error;
            sleepSync(delayMs);
        }
    }
}

export function resolveBuildScriptMode(argv = process.argv.slice(2)) {
    return argv.includes('--clean') ? 'clean' : 'build';
}

async function runCleanBuildScript() {
    cleanPackageDistSync({
        // Local dev can run with other watchers rebuilding dist; give ourselves a bit of headroom.
        retries: 25,
        delayMs: 20,
    });
}

async function runPackageBuildScript() {
    const packageJson = readJson(join(buildScriptPackageDir, 'package.json'));
    await buildPackageDistAtomically({ packageDir: buildScriptPackageDir, packageJson });
}

const buildScriptModeExecutors = {
    build: runPackageBuildScript,
    clean: runCleanBuildScript,
};

export async function buildPackageDistAtomically({
    packageDir,
    packageJson = readJson(join(packageDir, 'package.json')),
    buildIntoDistDir = undefined,
    env = process.env,
} = {}) {
    if (!packageDir) {
        throw new Error('buildPackageDistAtomically requires packageDir');
    }

    const buildPlan = createPackageDistBuildPlan({ packageDir });
    let stageRoot;
    let stageDistDir;
    let distMovedToBackup = false;

    try {
        ({ stageRoot, stageDistDir } = await stagePackageDistBuild({
            buildPlan,
            buildIntoDistDir,
            env,
        }));

        verifyStagedPackageDistExports({
            stageRoot,
            packageJson,
        });

        ({ distMovedToBackup } = await swapStagedPackageDistIntoPlace({
            buildPlan,
            stageDistDir,
        }));
    } catch (error) {
        await restorePackageDistFromBackup({
            buildPlan,
            distMovedToBackup,
        });
        throw error;
    } finally {
        if (stageRoot) {
            await cleanupPackageDistBuildArtifacts({
                buildPlan,
                stageRoot,
            });
        }
    }
}

async function runBuildScript(argv = process.argv.slice(2)) {
    const mode = resolveBuildScriptMode(argv);
    await buildScriptModeExecutors[mode]();
}

export {
    cleanupPackageDistBuildArtifacts,
    createPackageDistBuildPlan,
    restorePackageDistFromBackup,
    stagePackageDistBuild,
    swapStagedPackageDistIntoPlace,
    verifyStagedPackageDistExports,
};

const currentFilePath = buildScriptFilePath;
const entrypointPath = process.argv[1] ? resolve(process.argv[1]) : '';

if (entrypointPath === currentFilePath) {
    runBuildScript().catch((error) => {
        console.error(error instanceof Error ? error.stack ?? error.message : String(error));
        process.exitCode = 1;
    });
}
