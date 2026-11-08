import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { executeNativeSessionDirectoryPreparation } from './sessionDirectoryEffect';
import type { DirectoryPreflightRefusal } from '@/session/creation/directoryPreflightDiagnostic';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';

it('retains native Session folder refusal facts for canonicalization and directory access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-session-folder-'));
  const observations: DirectoryPreflightRefusal[] = [];
  const invoke = (path: string) => executeNativeSessionDirectoryPreparation({ kind: 'session.directory.prepare',
    request: { directory: { kind: 'path', path } }, approvedNewDirectoryCreation: false }, undefined,
  observation => observations.push(observation));
  try {
    const file = join(root, 'file');
    await writeFile(file, 'fixture');
    expect(await invoke('relative/path')).toMatchObject({ ok: false,
      result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: 'invalid_directory' } });
    expect(observations).toEqual([{ branch: 'canonical_path', directoryKind: 'path', requestedDirectory: 'relative/path',
      ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}) }]);
    expect(await invoke(file)).toMatchObject({ ok: false, result: { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.DIRECTORY_CREATE_FAILED } });
    expect(observations[1]).toEqual({ branch: 'directory_readiness', directoryKind: 'path', requestedDirectory: file,
      directory: file, ...(process.geteuid ? { effectiveUid: process.geteuid() } : {}) });
    expect(await invoke(root)).toMatchObject({ ok: true, directory: root });
    expect(await invoke(join(root, 'new'))).toMatchObject({ ok: false,
      result: { type: 'requestToApproveDirectoryCreation' } });
    expect(observations).toHaveLength(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
