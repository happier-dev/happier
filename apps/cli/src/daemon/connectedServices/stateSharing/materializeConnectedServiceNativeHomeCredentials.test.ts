import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ensurePrivateConnectedServiceMaterializedRoot } from '../materialize/privateMaterializedRoot';
import { materializeConnectedServiceNativeHomeCredentials } from './materializeConnectedServiceNativeHomeCredentials';

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
  });
});
