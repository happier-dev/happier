import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';

import { formatPiSessionDirectoryForCwd } from './piSessionFiles';
import { resolvePiContinueSessionFile } from './resolvePiContinueSessionFile';

/**
 * Contract: the file Pi 1.5.2 `--continue` opens (`SessionManager.continueRecent` +
 * `findMostRecentSession`, session dir from `PI_CODING_AGENT_SESSION_DIR` then merged
 * global/project settings `sessionDir`, agent dir from `PI_CODING_AGENT_DIR` or `~/.pi/agent`).
 */
describe('resolvePiContinueSessionFile', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let otherCwd: string;

  beforeEach(async () => {
    root = await createTempDir('happier-pi-continue-');
    home = join(root, 'home');
    cwd = join(root, 'project');
    otherCwd = join(root, 'elsewhere');
    await mkdir(home, { recursive: true });
    await mkdir(cwd, { recursive: true });
  });

  afterEach(async () => {
    await removeTempDir(root);
  });

  function defaultSessionDir(agentDir: string, forCwd = cwd): string {
    return join(agentDir, 'sessions', formatPiSessionDirectoryForCwd(forCwd));
  }

  async function writeSession(dir: string, name: string, params: Readonly<{
    cwd: string;
    mtimeSec: number;
    firstLine?: string;
  }>): Promise<string> {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, name);
    const header = params.firstLine ?? JSON.stringify({
      type: 'session',
      version: 3,
      id: name.replace(/\.jsonl$/, ''),
      timestamp: '2026-11-16T00:00:00.000Z',
      cwd: params.cwd,
    });
    await writeFile(filePath, `${header}\n${JSON.stringify({ type: 'message', id: 'm1' })}\n`);
    await utimes(filePath, params.mtimeSec, params.mtimeSec);
    return filePath;
  }

  async function writeJson(filePath: string, value: unknown): Promise<void> {
    await mkdir(join(filePath, '..'), { recursive: true });
    await writeFile(filePath, JSON.stringify(value));
  }

  it('picks the newest session by mtime in the default directory for the cwd', async () => {
    const agentDir = join(home, '.pi', 'agent');
    await writeSession(defaultSessionDir(agentDir), 'older.jsonl', { cwd, mtimeSec: 1_000 });
    const newest = await writeSession(defaultSessionDir(agentDir), 'newest.jsonl', { cwd, mtimeSec: 3_000 });
    await writeSession(defaultSessionDir(agentDir, otherCwd), 'other-project.jsonl', { cwd: otherCwd, mtimeSec: 9_000 });

    await expect(resolvePiContinueSessionFile({ cwd, env: { HOME: home } })).resolves.toBe(newest);
  });

  it('skips files without a readable session header', async () => {
    const dir = defaultSessionDir(join(home, '.pi', 'agent'));
    const valid = await writeSession(dir, 'valid.jsonl', { cwd, mtimeSec: 1_000 });
    await writeSession(dir, 'not-a-header.jsonl', { cwd, mtimeSec: 2_000, firstLine: JSON.stringify({ type: 'message', id: 'x' }) });
    await writeSession(dir, 'corrupt.jsonl', { cwd, mtimeSec: 3_000, firstLine: '{not json' });
    await writeSession(dir, 'notes.txt', { cwd, mtimeSec: 4_000 });

    await expect(resolvePiContinueSessionFile({ cwd, env: { HOME: home } })).resolves.toBe(valid);
  });

  it('does not filter the default directory by the header cwd', async () => {
    const dir = defaultSessionDir(join(home, '.pi', 'agent'));
    const moved = await writeSession(dir, 'moved.jsonl', { cwd: otherCwd, mtimeSec: 1_000 });

    await expect(resolvePiContinueSessionFile({ cwd, env: { HOME: home } })).resolves.toBe(moved);
  });

  it('honours PI_CODING_AGENT_DIR', async () => {
    const customAgentDir = join(root, 'custom-agent');
    await writeSession(defaultSessionDir(join(home, '.pi', 'agent')), 'home-default.jsonl', { cwd, mtimeSec: 9_000 });
    const custom = await writeSession(defaultSessionDir(customAgentDir), 'custom.jsonl', { cwd, mtimeSec: 1_000 });

    await expect(resolvePiContinueSessionFile({
      cwd,
      env: { HOME: home, PI_CODING_AGENT_DIR: customAgentDir },
    })).resolves.toBe(custom);
  });

  it('uses PI_CODING_AGENT_SESSION_DIR (tilde-expanded) and keeps only sessions started in the cwd', async () => {
    const sessionDir = join(home, 'pi-sessions');
    await writeSession(defaultSessionDir(join(home, '.pi', 'agent')), 'default-dir.jsonl', { cwd, mtimeSec: 9_000 });
    const mine = await writeSession(sessionDir, 'mine.jsonl', { cwd, mtimeSec: 1_000 });
    await writeSession(sessionDir, 'theirs.jsonl', { cwd: otherCwd, mtimeSec: 2_000 });
    await writeSession(sessionDir, 'no-cwd.jsonl', {
      cwd,
      mtimeSec: 3_000,
      firstLine: JSON.stringify({ type: 'session', id: 'no-cwd', timestamp: '' }),
    });

    await expect(resolvePiContinueSessionFile({
      cwd,
      env: { HOME: home, PI_CODING_AGENT_SESSION_DIR: '~/pi-sessions' },
    })).resolves.toBe(mine);
  });

  it('does not cwd-filter a configured session dir that is the default dir', async () => {
    const agentDir = join(home, '.pi', 'agent');
    const moved = await writeSession(defaultSessionDir(agentDir), 'moved.jsonl', { cwd: otherCwd, mtimeSec: 1_000 });

    await expect(resolvePiContinueSessionFile({
      cwd,
      env: { HOME: home, PI_CODING_AGENT_SESSION_DIR: defaultSessionDir(agentDir) },
    })).resolves.toBe(moved);
  });

  it('reads sessionDir from Pi settings with project over global, below PI_CODING_AGENT_SESSION_DIR', async () => {
    const agentDir = join(home, '.pi', 'agent');
    const globalDir = join(root, 'global-sessions');
    const projectDir = join(root, 'project-sessions');
    const envDir = join(root, 'env-sessions');
    await writeSession(defaultSessionDir(agentDir), 'default-dir.jsonl', { cwd, mtimeSec: 9_000 });
    const fromGlobal = await writeSession(globalDir, 'global.jsonl', { cwd, mtimeSec: 1_000 });
    await writeSession(globalDir, 'global-other.jsonl', { cwd: otherCwd, mtimeSec: 8_000 });
    const fromProject = await writeSession(projectDir, 'project.jsonl', { cwd, mtimeSec: 1_000 });
    await writeSession(projectDir, 'project-other.jsonl', { cwd: otherCwd, mtimeSec: 8_000 });
    const fromEnv = await writeSession(envDir, 'env.jsonl', { cwd, mtimeSec: 1_000 });
    const env = { HOME: home };

    await writeJson(join(agentDir, 'settings.json'), { sessionDir: globalDir });
    await expect(resolvePiContinueSessionFile({ cwd, env })).resolves.toBe(fromGlobal);

    await writeJson(join(cwd, '.pi', 'settings.json'), { sessionDir: projectDir });
    await expect(resolvePiContinueSessionFile({ cwd, env })).resolves.toBe(fromProject);

    await expect(resolvePiContinueSessionFile({
      cwd,
      env: { ...env, PI_CODING_AGENT_SESSION_DIR: envDir },
    })).resolves.toBe(fromEnv);
  });

  it('returns null when the session directory is missing, empty, or has no session for the cwd', async () => {
    const env = { HOME: home };
    await expect(resolvePiContinueSessionFile({ cwd, env })).resolves.toBeNull();

    await mkdir(defaultSessionDir(join(home, '.pi', 'agent')), { recursive: true });
    await expect(resolvePiContinueSessionFile({ cwd, env })).resolves.toBeNull();

    const sessionDir = join(root, 'shared-sessions');
    await writeSession(sessionDir, 'theirs.jsonl', { cwd: otherCwd, mtimeSec: 1_000 });
    await expect(resolvePiContinueSessionFile({
      cwd,
      env: { ...env, PI_CODING_AGENT_SESSION_DIR: sessionDir },
    })).resolves.toBeNull();
  });
});
