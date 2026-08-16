import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SharedManagedOpenCodeServerState } from './sharedManagedServer';

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
  };
});

describe('managed OpenCode Windows activation proof', () => {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

  beforeEach(() => {
    vi.resetModules();
    execFileSyncMock.mockReset();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', { ...originalPlatformDescriptor, value: 'win32' });
    }
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('binds a valid plugin handshake to the cmd.exe listener generation with a nonempty command hash', async () => {
    const spawnPid = 43_111;
    const listenerPid = 48_123;
    const baseUrl = 'http://127.0.0.1:43111';
    const commandLine = '"C:\\tools\\opencode.exe" serve --hostname=127.0.0.1 --port=43111';
    const processInstanceFingerprint = 'win32-cim:2026-08-14T10:00:00.0000000Z';

    execFileSyncMock.mockImplementation((command: string, args: readonly string[]) => {
      if (command === 'netstat') {
        return `  TCP    127.0.0.1:43111    0.0.0.0:0    LISTENING    ${listenerPid}`;
      }
      if (command !== 'powershell.exe') {
        throw new Error(`Unexpected command: ${command}`);
      }
      const script = args.at(-1) ?? '';
      if (script.includes('ParentProcessId')) {
        // PowerShell variable names are case-insensitive and $PID is read-only. Reintroducing the
        // old `$pid` ancestry cursor must reproduce the real Windows failure instead of allowing
        // this fixture to paper over it.
        if (/\$pid\b/i.test(script)) {
          throw new Error('SessionStateUnauthorizedAccessException: Cannot overwrite variable PID because it is read-only or constant.');
        }
        return JSON.stringify([
          { ProcessId: listenerPid, ParentProcessId: 47_000 },
          { ProcessId: 47_000, ParentProcessId: spawnPid },
        ]);
      }
      if (script.includes('CommandLine')) {
        return JSON.stringify({
          ProcessId: listenerPid,
          Name: 'opencode.exe',
          CommandLine: commandLine,
        });
      }
      throw new Error(`Unexpected PowerShell script: ${script}`);
    });

    const { resolveOpenCodeManagedServerTrackedPid } = await import('./resolveOpenCodeManagedServerTrackedPid');
    const trackedPid = await resolveOpenCodeManagedServerTrackedPid({
      spawnPid,
      baseUrl,
      invocationCommand: 'C:\\Windows\\System32\\cmd.exe',
    });
    expect(trackedPid).toBe(listenerPid);

    const { getOpenCodeServerProcessInfoBestEffort } = await import('./openCodeServerProcessState');
    const processInfo = await getOpenCodeServerProcessInfoBestEffort(trackedPid);
    expect(processInfo).toEqual({
      name: 'opencode.exe',
      cmd: commandLine,
    });

    const expectedCmdlineHash = createHash('sha256').update(commandLine).digest('hex');
    expect(expectedCmdlineHash).toMatch(/^[a-f0-9]{64}$/);

    const loadNonce = 'windows-managed-child-nonce';
    const selectionIdentity = 'opencode|connected|broker:1|openai-codex:work:';
    let persistedState: SharedManagedOpenCodeServerState = {
      v: 2,
      baseUrl,
      pid: trackedPid,
      startedAtMs: 1_000,
      status: 'ready',
      launchEnvFingerprint: 'windows-launch-fingerprint',
      ownerToken: 'windows-managed-child-owner',
      processInstanceFingerprint,
      expectedCmdlineHash,
      activeServerDir: 'C:\\happier\\servers\\cloud',
      daemonInstanceId: 'daemon-windows',
      brokerLoadNonce: loadNonce,
    };

    const { persistManagedOpenCodeBrokerActivationProof } = await import('./sharedManagedServer');
    const persisted = await persistManagedOpenCodeBrokerActivationProof({
      runtimeKind: 'opencode_managed_server',
      selectionIdentity,
      loadNonce,
      providers: ['openai'],
      pluginVersion: '1',
      processPid: trackedPid,
      observedAtMs: 2_000,
    }, {
      listStateKeys: async () => ['managed-child'],
      withStateLock: async <T>(_stateKey: string, fn: () => Promise<T>) => await fn(),
      readState: async () => persistedState,
      writeState: async (_stateKey, state) => {
        persistedState = state;
      },
      isPidAlive: () => true,
      getProcessInfo: async (pid) => await getOpenCodeServerProcessInfoBestEffort(pid),
      readProcessStartTimeMs: async () => null,
      readProcessInstanceFingerprint: async () => processInstanceFingerprint,
      currentActiveServerDir: 'C:\\happier\\servers\\cloud',
      isCurrentBrokerStateUsable: async () => true,
    });

    expect(persisted).toBe(true);
    expect(persistedState.expectedCmdlineHash).toBe(expectedCmdlineHash);
    expect(persistedState.brokerActivationProof).toEqual(expect.objectContaining({
      processPid: listenerPid,
      loadNonce,
      providers: ['openai'],
      pluginVersion: '1',
    }));
  });
});
