import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Credentials } from '@/persistence';
import { makeSessionFixtureRow } from '@/sessionControl/testFixtures';

import { handleAttachCommand } from './attach';

describe('happier attach', () => {
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as any);

  beforeEach(() => {
    exitSpy.mockClear();
  });

  it('dispatches provider-native attach for provider-attach local-control sessions', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = makeSessionFixtureRow({
      id: 'sid_opencode_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
    const rawSession = makeSessionFixtureRow({
      id: 'sid_opencode_publish_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
    const rawSession = makeSessionFixtureRow({
      id: 'sid_opencode_publish_fail_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
      fetchSessionByIdFn: async () => rawSession,
      runProviderAttachFn: async () => 1,
      createProviderAttachStatePublisherFn: () => ({ publishAttached }),
      readTerminalAttachmentInfoFn: async () => null,
      isTmuxAvailableFn: async () => true,
    })).rejects.toThrow('process.exit(1)');

    expect(publishAttached).toHaveBeenNthCalledWith(1, true);
    expect(publishAttached).toHaveBeenNthCalledWith(2, false);
  });

  it('uses decrypted session terminal metadata for tmux-backed attach when available', async () => {
    const credentials: Credentials = {
      token: 'token-1',
      encryption: { type: 'legacy', secret: new Uint8Array(32).fill(1) },
    };
    const rawSession = makeSessionFixtureRow({
      id: 'sid_claude_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => null,
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
    const rawSession = makeSessionFixtureRow({
      id: 'sid_windows_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
      fetchSessionByIdFn: async () => rawSession,
      readTerminalAttachmentInfoFn: async () => null,
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
    const rawSession = makeSessionFixtureRow({
      id: 'sid_windows_hidden_1',
      encryptionMode: 'plain',
      metadata: JSON.stringify({
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
