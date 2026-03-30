import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../paths';

const execFileAsync = promisify(execFile);

describe('scripts/run-wsrepl-lima-matrix.mjs', () => {
    const TEST_TIMEOUT_MS = 30_000;

    it('resolves the default tests-owned Lima matrix script from the repo root on macOS', async () => {
        const mod = await import('../../../scripts/runWsreplLimaMatrix.shared.mjs');
        const repoRoot = repoRootDir();
        const invocation = mod.resolveWsreplLimaMatrixInvocation({
            argv: ['qa-vm'],
            env: {},
            platform: 'darwin',
            repoRoot,
        });

        expect(invocation.ok).toBe(true);
        if (!invocation.ok) {
            return;
        }

        expect(invocation.command).toBe('bash');
        expect(invocation.args).toEqual([
            resolve(repoRoot, 'packages/tests/scripts/wsrepl-lima-matrix.sh'),
            'qa-vm',
        ]);
        expect(invocation.spawnOptions.cwd).toBe(resolve(repoRoot, 'apps/stack'));
    }, TEST_TIMEOUT_MS);

    it('resolves the default tests-owned Lima matrix script from the repo root on Linux', async () => {
        const mod = await import('../../../scripts/runWsreplLimaMatrix.shared.mjs');
        const invocation = mod.resolveWsreplLimaMatrixInvocation({
            argv: ['qa-vm'],
            env: {},
            platform: 'linux',
            repoRoot: repoRootDir(),
        });

        expect(invocation.ok).toBe(true);
        if (invocation.ok) {
            expect(invocation.command).toBe('bash');
            expect(invocation.args).toEqual([
                resolve(repoRootDir(), 'packages/tests/scripts/wsrepl-lima-matrix.sh'),
                'qa-vm',
            ]);
            return;
        }
    }, TEST_TIMEOUT_MS);

    it('fails closed on unsupported platforms before trying to spawn the matrix script', async () => {
        const mod = await import('../../../scripts/runWsreplLimaMatrix.shared.mjs');
        const invocation = mod.resolveWsreplLimaMatrixInvocation({
            argv: ['qa-vm'],
            env: {},
            platform: 'win32',
            repoRoot: repoRootDir(),
        });

        expect(invocation.ok).toBe(false);
        if (invocation.ok) {
            return;
        }
        expect(invocation.exitCode).toBe(1);
        expect(invocation.message).toContain('macOS and Linux');
    }, TEST_TIMEOUT_MS);

    it('executes an override harness with passthrough args', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'happier-wsrepl-lima-script-'));
        const capturePath = join(scratch, 'capture.json');
        const overridePath = join(scratch, 'fake-wsrepl-lima.sh');

        await writeFile(
            overridePath,
            [
                '#!/usr/bin/env bash',
                'set -euo pipefail',
                'python3 - <<\'PY\' "$@"',
                'import json, os, sys',
                'capture_path = os.environ["HAPPIER_WSREPL_CAPTURE_PATH"]',
                'with open(capture_path, "w", encoding="utf-8") as handle:',
                '    json.dump({',
                '        "argv": sys.argv[1:],',
                '        "cwd": os.getcwd(),',
                '    }, handle)',
                'PY',
                '',
            ].join('\n'),
            'utf8',
        );
        await chmod(overridePath, 0o755);

        const scriptPath = join(repoRootDir(), 'packages/tests/scripts/run-wsrepl-lima-matrix.mjs');
        await execFileAsync(
            process.execPath,
            [scriptPath, 'demo-vm', '--report-root', '/tmp/wsrepl-demo'],
            {
                cwd: scratch,
                env: {
                    ...process.env,
                    HAPPIER_E2E_WSREPL_LIMA_SCRIPT: overridePath,
                    HAPPIER_WSREPL_CAPTURE_PATH: capturePath,
                    HAPPIER_TEST_HEARTBEAT_MS: '1000',
                },
            },
        );

        const capture = JSON.parse(await readFile(capturePath, 'utf8')) as { argv: string[]; cwd: string };
        expect(capture.argv).toEqual(['demo-vm', '--report-root', '/tmp/wsrepl-demo']);
        expect(capture.cwd).toBe(resolve(repoRootDir(), 'apps/stack'));
    }, TEST_TIMEOUT_MS);
});
