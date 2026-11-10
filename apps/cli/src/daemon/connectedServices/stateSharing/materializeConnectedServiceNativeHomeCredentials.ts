import { constants } from 'node:fs';
import { lstat, open, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { writeProtectedLocalStateFileAtomic } from '@/utils/fs/protectedLocalState';

function isCanonicalRelativeCredentialPath(path: string): boolean {
  return path.length > 0
    && path === path.trim()
    && !isAbsolute(path)
    && !path.includes('\\')
    && !/^[A-Za-z]:/u.test(path)
    && path.split('/').every((segment) => (
      segment.length > 0 && segment !== '.' && segment !== '..'
    ));
}

function declaredNativeHomeFiles(input: Readonly<{ targetRoot: string; declaredSecretEntries: readonly string[] }>) {
  const paths = new Map<string, string>();
  for (const entry of input.declaredSecretEntries) {
    if (!isCanonicalRelativeCredentialPath(entry) || paths.has(entry)) {
      throw new Error('connected_service_native_home_secret_entry_invalid');
    }
    paths.set(entry, resolve(input.targetRoot, entry));
  }
  return paths;
}

/** Revocation removes declared secrets without discarding retained native history. */
export async function removeConnectedServiceNativeHomeCredentials(input: Readonly<{
  targetRoot: string;
  declaredSecretEntries: readonly string[];
}>): Promise<void> {
  for (const path of declaredNativeHomeFiles(input).values()) await rm(path, { recursive: true, force: true });
}

/** Snapshot only this prepared home's declared files; no source-home or arbitrary-path reads. */
export async function readConnectedServiceNativeHomeCredentialFiles(input: Readonly<{
  targetRoot: string;
  declaredSecretEntries: readonly string[];
}>): Promise<Readonly<Record<string, Uint8Array>>> {
  const files: Record<string, Uint8Array> = Object.create(null);
  for (const [fileId, path] of declaredNativeHomeFiles(input)) {
    try {
      let parent = input.targetRoot;
      for (const segment of fileId.split('/').slice(0, -1)) {
        parent = join(parent, segment);
        const stats = await lstat(parent);
        if (stats.isSymbolicLink() || !stats.isDirectory()) {
          throw new Error('connected_service_native_home_credential_path_unsafe');
        }
      }
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new Error('connected_service_native_home_credential_path_unsafe');
      }
      // Secret declarations can also name credential-store directories (e.g. Codex accounts).
      // Only declared files are callback inputs; never traverse credential directories.
      if (stats.isDirectory()) continue;
      if (!stats.isFile()) throw new Error('connected_service_native_home_credential_path_unsafe');
      const file = await open(path, constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW));
      try {
        files[fileId] = await file.readFile();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return Object.freeze(files);
}

/**
 * Publishes producer-returned opaque credential bytes at their declared native-home paths.
 * The caller owns the already-private, lifecycle-scoped root and its exact cleanup.
 */
export async function materializeConnectedServiceNativeHomeCredentials(input: Readonly<{
  targetRoot: string;
  declaredSecretEntries: readonly string[];
  files: Readonly<Record<string, Uint8Array>>;
}>): Promise<void> {
  const targetRoot = resolve(input.targetRoot);
  const declaredEntries = declaredNativeHomeFiles(input);

  for (const [fileId, contents] of Object.entries(input.files)) {
    if (!declaredEntries.has(fileId) || !isCanonicalRelativeCredentialPath(fileId)) {
      throw new Error('connected_service_native_home_credential_file_undeclared');
    }
    const path = resolve(join(targetRoot, fileId));
    const relativePath = relative(targetRoot, path);
    if (
      relativePath.length === 0
      || relativePath.startsWith('..')
      || isAbsolute(relativePath)
    ) {
      throw new Error('connected_service_native_home_credential_path_unsafe');
    }
    await writeProtectedLocalStateFileAtomic(path, contents, { authority: 'owned' });
  }
}
