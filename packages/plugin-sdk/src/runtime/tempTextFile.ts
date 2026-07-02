import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export type SecureTempTextFileInputV1 = Readonly<{
  prefix: string;
  suffix?: string;
  contents: string;
  tmpDir?: string | null;
}>;

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

export function writeSecureTempTextFileSync(input: SecureTempTextFileInputV1): string {
  validatePathToken(input.prefix, 'prefix');
  if (input.suffix !== undefined && input.suffix !== '') {
    validatePathToken(input.suffix, 'suffix');
  }

  const baseDir = input.tmpDir ?? tmpdir();
  mkdirSync(baseDir, { recursive: true, mode: PRIVATE_DIR_MODE });

  const directory = mkdtempSync(join(baseDir, `${input.prefix}-`));
  bestEffortChmod(directory, PRIVATE_DIR_MODE);

  const path = join(directory, `payload${input.suffix ?? ''}`);
  writeFileSync(path, input.contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE, flag: 'wx' });
  bestEffortChmod(path, PRIVATE_FILE_MODE);
  return path;
}
