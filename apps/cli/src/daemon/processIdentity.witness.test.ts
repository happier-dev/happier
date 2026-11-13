import { describe, expect, it } from 'vitest';
import type { ProcessCensusRow, ProcessCensusSnapshot } from '@/processes/census/processCensus';
import { captureProcessBirthWitness, inspectProcessBirthWitness, parseProcessGenerationWitness } from './processIdentity';

describe('process generation witness boundary', () => {
  it('projects the numeric birth witness from an observed process record', () => {
    expect(parseProcessGenerationWitness({ pid: 42, processStartTimeMs: 0, processCommand: 'existing record' }))
      .toEqual({ pid: 42, processStartTimeMs: 0 });
  });

  it.each([
    null, [], {}, { pid: 42 }, { pid: '42', processStartTimeMs: 1 },
    { pid: 0, processStartTimeMs: 1 }, { pid: -1, processStartTimeMs: 1 },
    { pid: 1.5, processStartTimeMs: 1 }, { pid: Number.MAX_SAFE_INTEGER + 1, processStartTimeMs: 1 },
    { pid: 42, processStartTimeMs: -1 }, { pid: 42, processStartTimeMs: '1' },
    { pid: 42, processStartTimeMs: 1.5 },
  ])('refuses an incomplete or non-integral generation witness: %j', value => {
    expect(parseProcessGenerationWitness(value)).toBeNull();
  });
});

function nativeCensus(rows: readonly ProcessCensusRow[], partial?: Extract<ProcessCensusSnapshot, { status: 'ok' }>['partial']): string {
  const self: ProcessCensusRow = { pid: process.pid, ppid: 1, start: { startTimeMs: 1 },
    principal: { kind: 'uid', value: '1000' }, name: 'daemon', memory: null, cpuTimeUs: null };
  return JSON.stringify({ v: 1, capturedAtMs: 1000, logicalCpus: 1, rows: [self, ...rows],
    ...(partial ? { partial } : {}) });
}

function nativeRow(start: ProcessCensusRow['start']): ProcessCensusRow {
  return { pid: 42, ppid: 1, start, principal: { kind: 'uid', value: '1000' }, name: 'service',
    memory: null, cpuTimeUs: null, state: 'sleeping' };
}

describe('native process birth witness', () => {
  it.each([
    { platform: 'darwin' as const, start: { startTimeMs: 1754041400000, native: 'darwin-proc:42:1754041400:123456' } },
    { platform: 'win32' as const, start: { startTimeMs: 1754041400123 } },
  ])('captures and verifies the native $platform birth without command or custody identity', async ({ platform, start }) => {
    let observations = 0;
    const dependencies = { platform, helperExecutablePath: '/helper', execFile: async () => {
      observations++;
      return { stdout: nativeCensus([nativeRow(start)]) };
    } };
    const witness = await captureProcessBirthWitness(42, dependencies);
    expect(witness).toEqual({ pid: 42, start });
    expect(observations).toBe(1);
    if (!witness) throw new Error('capture did not return the observed birth');
    await expect(inspectProcessBirthWitness(witness, dependencies)).resolves.toEqual({ status: 'same', witness });
    expect(observations).toBe(2);
  });

  it('detects Darwin same-second PID reuse from native birth evidence', async () => {
    await expect(inspectProcessBirthWitness({ pid: 42,
      start: { startTimeMs: 1754041400000, native: 'darwin-proc:42:1754041400:123456' } }, {
      platform: 'darwin', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: nativeCensus([nativeRow({ startTimeMs: 1754041400000,
        native: 'darwin-proc:42:1754041400:654321' })]) }),
    })).resolves.toEqual({ status: 'reused' });
  });

  it('keeps missing native evidence unknown instead of accepting a lower precision match', async () => {
    await expect(inspectProcessBirthWitness({ pid: 42,
      start: { startTimeMs: 1754041400000, native: 'darwin-proc:42:1754041400:123456' } }, {
      platform: 'darwin', helperExecutablePath: '/helper',
      execFile: async () => ({ stdout: nativeCensus([nativeRow({ startTimeMs: 1754041400000 })]) }),
    })).resolves.toEqual({ status: 'unknown', reason: 'native_birth_missing' });
  });

  it('settles confirmed absence and zombies while preserving denied observation as unknown', async () => {
    const witness = { pid: 42, start: { startTimeMs: 123 } };
    for (const [rows, partial, status] of [
      [[], undefined, 'absent'],
      [[{ ...nativeRow(witness.start), state: 'zombie' as const }], undefined, 'absent'],
      [[], [{ pid: 42, missing: ['start'] }], 'unknown'],
    ] as const) {
      await expect(inspectProcessBirthWitness(witness, { platform: 'win32', helperExecutablePath: '/helper',
        execFile: async () => ({ stdout: nativeCensus(rows, partial) }),
      })).resolves.toEqual(status === 'unknown' ? { status, reason: 'birth_unreadable' } : { status });
    }
    await expect(inspectProcessBirthWitness(witness, { platform: 'win32', helperExecutablePath: '/helper',
      execFile: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    })).resolves.toEqual({ status: 'unknown', reason: 'read_failed' });
  });

  it('captures Linux boot-relative native ticks through the real procfs census reader', async () => {
    const witness = await captureProcessBirthWitness(42, { platform: 'linux', linuxBoundary: {
      readFile: async path => path.endsWith('/stat')
        ? '42 (service) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 12345 22'
        : 'Uid: 1000 1000 1000 1000',
      readdir: async () => [], readlink: async () => '/repo',
    } });
    expect(witness).toEqual({ pid: 42, start: { startTimeMs: 190, native: 'linux-proc:19' } });
  });
});
