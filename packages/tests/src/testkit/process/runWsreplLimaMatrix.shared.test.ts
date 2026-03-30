import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRootDir } from '../paths';
import { resolveWsreplLimaMatrixInvocation } from '../../../scripts/runWsreplLimaMatrix.shared.mjs';

describe('runWsreplLimaMatrix.shared', () => {
    it('fails closed on unsupported platforms when using the default Lima harness', () => {
        const invocation = resolveWsreplLimaMatrixInvocation({
            repoRoot: repoRootDir(),
            platform: 'win32',
            argv: ['demo-vm'],
            env: {},
        });

        expect(invocation.ok).toBe(false);
        if (invocation.ok) {
            return;
        }

        expect(invocation.exitCode).toBe(1);
        expect(invocation.message).toContain('macOS and Linux');
    });

    it('uses the default tests-owned Lima harness on Darwin', () => {
        const repoRoot = repoRootDir();
        const invocation = resolveWsreplLimaMatrixInvocation({
            repoRoot,
            platform: 'darwin',
            argv: ['demo-vm', '--report-root', '/tmp/wsrepl-demo'],
            env: {},
        });

        expect(invocation.ok).toBe(true);
        if (!invocation.ok) {
            return;
        }

        expect(invocation.command).toBe('bash');
        expect(invocation.args).toEqual([
            join(repoRoot, 'packages/tests/scripts/wsrepl-lima-matrix.sh'),
            'demo-vm',
            '--report-root',
            '/tmp/wsrepl-demo',
        ]);
        expect(invocation.configLabel).toBe('demo-vm');
    });

    it('uses the default tests-owned Lima harness on Linux', () => {
        const repoRoot = repoRootDir();
        const invocation = resolveWsreplLimaMatrixInvocation({
            repoRoot,
            platform: 'linux',
            argv: ['demo-vm'],
            env: {},
        });

        expect(invocation.ok).toBe(true);
        if (!invocation.ok) {
            return;
        }

        expect(invocation.command).toBe('bash');
        expect(invocation.args).toEqual([
            join(repoRoot, 'packages/tests/scripts/wsrepl-lima-matrix.sh'),
            'demo-vm',
        ]);
    });

    it('allows an override script path for unsupported-platform test execution', async () => {
        const scratch = await mkdtemp(join(tmpdir(), 'happier-wsrepl-lima-shared-'));
        const overridePath = join(scratch, 'fake-runner.mjs');
        await writeFile(overridePath, 'export {};', 'utf8');

        const invocation = resolveWsreplLimaMatrixInvocation({
            repoRoot: repoRootDir(),
            platform: 'win32',
            argv: ['demo-vm', '--verbose'],
            env: {
                HAPPIER_E2E_WSREPL_LIMA_SCRIPT: overridePath,
            },
        });

        expect(invocation.ok).toBe(true);
        if (!invocation.ok) {
            return;
        }

        expect(invocation.command).toBe(process.execPath);
        expect(invocation.args).toEqual([overridePath, 'demo-vm', '--verbose']);
        expect(invocation.configLabel).toBe('demo-vm');
    });
});
