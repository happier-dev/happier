import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionNativeDirectory } from './unixPathAccess';

const available = process.platform === 'linux' && ['setfacl', 'getfacl'].every(command => spawnSync(command, ['--version']).status === 0);
it.skipIf(!available)('grants only the selected numeric UID on a real Linux leaf and leaves its private TMPDIR ancestor untouched', async () => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  const root = await mkdtemp(join(tmpdir(), 'acl-private-'));
  const original = await stat(root);
  vi.stubEnv('TMPDIR', root);
  let directory: Awaited<ReturnType<typeof createSessionNativeDirectory>> | undefined;
  try {
    directory = await createSessionNativeDirectory({ uid, prefix: 'acl-native-', access: 'rwx' });
    expect(dirname(directory.path)).toBe('/tmp');
    const acl = spawnSync('getfacl', ['-n', '-c', '-p', directory.path], { encoding: 'utf8' });
    expect(acl.status).toBe(0);
    expect(acl.stdout.trim().split('\n').sort()).toEqual([
      'user::rwx', `user:${uid}:rwx`, 'group::---', 'mask::rwx', 'other::---',
    ].sort());
    expect((await stat(root)).mode).toBe(original.mode);
  } finally { vi.unstubAllEnvs(); await directory?.dispose(); await rm(root, { recursive: true, force: true }); }
});
