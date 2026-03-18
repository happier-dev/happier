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
        const result = spawnSync('sh', ['-c', `
            set -eu
            cd "${getServerDir()}"
            PATH="${binDir}:${process.env.PATH ?? ''}" \
            HOME="${process.env.HOME ?? tmpDir}" \
            TMPDIR="${process.env.TMPDIR ?? tmpDir}" \
            NODE_OPTIONS="" \
            TSX_TSCONFIG_PATH="" \
            HAPPIER_SERVER_LIGHT_DATA_DIR="${lightDataDir}" \
            HAPPY_SERVER_LIGHT_DATA_DIR="${lightDataDir}" \
            HAPPIER_SERVER_LIGHT_FILES_DIR="${join(lightDataDir, 'files')}" \
            HAPPY_SERVER_LIGHT_FILES_DIR="${join(lightDataDir, 'files')}" \
            HAPPIER_SERVER_LIGHT_DB_DIR="${join(lightDataDir, 'db')}" \
            HAPPY_SERVER_LIGHT_DB_DIR="${join(lightDataDir, 'db')}" \
            node --import tsx "${getScriptPath()}"
        `], {
            env: {
                PATH: process.env.PATH ?? '',
                HOME: process.env.HOME ?? tmpDir,
                TMPDIR: process.env.TMPDIR ?? tmpDir,
            },
            stdio: 'pipe',
            encoding: 'utf8',
        });

        expect(result.status).toBe(0);
        const lines = await readLogLines(logPath);
        expect(lines).toEqual(['YARN -s migrate:sqlite:deploy', 'YARN -s start:light']);
    });
});
