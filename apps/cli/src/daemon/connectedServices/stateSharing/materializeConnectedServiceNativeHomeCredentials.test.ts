import { chmod, lstat, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as filesystem from 'node:fs/promises';

// Count actual filesystem publication; credential logic and protection remain real.
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import { ensurePrivateConnectedServiceMaterializedRoot } from '../materialize/privateMaterializedRoot';
import { materializeConnectedServiceNativeHomeCredentials, readConnectedServiceNativeHomeCredentialFiles } from './materializeConnectedServiceNativeHomeCredentials';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await rm(root, { recursive: true, force: true });
  }));
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'happier-native-home-credential-'));
  roots.push(root);
  return root;
}

describe('materializeConnectedServiceNativeHomeCredentials', () => {
  it('publishes no unchanged credential bytes and still repairs changed, missing and unprotected files', async () => {
    const targetRoot = await createRoot();
    await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);
    const credential = join(targetRoot, 'auth.json');
    const publish = async (value: number) => await materializeConnectedServiceNativeHomeCredentials({
      targetRoot, declaredSecretEntries: ['auth.json'], files: { 'auth.json': new Uint8Array([0, 255, value]) },
    });
    await publish(1);
    vi.mocked(filesystem.rename).mockClear();
    await publish(1);
    expect(filesystem.rename).toHaveBeenCalledTimes(0);
    await publish(2);
    expect(filesystem.rename).toHaveBeenCalledTimes(1);
    expect(await readFile(credential)).toEqual(Buffer.from([0, 255, 2]));
    await rm(credential);
    await publish(2);
    expect(filesystem.rename).toHaveBeenCalledTimes(2);
    if (process.platform !== 'win32') {
      await chmod(credential, 0o644);
      await publish(2);
      expect((await lstat(credential)).mode & 0o777).toBe(0o600);
    }
  });

  it('snapshots only declared existing files as opaque bytes and refuses redirected reads', async () => {
    const root = await createRoot();
    const targetRoot = join(root, 'account-home');
    await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);
    const contents = Buffer.from([0, 255, 42]);
    await writeFile(join(targetRoot, 'config.json'), contents);
    await writeFile(join(targetRoot, 'private.json'), 'unrequested');
    await mkdir(join(targetRoot, 'credential-store'));
    await writeFile(join(targetRoot, 'credential-store', 'private.json'), 'unrequested');
    await expect(readConnectedServiceNativeHomeCredentialFiles({ targetRoot,
      declaredSecretEntries: ['config.json', 'missing.json', 'credential-store'],
    })).resolves.toEqual({ 'config.json': contents });
    await expect(readConnectedServiceNativeHomeCredentialFiles({ targetRoot,
      declaredSecretEntries: ['../private.json'],
    })).rejects.toThrow('connected_service_native_home_secret_entry_invalid');
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'config.json'), 'outside');
    await symlink(outside, join(targetRoot, 'linked'));
    await expect(readConnectedServiceNativeHomeCredentialFiles({ targetRoot,
      declaredSecretEntries: ['linked/config.json'],
    })).rejects.toThrow('connected_service_native_home_credential_path_unsafe');
    await symlink(join(outside, 'config.json'), join(targetRoot, 'alias.json'));
    await expect(readConnectedServiceNativeHomeCredentialFiles({ targetRoot,
      declaredSecretEntries: ['alias.json'],
    })).rejects.toThrow('connected_service_native_home_credential_path_unsafe');
  });

  it('publishes opaque bytes at the declared isolated-home path without mutating the persistent source home', async () => {
    const root = await createRoot();
    const sourceRoot = join(root, 'persistent-codex-home');
    const targetRoot = join(root, 'session-codex-home');
    const original = new Uint8Array([0, 255, 12, 34]);
    const selected = new Uint8Array([123, 34, 116, 111, 107, 101, 110, 34, 58, 49, 125]);
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(join(sourceRoot, 'auth.json'), original);
    await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);

    await materializeConnectedServiceNativeHomeCredentials({
      targetRoot,
      declaredSecretEntries: ['auth.json', 'accounts/current.json'],
      files: { 'auth.json': selected },
    });

    await expect(readFile(join(targetRoot, 'auth.json'))).resolves.toEqual(Buffer.from(selected));
    const rotatedSelection = new Uint8Array([0, 255, 42, 1]);
    await materializeConnectedServiceNativeHomeCredentials({
      targetRoot, declaredSecretEntries: ['auth.json', 'accounts/current.json'],
      files: { 'auth.json': rotatedSelection },
    });
    await expect(readFile(join(targetRoot, 'auth.json'))).resolves.toEqual(Buffer.from(rotatedSelection));
    await expect(readFile(join(sourceRoot, 'auth.json'))).resolves.toEqual(Buffer.from(original));
  });

  it.each([
    '../auth.json',
    '/tmp/auth.json',
    'accounts/../auth.json',
    'accounts\\auth.json',
    'C:/auth.json',
  ])('refuses unsafe declared secret path %s', async (entry) => {
    const root = await createRoot();
    const targetRoot = join(root, 'session-home');
    await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);

    await expect(materializeConnectedServiceNativeHomeCredentials({
      targetRoot,
      declaredSecretEntries: [entry],
      files: {},
    })).rejects.toThrow('connected_service_native_home_secret_entry_invalid');
  });

  it('refuses undeclared output and a symlinked credential parent', async () => {
    const root = await createRoot();
    const targetRoot = join(root, 'session-home');
    const outside = join(root, 'outside');
    await ensurePrivateConnectedServiceMaterializedRoot(targetRoot);
    await mkdir(outside);

    await expect(materializeConnectedServiceNativeHomeCredentials({
      targetRoot,
      declaredSecretEntries: ['auth.json'],
      files: { 'other.json': new Uint8Array([1]) },
    })).rejects.toThrow('connected_service_native_home_credential_file_undeclared');

    await symlink(outside, join(targetRoot, 'accounts'));
    await expect(materializeConnectedServiceNativeHomeCredentials({
      targetRoot,
      declaredSecretEntries: ['accounts/current.json'],
      files: { 'accounts/current.json': new Uint8Array([2]) },
    })).rejects.toThrow();
    await expect(readFile(join(outside, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(join(outside, 'auth.json'), 'outside-native-auth');
    await symlink(join(outside, 'auth.json'), join(targetRoot, 'auth.json'));
    await expect(materializeConnectedServiceNativeHomeCredentials({
      targetRoot, declaredSecretEntries: ['auth.json'], files: { 'auth.json': new Uint8Array([3]) },
    })).rejects.toThrow();
    await expect(readFile(join(outside, 'auth.json'), 'utf8')).resolves.toBe('outside-native-auth');
  });
});
