import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { installVersionedPayload, writeHappierCliChoice } from '@happier-dev/cli-common/firstPartyRuntime';

import { ensureLocalFirstPartyComponentCommand, resolveExplicitOrInstalledLocalFirstPartyCommand } from './localFirstPartyCommand.js';

describe('ensureLocalFirstPartyComponentCommand', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('records the actual custom home before Desktop acquisition and retains sharing across apps', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-desktop-home-'));
        const happyHomeDir = join(rootDir, 'custom-home');
        const stateDir = join(rootDir, 'desktop-state');
        const payloadRoot = join(rootDir, 'payload');
        const bundleId = 'dev.happier.app';
        const binaryName = process.platform === 'win32' ? 'happier.exe' : 'happier';
        const processEnv = {
            HAPPIER_HOME_DIR: happyHomeDir,
            HAPPIER_STACK_REPO_DIR: join(rootDir, 'outside-repository'),
            HAPPIER_DESKTOP_BUNDLE_ID: bundleId,
            HAPPIER_DESKTOP_STATE_DIR: stateDir,
            HOME: rootDir,
            PATH: '',
        };
        mkdirSync(payloadRoot, { recursive: true });
        writeFileSync(join(payloadRoot, binaryName), '#!/bin/sh\nexit 0\n');
        chmodSync(join(payloadRoot, binaryName), 0o755);
        const params = { componentId: 'happier-cli' as const, releaseRing: 'stable' as const, processEnv };
        try {
            await ensureLocalFirstPartyComponentCommand(params, {
                // The verified download is the external boundary; installation and resolution stay real.
                preparePayload: async () => ({ versionId: '0.2.21', payloadRoot, cleanup: async () => {} }),
            });
            const statePath = join(stateDir, 'desktop-installations.json');
            expect(existsSync(statePath)).toBe(true);
            expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
                version: 1, bundleId, installations: [{ happyHomeDir, firstPartyInstallHome: happyHomeDir, cliPath: join(happyHomeDir, 'cli', 'current', binaryName) }],
            });
            const secondBundleId = 'dev.happier.app.preview';
            await ensureLocalFirstPartyComponentCommand({
                ...params,
                processEnv: { ...processEnv, HAPPIER_DESKTOP_BUNDLE_ID: secondBundleId, HAPPIER_DESKTOP_STATE_DIR: join(rootDir, 'preview-state') },
            });
            expect(JSON.parse(readFileSync(`${join(happyHomeDir, 'cli')}.desktop-ownership.json`, 'utf8'))).toMatchObject({
                consumers: [bundleId, secondBundleId],
            });
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('keeps non-CLI acquisition failures provider-neutral', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-server-acquisition-failure-'));
        const preparePayload = vi.fn(async () => {
            throw new Error('release unavailable');
        });

        try {
            await expect(ensureLocalFirstPartyComponentCommand({
                componentId: 'happier-server',
                releaseRing: 'stable',
                processEnv: {
                    HAPPIER_HOME_DIR: join(rootDir, 'home'),
                    HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'),
                    PATH: '',
                },
            }, {
                preparePayload,
                installPayload: vi.fn(),
            })).rejects.toMatchObject({ code: 'first_party_component_install_failed' });
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('prefers the repo-local hstack command before attempting a payload download', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-hstack-'));
        const repoRoot = join(rootDir, 'repo');
        const hstackPath = join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');
        const preparePayload = vi.fn(async () => {
            throw new Error('preparePayload should not have been called');
        });
        const installPayload = vi.fn(async () => {
            throw new Error('installPayload should not have been called');
        });

        try {
            mkdirSync(dirname(hstackPath), { recursive: true });
            writeFileSync(hstackPath, '#!/usr/bin/env node\n', 'utf8');
            chmodSync(hstackPath, 0o755);

            await expect(ensureLocalFirstPartyComponentCommand({
                componentId: 'hstack',
                releaseRing: 'stable',
                processEnv: {
                    HAPPIER_HOME_DIR: join(rootDir, 'home'),
                    HAPPIER_STACK_REPO_DIR: repoRoot,
                    PATH: '',
                },
            }, {
                preparePayload,
                installPayload,
            })).resolves.toEqual({ command: hstackPath, provenance: 'override' });

            expect(preparePayload).not.toHaveBeenCalled();
            expect(installPayload).not.toHaveBeenCalled();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('prefers the repo-local Happier CLI command before attempting a payload download', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-repo-local-happier-cli-'));
        const repoRoot = join(rootDir, 'repo');
        const happierPath = join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs');
        const preparePayload = vi.fn(async () => {
            throw new Error('preparePayload should not have been called');
        });
        const installPayload = vi.fn(async () => {
            throw new Error('installPayload should not have been called');
        });

        try {
            mkdirSync(dirname(happierPath), { recursive: true });
            writeFileSync(happierPath, '#!/usr/bin/env node\n', 'utf8');
            chmodSync(happierPath, 0o755);

            await expect(ensureLocalFirstPartyComponentCommand({
                componentId: 'happier-cli',
                releaseRing: 'stable',
                processEnv: {
                    HAPPIER_HOME_DIR: join(rootDir, 'home'),
                    HAPPIER_STACK_REPO_DIR: repoRoot,
                    PATH: '',
                },
            }, {
                preparePayload,
                installPayload,
            })).resolves.toEqual({ command: happierPath, provenance: 'override' });

            expect(preparePayload).not.toHaveBeenCalled();
            expect(installPayload).not.toHaveBeenCalled();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('refuses managed provenance for a binary planted under the install root with no install record', () => {
        // A local process can create `~/.happier/cli/current/<binary>` before anything was ever
        // acquired. Nothing verified it, so it must never be classified `managed` — automatic
        // pairing approval hands a managed CLI the account content key (R13/INV2/D4).
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-planted-binary-'));
        const happyHomeDir = join(rootDir, 'home');
        const plantedPath = join(happyHomeDir, 'cli', 'current', 'happier');

        try {
            mkdirSync(dirname(plantedPath), { recursive: true });
            writeFileSync(plantedPath, '#!/usr/bin/env node\n', 'utf8');
            chmodSync(plantedPath, 0o755);

            expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
                componentId: 'happier-cli',
                releaseRing: 'stable',
                processEnv: { HOME: rootDir, PATH: '', HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere') },
            })).toEqual({ command: plantedPath, provenance: 'override' });
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('reports a real managed install as managed and env/repo overrides as override', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-provenance-'));
        const happyHomeDir = join(rootDir, 'home');
        const managedPath = join(happyHomeDir, 'cli', 'current', 'happier');
        const repoRoot = join(rootDir, 'repo');
        const repoPath = join(repoRoot, 'apps', 'cli', 'bin', 'happier.mjs');
        const envPath = join(rootDir, 'env-happier');
        const stagedPayloadRoot = join(rootDir, 'staged');

        try {
            for (const path of [repoPath, envPath]) {
                mkdirSync(dirname(path), { recursive: true });
                writeFileSync(path, '#!/usr/bin/env node\n', 'utf8');
                chmodSync(path, 0o755);
            }

            // The real install path: it writes the payload under `versions/<versionId>` and
            // records `current.version` beside it. That record is what `managed` means.
            mkdirSync(stagedPayloadRoot, { recursive: true });
            writeFileSync(join(stagedPayloadRoot, 'happier'), '#!/usr/bin/env node\n', 'utf8');
            chmodSync(join(stagedPayloadRoot, 'happier'), 0o755);
            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '0.2.13',
                payloadRoot: stagedPayloadRoot,
                releaseRing: 'stable',
                processEnv: { HAPPIER_HOME_DIR: happyHomeDir },
            });

            expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
                componentId: 'happier-cli',
                releaseRing: 'stable',
                envVarNames: ['HAPPIER_BOOTSTRAP_CLI_PATH'],
                processEnv: { HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: repoRoot, HAPPIER_BOOTSTRAP_CLI_PATH: envPath },
            })).toEqual({ command: envPath, provenance: 'override' });

            expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
                componentId: 'happier-cli',
                releaseRing: 'stable',
                envVarNames: ['HAPPIER_BOOTSTRAP_CLI_PATH'],
                processEnv: { HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: repoRoot },
            })).toEqual({ command: managedPath, provenance: 'managed' });

            rmSync(join(happyHomeDir, 'cli', 'versions'), { recursive: true, force: true });
            rmSync(managedPath, { force: true });
            expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
                componentId: 'happier-cli',
                releaseRing: 'stable',
                processEnv: { HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: repoRoot },
            })).toEqual({ command: repoPath, provenance: 'override' });

            expect(resolveExplicitOrInstalledLocalFirstPartyCommand({
                componentId: 'happier-cli',
                releaseRing: 'preview',
                processEnv: { HOME: rootDir, PATH: '', HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere') },
            })).toBeNull();
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });

    it('resolves the one CLI this computer chose, and never acquires past a CLI the user installed (R12)', async () => {
        const rootDir = mkdtempSync(join(tmpdir(), 'hsetup-cli-choice-'));
        const happyHomeDir = join(rootDir, 'home');
        const npmBin = join(rootDir, 'npm-global', 'bin');
        const npmHappier = join(npmBin, 'happier');
        const managedPath = join(happyHomeDir, 'cli', 'current', 'happier');
        const stagedPayloadRoot = join(rootDir, 'staged');
        const processEnv = { HAPPIER_HOME_DIR: happyHomeDir, HAPPIER_STACK_REPO_DIR: join(rootDir, 'elsewhere'), PATH: npmBin };
        const resolve = () => resolveExplicitOrInstalledLocalFirstPartyCommand({ componentId: 'happier-cli', releaseRing: 'stable', processEnv });

        try {
            mkdirSync(npmBin, { recursive: true });
            writeFileSync(npmHappier, '#!/bin/sh\n', 'utf8');
            chmodSync(npmHappier, 0o755);

            // Nobody was asked yet: the CLI on PATH answers, so no read acquires a second one.
            expect(resolve()).toEqual({ command: npmHappier, provenance: 'override' });

            // "Let Happier manage it" with nothing installed yet: acquisition runs.
            await writeHappierCliChoice({ choice: { mode: 'managed' }, processEnv });
            expect(resolve()).toBeNull();

            mkdirSync(stagedPayloadRoot, { recursive: true });
            writeFileSync(join(stagedPayloadRoot, 'happier'), '#!/bin/sh\n', 'utf8');
            chmodSync(join(stagedPayloadRoot, 'happier'), 0o755);
            await installVersionedPayload({
                componentId: 'happier-cli',
                versionId: '0.2.13',
                payloadRoot: stagedPayloadRoot,
                releaseRing: 'stable',
                processEnv,
            });
            expect(resolve()).toEqual({ command: managedPath, provenance: 'managed' });

            // "Keep my own": that CLI wins even over a managed copy still on disk.
            await writeHappierCliChoice({ choice: { mode: 'own', command: npmHappier }, processEnv });
            expect(resolve()).toEqual({ command: npmHappier, provenance: 'override' });

            // The kept CLI disappeared (R13 b): still this computer's answer, so neither the managed
            // copy left on disk nor a fresh acquisition stands in for it — the question comes first.
            rmSync(npmHappier, { force: true });
            expect(resolve).toThrow(expect.objectContaining({ code: 'cli_choice_required', message: expect.stringContaining(npmHappier) }));
            await expect(ensureLocalFirstPartyComponentCommand(
                { componentId: 'happier-cli', releaseRing: 'stable', processEnv },
                { preparePayload: async () => { throw new Error('must not acquire'); } },
            )).rejects.toMatchObject({ code: 'cli_choice_required' });
        } finally {
            rmSync(rootDir, { recursive: true, force: true });
        }
    });
});
