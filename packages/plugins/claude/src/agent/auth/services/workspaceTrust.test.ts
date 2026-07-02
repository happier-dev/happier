import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeClaudeAuthEnvironment } from '../../contributions/runtime.js';
import { projectClaudeWorkspaceTrust } from './workspaceTrust.js';

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
            projects: { '/other/project': { hasTrustDialogAccepted: true } },
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

    it('does not write anything when the workspace has no accepted trust state', async () => {
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

    it('honors an explicit declined trust state on the override candidate without falling through', async () => {
        const sourceDir = join(root, 'source-config');
        const homeDir = join(root, 'home');
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
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

        expect(await readRootConfig(targetDir)).toBeNull();
    });

    it('never reads the target dir as its own trust source', async () => {
        const targetDir = join(root, 'target-config');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(targetDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
        const before = await readFile(join(targetDir, '.claude.json'), 'utf8');

        await projectClaudeWorkspaceTrust({
            sourceEnv: { CLAUDE_CONFIG_DIR: targetDir, HOME: join(root, 'home') },
            targetDir,
            sessionDirectory,
        });

        expect(await readFile(join(targetDir, '.claude.json'), 'utf8')).toBe(before);
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
});

describe('materializeClaudeAuthEnvironment workspace trust wiring', () => {
    it('projects workspace trust into the materialized home during auth materialization', async () => {
        const sourceDir = join(root, 'source-config');
        const targetDir = join(root, 'materialized-home');
        const sessionDirectory = join(root, 'workspace');
        await writeRootConfig(sourceDir, {
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });

        const result = await materializeClaudeAuthEnvironment({
            rootDir: targetDir,
            processEnv: { CLAUDE_CONFIG_DIR: sourceDir, HOME: join(root, 'home') },
            sessionDirectory,
            claudeSubscription: null,
            anthropic: null,
        });

        expect(result.env.CLAUDE_CONFIG_DIR).toBe(targetDir);
        expect(await readRootConfig(targetDir)).toMatchObject({
            projects: { [sessionDirectory]: { hasTrustDialogAccepted: true } },
        });
    });
});
