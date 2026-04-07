import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { mkdtempSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { resolveInstalledFirstPartyComponentPaths } from '../../firstPartyRuntime/index.js';
import { discoverHappierInstallations } from './discoverHappierInstallations.js';

describe('discoverHappierInstallations', () => {
    it('skips missing PATH candidates and prefers managed shim targets that actually exist', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-runtime-installations-'));
        try {
            const processEnv = {
                HAPPIER_HOME_DIR: join(root, '.happier'),
                PATH: [join(root, 'missing-bin'), join(root, '.happier', 'bin')].join(delimiter),
            } as NodeJS.ProcessEnv;

            const paths = resolveInstalledFirstPartyComponentPaths({
                componentId: 'happier-cli',
                channel: 'preview',
                processEnv,
            });

            await mkdir(paths.currentPath, { recursive: true });
            await mkdir(join(root, '.happier', 'bin'), { recursive: true });
            await writeFile(
                join(paths.currentPath, 'package.json'),
                JSON.stringify({ version: '1.2.3-preview.4' }, null, 2),
                'utf8',
            );
            await writeFile(paths.binaryPath, '#!/bin/sh\n', 'utf8');
            await chmod(paths.binaryPath, 0o755);
            await symlink(paths.binaryPath, join(root, '.happier', 'bin', 'hprev'));

            const inventory = await discoverHappierInstallations({
                processEnv,
                invokedPath: join(root, '.happier', 'bin', 'hprev'),
                invokerName: 'hprev',
            });

            expect(inventory.installations).toEqual([
                expect.objectContaining({
                    source: 'firstPartyManaged',
                    ring: 'preview',
                    version: '1.2.3-preview.4',
                    path: paths.currentPath,
                    shimName: 'hprev',
                    onPath: true,
                }),
            ]);
            expect(inventory.activeInvocation).toEqual(expect.objectContaining({
                path: join(root, '.happier', 'bin', 'hprev'),
                invokerName: 'hprev',
                ring: 'preview',
                version: '1.2.3-preview.4',
            }));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('records every Happier CLI shim found on PATH instead of only the first match', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-runtime-installations-path-'));
        try {
            const firstBinDir = join(root, 'first-bin');
            const secondBinDir = join(root, 'second-bin');
            const processEnv = {
                HAPPIER_HOME_DIR: join(root, '.happier'),
                PATH: [firstBinDir, secondBinDir].join(delimiter),
            } as NodeJS.ProcessEnv;

            await mkdir(firstBinDir, { recursive: true });
            await mkdir(secondBinDir, { recursive: true });
            await writeFile(join(firstBinDir, 'happier'), '#!/bin/sh\n', 'utf8');
            await chmod(join(firstBinDir, 'happier'), 0o755);
            await writeFile(join(secondBinDir, 'happier'), '#!/bin/sh\n', 'utf8');
            await chmod(join(secondBinDir, 'happier'), 0o755);

            const inventory = await discoverHappierInstallations({
                processEnv,
                invokedPath: join(firstBinDir, 'happier'),
                invokerName: 'happier',
            });

            const onPathCliInstallations = inventory.installations.filter((entry) => entry.onPath && entry.components.includes('happier-cli'));
            expect(onPathCliInstallations).toHaveLength(2);
            expect(onPathCliInstallations.map((entry) => entry.path).sort()).toEqual([
                join(firstBinDir, 'happier'),
                join(secondBinDir, 'happier'),
            ]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('adds npm-global Happier installs even when they are not the active PATH resolution', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-runtime-installations-npm-'));
        try {
            const processEnv = {
                HAPPIER_HOME_DIR: join(root, '.happier'),
                PATH: '',
            } as NodeJS.ProcessEnv;

            const npmPrefix = join(root, 'npm-prefix');
            const npmRoot = join(npmPrefix, 'lib', 'node_modules');
            const cliPackageDir = join(npmRoot, '@happier-dev', 'cli');
            await mkdir(cliPackageDir, { recursive: true });
            await writeFile(join(cliPackageDir, 'package.json'), JSON.stringify({ version: '9.9.9' }), 'utf8');

            const inventory = await discoverHappierInstallations({
                processEnv,
                fs: {},
                commands: {
                    run: ({ cmd, args }) => {
                        if (cmd !== 'npm') return null;
                        if (args.join(' ') === 'prefix -g') return npmPrefix;
                        if (args.join(' ') === 'root -g') return npmRoot;
                        return null;
                    },
                },
            });

            expect(inventory.installations).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    source: 'npmGlobal',
                    version: '9.9.9',
                    path: cliPackageDir,
                    onPath: false,
                }),
            ]));
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('classifies the active invocation when the source checkout is invoked directly outside PATH discovery', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-runtime-installations-source-'));
        try {
            const sourceRoot = join(root, 'repo');
            const cliBinPath = join(sourceRoot, 'apps', 'cli', 'bin', 'happier.mjs');
            const processEnv = {
                HAPPIER_HOME_DIR: join(root, '.happier'),
                PATH: '',
            } as NodeJS.ProcessEnv;

            await mkdir(join(sourceRoot, 'apps', 'cli', 'bin'), { recursive: true });
            await writeFile(cliBinPath, '#!/usr/bin/env node\n', 'utf8');
            await chmod(cliBinPath, 0o755);
            await writeFile(join(sourceRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ version: '2.3.4-dev.1' }), 'utf8');

            const inventory = await discoverHappierInstallations({
                processEnv,
                invokedPath: cliBinPath,
                invokerName: 'happier',
            });

            expect(inventory.activeInvocation).toEqual(expect.objectContaining({
                path: cliBinPath,
                invokerName: 'happier',
                ring: 'stable',
                version: '2.3.4-dev.1',
            }));
            expect(inventory.activeInvocation?.installationId).toBe(`fromSource:${inventory.activeInvocation?.realPath ?? cliBinPath}`);
            expect(inventory.installations).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    it('classifies the dev source wrapper as a dev ring invocation', async () => {
        const root = mkdtempSync(join(tmpdir(), 'happier-runtime-installations-dev-source-'));
        try {
            const sourceRoot = join(root, 'repo');
            const cliBinPath = join(sourceRoot, 'apps', 'cli', 'bin', 'happier-dev.mjs');
            const processEnv = {
                HAPPIER_HOME_DIR: join(root, '.happier'),
                PATH: '',
            } as NodeJS.ProcessEnv;

            await mkdir(join(sourceRoot, 'apps', 'cli', 'bin'), { recursive: true });
            await writeFile(cliBinPath, '#!/usr/bin/env node\n', 'utf8');
            await chmod(cliBinPath, 0o755);
            await writeFile(join(sourceRoot, 'apps', 'cli', 'package.json'), JSON.stringify({ version: '2.3.4-dev.1' }), 'utf8');

            const inventory = await discoverHappierInstallations({
                processEnv,
                invokedPath: cliBinPath,
                invokerName: 'happier-dev',
            });

            expect(inventory.activeInvocation).toEqual(expect.objectContaining({
                path: cliBinPath,
                invokerName: 'happier-dev',
                ring: 'dev',
                version: '2.3.4-dev.1',
            }));
            expect(inventory.activeInvocation?.installationId).toBe(`fromSource:${inventory.activeInvocation?.realPath ?? cliBinPath}`);
            expect(inventory.installations).toEqual([]);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});
