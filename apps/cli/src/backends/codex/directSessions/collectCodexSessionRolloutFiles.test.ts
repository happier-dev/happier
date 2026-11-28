import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const readdirMock = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    readdir: (...args: Parameters<typeof actual.readdir>) => readdirMock(...args),
  };
});

import { collectCodexSessionRolloutFiles } from './collectCodexSessionRolloutFiles';

describe('collectCodexSessionRolloutFiles', () => {
  beforeEach(async () => {
    readdirMock.mockReset();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    readdirMock.mockImplementation(actual.readdir);
  });

  it('collects rollout files from date-derived day directories without reading the sessions root', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-fast-'));
    const remoteSessionId = '019c5b0c-b765-72e0-b799-6eca4714a46b';
    const dayDir = join(codexHome, 'sessions', '2026', '02', '14');
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`),
      '{"event":"one"}\n',
      'utf8',
    );
    await writeFile(
      join(dayDir, `rollout-2026-02-14T12-45-10-${remoteSessionId}.jsonl.zst`),
      '{"event":"two"}\n',
      'utf8',
    );

    readdirMock.mockImplementation(async (dir, options) => {
      const dirPath = String(dir);
      if (dirPath === join(codexHome, 'sessions') || dirPath === join(codexHome, 'archived_sessions')) {
        throw Object.assign(new Error('root scan disabled for fast-path test'), { code: 'EACCES' });
      }
      const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      return actual.readdir(dir, options as any);
    });

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId, includeCompressed: true });

    expect(files.map((file) => file.fileRelPath)).toEqual([
      `sessions/2026/02/14/rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`,
      `sessions/2026/02/14/rollout-2026-02-14T12-45-10-${remoteSessionId}.jsonl.zst`,
    ]);
  });

  it('falls back to recursive scanning for non timestamp-derived session ids', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-fallback-'));
    const remoteSessionId = 'legacy-session-id';
    const nestedDir = join(codexHome, 'sessions', 'custom', 'tree');
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`),
      '{"event":"legacy"}\n',
      'utf8',
    );

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId });

    expect(files.map((file) => file.fileRelPath)).toEqual([
      `sessions/custom/tree/rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`,
    ]);
  });

  it('does not treat a filename containing the id as a rollout for that id', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-exact-match-'));
    const remoteSessionId = 'legacy-session-id';
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const target = join(sessionsDir, `rollout-2026-02-14T08-28-05-${remoteSessionId}.jsonl`);
    const decoy = join(sessionsDir, `rollout-2026-02-14T08-28-06-other-${remoteSessionId}-suffix.jsonl`);
    await writeFile(target, '{"event":"target"}\n', 'utf8');
    await writeFile(decoy, '{"event":"decoy"}\n', 'utf8');

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId });

    expect(files.map((file) => file.filePath)).toEqual([target]);
  });

  it('collects a rollout by its metadata id when the filename uses an opaque suffix', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-metadata-id-'));
    const metadataId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const sessionsDir = join(codexHome, 'sessions', 'custom');
    await mkdir(sessionsDir, { recursive: true });
    const target = join(sessionsDir, 'rollout-2026-02-14T08-28-05-legacy-session-id.jsonl');
    await writeFile(target, JSON.stringify({ type: 'session_meta', payload: { id: metadataId } }) + '\n{"event":"target"}\n', 'utf8');

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId: metadataId });

    expect(files.map((file) => file.filePath)).toEqual([target]);
  });

  it('matches UUID rollout identities case-insensitively', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'happier-codex-rollout-uuid-case-'));
    const metadataId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const sessionsDir = join(codexHome, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const target = join(sessionsDir, `rollout-2026-02-14T08-28-05-${metadataId}.jsonl`);
    await writeFile(target, '{"event":"target"}\n', 'utf8');

    const files = await collectCodexSessionRolloutFiles({ codexHome, remoteSessionId: metadataId.toUpperCase() });

    expect(files.map((file) => file.filePath)).toEqual([target]);
  });
});
