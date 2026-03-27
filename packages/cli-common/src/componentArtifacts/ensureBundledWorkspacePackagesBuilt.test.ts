import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'vitest';

import { ensureBundledWorkspacePackagesBuilt } from './ensureBundledWorkspacePackagesBuilt.js';

describe('ensureBundledWorkspacePackagesBuilt', () => {
    it('builds bundled workspace packages that are missing dist output', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-ws-bundles-'));
        try {
            const workspaceSrc = join(repoRoot, 'packages', 'cli-common');
            mkdirSync(workspaceSrc, { recursive: true });
            // No dist/ initially.

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            const runCommand = (cmd: string, args: string[], options?: { cwd?: string }) => {
                calls.push({ cmd, args, cwd: options?.cwd });
                if (args[0] === 'workspace' && args[1] === '@happier-dev/cli-common' && args[2] === 'build') {
                    const distDir = join(workspaceSrc, 'dist', 'firstPartyRuntime');
                    mkdirSync(distDir, { recursive: true });
                    writeFileSync(join(distDir, 'index.js'), 'export {};\n', 'utf8');
                }
            };

            await ensureBundledWorkspacePackagesBuilt({
                repoRoot,
                bundles: [
                    {
                        packageName: '@happier-dev/cli-common',
                        srcDir: workspaceSrc,
                    },
                ],
                yarn: { cmd: 'yarn', args: [] },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                runCommand: runCommand as any,
            });

            expect(calls).toEqual([
                {
                    cmd: 'yarn',
                    args: ['workspace', '@happier-dev/cli-common', 'build'],
                    cwd: repoRoot,
                },
            ]);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not rebuild workspace packages when dist already exists', async () => {
        const repoRoot = mkdtempSync(join(tmpdir(), 'cli-common-ws-bundles-'));
        try {
            const workspaceSrc = join(repoRoot, 'packages', 'protocol');
            const distDir = join(workspaceSrc, 'dist');
            mkdirSync(distDir, { recursive: true });
            writeFileSync(join(distDir, 'index.js'), 'export {};\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            const runCommand = (cmd: string, args: string[], options?: { cwd?: string }) => {
                calls.push({ cmd, args, cwd: options?.cwd });
            };

            await ensureBundledWorkspacePackagesBuilt({
                repoRoot,
                bundles: [
                    {
                        packageName: '@happier-dev/protocol',
                        srcDir: workspaceSrc,
                    },
                ],
                yarn: { cmd: 'yarn', args: [] },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                runCommand: runCommand as any,
            });

            expect(calls).toEqual([]);
        } finally {
            rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
