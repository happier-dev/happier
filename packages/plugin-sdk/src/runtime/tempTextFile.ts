/** @moduleRealm daemon */
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createWindowsProtectedAclBoundarySync,
  type WindowsProtectedAclBoundarySync,
} from '@happier-dev/cli-common/fs/windowsProtectedAcl';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type SecureTempTextFileInputV1 = Readonly<{
  prefix: string;
  suffix?: string;
  contents: string;
  tmpDir?: string | null;
}>;

type SecureTempTextFileDeps = Readonly<{
  platform?: NodeJS.Platform;
  windowsAclBoundary?: WindowsProtectedAclBoundarySync;
}>;

let defaultWindowsAclBoundary: WindowsProtectedAclBoundarySync | null = null;

function validatePathToken(value: string, field: 'prefix' | 'suffix'): void {
  if (!value || value === '.' || value === '..' || value.includes('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Invalid temporary file ${field}`);
  }
}

function bestEffortChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // Some platforms/filesystems do not fully support POSIX modes.
  }
}

export function writeSecureTempTextFileSyncWithDeps(
  input: SecureTempTextFileInputV1,
  deps: SecureTempTextFileDeps = {},
): string {
  validatePathToken(input.prefix, 'prefix');
  if (input.suffix !== undefined && input.suffix !== '') {
    validatePathToken(input.suffix, 'suffix');
  }

  const baseDir = input.tmpDir ?? tmpdir();
  mkdirSync(baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  const directory = mkdtempSync(join(baseDir, `${input.prefix}-`));
  const platform = deps.platform ?? process.platform;
  const path = join(directory, `payload${input.suffix ?? ''}`);

  if (platform !== 'win32') {
    bestEffortChmod(directory, PRIVATE_DIR_MODE);
    writeFileSync(path, input.contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
    bestEffortChmod(path, PRIVATE_FILE_MODE);
    return path;
  }

  const windowsAclBoundary = deps.windowsAclBoundary
    ?? (defaultWindowsAclBoundary ??= createWindowsProtectedAclBoundarySync());
  let fileDescriptor: number | null = null;
  try {
    windowsAclBoundary.applyAndVerify({ path: directory, kind: 'directory' });
    fileDescriptor = openSync(path, 'wx', PRIVATE_FILE_MODE);
    // Apply and verify the restrictive DACL while the file is still empty.
    windowsAclBoundary.applyAndVerify({ path, kind: 'file' });
    writeFileSync(fileDescriptor, input.contents, { encoding: 'utf8' });
    fsyncSync(fileDescriptor);
    closeSync(fileDescriptor);
    fileDescriptor = null;
    windowsAclBoundary.verify({ path, kind: 'file' });
    return path;
  } catch (error) {
    if (fileDescriptor !== null) {
      try {
        closeSync(fileDescriptor);
      } catch {
        // Preserve the original ACL/write failure.
      }
    }
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function writeSecureTempTextFileSync(input: SecureTempTextFileInputV1): string {
  return writeSecureTempTextFileSyncWithDeps(input);
}
