import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials, Settings } from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

import { handleAttachCommand } from './attach';

describe('happier attach', () => {
  const localSettings = { machineId: 'machine-local' } as Settings;
  const previousManagedServerStatePath = process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as any);

  beforeEach(() => {
    exitSpy.mockClear();
  });

  afterEach(() => {
    if (previousManagedServerStatePath === undefined) {
      delete process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH;
    } else {
      process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = previousManagedServerStatePath;
    }
    vi.unstubAllGlobals();
  });

  it('rejects explicit tmux attach for sessions from another machine', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rawSession = createSessionRecordFixture({
      id: 'sid_remote_tmux_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-remote',
        path: '/tmp/claude-workspace',
        flavor: 'claude',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:session-1',
          },
        },
      }),
    });

    await expect((handleAttachCommand as any)(['sid_remote_tmux_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => null,
      runProviderAttachFn: vi.fn(async () => false),
      runTmuxAttachFn: vi.fn(async () => 0),
    })).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(expect.anything(), 'Session belongs to another machine and cannot be attached from this computer.');
    errorSpy.mockRestore();
  });

  it('allows explicit remote provider attach when machine ownership is missing', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_missing_machine_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        path: '/tmp/opencode-workspace',
        host: 'test',
        flavor: 'opencode',
        opencodeSessionId: 'vendor-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });
    const runProviderAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_opencode_missing_machine_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => null,
      runProviderAttachFn,
      runTmuxAttachFn: vi.fn(async () => 0),
    });

    expect(runProviderAttachFn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      sessionId: 'sid_opencode_missing_machine_1',
    }));
  });

  it('allows explicit local OpenCode attach after machine id drift when a local attachment marker exists', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'happier-opencode-attach-command-'));
    process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH = join(stateDir, 'managed-server.json');
    await writeFile(process.env.HAPPIER_OPENCODE_SERVER_STATE_PATH, JSON.stringify({
      baseUrl: 'http://127.0.0.1:4096/',
      pid: 12345,
      startedAtMs: Date.now(),
      status: 'ready',
    }));

    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_local_marker_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-before-reauth',
        path: '/tmp/opencode-workspace',
        host: 'test',
        flavor: 'opencode',
        opencodeSessionId: 'vendor-session-1',
        opencodeBackendMode: 'server',
      }),
    });
    const runProviderAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_opencode_local_marker_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-after-reauth' } as Settings),
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'sid_opencode_local_marker_1',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:opencode-1' },
        },
        updatedAt: Date.now(),
      }),
      runProviderAttachFn,
      runTmuxAttachFn: vi.fn(async () => 0),
    });

    expect(runProviderAttachFn).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'opencode',
      sessionId: 'sid_opencode_local_marker_1',
    }));
  });

  it('shows local rows plus probeable remote provider rows in interactive attach', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const fetchSessionsPageFn = vi.fn(async () => ({
      sessions: [
        createSessionRecordFixture({
          id: 'sid_attachable_1',
          active: true,
          updatedAt: 20,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            machineId: 'machine-local',
            flavor: 'claude',
            tag: 'repo-a',
            path: '/tmp/repo-a',
            terminal: {
              mode: 'tmux',
              requested: 'tmux',
              tmux: { target: 'happy:attachable-1' },
            },
          }),
        }),
        createSessionRecordFixture({
          id: 'sid_not_attachable_1',
          active: true,
          updatedAt: 10,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            machineId: 'machine-local',
            flavor: 'codex',
            tag: 'repo-b',
            path: '/tmp/repo-b',
            terminal: {
              mode: 'plain',
              requested: 'tmux',
            },
          }),
        }),
        createSessionRecordFixture({
          id: 'sid_remote_tmux_1',
          active: true,
          updatedAt: 30,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            machineId: 'machine-remote',
            flavor: 'claude',
            path: '/tmp/remote',
            terminal: {
              mode: 'tmux',
              requested: 'tmux',
              tmux: { target: 'happy:remote-1' },
            },
          }),
        }),
        createSessionRecordFixture({
          id: 'sid_remote_opencode_1',
          active: true,
          updatedAt: 35,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            machineId: 'machine-remote',
            flavor: 'opencode',
            tag: 'remote-server',
            path: '/srv/opencode',
            opencodeSessionId: 'remote-opencode-session-1',
            opencodeBackendMode: 'server',
            opencodeServerBaseUrl: 'https://remote.example.test/',
            opencodeServerBaseUrlExplicit: true,
          }),
        }),
        createSessionRecordFixture({
          id: 'sid_inactive_1',
          active: false,
          updatedAt: 40,
          encryptionMode: 'plain',
          metadata: JSON.stringify({
            machineId: 'machine-local',
            flavor: 'claude',
            path: '/tmp/inactive',
            terminal: {
              mode: 'tmux',
              requested: 'tmux',
              tmux: { target: 'happy:inactive-1' },
            },
          }),
        }),
      ],
      nextCursor: null,
      hasNext: false,
    }));
    const selectAttachableSessionIdFn = vi.fn(async ({
      rows,
      probeSessionIdFn,
    }: {
      rows: Array<Record<string, unknown>>;
      probeSessionIdFn?: (sessionId: string) => Promise<{ reachable: boolean; reason?: string }>;
    }) => {
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        sessionId: 'sid_attachable_1',
        disabled: false,
      });
      expect(rows[1]).toMatchObject({
        sessionId: 'sid_remote_opencode_1',
        disabled: true,
        annotation: 'remote',
        disabledReason: 'Press P to check remote reachability.',
        probeable: true,
      });
      expect(rows[2]).toMatchObject({
        sessionId: 'sid_not_attachable_1',
        disabled: true,
      });
      expect(String(rows[2].disabledReason)).toMatch(/outside tmux|not started in tmux/i);

      await expect(probeSessionIdFn?.('sid_remote_opencode_1')).resolves.toMatchObject({
        reachable: true,
      });

      return { type: 'selected', sessionId: 'sid_attachable_1' };
    });
    const runTmuxAttachFn = vi.fn(async () => 0);
    const runProviderAttachFn = vi.fn(async () => 0);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

    await (handleAttachCommand as any)([], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async (): Promise<Settings> => ({ machineId: 'machine-local' } as Settings),
      fetchSessionsPageFn,
      fetchSessionByIdFn: async ({ sessionId }: { sessionId: string }) => {
        const page = await fetchSessionsPageFn();
        return page.sessions.find((row: { id: string }) => row.id === sessionId) ?? null;
      },
      canUseInkSelectorFn: () => true,
      selectAttachableSessionIdFn,
      readTerminalAttachmentInfoFn: async ({ sessionId }: { sessionId: string }) => sessionId === 'sid_attachable_1'
        ? {
            version: 1,
            sessionId,
            updatedAt: Date.now(),
            terminal: {
              mode: 'tmux',
              requested: 'tmux',
              tmux: { target: 'happy:attachable-1' },
            },
          }
        : null,
      runProviderAttachFn,
      runTmuxAttachFn,
    });

    expect(runTmuxAttachFn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'sid_attachable_1' }));
    expect(runProviderAttachFn).not.toHaveBeenCalled();
  });

  it('dispatches provider-native attach for provider-attach local-control sessions', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: '/tmp/opencode-workspace',
        host: 'test',
        flavor: 'opencode',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });
    const runProviderAttachFn = vi.fn(async () => 0);
    const runTmuxAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_opencode_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      runProviderAttachFn,
      runTmuxAttachFn,
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    });

    expect(runProviderAttachFn).toHaveBeenCalledWith({
      agentId: 'opencode',
      metadata: expect.objectContaining({
        path: '/tmp/opencode-workspace',
        opencodeSessionId: 'opencode-session-1',
      }),
      sessionId: 'sid_opencode_1',
    });
    expect(runTmuxAttachFn).not.toHaveBeenCalled();
  });

  it('publishes provider-attach local-control state before attach and restores remote mode after exit', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_publish_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: '/tmp/opencode-workspace',
        host: 'test',
        flavor: 'opencode',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });
    const callOrder: string[] = [];
    const runProviderAttachFn = vi.fn(async () => {
      callOrder.push('attach');
      return 0;
    });
    const publishAttached = vi.fn(async (attached: boolean) => {
      callOrder.push(attached ? 'publish-local' : 'publish-remote');
    });

    await (handleAttachCommand as any)(['sid_opencode_publish_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      runProviderAttachFn,
      createProviderAttachStatePublisherFn: () => ({ publishAttached }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    });

    expect(publishAttached).toHaveBeenNthCalledWith(1, true);
    expect(publishAttached).toHaveBeenNthCalledWith(2, false);
    expect(callOrder).toEqual(['publish-local', 'attach', 'publish-remote']);
  });

  it('restores remote provider-attach state even when provider attach exits non-zero', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_opencode_publish_fail_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: '/tmp/opencode-workspace',
        host: 'test',
        flavor: 'opencode',
        opencodeSessionId: 'opencode-session-1',
        opencodeBackendMode: 'server',
        opencodeServerBaseUrl: 'http://127.0.0.1:4096/',
        opencodeServerBaseUrlExplicit: true,
      }),
    });
    const publishAttached = vi.fn(async () => {});

    await expect((handleAttachCommand as any)(['sid_opencode_publish_fail_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      runProviderAttachFn: async () => 1,
      createProviderAttachStatePublisherFn: () => ({ publishAttached }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    })).rejects.toThrow('process.exit(1)');

    expect(publishAttached).toHaveBeenNthCalledWith(1, true);
    expect(publishAttached).toHaveBeenNthCalledWith(2, false);
  });

  it('uses local terminal attachment info for tmux-backed attach on the current machine', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_claude_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: '/tmp/claude-workspace',
        host: 'test',
        flavor: 'claude',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:session-1',
            tmpDir: '/tmp/happy-tmux',
          },
        },
      }),
    });
    const runTmuxAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_claude_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'sid_claude_1',
        updatedAt: Date.now(),
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:session-1',
            tmpDir: '/tmp/happy-tmux',
          },
        },
      }),
      isTmuxAvailableFn: async () => true,
      runProviderAttachFn: vi.fn(async () => false),
      runTmuxAttachFn,
    });

    expect(runTmuxAttachFn).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        mode: 'tmux',
        tmux: expect.objectContaining({ target: 'happy:session-1' }),
      }),
    }));
  });

  it('requests a remote-control banner refresh when attaching to daemon-started tmux sessions', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_daemon_claude_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: '/tmp/claude-workspace',
        host: 'test',
        flavor: 'claude',
        startedBy: 'daemon',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:session-1',
            tmpDir: '/tmp/happy-tmux',
          },
        },
      }),
    });
    const runTmuxAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_daemon_claude_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'sid_daemon_claude_1',
        updatedAt: Date.now(),
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:session-1',
            tmpDir: '/tmp/happy-tmux',
          },
        },
      }),
      isTmuxAvailableFn: async () => true,
      runProviderAttachFn: vi.fn(async () => false),
      runTmuxAttachFn,
    });

    expect(runTmuxAttachFn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sid_daemon_claude_1',
      refreshRemoteControl: true,
    }));
  });

  it('falls back to persisted local attachment info when session metadata is unavailable', async () => {
    const runTmuxAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_local_1'], {
      readCredentialsFn: async () => null,
      fetchSessionByIdFn: async () => null,
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'sid_local_1',
        updatedAt: Date.now(),
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: {
            target: 'happy:local-1',
          },
        },
      }),
      isTmuxAvailableFn: async () => true,
      runProviderAttachFn: vi.fn(async () => false),
      runTmuxAttachFn,
    });

    expect(runTmuxAttachFn).toHaveBeenCalledWith(expect.objectContaining({
      terminal: expect.objectContaining({
        mode: 'tmux',
        tmux: expect.objectContaining({ target: 'happy:local-1' }),
      }),
    }));
  });

  it('dispatches Windows Terminal host attach for windows terminal metadata', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_windows_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: 'C:\\\\workspace',
        host: 'test',
        flavor: 'codex',
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            windowId: 'happy-session-1',
          },
        },
      }),
    });
    const runWindowsTerminalAttachFn = vi.fn(async () => 0);

    await (handleAttachCommand as any)(['sid_windows_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => ({
        version: 1,
        sessionId: 'sid_windows_1',
        updatedAt: Date.now(),
        terminal: {
          mode: 'windows_terminal',
          requested: 'windows_terminal',
          windows: {
            host: 'windows_terminal',
            windowId: 'happy-session-1',
          },
        },
      }),
      runProviderAttachFn: vi.fn(async () => 1),
      runTmuxAttachFn: vi.fn(async () => 0),
      runWindowsTerminalAttachFn,
      runWindowsConsoleAttachFn: vi.fn(async () => 0),
    });

    expect(runWindowsTerminalAttachFn).toHaveBeenCalledWith({
      sessionId: 'sid_windows_1',
      terminal: expect.objectContaining({
        mode: 'windows_terminal',
      }),
    });
  });

  it('fails with a not-attachable error for hidden Windows sessions', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = createSessionRecordFixture({
      id: 'sid_windows_hidden_1',
      active: true,
      encryptionMode: 'plain',
      metadata: JSON.stringify({
        machineId: 'machine-local',
        path: 'C:\\\\workspace',
        host: 'test',
        flavor: 'codex',
        terminal: {
          mode: 'plain',
          requested: 'windows_terminal',
          fallbackReason: 'started hidden on Windows',
        },
      }),
    });

    await expect((handleAttachCommand as any)(['sid_windows_hidden_1'], {
      readCredentialsFn: async () => credentials,
      readSettingsFn: async () => localSettings,
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => null,
      runProviderAttachFn: vi.fn(async () => 1),
      runTmuxAttachFn: vi.fn(async () => 0),
      runWindowsTerminalAttachFn: vi.fn(async () => 0),
      runWindowsConsoleAttachFn: vi.fn(async () => 0),
    })).rejects.toThrow('process.exit(1)');

    expect(errorSpy).toHaveBeenCalledWith(expect.anything(), 'This Windows session was started hidden and cannot be attached later.');
    errorSpy.mockRestore();
  });
});
