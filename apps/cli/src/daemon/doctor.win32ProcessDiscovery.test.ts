import { ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { censusOutput, execFileMock } = vi.hoisted(() => ({
  censusOutput: { value: '' },
  execFileMock: vi.fn(),
}));

// Native executable presence and process output are genuine OS boundaries.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: (path: string) => path.endsWith('happier-process-custody.exe') || actual.existsSync(path) };
});
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  execFile: execFileMock,
}));

describe('doctor Windows census discovery', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const executable = String.raw`C:\Program Files\Happier\happier.exe`;
  const entrypoint = String.raw`C:\Program Files\Happier\package-dist\index.mjs`;
  const command = `"${executable}" "${entrypoint}" codex --started-by daemon`;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = new ChildProcess();
      queueMicrotask(() => {
        Object.defineProperty(child, 'exitCode', { value: 0 });
        child.emit('exit', 0, null);
        callback(null, censusOutput.value, '');
        child.emit('close', 0, null);
      });
      return child;
    });
    censusOutput.value = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [
      { pid: process.pid, ppid: 1, name: 'node.exe', start: { startTimeMs: 1000 }, principal: { kind: 'sid', value: 'S-1-5-21-1' }, memory: null, cpuTimeUs: null },
      { pid: 26316, ppid: 17692, name: 'MainThread', commandLine: command,
        argv: [executable, entrypoint, 'codex', '--started-by', 'daemon'],
        start: { startTimeMs: 2000 }, principal: { kind: 'sid', value: 'S-1-5-21-1' }, memory: { bytes: 1024, kind: 'private' }, cpuTimeUs: 500 },
    ] });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    execFileMock.mockReset();
  });

  it('recognizes a packaged session from the native command and preserves exact command bytes', async () => {
    const { findHappyProcessByPid } = await import('./doctor');
    await expect(findHappyProcessByPid(26316)).resolves.toEqual({
      pid: 26316, command, type: 'daemon-spawned-session',
    });
  });

  it('does not reinterpret unavailable native facts as an unrelated process', async () => {
    censusOutput.value = 'truncated-json';
    const { classifyProcessByPid } = await import('./doctor');
    await expect(classifyProcessByPid(26316)).resolves.toEqual({ kind: 'unknown' });
  });

  it('keeps an empty command during an exec transition unknown', async () => {
    const envelope = JSON.parse(censusOutput.value) as { rows: Array<{ pid: number; name: string; argv?: string[]; commandLine?: string }> };
    const row = envelope.rows.find(row => row.pid === 26316)!;
    row.name = 'node.exe';
    row.argv = [];
    delete row.commandLine;
    censusOutput.value = JSON.stringify(envelope);
    const { classifyProcessByPid } = await import('./doctor');
    await expect(classifyProcessByPid(26316)).resolves.toEqual({ kind: 'unknown' });
  });

  it('admits an independent updater whose Windows service ancestors belong to another principal', async () => {
    // Native WSL ancestry: caller -> wslhost -> wslservice -> services -> wininit.
    // The census intentionally omits foreign-principal command lines.
    const own = { kind: 'sid', value: 'S-1-5-21-1' };
    const system = { kind: 'sid', value: 'S-1-5-18' };
    censusOutput.value = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [
      { pid: process.pid, ppid: 22068, name: 'node.exe', argv: ['node.exe'], start: { startTimeMs: 6000 }, principal: own, memory: null, cpuTimeUs: null },
      { pid: 22068, ppid: 12552, name: 'wslhost.exe', argv: ['wslhost.exe'], start: { startTimeMs: 5000 }, principal: own, memory: null, cpuTimeUs: null },
      { pid: 12552, ppid: 1808, name: 'wslservice.exe', start: { startTimeMs: 4000 }, principal: system, memory: null, cpuTimeUs: null },
      { pid: 1808, ppid: 1672, name: 'services.exe', start: { startTimeMs: 3000 }, principal: system, memory: null, cpuTimeUs: null },
      { pid: 1672, ppid: 1180, name: 'wininit.exe', start: { startTimeMs: 2000 }, principal: system, memory: null, cpuTimeUs: null },
    ] });
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).resolves.toBeUndefined();
  });

  it.each(['managed-daemon-above-foreign', 'unreadable-own-command'] as const)('refuses update admission for %s ancestry', async (kind) => {
    const own = { kind: 'sid', value: 'S-1-5-21-1' };
    const foreign = { kind: 'sid', value: 'S-1-5-18' };
    censusOutput.value = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [
      { pid: process.pid, ppid: 22067, name: 'node.exe', argv: ['node.exe'], start: { startTimeMs: 7000 }, principal: own, memory: null, cpuTimeUs: null },
      { pid: 22067, ppid: 22068, name: 'service.exe', start: { startTimeMs: 6000 }, principal: foreign, memory: null, cpuTimeUs: null },
      { pid: 22068, ppid: 1, name: 'happier.exe', start: { startTimeMs: 5000 }, principal: own, memory: null, cpuTimeUs: null,
        ...(kind === 'managed-daemon-above-foreign' ? { commandLine: 'happier.exe daemon start-sync', argv: ['happier.exe', 'daemon', 'start-sync'] } : {}) },
    ] });
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).rejects.toThrow(
      kind === 'managed-daemon-above-foreign' ? /inside a Happier daemon/ : /Cannot verify Windows update process ancestry/,
    );
  });

  it.each(['happier.exe', 'node.exe', 'bun.exe'])('refuses an unreadable foreign %s ancestor that could host a service daemon', async (name) => {
    censusOutput.value = JSON.stringify({ v: 1, capturedAtMs: Date.now(), logicalCpus: 4, rows: [
      { pid: process.pid, ppid: 22068, name: 'node.exe', argv: ['node.exe'], start: { startTimeMs: 6000 }, principal: { kind: 'sid', value: 'self' }, memory: null, cpuTimeUs: null },
      { pid: 22068, ppid: 1, name, start: { startTimeMs: 5000 }, principal: { kind: 'sid', value: 'system' }, memory: null, cpuTimeUs: null },
    ] });
    const { assertWindowsCliUpdateIsOutsideManagedProcessTree } = await import('@/cli/runtime/update/quiesceInstalledCliWindowsPayloadOwners');
    await expect(assertWindowsCliUpdateIsOutsideManagedProcessTree()).rejects.toThrow(/Cannot verify Windows update process ancestry/);
  });
});
