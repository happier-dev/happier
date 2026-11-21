import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  applyUpdaterAdmissionPathArg,
  readUpdaterAdmission,
  reportUpdaterAdmission,
  UPDATER_ADMISSION_FD_ENV,
  UPDATER_ADMISSION_PATH_ENV,
} from './updaterAdmission';

describe('updater admission report', () => {
  it('writes exactly one line to the named descriptor, then never again', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-admission-'));
    try {
      const path = join(dir, 'fd3');
      const env: NodeJS.ProcessEnv = { [UPDATER_ADMISSION_FD_ENV]: String(openSync(path, 'w')) };
      reportUpdaterAdmission({ admitted: false, code: 'cli_update_in_progress', message: 'busy' }, env);
      reportUpdaterAdmission({ admitted: true }, env);
      expect(readFileSync(path, 'utf8')).toBe('{"admitted":false,"code":"cli_update_in_progress","message":"busy"}\n');
      expect(env[UPDATER_ADMISSION_FD_ENV]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the same one line to the admission file a scheduled task can leave behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'happier-admission-file-'));
    try {
      const path = join(dir, 'nested', 'admission.json');
      const env: NodeJS.ProcessEnv = { [UPDATER_ADMISSION_PATH_ENV]: path };
      const argv = applyUpdaterAdmissionPathArg(['self', 'update', '--preview', '--admission-path', path], env);
      expect(argv).toEqual(['self', 'update', '--preview']);
      reportUpdaterAdmission({ admitted: true }, env);
      reportUpdaterAdmission({ admitted: false, code: 'cli_update_failed', message: 'late' }, env);
      expect(readFileSync(path, 'utf8')).toBe('{"admitted":true}\n');
      expect(env[UPDATER_ADMISSION_PATH_ENV]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads the report, or null when the updater ended without one', async () => {
    const admitted = new PassThrough();
    const reading = readUpdaterAdmission(admitted);
    admitted.write('{"admitted":tr');
    admitted.write('ue}\n');
    await expect(reading).resolves.toEqual({ admitted: true });

    const crashed = new PassThrough();
    const readingCrashed = readUpdaterAdmission(crashed);
    crashed.end();
    await expect(readingCrashed).resolves.toBeNull();
  });
});
