import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolvePreparedSessionDirectory } from '@/daemon/startup/resolvePreparedSessionDirectory';
import { resolveDarwinBackgroundServiceSpawnDirectoryFailure } from '@/daemon/spawn/resolveDarwinBackgroundServiceSpawnDirectoryFailure';
import { executeNativeSessionDirectoryPreparation } from './sessionDirectoryEffect';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('retains the macOS background-service protected-folder refusal for home intent', () => {
  const input = { startupSource: 'background-service' as const, platform: 'darwin' as const,
    env: { HOME: '/Users/custodian' } };
  expect(resolveDarwinBackgroundServiceSpawnDirectoryFailure({ ...input, directory: '~/Documents/project' })).not.toBeNull();
  expect(resolveDarwinBackgroundServiceSpawnDirectoryFailure({ ...input, directory: '~/projects' })).toBeNull();
});

it.each([
  { lifecycle: 'fresh', intent: '~', suffix: [] },
  { lifecycle: 'resume', intent: '~', suffix: [] },
  { lifecycle: 'fresh', intent: '~\\projects/child', suffix: ['projects', 'child'] },
  { lifecycle: 'resume', intent: '~/projects\\child', suffix: ['projects', 'child'] },
])('resolves $lifecycle $intent under the separated member home, after directory selection', async ({ lifecycle, intent, suffix }) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'happier-session-home-intent-'));
  const daemonHome = join(root, 'custodian');
  const memberHome = join(root, 'member');
  const expectedDirectory = join(memberHome, ...suffix);
  await fs.mkdir(expectedDirectory, { recursive: true });
  const access = fs.access.bind(fs);
  // HOME and access permissions model the native process/OS boundary. Both
  // directory owners, canonical expansion and filesystem readiness stay real.
  vi.spyOn(fs, 'access').mockImplementation(async (path, mode) => {
    if (String(path).startsWith(daemonHome)) throw Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    return access(path, mode);
  });
  try {
    vi.stubEnv('HOME', daemonHome);
    vi.stubEnv('USERPROFILE', daemonHome);
    const resumed = lifecycle === 'resume';
    const selected = resolvePreparedSessionDirectory({
      options: { directory: resumed ? '/ignored-caller-directory' : intent },
      normalizedExistingSessionId: resumed ? 'retained-session' : '',
      existingSessionWorkspacePath: resumed ? intent : null,
      ownerMetadata: resumed ? { v: 1, workspace: { path: intent } } : null,
    });
    vi.stubEnv('HOME', memberHome);
    vi.stubEnv('USERPROFILE', memberHome);
    const prepare = (path: string) => executeNativeSessionDirectoryPreparation({
      kind: 'session.directory.prepare', request: { directory: { kind: 'path', path } },
      approvedNewDirectoryCreation: false,
    });
    expect(await prepare(selected.directory)).toEqual({ ok: true, directory: expectedDirectory,
      directoryCreated: false, checkoutCreated: false });
    // An explicit custodian path remains explicit; it must not become the
    // member's home merely because the caller lacks access to that directory.
    expect(await prepare(daemonHome)).toMatchObject({ ok: false, result: { type: 'error' } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
