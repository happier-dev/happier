import { mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { readUpdaterAdmission, reportUpdaterAdmission, UPDATER_ADMISSION_FD_ENV } from './updaterAdmission';

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
