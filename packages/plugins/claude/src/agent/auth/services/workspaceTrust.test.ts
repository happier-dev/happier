import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeClaudeAuthEnvironment } from '../../contributions/runtime.js';
import { projectClaudeWorkspaceTrust, reconcileClaudeAccountScopedRootConfig } from './workspaceTrust.js';

let root: string;

async function writeRootConfig(dir: string, config: Record<string, unknown>): Promise<void> {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, '.claude.json'), `${JSON.stringify(config)}\n`);
}

async function readRootConfig(dir: string): Promise<Record<string, unknown> | null> {
    const path = join(dir, '.claude.json');
    if (!existsSync(path)) return null;
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'claude-workspace-trust-'));
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe('projectClaudeWorkspaceTrust', () => {
    it('projects accepted workspace trust for the session directory into the target root config', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await mkdir(targetDir, { recursive: true });
        await writeRootConfig(sourceDir, {
            projects: {
                [sessionDirectory]: {
                    hasTrustDialogAccepted: true,
                    hasCompletedProjectOnboarding: true,
                    allowedTools: ['Bash'],
                },
            },
        });
        await writeRootConfig(targetDir, {
            existingKey: 'kept',
            projects: {
                '/other/project': { hasTrustDialogAccepted: true },
                [sessionDirectory]: { hasTrustDialogAccepted: false, targetOwnedSetting: 'kept' },
            },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        const written = await readRootConfig(targetDir);
        expect(written).toMatchObject({
            existingKey: 'kept',
            projects: {
                '/other/project': { hasTrustDialogAccepted: true },
                [sessionDirectory]: {
                    hasTrustDialogAccepted: true,
                    hasCompletedProjectOnboarding: true,
                    targetOwnedSetting: 'kept',
                },
            },
        });
        // Only the trust projection is carried — not arbitrary project config.
        const projects = written?.projects as Record<string, Record<string, unknown>>;
        expect(projects[sessionDirectory]).not.toHaveProperty('allowedTools');
        if (process.platform !== 'win32') {
            const fileStat = await stat(join(targetDir, '.claude.json'));
            expect(fileStat.mode & 0o777).toBe(0o600);
        }
    });

    it('falls back to the home root config when no explicit config dir override exists', async () => {
        const homeDir = join(root, 'home');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(homeDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { HOME: homeDir },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toMatchObject({
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
    });

    it('does not write workspace trust when the source has no trust state', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            projects: { '/unrelated': { hasTrustDialogAccepted: true } },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toBeNull();
    });

    it('projects onboarding root-only while honoring declined trust without falling through', async () => {
        const sourceDir = join(root, 'source-config');
        const homeDir = join(root, 'home');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            hasCompletedOnboarding: true,
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: false } },
        });
        await writeRootConfig(homeDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toEqual({ hasCompletedOnboarding: true });
    });

    it('never reads the target dir as its own trust source', async () => {
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(targetDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: false } },
        });
        const before = await readFile(join(targetDir, '.claude.json'), 'utf8');

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: targetDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readFile(join(targetDir, '.claude.json'), 'utf8')).toBe(before);
    });

    it('projects ambient onboarding root-only without synthesizing missing workspace trust', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, { hasCompletedOnboarding: true });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toEqual({ hasCompletedOnboarding: true });
    });

    it('no-ops without a session directory', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        await writeRootConfig(sourceDir, {
            projects: { '/anything': { hasTrustDialogAccepted: true } },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory: null,
        });

        expect(await readRootConfig(targetDir)).toBeNull();
    });

    it('projects the exact top-level onboarding-complete boolean from the ambient Claude root', async () => {
        const sourceDir = join(root, 'source-config');
        const homeDir = join(root, 'home');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
        await writeRootConfig(homeDir, { hasCompletedOnboarding: true });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toMatchObject({ hasCompletedOnboarding: true });
    });

    it.each([undefined, false])('does not synthesize onboarding completion from %s', async (hasCompletedOnboarding) => {
        const sourceDir = join(root, 'source-config');
        const homeDir = join(root, 'home');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            ...(hasCompletedOnboarding === undefined ? {} : { hasCompletedOnboarding }),
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
        if (hasCompletedOnboarding === false) {
            await writeRootConfig(homeDir, { hasCompletedOnboarding: true });
        }

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: homeDir },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).not.toHaveProperty('hasCompletedOnboarding');
    });

    it('preserves an existing target onboarding decision when no source completion is projected', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            hasCompletedOnboarding: false,
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
        await writeRootConfig(targetDir, {
            hasCompletedOnboarding: true,
            targetOwnedSetting: 'kept',
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toMatchObject({
            hasCompletedOnboarding: true,
            targetOwnedSetting: 'kept',
        });
    });

    it('applies source onboarding completion over an existing false target without clobbering target state', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            hasCompletedOnboarding: true,
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
        await writeRootConfig(targetDir, {
            hasCompletedOnboarding: false,
            targetOwnedSetting: 'kept',
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readRootConfig(targetDir)).toMatchObject({
            hasCompletedOnboarding: true,
            targetOwnedSetting: 'kept',
        });
    });

    it('isolates source root secrets while projecting onboarding completion', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            hasCompletedOnboarding: true,
            accessToken: 'must-not-copy',
            refreshToken: 'must-not-copy',
            apiKey: 'must-not-copy',
            nestedSecret: { token: 'must-not-copy' },
        });

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        const written = await readRootConfig(targetDir);
        expect(written).toMatchObject({ hasCompletedOnboarding: true });
        expect(written).not.toHaveProperty('accessToken');
        expect(written).not.toHaveProperty('refreshToken');
        expect(written).not.toHaveProperty('apiKey');
        expect(written).not.toHaveProperty('nestedSecret');
        expect(written).not.toHaveProperty('projects');
    });
});

describe('reconcileClaudeAccountScopedRootConfig', () => {
    it('removes predecessor entitlement state while keeping workspace state', async () => {
        const targetDir = join(root, 'target-config');
        await writeRootConfig(targetDir, {
            oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.test' },
            modelAccessCache: [{ value: 'claude-fable-5' }],
            additionalModelOptionsCache: [{ description: 'Requires usage credits' }],
            cachedExtraUsageDisabledReason: 'org_level_disabled',
            projects: { '/repo': { hasTrustDialogAccepted: true } },
        });
        await reconcileClaudeAccountScopedRootConfig({
            targetDir,
            preserveExistingAccountState: false,
            providerAccountId: 'new',
            providerEmail: 'new@example.test',
        });
        expect(await readRootConfig(targetDir)).toEqual({
            hasCompletedOnboarding: true,
            oauthAccount: { accountUuid: 'new', emailAddress: 'new@example.test' },
            projects: { '/repo': { hasTrustDialogAccepted: true } },
        });
    });
});

describe('materializeClaudeAuthEnvironment workspace trust wiring', () => {
    it('projects workspace trust into the materialized home during auth materialization', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'materialized-home');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            hasCompletedOnboarding: true,
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });

        const result = await materializeClaudeAuthEnvironment({
            rootDir: targetDir,
            processEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            sessionDirectory,
            connectedAccountMaterializationAuthority: 'qualified',
            claudeSubscription: null,
            anthropic: null,
        });

        expect(result.env.CLAUDE_CONFIG_DIR).toBe(targetDir);
        expect(await readRootConfig(targetDir)).toMatchObject({
            hasCompletedOnboarding: true,
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
    });
});
