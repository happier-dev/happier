import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readConnectedServiceStateSharingManifest } from '@/daemon/connectedServices/stateSharing/connectedServiceStateSharingManifest';

import { syncClaudeConnectedServiceHome } from './syncClaudeConnectedServiceHome';
import { verifyResumeReachableClaude } from './verifyResumeReachableClaude';

const PROJECT_DIR_NAME = '-Users-leeroy-Documents-Development-happier-remote-dev';
const VENDOR_RESUME_ID = '4b9434a8-b115-4363-851a-f39fff76a94b';

describe('Claude account retention through profile materialization', () => {
  it.each(['copied', 'isolated'] as const)('preserves the selected period across %s configuration refreshes', async (configMode) => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-retention-profile-'));
    const sourceDir = join(root, 'native');
    const targetDir = join(root, 'profile');
    try {
      await mkdir(sourceDir, { recursive: true });
      for (const nativeDays of [7, 14]) {
        await writeFile(join(sourceDir, 'settings.json'), JSON.stringify({ cleanupPeriodDays: nativeDays, model: 'sonnet' }));
        await syncClaudeConnectedServiceHome({
          sourceEnv: { HOME: root, CLAUDE_CONFIG_DIR: sourceDir },
          targetDir,
          accountSettings: { claudeSessionRetentionV1: { mode: 'days', days: 365 } },
          sharingPolicyOverride: { configMode, stateMode: 'isolated' },
        });
        const settings = JSON.parse(await readFile(join(targetDir, 'settings.json'), 'utf8'));
        expect(settings.cleanupPeriodDays).toBe(365);
        if (configMode === 'copied') expect(settings.model).toBe('sonnet');
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes through linked settings, resets only retention, and leaves unmanaged settings alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-retention-linked-'));
    const sourceDir = join(root, 'native');
    const targetDir = join(root, 'profile');
    const sync = (accountSettings: Readonly<Record<string, unknown>>) => syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: root, CLAUDE_CONFIG_DIR: sourceDir }, targetDir, accountSettings,
      sharingPolicyOverride: { configMode: 'linked', stateMode: 'isolated' },
    });
    try {
      await mkdir(sourceDir, { recursive: true });
      const path = join(sourceDir, 'settings.json');
      await writeFile(path, JSON.stringify({ cleanupPeriodDays: 7, model: 'sonnet' }));
      await sync({ claudeSessionRetentionV1: { mode: 'days', days: 36500 } });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ cleanupPeriodDays: 36500, model: 'sonnet' });
      expect(await realpath(join(targetDir, 'settings.json'))).toBe(await realpath(path));
      await sync({ claudeSessionRetentionV1: { mode: 'providerDefault' } });
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ model: 'sonnet' });
      await writeFile(path, '{"cleanupPeriodDays":90,"model":"opus"}\n');
      await sync({});
      expect(await readFile(path, 'utf8')).toBe('{"cleanupPeriodDays":90,"model":"opus"}\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports invalid settings without replacing them when retention is managed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-retention-invalid-'));
    try {
      const sourceDir = join(root, 'native');
      const targetDir = join(root, 'profile');
      await mkdir(sourceDir, { recursive: true });
      await writeFile(join(sourceDir, 'settings.json'), '{invalid');
      await expect(syncClaudeConnectedServiceHome({
        sourceEnv: { HOME: root, CLAUDE_CONFIG_DIR: sourceDir }, targetDir,
        accountSettings: { claudeSessionRetentionV1: { mode: 'days', days: 365 } },
        sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
      })).rejects.toThrow('invalid_settings');
      expect(await readFile(join(targetDir, 'settings.json'), 'utf8')).toBe('{invalid');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('syncClaudeConnectedServiceHome durable account-local projects', () => {
  it('retains sibling private sessions across refresh, then adopts them before linking shared projects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-claude-durable-projects-'));
    const targetDir = join(root, 'account');
    const sourceDir = join(root, 'native');
    const sourceEnv = { HOME: root, CLAUDE_CONFIG_DIR: sourceDir };
    const projectDir = join(targetDir, 'projects', PROJECT_DIR_NAME);
    try {
      await mkdir(projectDir, { recursive: true });
      await mkdir(join(sourceDir, 'projects'), { recursive: true });
      await writeFile(join(projectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"private"}\n');
      await writeFile(join(projectDir, 'sibling.jsonl'), '{"type":"assistant","text":"sibling"}\n');
      for (let pass = 0; pass < 2; pass += 1) {
        await syncClaudeConnectedServiceHome({ sourceEnv, targetDir, sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' } });
        await expect(readFile(join(projectDir, 'sibling.jsonl'), 'utf8')).resolves.toContain('sibling');
        await expect(verifyResumeReachableClaude({ vendorResumeId: VENDOR_RESUME_ID, processEnv: { ...sourceEnv, CLAUDE_CONFIG_DIR: targetDir } })).resolves.toMatchObject({ ok: true });
      }
      await syncClaudeConnectedServiceHome({ sourceEnv, targetDir, sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' } });
      await expect(readFile(join(sourceDir, 'projects', PROJECT_DIR_NAME, 'sibling.jsonl'), 'utf8')).resolves.toContain('sibling');
      const projectsLink = await lstat(join(targetDir, 'projects'));
      await syncClaudeConnectedServiceHome({ sourceEnv, targetDir, sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' } });
      expect((await lstat(join(targetDir, 'projects'))).ino).toBe(projectsLink.ino);
      await expect(verifyResumeReachableClaude({ vendorResumeId: VENDOR_RESUME_ID, processEnv: { ...sourceEnv, CLAUDE_CONFIG_DIR: targetDir } })).resolves.toMatchObject({ ok: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function makeSelfSourceHome(): Promise<Readonly<{ homeDir: string; targetDir: string; ambientDir: string }>> {
  const homeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-home-'));
  const targetDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-target-'));
  const ambientDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-ambient-'));
  return { homeDir, targetDir, ambientDir };
}

async function setFileMtime(path: string, atMs: number): Promise<void> {
  const seconds = atMs / 1000;
  await utimes(path, seconds, seconds);
}

describe('syncClaudeConnectedServiceHome self-source sharing-policy reconciliation', () => {
  it('converts an isolated self-source projects dir into a shared-store link when sharing is toggled on', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const isolatedProjectDir = join(targetDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(isolatedProjectDir, { recursive: true });
    await writeFile(join(isolatedProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"isolated era session"}\n');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('shared');
    expect(result.effectiveStateMode).toBe('shared');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(true);
    await expect(realpath(join(targetDir, 'projects'))).resolves.toBe(await realpath(join(ambientDir, 'projects')));

    // The isolated-era session file is preserved into the shared store and stays reachable through the link.
    await expect(
      readFile(join(ambientDir, 'projects', PROJECT_DIR_NAME, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('isolated era session');
    await expect(verifyResumeReachableClaude({
      vendorResumeId: VENDOR_RESUME_ID,
      processEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
    })).resolves.toMatchObject({ ok: true });

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('shared');
    expect(manifest.effectiveStateMode).toBe('shared');
    expect(manifest.stateEntries).toContain('projects');
  });

  it('detaches the shared projects link into an isolated dir when sharing is toggled off', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    await writeFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), '{"type":"assistant","text":"shared era session"}\n');
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const result = await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'isolated' },
      ambientStateSourceDir: ambientDir,
    });

    expect(result.requestedStateMode).toBe('isolated');
    expect(result.effectiveStateMode).toBe('isolated');

    const projectsStat = await lstat(join(targetDir, 'projects'));
    expect(projectsStat.isSymbolicLink()).toBe(false);
    expect(projectsStat.isDirectory()).toBe(true);
    await expect(readdir(join(targetDir, 'projects'))).resolves.toEqual([]);

    // Ambient sessions stay in the ambient store untouched — nothing is deleted by the detach.
    await expect(
      readFile(join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`), 'utf8'),
    ).resolves.toContain('shared era session');

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    expect(manifest.requestedStateMode).toBe('isolated');
    expect(manifest.effectiveStateMode).toBe('isolated');
    expect(manifest.stateEntries).toEqual([]);
  });
});

describe('syncClaudeConnectedServiceHome candidate session import reconciliation', () => {
  it('keeps the newest canonical jsonl and removes stale conflict copies instead of leaving divergent imports', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"canonical newest content"}\n');
    const staleConflictPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.happier-import-deadbeef0000.jsonl`);
    await writeFile(staleConflictPath, '{"type":"assistant","text":"frozen import"}\n');
    await setFileMtime(staleConflictPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"older divergent source"}\n');
    await setFileMtime(candidatePath, Date.now() - 30 * 60 * 1000);

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    // Canonical newest content wins; no conflict copy remains for the resume id.
    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('canonical newest content');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath.endsWith(`${VENDOR_RESUME_ID}.jsonl`)).toBe(true);
    expect(mapping?.destinationPath.includes('.happier-import-')).toBe(false);
  });

  it('promotes a newer candidate session file over a stale canonical copy', async () => {
    const { homeDir, targetDir, ambientDir } = await makeSelfSourceHome();
    const ambientProjectDir = join(ambientDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(ambientProjectDir, { recursive: true });
    const canonicalPath = join(ambientProjectDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(canonicalPath, '{"type":"assistant","text":"stale canonical"}\n');
    await setFileMtime(canonicalPath, Date.now() - 60 * 60 * 1000);
    await symlink(join(ambientDir, 'projects'), join(targetDir, 'projects'), 'dir');

    const previousHomeDir = await mkdtemp(join(tmpdir(), 'happier-claude-sync-previous-'));
    const candidateDir = join(previousHomeDir, 'projects', PROJECT_DIR_NAME);
    await mkdir(candidateDir, { recursive: true });
    const candidatePath = join(candidateDir, `${VENDOR_RESUME_ID}.jsonl`);
    await writeFile(candidatePath, '{"type":"assistant","text":"newer real session"}\n');

    await syncClaudeConnectedServiceHome({
      sourceEnv: { HOME: homeDir, CLAUDE_CONFIG_DIR: targetDir },
      targetDir,
      sharingPolicyOverride: { configMode: 'copied', stateMode: 'shared' },
      ambientStateSourceDir: ambientDir,
      vendorResumeId: VENDOR_RESUME_ID,
      candidatePersistedSessionFile: candidatePath,
    });

    await expect(readFile(canonicalPath, 'utf8')).resolves.toContain('newer real session');
    const entries = await readdir(ambientProjectDir);
    expect(entries.filter((entry) => entry.includes('.happier-import-'))).toEqual([]);

    const manifest = await readConnectedServiceStateSharingManifest(targetDir);
    const mapping = manifest.sessionFileMappings.find((item) => item.vendorResumeId === VENDOR_RESUME_ID);
    expect(mapping?.destinationPath).toBe(canonicalPath);
  });
});
