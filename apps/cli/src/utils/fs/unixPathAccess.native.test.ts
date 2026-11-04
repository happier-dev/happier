import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSessionNativeDirectory, grantExactUidPathAccess } from './unixPathAccess';

const available = process.platform === 'linux' && ['setfacl', 'getfacl'].every(command => spawnSync(command, ['--version']).status === 0);
function readAcl(path: string): string[] {
  const acl = spawnSync('getfacl', ['-n', '-c', '-p', path], { encoding: 'utf8' });
  expect(acl.status).toBe(0);
  return acl.stdout.trim().split('\n').sort();
}

it.skipIf(!available)('rejects a real setfacl failure on the test process procfs file without ACL support', async () => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  // procfs has no stored ACLs; this inode belongs only to the current test process.
  const path = `/proc/${process.pid}/comm`;
  const entry = await stat(path);
  expect(entry.isFile()).toBe(true);
  expect(entry.uid).toBe(process.getuid!());
  expect(entry.nlink).toBe(1);
  const result = spawnSync('setfacl', ['--set', `user::rw-,user:${uid}:rw-,group::---,mask::rw-,other::---`, path], { encoding: 'utf8' });
  expect(result.status).not.toBe(0);
  await expect(grantExactUidPathAccess({ path, uid, directory: false, access: 'rw-' })).rejects.toThrow('Native Unix path access is unavailable');
});
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

it.skipIf(!available)('closes pre-existing 0644 access and removes stale named grants on a real file', async () => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  const root = await mkdtemp(join(tmpdir(), 'acl-public-file-'));
  const path = join(root, 'entry');
  try {
    await writeFile(path, 'selected data'); await chmod(path, 0o644);
    expect(spawnSync('setfacl', ['-m', 'user:99996:rwx', path]).status).toBe(0);
    await grantExactUidPathAccess({ path, uid, directory: false, access: 'rw-' });
    expect(readAcl(path)).toEqual(['user::rw-', `user:${uid}:rw-`, 'group::---', 'mask::rw-', 'other::---'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!available)('replaces stale directory defaults and installs only requested inheritance on real Linux', async () => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  const path = await mkdtemp(join(tmpdir(), 'acl-defaults-'));
  const stale = 'd:user::rwx,d:user:99996:rwx,d:group::r-x,d:mask::rwx,d:other::r-x';
  const expected = ['user::rwx', `user:${uid}:rwx`, 'group::---', 'mask::rwx', 'other::---'];
  try {
    expect(spawnSync('setfacl', ['-m', stale, path]).status).toBe(0);
    await grantExactUidPathAccess({ path, uid, directory: true, access: 'rwx' });
    expect(readAcl(path)).toEqual([...expected].sort());
    expect(spawnSync('setfacl', ['-m', stale, path]).status).toBe(0);
    await grantExactUidPathAccess({ path, uid, directory: true, access: 'rwx', inherit: true });
    expect(readAcl(path)).toEqual([...expected, 'default:user::rwx', `default:user:${process.getuid!()}:rwx`,
      `default:user:${uid}:rwx`, 'default:group::---', 'default:mask::rwx', 'default:other::---'].sort());
  } finally { await rm(path, { recursive: true, force: true }); }
});

it.skipIf(!available).each([0o400, 0o640, 0o644])('preserves source mode %s while granting its owner permissions on real Linux', async mode => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  const root = await mkdtemp(join(tmpdir(), 'acl-preserve-'));
  const path = join(root, 'entry');
  const access = (bits: number) => `${bits & 4 ? 'r' : '-'}${bits & 2 ? 'w' : '-'}${bits & 1 ? 'x' : '-'}`;
  try {
    await writeFile(path, 'seed'); await chmod(path, mode);
    await grantExactUidPathAccess({ path, uid, directory: false, access: 'owner', preservePermissions: true });
    expect(readAcl(path)).toEqual([`user::${access((mode >> 6) & 7)}`, `user:${uid}:${access((mode >> 6) & 7)}`,
      `group::${access((mode >> 3) & 7)}`, `mask::${access(((mode >> 6) | (mode >> 3)) & 7)}`, `other::${access(mode & 7)}`].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.skipIf(!available)('grants exact-UID access to a real socket through its held descriptor', async () => {
  const uid = process.getuid?.() === 99998 ? 99997 : 99998;
  const directory = await createSessionNativeDirectory({ uid, prefix: 'acl-socket-', access: '--x' });
  const path = join(directory.path, 'mcp.sock');
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    await chmod(path, 0o600);
    await grantExactUidPathAccess({ path, uid, directory: false, kind: 'socket', access: 'rw-' });
    const acl = spawnSync('getfacl', ['-n', '-c', '-p', path], { encoding: 'utf8' });
    expect(acl.status).toBe(0);
    expect(acl.stdout.trim().split('\n').sort()).toEqual([
      'user::rw-', `user:${uid}:rw-`, 'group::---', 'mask::rw-', 'other::---',
    ].sort());
    expect((await stat(path)).isSocket()).toBe(true);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await directory.dispose();
  }
});
