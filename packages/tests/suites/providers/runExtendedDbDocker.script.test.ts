import { describe, expect, it } from 'vitest';

import { parseArgs, resolveExtendedDbCommandTimeoutMs, resolveExtendedDbStepTimeoutMs } from '../../scripts/run-extended-db-docker.mjs';

describe('extended-db docker script args', () => {
  it('parses valid args', () => {
    const parsed = parseArgs([
      'node',
      'run-extended-db-docker.mjs',
      '--db',
      'postgres',
      '--mode',
      'contract',
      '--name',
      'db-test',
      '--keep',
    ]);

    expect(parsed).toEqual({
      mode: 'contract',
      keep: true,
      db: 'postgres',
      name: 'db-test',
    });
  });

  it('rejects unknown args', () => {
    expect(() => parseArgs(['node', 'run-extended-db-docker.mjs', '--db', 'postgres', '--invalid'])).toThrow(
      /Unknown arg/,
    );
  });
});

describe('extended-db docker script timeouts', () => {
  it('uses a generous default step timeout (overrideable by env)', () => {
    expect(resolveExtendedDbStepTimeoutMs({} as unknown as NodeJS.ProcessEnv)).toBe(3_600_000);
    expect(
      resolveExtendedDbStepTimeoutMs({ HAPPIER_E2E_EXTENDED_DB_STEP_TIMEOUT_MS: '120000' } as unknown as NodeJS.ProcessEnv),
    ).toBe(120_000);
  });

  it('uses fallback for missing/invalid values', () => {
    expect(resolveExtendedDbCommandTimeoutMs(undefined, 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('0', 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('-1', 55_000)).toBe(55_000);
    expect(resolveExtendedDbCommandTimeoutMs('abc', 55_000)).toBe(55_000);
  });

  it('parses values and clamps minimum', () => {
    expect(resolveExtendedDbCommandTimeoutMs('120000', 55_000)).toBe(120_000);
    expect(resolveExtendedDbCommandTimeoutMs('500', 55_000)).toBe(5_000);
  });
});
