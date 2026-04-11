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
            writeFileSync(
                join(workspaceSrc, 'package.json'),
                JSON.stringify({
                    name: '@happier-dev/cli-common',
                    version: '0.0.0',
                    main: './dist/index.js',
                    types: './dist/index.d.ts',
                    exports: {
                        '.': {
                            default: './dist/index.js',
                            types: './dist/index.d.ts',
                        },
                        './firstPartyRuntime/listInstalledVersionIdsNewestFirst': {
                            default: './dist/firstPartyRuntime/listInstalledVersionIdsNewestFirst.js',
                        },
                    },
                }),
                'utf8',
            );
            mkdirSync(join(workspaceSrc, 'dist'), { recursive: true });
            writeFileSync(join(workspaceSrc, 'dist', 'index.js'), 'export {};\n', 'utf8');
            writeFileSync(join(workspaceSrc, 'dist', 'index.d.ts'), 'export {};\n', 'utf8');

            const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
            const runCommand = async (cmd: string, args: string[], options?: { cwd?: string }) => {
                calls.push({ cmd, args, cwd: options?.cwd });
                if (args[0] === 'workspace' && args[1] === '@happier-dev/cli-common' && args[2] === 'build') {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    const distDir = join(workspaceSrc, 'dist', 'firstPartyRuntime');
                    mkdirSync(distDir, { recursive: true });
                    writeFileSync(join(distDir, 'index.js'), 'export {};\n', 'utf8');
                    writeFileSync(join(distDir, 'listInstalledVersionIdsNewestFirst.js'), 'export {};\n', 'utf8');
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
            mkdirSync(workspaceSrc, { recursive: true });
            writeFileSync(
                join(workspaceSrc, 'package.json'),
                JSON.stringify({
                    name: '@happier-dev/protocol',
                    version: '0.0.0',
                    main: './dist/index.js',
                    types: './dist/index.d.ts',
                    exports: {
                        '.': {
                            default: './dist/index.js',
                            types: './dist/index.d.ts',
                        },
                    },
                }),
                'utf8',
            );
            const distDir = join(workspaceSrc, 'dist');
            mkdirSync(distDir, { recursive: true });
            writeFileSync(join(distDir, 'index.js'), 'export {};\n', 'utf8');
            writeFileSync(join(distDir, 'index.d.ts'), 'export {};\n', 'utf8');

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
