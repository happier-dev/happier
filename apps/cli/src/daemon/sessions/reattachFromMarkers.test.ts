import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { reattachTrackedSessionsFromMarkers } from './reattachFromMarkers';
import { findAllHappyProcesses } from '../doctor';
import { adoptSessionsFromMarkers } from '../reattach';
import { hashProcessCommand, listSessionMarkers, removeSessionMarker, writeSessionMarker } from '../sessionRegistry';
import type { HappyProcessInfo } from '../doctor';
import type { TrackedSession } from '../types';
import type { Credentials } from '@/persistence';

const emptyAdoptResult = {
  adopted: 0,
  eligible: 0,
  adoptedPids: [],
  respawnRestoreErrors: [],
} satisfies ReturnType<typeof adoptSessionsFromMarkers>;

const { isOwnedLiveDaemonSessionProcessCommandMock } = vi.hoisted(() => ({
  isOwnedLiveDaemonSessionProcessCommandMock: vi.fn(() => true),
}));

vi.mock('../doctor', () => ({
  findAllHappyProcesses: vi.fn(async () => []),
}));

vi.mock('../reattach', () => ({
  adoptSessionsFromMarkers: vi.fn(() => emptyAdoptResult),
  isOwnedLiveDaemonSessionProcessCommand: isOwnedLiveDaemonSessionProcessCommandMock,
}));

vi.mock('../sessionRegistry', () => ({
  listSessionMarkers: vi.fn(async () => []),
  removeSessionMarker: vi.fn(async () => {}),
  writeSessionMarker: vi.fn(async () => {}),
  hashProcessCommand: vi.fn((command: string) => `hash:${command}`),
}));

describe('reattachTrackedSessionsFromMarkers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED;
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
        pid: 12345,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(adoptSessionsFromMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        markers: [],
        happyProcesses: [
          {
            pid: 12345,
            type: 'daemon-spawned-session',
            cwd: '/tmp/project',
            environmentVariables: {
              CLAUDE_CONFIG_DIR: '/tmp/claude-config',
            },
            command:
              '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
          },
        ],
        pidToTrackedSession,
      }),
    );
    expect(pidToTrackedSession.get(12345)).toEqual(
      expect.objectContaining({
        startedBy: 'daemon',
        happySessionId: 'session-123',
        pid: 12345,
        vendorResumeId: 'vendor-1',
        spawnOptions: {
          directory: '/tmp/project',
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
          resume: 'vendor-1',
          environmentVariables: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          },
        },
        reattachedFromDiskMarker: true,
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
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        resume: 'vendor-1',
        environmentVariables: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
      },
    });
  });

  it('skips markerless daemon-spawned session recovery when disabled by environment', async () => {
    process.env.HAPPIER_DAEMON_MARKERLESS_REATTACH_ENABLED = '0';
    const markerlessDaemonSessionProcess = {
      pid: 12345,
      type: 'daemon-spawned-session',
      cwd: '/tmp/project',
      command:
        '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
    } satisfies HappyProcessInfo;

    vi.mocked(listSessionMarkers).mockResolvedValue([]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([markerlessDaemonSessionProcess]);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const pidToTrackedSession = new Map<number, TrackedSession>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.size).toBe(0);
    expect(writeSessionMarker).not.toHaveBeenCalled();
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
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
        resume: 'vendor-1',
      },
    });
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
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
          backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
        backendTarget: { kind: 'builtInAgent', agentId: 'opencode' },
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
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 12345,
        happySessionId: 'session-123',
        happyHomeDir: '/tmp/happy',
        createdAt: 1,
        updatedAt: 1,
        startedBy: 'daemon',
        processCommandHash: 'hash:/some/other/process',
      } as any,
    ]);
    vi.mocked(findAllHappyProcesses).mockResolvedValue([
      {
        pid: 12345,
        type: 'daemon-spawned-session',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation(() => true as any);
    vi.mocked(adoptSessionsFromMarkers).mockReturnValue(emptyAdoptResult);

    const pidToTrackedSession = new Map<number, any>();
    await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

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

  it('does not report an orphaned dead daemon session when the same happy session was recovered live during startup', async () => {
    vi.mocked(listSessionMarkers).mockResolvedValue([
      {
        pid: 11111,
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
        pid: 22222,
        type: 'daemon-spawned-session',
        cwd: '/tmp/project',
        command:
          '/home/guest/.happier/cli-preview/current/happier opencode --happy-starting-mode remote --started-by daemon --resume vendor-1 --existing-session session-123',
      } as any,
    ]);
    vi.spyOn(process, 'kill').mockImplementation((pid: number) => {
      if (pid === 11111) {
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      }
      return true as any;
    });

    const pidToTrackedSession = new Map<number, any>();
    const result = await reattachTrackedSessionsFromMarkers({ pidToTrackedSession });

    expect(pidToTrackedSession.get(22222)).toEqual(expect.objectContaining({
      happySessionId: 'session-123',
      pid: 22222,
    }));
    expect(result).toEqual({
      orphanedDeadDaemonSessions: [],
    });
  });
});
