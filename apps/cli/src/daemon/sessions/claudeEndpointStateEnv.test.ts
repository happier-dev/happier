import { describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { resolveZellijSocketDir } from '@/integrations/zellij/socketDir';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { SpawnSessionOptions } from '@/rpc/handlers/registerSessionHandlers';
import type { DaemonSessionMarker } from '../sessionRegistry';
import {
  HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY,
  type AttachmentBoundClaudeEndpointState,
} from '@/backends/claude/endpointRecovery/claudeEndpointArtifacts';
import {
  ClaudeEndpointRecoveryFenceError,
  mergeClaudeEndpointStateIntoSpawnOptions,
  resolveClaudeEndpointRecoverySpawnOptions,
} from './claudeEndpointStateEnv';

const endpointState: AttachmentBoundClaudeEndpointState = {
  v: 2,
  attachmentId: 'attachment-endpoint-1',
  hookServerPort: 43123,
  hookPluginDir: '/tmp/happier/hooks/session-sess-claude',
  hookSettingsPath: '/tmp/happier/hooks/session-hook.json',
  hookSettingsOverlayPath: '/tmp/happier/hooks/session-hook.overlay.json',
  statuslineSecretFilePath: '/tmp/happier/hooks/session-hook.statusline-secret',
  mcpUrl: 'http://127.0.0.1:43124',
  mcpPort: 43124,
};

const marker: DaemonSessionMarker = {
  pid: 111,
  happySessionId: 'sess-claude',
  happyHomeDir: '/tmp/happy',
  createdAt: 1,
  updatedAt: 1,
  startedBy: 'daemon',
};

const handle: TerminalHostHandle = {
  kind: 'tmux',
  sessionName: 'happier-sess-claude',
  paneId: 'claude.1',
  attachMetadata: {
    attachStrategy: 'terminal_host',
    topology: 'shared',
    locality: 'same_machine',
    liveProbe: 'required',
  },
};

const attachment: TerminalAttachmentInfo = {
  version: 1,
  sessionId: 'sess-claude',
  terminal: {
    mode: 'tmux',
    tmux: {
      target: 'happier-sess-claude:claude.1',
    },
  },
  updatedAt: 1,
};

describe('claude endpoint recovery respawn options', () => {
  it('recovers an exact live attachment for explicit Resume without a runner marker candidate', async () => {
    const attachmentId = 'attachment-explicit-resume' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundEndpointState: AttachmentBoundClaudeEndpointState = { ...endpointState, attachmentId };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      defaultOptions,
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-claude',
        handle: { ...handle, attachmentId },
        terminal: attachment.terminal,
        updatedAt: 1,
      }),
      readClaudeEndpointDescriptor: async () => boundEndpointState,
      terminalHostAdapters: { tmux: adapter },
      resolveAdoptEndpointRecovery: async (state) => ({
        state,
        permissionHookSecret: 'permission-secret',
        statuslineSecret: 'statusline-secret',
      }),
    })).resolves.toEqual({
      ...defaultOptions,
      environmentVariables: {
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(boundEndpointState),
      },
    });
  });

  it('recovers endpoint control from the provider descriptor rather than wrapper-owned marker state', async () => {
    const attachmentId = 'attachment-alive-1' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundAttachment: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-claude',
      handle: { ...handle, attachmentId },
      terminal: attachment.terminal,
      updatedAt: 1,
    };
    const boundEndpointState: AttachmentBoundClaudeEndpointState = { ...endpointState, attachmentId };
    const markerWithoutEndpoint: DaemonSessionMarker = marker;
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => markerWithoutEndpoint,
      readClaudeEndpointDescriptor: async () => boundEndpointState,
      readTerminalAttachmentInfo: async () => boundAttachment,
      terminalHostAdapters: { tmux: adapter },
      resolveAdoptEndpointRecovery: async (state) => ({
        state,
        permissionHookSecret: 'permission-secret',
        statuslineSecret: 'statusline-secret',
      }),
    })).resolves.toEqual({
      ...defaultOptions,
      environmentVariables: {
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(boundEndpointState),
      },
    });
  });

  it('retires an exact alive but unusable attachment after re-proving runner absence so Resume can launch fresh', async () => {
    const attachmentId = 'attachment-alive-unusable' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundAttachment: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-claude',
      handle: { ...handle, attachmentId },
      terminal: attachment.terminal,
      updatedAt: 1,
    };
    const boundEndpointState: AttachmentBoundClaudeEndpointState = { ...endpointState, attachmentId };
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const onExactTerminalAttachmentRetired = vi.fn(async () => undefined);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(async () => undefined),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
      environmentVariables: {
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: 'stale-recovery-proof',
      },
    };

    const input: Parameters<typeof resolveClaudeEndpointRecoverySpawnOptions>[0] = {
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      defaultOptions,
      readTerminalAttachmentInfo: async () => boundAttachment,
      readClaudeEndpointDescriptor: async () => boundEndpointState,
      removeTerminalAttachmentInfo,
      onExactTerminalAttachmentRetired,
      terminalHostAdapters: { tmux: adapter },
      resolveAdoptEndpointRecovery: async () => null,
      proveExactSessionRunnerAbsent: async () => true,
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions(input)).resolves.toEqual({
      ...defaultOptions,
      environmentVariables: {},
    });

    expect(adapter.dispose).toHaveBeenCalledWith(boundAttachment.handle);
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      expectedAttachmentId: attachmentId,
      expectedTerminal: attachment.terminal,
    });
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      attachmentInfo: boundAttachment,
    });
  });

  it('fences an unusable live attachment when exact runner absence cannot be proven', async () => {
    const attachmentId = 'attachment-alive-runner-unproven' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundAttachment: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-claude',
      handle: { ...handle, attachmentId },
      terminal: attachment.terminal,
      updatedAt: 1,
    };
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      defaultOptions: {
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess-claude',
      },
      readTerminalAttachmentInfo: async () => boundAttachment,
      readClaudeEndpointDescriptor: async () => ({ ...endpointState, attachmentId }),
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { tmux: adapter },
      resolveAdoptEndpointRecovery: async () => null,
      proveExactSessionRunnerAbsent: async () => false,
    })).rejects.toMatchObject({
      name: ClaudeEndpointRecoveryFenceError.name,
      reason: 'live_attachment_adoption_unavailable',
    });

    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
  });

  it('fences a live exact attachment when its provider proof is missing without replacing or retiring it', async () => {
    const attachmentId = 'attachment-live-missing-proof' as NonNullable<TerminalHostHandle['attachmentId']>;
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      defaultOptions: {
        directory: '/workspace/project',
        backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
        existingSessionId: 'sess-claude',
      },
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId,
        sessionId: 'sess-claude',
        handle: { ...handle, attachmentId },
        terminal: attachment.terminal,
        updatedAt: 1,
      }),
      readClaudeEndpointDescriptor: async () => null,
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { tmux: adapter },
    })).rejects.toMatchObject({ reason: 'live_attachment_adoption_unavailable' });

    expect(adapter.createOrAttachHost).not.toHaveBeenCalled();
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
  });
  it('uses one shared env derivation for Claude endpoint state', () => {
    const spawnOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      environmentVariables: { EXISTING: '1' },
    };

    expect(mergeClaudeEndpointStateIntoSpawnOptions(spawnOptions, endpointState)).toEqual({
      ...spawnOptions,
      environmentVariables: {
        EXISTING: '1',
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify(endpointState),
      },
    });
  });

  it('injects adopt endpoint env during mid-life respawn when the marker endpoint and terminal host are alive', async () => {
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
      resume: 'claude-thread',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readClaudeEndpointDescriptor: async () => ({ ...endpointState, attachmentId: 'attachment-alive-existing' }),
      readTerminalAttachmentInfo: async () => ({
        version: 2,
        attachmentId: 'attachment-alive-existing' as NonNullable<TerminalHostHandle['attachmentId']>,
        sessionId: 'sess-claude',
        handle: { ...handle, attachmentId: 'attachment-alive-existing' as NonNullable<TerminalHostHandle['attachmentId']> },
        terminal: attachment.terminal,
        updatedAt: 1,
      }),
      removeTerminalAttachmentInfo: vi.fn(),
      terminalHostAdapters: { tmux: adapter },
      resolveAdoptEndpointRecovery: async (state) => ({
        state,
        permissionHookSecret: 'permission-secret',
        statuslineSecret: 'statusline-secret',
      }),
    })).resolves.toEqual({
      ...defaultOptions,
      environmentVariables: {
        [HAPPIER_CLAUDE_ENDPOINT_STATE_ENV_KEY]: JSON.stringify({ ...endpointState, attachmentId: 'attachment-alive-existing' }),
      },
    });

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'tmux',
      sessionName: 'happier-sess-claude',
      paneId: 'claude.1',
    }));
  });

  it('retires a dead legacy attachment without inferring destructive ownership', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => attachment,
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { tmux: adapter },
    })).resolves.toBe(defaultOptions);

    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      expectedLegacyAttachment: attachment,
    });
  });

  it('uses the released v1 Zellij writer socket root to prove an abandoned attachment dead', async () => {
    const happyHomeDir = '/tmp/happier/released-v1-home-with-a-long-enough-path-to-exercise-socket-shortening';
    const releasedV1Attachment: TerminalAttachmentInfo = {
      version: 1,
      sessionId: 'sess-claude',
      terminal: {
        mode: 'zellij',
        zellij: {
          sessionName: 'happier-claude-unified-released-v1',
          paneId: 'terminal_1',
        },
      },
      updatedAt: 1,
    };
    const expectedSocketDir = resolveZellijSocketDir(happyHomeDir);
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'zellij',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async (candidate) => candidate.socketDir === expectedSocketDir
        ? { paneAlive: false, paneDead: true, observedAt: 1 }
        : { paneAlive: false, probeInconclusive: true, observedAt: 1 }),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      happyHomeDir,
      sessionId: 'sess-claude',
      defaultOptions,
      readTerminalAttachmentInfo: async () => releasedV1Attachment,
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { zellij: adapter },
    })).resolves.toBe(defaultOptions);

    expect(adapter.evaluateLiveness).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'zellij',
      sessionName: 'happier-claude-unified-released-v1',
      paneId: 'terminal_1',
      socketDir: expectedSocketDir,
    }));
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir,
      sessionId: 'sess-claude',
      expectedLegacyAttachment: releasedV1Attachment,
    });
  });

  it('continues fresh respawn after exact positive-dead retirement even when provider cleanup remains pending', async () => {
    const attachmentId = 'attachment-dead-1' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundHandle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
      ...handle,
      attachmentId,
    };
    const boundAttachment: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-claude',
      handle: boundHandle,
      terminal: attachment.terminal,
      updatedAt: 1,
    };
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
      dispose: vi.fn(async () => undefined),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };
    const onExactTerminalAttachmentRetired = vi.fn(async () => {
      throw new Error('provider cleanup failed');
    });
    const retirementOrder: string[] = [];
    const retireExactTerminalControlServiceability = vi.fn(async () => {
      retirementOrder.push('remote-serviceability');
      return 'retired' as const;
    });

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => boundAttachment,
      removeTerminalAttachmentInfo,
      onExactTerminalAttachmentRetired,
      retireExactTerminalControlServiceability,
      terminalHostAdapters: { tmux: adapter },
    })).resolves.toBe(defaultOptions);

    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      expectedAttachmentId: attachmentId,
      expectedTerminal: attachment.terminal,
    });
    expect(onExactTerminalAttachmentRetired).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      attachmentInfo: boundAttachment,
    });
    expect(retireExactTerminalControlServiceability).toHaveBeenCalledWith({
      happyHomeDir: '/tmp/happy',
      sessionId: 'sess-claude',
      attachmentInfo: boundAttachment,
    });
    expect(retirementOrder).toEqual(['remote-serviceability']);
  });

  it('fences fresh respawn and retains local evidence when serviceability retirement is superseded', async () => {
    const attachmentId = 'attachment-dead-superseded' as NonNullable<TerminalHostHandle['attachmentId']>;
    const boundHandle: TerminalHostHandle & { attachmentId: NonNullable<TerminalHostHandle['attachmentId']> } = {
      ...handle,
      attachmentId,
    };
    const boundAttachment: TerminalAttachmentInfo = {
      version: 2,
      attachmentId,
      sessionId: 'sess-claude',
      handle: boundHandle,
      terminal: attachment.terminal,
      updatedAt: 1,
    };
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: false, paneDead: true, observedAt: 1 })),
      dispose: vi.fn(async () => undefined),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => boundAttachment,
      removeTerminalAttachmentInfo,
      retireExactTerminalControlServiceability: async () => 'superseded',
      terminalHostAdapters: { tmux: adapter },
    })).rejects.toMatchObject({
      name: 'ClaudeEndpointRecoveryFenceError',
      reason: 'serviceability_retirement_failed',
    });

    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
  });

  it('retains the durable attachment when endpoint recovery probes remain inconclusive', async () => {
    const removeTerminalAttachmentInfo = vi.fn(async () => true);
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(),
      injectUserPrompt: vi.fn(),
      interruptTurn: vi.fn(),
      evaluateLiveness: vi.fn(async () => {
        throw new Error('terminal liveness probe timed out');
      }),
      dispose: vi.fn(),
    };
    const defaultOptions: SpawnSessionOptions = {
      directory: '/workspace/project',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      existingSessionId: 'sess-claude',
    };

    await expect(resolveClaudeEndpointRecoverySpawnOptions({
      previousPid: 111,
      sessionId: 'sess-claude',
      defaultOptions,
      readSessionMarkerForPid: async () => marker,
      readTerminalAttachmentInfo: async () => attachment,
      removeTerminalAttachmentInfo,
      terminalHostAdapters: { tmux: adapter },
    })).rejects.toMatchObject({
      name: ClaudeEndpointRecoveryFenceError.name,
      reason: 'recovery_probe_inconclusive',
    });

    expect(adapter.evaluateLiveness).toHaveBeenCalledTimes(2);
    expect(adapter.dispose).not.toHaveBeenCalled();
    expect(removeTerminalAttachmentInfo).not.toHaveBeenCalled();
  });
});
