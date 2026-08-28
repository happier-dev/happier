import { isAbsolute, join, relative, resolve } from 'node:path';

import { writePrivateOwnerFile } from '@/daemon/privateBearerFile';

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
  const declaredEntries = new Set<string>();
  for (const entry of input.declaredSecretEntries) {
    if (!isCanonicalRelativeCredentialPath(entry) || declaredEntries.has(entry)) {
      throw new Error('connected_service_native_home_secret_entry_invalid');
    }
    declaredEntries.add(entry);
  }

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
    await writePrivateOwnerFile({ path, contents });
  }
}
