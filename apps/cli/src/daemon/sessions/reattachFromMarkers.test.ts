import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import { hashProcessCommand, listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';
import type { Credentials } from '@/persistence';

const emptyAdoptResult = {
  adopted: 0,
  eligible: 0,
} satisfies ReturnType<typeof adoptSessionsFromMarkers>;

const {
  isOwnedLiveDaemonSessionProcessCommandMock,
} = vi.hoisted(() => ({
  isOwnedLiveDaemonSessionProcessCommandMock: vi.fn(() => true),
}));

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
}));

vi.mock('../reattach', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../reattach')>();
  return {
    ...actual,
    adoptSessionsFromMarkers: vi.fn(() => emptyAdoptResult),
    isOwnedLiveDaemonSessionProcessCommand: isOwnedLiveDaemonSessionProcessCommandMock,
  };
});

vi.mock('../sessionRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../sessionRegistry')>();
  return {
    ...actual,
    listSessionMarkers: vi.fn(async () => []),
    removeSessionMarker: vi.fn(async () => {}),
    writeSessionMarker: vi.fn(async () => {}),
    hashProcessCommand: vi.fn((command: string) => `hash:${command}`),
  };
});

describe('reattachTrackedSessionsFromMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(true);
  });

  it('returns orphaned dead daemon sessions when removing dead markers', async () => {
    const marker = {
      pid: 43210,
      happySessionId: 'session-123',
      happyHomeDir: '/tmp/happy',
      createdAt: 1,
      updatedAt: 1,
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash: 'a'.repeat(64),
    };

    vi.mocked(listSessionMarkers).mockResolvedValue([marker as any]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([]);
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({
      orphanedDeadDaemonSessions: [
        {
          sessionId: 'session-123',
          pid: 43210,
        },
      ],
    });
    expect(removeSessionMarker).toHaveBeenCalledWith(43210);
    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith({
      markers: [],
      happyProcesses: [],
      pidToTrackedSession,
    });
  });

  it('recovers a markerless daemon-spawned session from the live process command and heals its marker', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({ orphanedDeadDaemonSessions: [] });
    expect(pidToTrackedSession.get(54321)).toMatchObject({
      pid: 54321,
      startedBy: 'daemon',
      happySessionId: 'session-123',
      vendorResumeId: 'vendor-1',
      spawnOptions: {
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        resume: 'vendor-1',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
      },
      processCommandHash:
        'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
    });
    expect(writeSessionMarker).toHaveBeenCalledWith(
      {
        pid: 54321,
        happySessionId: 'session-123',
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash:
          'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        processCommand:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          resume: 'vendor-1',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          },
        },
      },
    );
  });

  it('recovers a live daemon-spawned process when its live marker is missing process identity fields', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        vendorResumeId: 'vendor-1',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          resume: 'vendor-1',
        },
        reattachedFromDiskMarker: true,
        processCommand:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
        processCommandHash:
          'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      processCommand:
        '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        resume: 'vendor-1',
      },
    });
  });

  it('recovers a daemon session from a non-adopted hashed marker when takeover adoption returns zero', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 23456,
        happySessionId: 'session-hash-fallback',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        processCommandHash: 'a'.repeat(64),
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 23456,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier claude --happy-starting-mode remote --started-by daemon --existing-session session-hash-fallback',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(23456)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-hash-fallback',
        pid: 23456,
        reattachedFromDiskMarker: true,
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 23456,
        happySessionId: 'session-hash-fallback',
        startedBy: 'daemon',
      }),
    );
  });

  it('recovers a live daemon-spawned process from its marker when the live command lacks --existing-session', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        },
        reattachedFromDiskMarker: true,
        processCommand:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
        processCommandHash:
          'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      processCommand:
        'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      },
    });
  });

  it('recovers a live daemon marker from marker respawn data when the live process proves the session identity', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'opencode',
          },
        },
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'user-session',
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          approvedNewDirectoryCreation: true,
        },
        reattachedFromDiskMarker: true,
        processCommand:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
        processCommandHash:
          'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      processCommand:
        'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      respawn: {
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
      },
    });
  });

  it('does not recover a weak incomplete marker when the live process only classifies as a generic happy user session', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'backend',
            backendId: 'opencode',
            sourceKind: 'built_in',
          },
        },
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'user-session',
        command: 'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers a generic happy user session only when the live command proves the session identity and preserves encrypted respawn env', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(9) },
    };
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: {
            kind: 'builtInAgent',
            agentId: 'opencode',
          },
          sealedEnvironmentVariables: {
            format: 'account_scoped_v1',
            ciphertext: sealAccountScopedBlobCiphertext({
              kind: 'session_respawn_environment',
              material: credentials.encryption,
              payload: {
                CODEX_HOME: '/tmp/codex-home',
                OPENAI_API_KEY: 'sk-test',
              },
              randomBytes: (length) => new Uint8Array(length).fill(4),
            }),
          },
        },
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'user-session',
        command:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession, credentials });

    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
          environmentVariables: {
            CODEX_HOME: '/tmp/codex-home',
            OPENAI_API_KEY: 'sk-test',
          },
          approvedNewDirectoryCreation: true,
        },
        reattachedFromDiskMarker: true,
        processCommand:
          'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
        processCommandHash:
          'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith({
      pid: 12345,
      happySessionId: 'session-123',
      startedBy: 'daemon',
      cwd: '/tmp/project',
      processCommandHash:
        'hash:C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      processCommand:
        'C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\happier.exe C:\\hq\\windetachedfix-007\\happier-v0.2.4-windows-x64\\package-dist\\index.mjs opencode --happy-starting-mode remote --started-by daemon --existing-session session-123',
      respawn: expect.objectContaining({
        version: 1,
        directory: '/tmp/project',
        backendTarget: { kind: 'backend', backendId: 'opencode', sourceKind: 'built_in' },
        environmentVariables: {
          CODEX_HOME: '/tmp/codex-home',
        },
        sealedEnvironmentVariables: {
          format: 'account_scoped_v1',
          ciphertext: expect.any(String),
        },
      }),
    });
  });

  it('does not recover a live daemon-spawned process when a live marker failed marker adoption safety checks', async () => {
    const command = `${process.execPath} -e "setInterval(()=>{}, 1000)"`;

    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54322,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        processCommandHash: 'hash:/some/other/process',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      { pid: 54322, command, type: 'daemon-spawned-session' } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(result).toEqual({ orphanedDeadDaemonSessions: [] });
    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('does not recover a markerless daemon-spawned session when the live command belongs to a different cli runtime root', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/Users/other/happier/remote-dev/apps/cli/src/index.ts opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
  });

  it('recovers incomplete daemon markers during cli-update takeover even when the live command belongs to a different runtime root', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 54321,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 54321,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/Users/other/happier/cli-preview/current/package-dist/index.mjs claude --happy-starting-mode remote --started-by daemon',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(54321)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 54321,
        reattachedFromDiskMarker: true,
      }),
    );
    expect(writeSessionMarker).toHaveBeenCalledWith(
      expect.objectContaining({
        pid: 54321,
        happySessionId: 'session-123',
        startedBy: 'daemon',
      }),
    );
  });

  it('recovers incomplete daemon markers during takeover when the live command degrades to a bare runtime command', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 76543,
        happySessionId: 'session-789',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
        respawn: {
          version: 1,
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        },
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 76543,
        type: 'user-session',
        cwd: '/tmp/project',
        command: 'node',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(76543)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-789',
        pid: 76543,
        reattachedFromDiskMarker: true,
      }),
    );
  });

  it('recovers incomplete daemon markers when process classification falls back to user-session but command still declares --started-by daemon', async () => {
    isOwnedLiveDaemonSessionProcessCommandMock.mockReturnValue(false);
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 65432,
        happySessionId: 'session-456',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        cwd: '/tmp/project',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 65432,
        type: 'user-session',
        cwd: '/tmp/project',
        command:
          'node "/Users/other/happier/cli-preview/current/package-dist/index.mjs" claude "--happy-starting-mode" "remote" "--started-by" "daemon"',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(65432)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-456',
        pid: 65432,
        reattachedFromDiskMarker: true,
      }),
    );
  });
});
