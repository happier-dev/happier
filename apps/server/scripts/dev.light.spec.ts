import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function getScriptPath(): string {
    return './scripts/dev.light.ts';
}

function getServerDir(): string {
    return resolve(__dirname, '..');
}

async function writeFakeYarn(params: Readonly<{ dir: string; logPath: string }>): Promise<void> {
    const yarnPath = join(params.dir, 'yarn');
    const content = `#!/bin/sh
set -e
echo "YARN $@" >> "${params.logPath}"
exit 0
`;
    await writeFile(yarnPath, content, { mode: 0o755 });
    await chmod(yarnPath, 0o755);
}

async function readLogLines(path: string): Promise<string[]> {
    const raw = await readFile(path, 'utf8').catch(() => '');
    return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function runDevLightScript(params: Readonly<{
    binDir: string;
    tmpDir: string;
    lightDataDir: string;
    migrateMode?: 'always' | 'auto' | 'skip';
}>) {
    return spawnSync('sh', ['-c', `
            set -eu
            cd "${getServerDir()}"
            PATH="${params.binDir}:${process.env.PATH ?? ''}" \
            HOME="${process.env.HOME ?? params.tmpDir}" \
            TMPDIR="${process.env.TMPDIR ?? params.tmpDir}" \
            NODE_OPTIONS="" \
            TSX_TSCONFIG_PATH="" \
            HAPPIER_SERVER_LIGHT_DATA_DIR="${params.lightDataDir}" \
            HAPPY_SERVER_LIGHT_DATA_DIR="${params.lightDataDir}" \
            HAPPIER_SERVER_LIGHT_FILES_DIR="${join(params.lightDataDir, 'files')}" \
            HAPPY_SERVER_LIGHT_FILES_DIR="${join(params.lightDataDir, 'files')}" \
            HAPPIER_SERVER_LIGHT_DB_DIR="${join(params.lightDataDir, 'db')}" \
            HAPPY_SERVER_LIGHT_DB_DIR="${join(params.lightDataDir, 'db')}" \
            HAPPIER_STACK_MIGRATE_MODE="${params.migrateMode ?? ''}" \
            node --import tsx "${getScriptPath()}"
        `], {
        env: {
            PATH: process.env.PATH ?? '',
            HOME: process.env.HOME ?? params.tmpDir,
            TMPDIR: process.env.TMPDIR ?? params.tmpDir,
        },
        stdio: 'pipe',
        encoding: 'utf8',
    });
}

describe('dev.light.ts', () => {
    let tmpDir = '';
    let binDir = '';
    let logPath = '';

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), 'happier-server-dev-light-'));
        binDir = join(tmpDir, 'bin');
        logPath = join(tmpDir, 'yarn.log');
        await mkdir(binDir, { recursive: true });
        await writeFile(logPath, '', 'utf8');
        await writeFakeYarn({ dir: binDir, logPath });
    });

    afterEach(async () => {
        await rm(tmpDir, { recursive: true, force: true });
    });

    it('runs light migrate and start steps through the tsx entrypoint', async () => {
        const lightDataDir = join(tmpDir, 'server-light');
        const result = runDevLightScript({ binDir, tmpDir, lightDataDir });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('{"happierStackTransition":"migration_started"}');
        expect(result.stdout).toContain('{"happierStackTransition":"migration_completed"}');
        const lines = await readLogLines(logPath);
        expect(lines).toEqual(['YARN -s migrate:deploy', 'YARN -s start:light']);
    });

    it('does not let a previous local run authorize skipping migrations', async () => {
        const lightDataDir = join(tmpDir, 'server-light-repeat');

        const first = runDevLightScript({ binDir, tmpDir, lightDataDir });
        expect(first.status).toBe(0);
        await writeFile(logPath, '', 'utf8');

        const second = runDevLightScript({ binDir, tmpDir, lightDataDir });
        expect(second.status).toBe(0);

        const lines = await readLogLines(logPath);
        expect(lines).toEqual(['YARN -s migrate:deploy', 'YARN -s start:light']);
    }, 60_000);

    it('skips light migrate only when the Stack planner explicitly admits skip', async () => {
        const lightDataDir = join(tmpDir, 'server-light-explicit-skip');
        const result = runDevLightScript({ binDir, tmpDir, lightDataDir, migrateMode: 'skip' });

        expect(result.status).toBe(0);
        const lines = await readLogLines(logPath);
        expect(lines).toEqual(['YARN -s start:light']);
    }, 60_000);
});
