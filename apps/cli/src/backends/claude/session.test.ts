import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionClientPort } from '@/api/session/sessionClientPort';
import type { Metadata } from '@/api/types';
import { Session } from './session';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import type { EnhancedMode } from './loop';
import { getProjectPath } from './utils/path';
import { PermissionHandler } from './utils/permissionHandler';
import { syncClaudePermissionModeFromMetadata } from './utils/syncPermissionModeFromMetadata';
import { createClaudeUnifiedTerminalMetadataModeApplier } from './unifiedTerminal/metadataRuntimeModeApplier';
import { createClaudeUnifiedRuntimeControlBridge } from './unifiedTerminal/runtimeControlIntegration';
import { createClaudeUnifiedTuiControlController } from './unifiedTerminal/tuiControls/controller';
import { createFakeControlPort } from './unifiedTerminal/tuiControls/fakeControlPort';
import { createClaudeSettingsGuard } from './unifiedTerminal/tuiControls/settingsGuard';
import { ClaudeUnifiedDialogChoiceBroker } from './unifiedTerminal/dialogChoice/claudeUnifiedDialogChoiceBroker';
import { DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS } from './unifiedTerminal/tuiControls/types';
import { claudeRemoteAgentSdk } from './remote/claudeRemoteAgentSdk';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { startAnthropicSseBoundary } from './sdk/anthropicSseBoundary.testkit';
import type {
  SessionRuntimeActivityContributionHandle,
} from '@/session/runtimeActivity/types';

type SessionFoundHookData = NonNullable<Parameters<Session['onSessionFound']>[1]>;

it('preserves primary tool identity for consumers registered after the native broker until Session retires it', async () => {
  const session = createSession(createSessionClientStub());
  const broker = new ClaudeUnifiedDialogChoiceBroker(session);
  session.addClaudeSessionHookCallback((data) => broker.observeSessionHook(data));
  const facts = { sessionId: 'native-session', toolName: 'ExitPlanMode', toolInput: { plan: '# Harmless plan' } };
  try {
    session.onClaudeSessionHook({ hook_event_name: 'PreToolUse', session_id: facts.sessionId,
      tool_name: facts.toolName, tool_input: facts.toolInput, tool_use_id: 'primary-tool-id' });
    session.onClaudeSessionHook({ hook_event_name: 'Stop', session_id: facts.sessionId, agent_id: 'headless-agent' });
    expect(session.claudeToolHookCorrelation.findToolUseId(facts)).toBe('primary-tool-id');
    let observedToolId: unknown;
    session.addClaudeSessionHookCallback((data) => {
      if (data.hook_event_name === 'PostToolUse') observedToolId = session.claudeToolHookCorrelation.get('primary-tool-id')?.tool_use_id;
    });
    session.onClaudeSessionHook({ hook_event_name: 'PostToolUse', session_id: facts.sessionId, tool_use_id: 'primary-tool-id' });
    expect(observedToolId).toBe('primary-tool-id');
    expect(session.claudeToolHookCorrelation.get('primary-tool-id')).toBeUndefined();
  } finally {
    await broker.dispose();
    session.cleanup();
  }
});

function createMetadataStub(overrides?: Partial<Metadata>): Metadata {
  return {
    path: '/tmp',
    host: 'host',
    homeDir: '/home',
    happyHomeDir: '/home/.happier',
    happyLibDir: '/home/.happier/lib',
    happyToolsDir: '/home/.happier/tools',
    ...overrides,
  };
}

function createSessionClientStub(overrides?: Partial<SessionClientPort>): SessionClientPort {
  const client: SessionClientPort = {
    sessionId: 'session-test',
    rpcHandlerManager: {
      registerHandler: vi.fn(),
      invokeLocal: vi.fn(async () => ({})),
    },
    sendSessionEvent: vi.fn(),
    sendClaudeSessionMessage: vi.fn(),
    sendAgentMessage: vi.fn(),
    sendAgentMessageCommitted: vi.fn(async () => {}),
    keepAlive: vi.fn(),
    getMetadataSnapshot: () => null,
    waitForMetadataUpdate: vi.fn(async () => false),
    waitForPendingEligibilityUpdate: vi.fn(async () => false),
    popPendingMessage: vi.fn(async () => false),
    peekPendingMessageQueueV2Count: vi.fn(async () => 0),
    discardPendingMessageQueueV2All: vi.fn(async () => 0),
    discardCommittedMessageLocalIds: vi.fn(async () => 0),
    updateMetadata: vi.fn(),
    updateAgentStateRequestSettlement: vi.fn(async () => {}),
      updateAgentState: vi.fn(),
    sendSessionDeath: vi.fn(),
    flush: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    on: vi.fn(),
    off: vi.fn(),
    ...overrides,
  };
  return client;
}

function createSession(
  client: SessionClientPort,
  claudeArgs?: string[],
  reportSessionMetadataToDaemon?: (input: Readonly<{
    sessionId: string;
    metadata: Metadata;
  }>) => Promise<void> | void,
): Session {
  return new Session({
    client,
    path: '/tmp',
    logPath: '/tmp/log',
    sessionId: null,
    claudeArgs,
    messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
    onModeChange: () => {},
    hookSettingsPath: '/tmp/hooks.json',
    reportSessionMetadataToDaemon,
  });
}

function hookWithTranscript(transcriptPath: string): SessionFoundHookData {
  return { transcript_path: transcriptPath };
}

function writeClaudeTranscriptInit(transcriptPath: string, sessionId: string): void {
  writeFileSync(transcriptPath, `${JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    cwd: '/workspace/project',
    uuid: 'test-uuid',
    timestamp: '2026-06-14T00:00:00.000Z',
  })}\n`, 'utf8');
}

function writeCurrentClaudeTranscriptStart(transcriptPath: string, sessionId: string): void {
  const rows = [
    {
      type: 'last-prompt',
      leafUuid: 'leaf-uuid',
      sessionId,
    },
    {
      type: 'mode',
      mode: 'normal',
      sessionId,
    },
    {
      type: 'permission-mode',
      permissionMode: 'auto',
      sessionId,
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: 'system',
      subtype: 'informational',
      content: 'Claude permission mode notice',
      isMeta: false,
      timestamp: '2026-06-14T00:00:00.000Z',
      uuid: 'system-uuid',
      level: 'notice',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/workspace/project',
      sessionId,
      version: '2.1.177',
      gitBranch: 'main',
    },
    {
      type: 'file-history-snapshot',
      messageId: 'user-uuid',
      snapshot: {
        messageId: 'user-uuid',
        trackedFileBackups: {},
        timestamp: '2026-06-14T00:00:01.000Z',
      },
      isSnapshotUpdate: false,
    },
    {
      parentUuid: 'system-uuid',
      isSidechain: false,
      promptId: 'prompt-uuid',
      type: 'user',
      message: {
        role: 'user',
        content: 'continue',
      },
      uuid: 'user-uuid',
      timestamp: '2026-06-14T00:00:01.000Z',
      permissionMode: 'auto',
      promptSource: 'typed',
      userType: 'external',
      entrypoint: 'cli',
      cwd: '/workspace/project',
      sessionId,
      version: '2.1.177',
      gitBranch: 'main',
    },
  ];
  writeFileSync(transcriptPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

describe('Claude Unified terminal metadata publication', () => {
  it('publishes the exact attached terminal through session metadata and the existing daemon reporter', async () => {
    let metadata = createMetadataStub({});
    const updateMetadata = vi.fn(async (updater: (current: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const session = createSession(
      createSessionClientStub({
        sessionId: 'happy-session-id',
        getMetadataSnapshot: () => metadata,
        updateMetadata,
      }),
      undefined,
      reportSessionMetadataToDaemon,
    );
    const terminal = {
      mode: 'tmux',
      tmux: {
        target: 'happier-claude-unified-123:main',
      },
    } as const;

    await session.publishUnifiedTerminalHostMetadata(terminal);

    expect(metadata.terminal).toEqual(terminal);
    expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      metadata: expect.objectContaining({
        terminal,
      }),
    });
    session.cleanup();
  });
});

function createTempClaudeTranscript(
  sessionId: string,
  options?: Readonly<{ projectId?: string; transcriptSessionId?: string }>,
): Readonly<{ tempDir: string; transcriptPath: string; configDir: string }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
  const configDir = tempDir;
  const transcriptDir = join(configDir, 'projects', options?.projectId ?? 'project-a');
  mkdirSync(transcriptDir, { recursive: true });
  const transcriptPath = join(transcriptDir, `${sessionId}.jsonl`);
  writeClaudeTranscriptInit(transcriptPath, options?.transcriptSessionId ?? sessionId);
  vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
  return { tempDir, transcriptPath, configDir };
}

describe('Session', () => {
  it('synchronizes the accepted Session permission intent instead of stale metadata and ignores absent intent', async () => {
    let metadata = createMetadataStub({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 10 });
    const session = createSession(createSessionClientStub({ getMetadataSnapshot: () => metadata }));
    session.lastPermissionMode = 'yolo';
    session.lastPermissionModeUpdatedAt = 20;
    const handler = new PermissionHandler(session);
    try {
      expect(syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler })).toBe('yolo');
      expect(session.lastPermissionModeUpdatedAt).toBe(20);
      await expect(handler.handleToolCall('Write', { file_path: '/tmp/example.txt', content: 'x' }, {
        permissionMode: 'default',
      }, { signal: new AbortController().signal, toolUseId: 'current-session-permission-write' })).resolves.toMatchObject({ behavior: 'allow' });
      metadata = createMetadataStub();
      expect(syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler })).toBeNull();
    } finally {
      handler.dispose();
      session.cleanup();
    }
  });

  it('applies unified-compatible remote-launcher permission controls after the approval watcher already adopted the same update', async () => {
    const metadata = createMetadataStub({ permissionMode: 'safe-yolo', permissionModeUpdatedAt: 20 });
    // The network broadcast reaches the approval watcher before the idle provider consumer.
    let broadcast: ((updated: boolean) => void) | undefined;
    const session = createSession(createSessionClientStub({
      getMetadataSnapshot: () => metadata,
      waitForMetadataUpdate: (signal) => new Promise<boolean>((resolve) => {
        broadcast = resolve;
        signal?.addEventListener('abort', () => resolve(false), { once: true });
      }),
    }));
    session.lastPermissionMode = 'default';
    session.lastPermissionModeUpdatedAt = 10;
    const handler = new PermissionHandler(session);
    const configDir = mkdtempSync(join(tmpdir(), 'claude-metadata-permission-'));
    writeFileSync(join(configDir, 'settings.json'), '{}', 'utf8');
    const idle = ['╭─────╮', '│ >   │', '╰─────╯', '  ? for shortcuts'].join('\n');
    const accept = ['╭─────╮', '│ >   │', '╰─────╯', '  ⏵⏵ accept edits on (shift+tab to cycle)'].join('\n');
    const port = createFakeControlPort({ captures: [idle, accept] });
    const controller = createClaudeUnifiedTuiControlController({
      port,
      featureEnabled: true,
      settingsGuard: createClaudeSettingsGuard({ configDir }),
      wait: async () => undefined,
      timings: DEFAULT_CLAUDE_TUI_CONTROL_TIMINGS,
      nowMs: () => 1000,
    });
    const currentMode: EnhancedMode = { permissionMode: 'default', claudeUnifiedTerminalEnabled: true };
    const bridge = createClaudeUnifiedRuntimeControlBridge({
      controller,
      emitRuntimeConfigOutcome: () => {},
      startupMode: currentMode,
    });
    const applyMetadata = createClaudeUnifiedTerminalMetadataModeApplier({
      getCurrentMode: () => currentMode,
      getApplier: () => bridge.applyOutOfBand,
    });
    try {
      broadcast?.(true);
      await vi.waitFor(() => expect(session.lastPermissionModeUpdatedAt).toBe(20));
      // The retained unified-compatible remote-launcher callback uses this helper and applier.
      // Current direct-unified entry uses a separate permission bridge and is exempt.
      const updated = syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });
      if (updated) await applyMetadata(updated);
      expect(port.sentKeys).toEqual(['ShiftTab']);

      const repeated = syncClaudePermissionModeFromMetadata({ session, permissionHandler: handler });
      if (repeated) await applyMetadata(repeated);
      expect(port.sentKeys).toEqual(['ShiftTab']);
    } finally {
      handler.dispose();
      await bridge.dispose();
      session.cleanup();
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('owns unavailable group truth from runtime control registration through cleanup', async () => {
    const unregister = vi.fn();
    const registerSessionRuntimeControls = vi.fn((
      _controls: Parameters<NonNullable<SessionClientPort['registerSessionRuntimeControls']>>[0],
    ) => unregister);
    const client = createSessionClientStub({ registerSessionRuntimeControls });
    const session = createSession(client);

    expect(registerSessionRuntimeControls).toHaveBeenCalledOnce();
    const controls = registerSessionRuntimeControls.mock.calls[0]?.[0];
    expect(controls?.applyConnectedServiceAuthGeneration).toBeTypeOf('function');
    await expect(controls?.applyConnectedServiceAuthGeneration?.({
      serviceId: 'claude-subscription',
      reason: 'diagnostic',
      authGeneration: {
        kind: 'current_auth_group_unavailable',
        groupId: 'team',
        unavailableReason: 'group_missing',
      },
    })).resolves.toEqual({ ok: true, appliedVia: 'current_truth_fence' });

    const abortController = new AbortController();
    let released = false;
    const waiting = session.connectedServiceAuthGroupRequestFence
      .waitUntilAvailable(abortController.signal)
      .then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);

    await controls?.applyConnectedServiceAuthGeneration?.({
      serviceId: 'claude-subscription',
      reason: 'diagnostic',
      authGeneration: {
        kind: 'current_auth_group_available',
        groupId: 'replacement-team',
        generation: 3,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    await waiting;
    expect(released).toBe(true);

    session.cleanup();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it('notifies the active Claude runtime after exact connected-service application without failing settlement', async () => {
    const registerSessionRuntimeControls = vi.fn((
      _controls: Parameters<NonNullable<SessionClientPort['registerSessionRuntimeControls']>>[0],
    ) => () => undefined);
    const client = createSessionClientStub({ registerSessionRuntimeControls });
    const session = createSession(client);
    const releaseRuntime = vi.fn(async () => {
      throw new Error('terminal release is best effort');
    });
    const unregisterRelease = session.registerConnectedServiceExactApplicationHandler(releaseRuntime);

    const controls = registerSessionRuntimeControls.mock.calls[0]?.[0];
    await expect(controls?.applyConnectedServiceAuthGeneration?.({
      serviceId: 'claude-subscription',
      reason: 'diagnostic',
      applicationSettled: true,
      authGeneration: {
        kind: 'current_auth_group_available',
        groupId: 'team',
        generation: 3,
        credentialRevision: 'csr_aaaaaaaaaaaaaaaaaaaaaa',
      },
    })).resolves.toEqual({ ok: true, appliedVia: 'current_truth_fence' });
    expect(releaseRuntime).toHaveBeenCalledOnce();

    unregisterRelease();
    await controls?.applyConnectedServiceAuthGeneration?.({
      serviceId: 'claude-subscription',
      reason: 'diagnostic',
      applicationSettled: true,
      authGeneration: {
        kind: 'current_auth_group_available',
        groupId: 'team',
        generation: 4,
        credentialRevision: 'csr_bbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    expect(releaseRuntime).toHaveBeenCalledOnce();
    session.cleanup();
  });

  it('tracks recent user abort requests', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-02-26T07:46:00.000Z'));

    const client = createSessionClientStub();
    const session = createSession(client);

    try {
      expect(session.wasUserAbortRequestedRecently(1)).toBe(false);

      session.noteUserAbortRequested();
      expect(session.wasUserAbortRequestedRecently(10_000)).toBe(true);

      vi.setSystemTime(new Date('2026-02-26T07:46:11.000Z'));
      expect(session.wasUserAbortRequestedRecently(10_000)).toBe(false);
    } finally {
      session.cleanup();
      vi.useRealTimers();
    }
  });

  it('tracks changed Claude session id metadata writes as drainable critical persistence', async () => {
    const transcript = createTempClaudeTranscript('sess_critical');
    let resolveMetadataUpdate!: () => void;
    const metadataUpdate = new Promise<void>((resolve) => {
      resolveMetadataUpdate = resolve;
    });
    const client = createSessionClientStub({
      updateMetadata: vi.fn(() => metadataUpdate),
    });
    const session = createSession(client);

    try {
      session.onSessionFound('sess_critical', hookWithTranscript(transcript.transcriptPath));

      const drained = session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      await vi.waitFor(() => expect(client.updateMetadata).toHaveBeenCalledTimes(1));

      let didDrain = false;
      void drained.then(() => {
        didDrain = true;
      });
      await Promise.resolve();
      expect(didDrain).toBe(false);

      resolveMetadataUpdate();
      await drained;
      expect(didDrain).toBe(true);
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('defaults startedBy to terminal', () => {
    const client = createSessionClientStub();

    const session = createSession(client);

    try {
      expect((session as any).startedBy).toBe('terminal');
    } finally {
      session.cleanup();
    }
  });

  it('stores startedBy when provided', () => {
    const client = createSessionClientStub();

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      claudeArgs: [],
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
    });

    try {
      expect((session as any).startedBy).toBe('daemon');
    } finally {
      session.cleanup();
    }
  });

  it('adopts permissionMode from metadata without republishing it', () => {
    const metadataUpdates: Metadata[] = [];
    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadataUpdates.push(updater(createMetadataStub()));
      },
    });

    const session = createSession(client);

    try {
      session.setLastPermissionMode('plan', 111);
      expect(metadataUpdates).toEqual([expect.objectContaining({ permissionMode: 'plan', permissionModeUpdatedAt: 111 })]);
      metadataUpdates.length = 0;

      expect(session.adoptLastPermissionModeFromMetadata('acceptEdits', 222)).toBe(true);
      expect(session.lastPermissionMode).toBe('safe-yolo');
      expect(session.lastPermissionModeUpdatedAt).toBe(222);
      expect(metadataUpdates).toEqual([]);

      expect(session.adoptLastPermissionModeFromMetadata('default', 200)).toBe(false);
      expect(session.lastPermissionMode).toBe('safe-yolo');
      expect(session.lastPermissionModeUpdatedAt).toBe(222);
    } finally {
      session.cleanup();
    }
  });

  it('does not bump permissionModeUpdatedAt when permission mode does not change', () => {
    const metadataUpdates: Metadata[] = [];
    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadataUpdates.push(updater(createMetadataStub()));
      },
    });

    const session = createSession(client);

    try {
      session.setLastPermissionMode('default', 111);
      session.setLastPermissionMode('default', 222);
      session.setLastPermissionMode('plan', 333);
      session.setLastPermissionMode('plan', 444);

      expect(metadataUpdates).toEqual([expect.objectContaining({ permissionMode: 'plan', permissionModeUpdatedAt: 333 })]);
    } finally {
      session.cleanup();
    }
  });

  it('notifies sessionFound callbacks with transcriptPath when provided', async () => {
    const transcript = createTempClaudeTranscript('sess_1');
    let metadata: Metadata = createMetadataStub();

    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
    });

    const session = createSession(client);

    try {
      const events: Array<{ sessionId: string; transcriptPath: string | null }> = [];
      session.addSessionFoundCallback((info) => events.push(info));

      session.onSessionFound('sess_1', hookWithTranscript(transcript.transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBe('sess_1');
      expect(metadata.claudeTranscriptPath).toBe(transcript.transcriptPath);
      expect(events).toEqual([{ sessionId: 'sess_1', transcriptPath: transcript.transcriptPath }]);
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('reports discovered Claude session metadata back to the daemon tracker', async () => {
    const transcript = createTempClaudeTranscript('claude-session-1');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('claude-session-1', hookWithTranscript(transcript.transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          startedBy: 'daemon',
          claudeSessionId: 'claude-session-1',
          claudeTranscriptPath: transcript.transcriptPath,
        }),
      });
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('promotes Claude resume metadata from current transcript rows with camelCase sessionId', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-current');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'claude-current-session.jsonl');
    writeCurrentClaudeTranscriptStart(transcriptPath, 'claude-current-session');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('claude-current-session', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'claude-current-session',
        claudeTranscriptPath: transcriptPath,
      }));
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          claudeSessionId: 'claude-current-session',
          claudeTranscriptPath: transcriptPath,
        }),
      });
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps a fresh Claude session id provisional until its transcript is reachable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-a');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_missing_initial.jsonl');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_missing_initial', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBeUndefined();
      expect(metadata.claudeTranscriptPath).toBeUndefined();
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess_missing_initial');
      expect(session.transcriptPath).toBe(transcriptPath);

      writeFileSync(transcriptPath, '', 'utf8');
      session.onSessionFound('sess_missing_initial', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBeUndefined();

      writeClaudeTranscriptInit(transcriptPath, 'sess_missing_initial');
      session.onSessionFound('sess_missing_initial', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBe('sess_missing_initial');
      expect(metadata.claudeTranscriptPath).toBe(transcriptPath);
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1', metadata,
      });
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    { hook_event_name: 'SessionEnd' },
    { hookEventName: 'SessionEnd' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'UserPromptSubmit' },
  ])('keeps lifecycle hooks from replacing the native resume identity: %j', async (event) => {
    const session = createSession(createSessionClientStub(), ['--resume', 'sess_reachable']);
    const transcriptPath = '/tmp/sess_reachable.jsonl';
    session.transcriptPath = transcriptPath;
    const discoveredSessions: string[] = [];
    session.addSessionFoundCallback((info) => discoveredSessions.push(info.sessionId));

    try {
      session.onSessionFound('sess_missing', {
        ...event,
        transcript_path: '/tmp/sess_missing.jsonl',
      });
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      session.consumeOneTimeFlags();

      expect(session.sessionId).toBe('sess_reachable');
      expect(session.transcriptPath).toBe(transcriptPath);
      expect(discoveredSessions).toEqual([]);
    } finally {
      session.cleanup();
    }
  });

  it('preserves the established resume identity while a changed Claude session remains provisional', async () => {
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
      claudeLastAssistantUuid: 'asst_stale',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'sess_reachable',
        source: {
          kind: 'claudeConfig',
          configDir: '/tmp/.claude',
          projectId: 'project-a',
        },
        linkedAtMs: 1,
      },
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_missing', { ...hookWithTranscript('/tmp/sess_missing.jsonl'), hook_event_name: 'SessionStart' });
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBe('sess_reachable');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(metadata.claudeLastAssistantUuid).toBe('asst_stale');
      expect(metadata.directSessionV1?.remoteSessionId).toBe('sess_reachable');
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess_missing');
      expect(session.transcriptPath).toBe('/tmp/sess_missing.jsonl');
    } finally {
      session.cleanup();
    }
  });

  it('does not promote Claude resume metadata from a transcript file that does not match the session id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-a');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_other.jsonl');
    writeClaudeTranscriptInit(transcriptPath, 'sess_other');
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_candidate', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBe('sess_reachable');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess_candidate');
      expect(session.transcriptPath).toBe(transcriptPath);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not promote Claude resume metadata from a matching transcript filename with mismatched session content', async () => {
    const transcript = createTempClaudeTranscript('sess_candidate', { transcriptSessionId: 'sess_other' });
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_candidate', hookWithTranscript(transcript.transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBe('sess_reachable');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess_candidate');
      expect(session.transcriptPath).toBe(transcript.transcriptPath);
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('does not promote Claude resume metadata from current transcript rows with a mismatched sessionId', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-current');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_candidate.jsonl');
    writeCurrentClaudeTranscriptStart(transcriptPath, 'sess_other');
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_candidate', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBe('sess_reachable');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not promote Claude resume metadata from a matching transcript outside the native Claude store', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    const configDir = join(tempDir, '.claude');
    vi.stubEnv('CLAUDE_CONFIG_DIR', configDir);
    const outsideDir = join(tempDir, 'outside');
    mkdirSync(outsideDir, { recursive: true });
    const transcriptPath = join(outsideDir, 'sess_candidate.jsonl');
    writeClaudeTranscriptInit(transcriptPath, 'sess_candidate');
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_candidate', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBe('sess_reachable');
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.sessionId).toBe('sess_candidate');
      expect(session.transcriptPath).toBe(transcriptPath);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('promotes id-only Claude discoveries only when the native project transcript proves the session id', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = getProjectPath('/tmp', tempDir);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_scanned.jsonl');
    writeClaudeTranscriptInit(transcriptPath, 'sess_scanned');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_scanned');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_scanned',
        claudeTranscriptPath: transcriptPath,
      }));
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          claudeSessionId: 'sess_scanned',
          claudeTranscriptPath: transcriptPath,
        }),
      });
      expect(session.transcriptPath).toBe(transcriptPath);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps id-only Claude discoveries provisional before the native transcript exists', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptPath = join(getProjectPath('/tmp', tempDir), 'sess_legacy_early.jsonl');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_legacy_early');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata.claudeSessionId).toBeUndefined();
      expect(metadata.claudeTranscriptPath).toBeUndefined();
      expect(reportSessionMetadataToDaemon).not.toHaveBeenCalled();
      expect(session.transcriptPath).toBe(transcriptPath);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('promotes id-only Claude discoveries from current native transcript rows', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = getProjectPath('/tmp', tempDir);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_current_scanned.jsonl');
    writeCurrentClaudeTranscriptStart(transcriptPath, 'sess_current_scanned');
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_current_scanned');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_current_scanned',
        claudeTranscriptPath: transcriptPath,
      }));
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          claudeSessionId: 'sess_current_scanned',
          claudeTranscriptPath: transcriptPath,
        }),
      });
      expect(session.transcriptPath).toBe(transcriptPath);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('promotes id-only Claude discoveries from large current native transcripts', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = getProjectPath('/tmp', tempDir);
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_large_scanned.jsonl');
    const rows = [
      { type: 'queue-operation', operation: 'dequeue', sessionId: 'sess_large_scanned' },
      {
        type: 'user',
        sessionId: 'sess_large_scanned',
        message: {
          role: 'user',
          content: 'x'.repeat(128 * 1024),
        },
      },
      { type: 'assistant', sessionId: 'sess_large_scanned', message: { role: 'assistant', content: 'done' } },
    ];
    writeFileSync(
      transcriptPath,
      `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
      'utf8',
    );
    let metadata: Metadata = createMetadataStub({ startedBy: 'daemon' });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: null,
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_large_scanned');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_large_scanned',
        claudeTranscriptPath: transcriptPath,
      }));
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          claudeSessionId: 'sess_large_scanned',
          claudeTranscriptPath: transcriptPath,
        }),
      });
      expect(session.transcriptPath).toBe(transcriptPath);

      // A matching long first record must not conceal a contradictory identity later in the file.
      metadata = createMetadataStub({ startedBy: 'daemon' });
      writeFileSync(transcriptPath, `${[...rows, { type: 'assistant', sessionId: 'foreign' }].map(row => JSON.stringify(row)).join('\n')}\n`);
      session.onSessionFound('sess_large_scanned');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBeUndefined();

      writeFileSync(transcriptPath, `${rows.map(row => JSON.stringify(row)).join('\n')}\n{"type":"assistant"`);
      session.onSessionFound('sess_large_scanned');
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBeUndefined();
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each(['matching', 'missing', 'empty', 'mismatched'] as const)('publishes only established SDK identities at successful turn completion: %s', async proof => {
    const root = mkdtempSync(join(tmpdir(), 'happier-claude-sdk-identity-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    const id = 'sdk-established';
    const transcriptPath = join(root, 'projects', 'exact-hook-project', `${id}.jsonl`);
    mkdirSync(join(root, 'projects', 'exact-hook-project'), { recursive: true });
    let metadata = createMetadataStub({ machineId: 'machine', flavor: 'claude' });
    const client = createSessionClientStub({ updateMetadata: async updater => { metadata = updater(metadata); } });
    const session = createSession(client);
    let finish!: () => void;
    const done = new Promise<null>(resolve => { finish = () => resolve(null); });
    let sent = false;
    // The SDK is an external process boundary; the Session and runner logic beneath it are real.
    const createQuery = ((params: { options: { hooks: { SessionStart: Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }> } } }) => ({
      async *[Symbol.asyncIterator]() {
        await params.options.hooks.SessionStart[0].hooks[0]({ session_id: id, transcript_path: transcriptPath });
        yield { type: 'system', subtype: 'init', session_id: id };
        expect(metadata.claudeSessionId).toBeUndefined();
        if (proof === 'empty') writeFileSync(transcriptPath, '');
        if (proof === 'matching' || proof === 'mismatched') {
          const sessionId = proof === 'matching' ? id : 'foreign';
          writeFileSync(transcriptPath, `${[
            { type: 'user', sessionId, message: { role: 'user', content: 'hello' } },
            { type: 'assistant', sessionId, message: { role: 'assistant', content: 'done' } },
          ].map(row => JSON.stringify(row)).join('\n')}\n`);
        }
        yield { type: 'result', subtype: 'success', session_id: id, result: 'done' };
        await done;
      },
      close() { finish(); },
    })) as unknown as NonNullable<Parameters<typeof claudeRemoteAgentSdk>[0]['createQuery']>;
    try {
      await claudeRemoteAgentSdk({
        sessionId: null, transcriptPath: null, path: '/tmp', claudeExecutablePath: '/tmp/claude',
        nextMessage: async () => {
          if (sent) return done;
          sent = true;
          return { message: 'hello', mode: { permissionMode: 'default', claudeRemoteAgentSdkEnabled: true } };
        },
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAborted: () => false, onMessage: () => {}, onReady: finish,
        onSessionFound: session.onSessionFound, createQuery,
      });
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBe(proof === 'matching' ? id : undefined);
      const spawn = buildInactiveSessionResumeSpawnOptions({
        sessionId: client.sessionId,
        rawSession: {
          id: client.sessionId, active: false, machineId: 'machine', path: '/tmp',
          seq: 0, createdAt: 0, updatedAt: 0, activeAt: 0,
          metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        } satisfies RawSessionRecord,
        metadata,
      });
      expect(spawn?.resume).toBe(proof === 'matching' ? id : undefined);
    } finally {
      finish();
      session.cleanup();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.runIf(Boolean(process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH))('publishes the actual native SDK identity after a completed first turn for inactive resume', async () => {
    const root = mkdtempSync(join(tmpdir(), 'happier-native-session-identity-'));
    const boundary = await startAnthropicSseBoundary();
    vi.stubEnv('CLAUDE_CONFIG_DIR', root);
    vi.stubEnv('CLAUDECODE', undefined);
    vi.stubEnv('ANTHROPIC_BASE_URL', boundary.url);
    vi.stubEnv('ANTHROPIC_API_KEY', 'local-test-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', undefined);
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    let metadata = createMetadataStub({ machineId: 'machine', flavor: 'claude' });
    const client = createSessionClientStub({ updateMetadata: async updater => { metadata = updater(metadata); } });
    const session = createSession(client);
    let finish!: () => void;
    const done = new Promise<null>(resolve => { finish = () => resolve(null); });
    let sent = false;
    let nativeId: string | undefined;
    let completed = false;
    try {
      await claudeRemoteAgentSdk({
        sessionId: null, transcriptPath: null, path: '/tmp',
        claudeExecutablePath: process.env.HAPPIER_TEST_NATIVE_CLAUDE_PATH,
        nextMessage: async () => {
          if (sent) return done;
          sent = true;
          return { message: 'hello owner control', mode: {
            permissionMode: 'default', model: 'claude-sonnet-4-6',
            claudeRemoteAgentSdkEnabled: true, claudeRemoteSettingSourcesV2: [],
          } };
        },
        canCallTool: async () => ({ behavior: 'allow', updatedInput: {} }),
        isAborted: () => false,
        onMessage: message => {
          if (message.type === 'system' && message.subtype === 'init' && typeof message.session_id === 'string') {
            nativeId = message.session_id;
            expect(metadata.claudeSessionId).toBeUndefined();
          }
          if (message.type === 'result') {
            expect(message.subtype).toBe('success');
            completed = true;
          }
        },
        onReady: finish, onSessionFound: session.onSessionFound,
      });
      await session.drainCriticalMetadataWrites();
      expect(completed).toBe(true);
      expect(nativeId).toBeTruthy();
      expect(metadata.claudeSessionId).toBe(nativeId);
      expect(metadata.claudeTranscriptPath).toBe(join(getProjectPath('/tmp', root), `${nativeId}.jsonl`));
      expect(buildInactiveSessionResumeSpawnOptions({
        sessionId: client.sessionId,
        rawSession: {
          id: client.sessionId, active: false, machineId: 'machine', path: '/tmp',
          seq: 0, createdAt: 0, updatedAt: 0, activeAt: 0,
          metadata: '{}', metadataVersion: 0, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
        } satisfies RawSessionRecord,
        metadata,
      })?.resume).toBe(nativeId);
    } finally {
      finish();
      session.cleanup();
      await boundary.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let earlier paged proof overwrite a newer Claude session observation', async () => {
    const transcript = createTempClaudeTranscript('older');
    const newerPath = join(transcript.configDir, 'projects', 'project-a', 'newer.jsonl');
    writeFileSync(transcript.transcriptPath, `${Array.from({ length: 5000 }, () => JSON.stringify({
      type: 'assistant', sessionId: 'older', message: { content: 'x'.repeat(300) },
    })).join('\n')}\n`);
    writeClaudeTranscriptInit(newerPath, 'newer');
    let metadata = createMetadataStub();
    const session = createSession(createSessionClientStub({ updateMetadata: updater => { metadata = updater(metadata); } }));
    try {
      session.onSessionFound('older', hookWithTranscript(transcript.transcriptPath));
      session.onSessionFound('newer', hookWithTranscript(newerPath));
      await session.drainCriticalMetadataWrites();
      expect(metadata.claudeSessionId).toBe('newer');
      expect(metadata.claudeTranscriptPath).toBe(newerPath);
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('reports delayed Claude resume metadata promotion when a deferred session transcript becomes reachable', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-a');
    mkdirSync(transcriptDir, { recursive: true });
    const transcriptPath = join(transcriptDir, 'sess_delayed.jsonl');
    let metadata: Metadata = createMetadataStub({
      startedBy: 'daemon',
      claudeSessionId: 'sess_reachable',
      claudeTranscriptPath: '/tmp/sess_reachable.jsonl',
      claudeLastAssistantUuid: 'previous-session-anchor',
    });
    const reportSessionMetadataToDaemon = vi.fn(async () => {});
    const updateMetadata = vi.fn(async (updater: (metadata: Metadata) => Metadata) => {
      metadata = updater(metadata);
    });
    const client = createSessionClientStub({
      sessionId: 'happy-session-1',
      updateMetadata,
    });

    const session = new Session({
      client,
      path: '/tmp',
      logPath: '/tmp/log',
      sessionId: 'sess_reachable',
      messageQueue: new MessageQueue2<EnhancedMode>(() => 'mode'),
      onModeChange: () => {},
      hookSettingsPath: '/tmp/hooks.json',
      startedBy: 'daemon',
      reportSessionMetadataToDaemon,
    });

    try {
      session.onSessionFound('sess_delayed', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_reachable',
      }));
      expect(metadata.claudeTranscriptPath).toBe('/tmp/sess_reachable.jsonl');
      expect(metadata.claudeLastAssistantUuid).toBe('previous-session-anchor');

      writeClaudeTranscriptInit(transcriptPath, 'sess_delayed');
      session.onSessionFound('sess_delayed', hookWithTranscript(transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });

      expect(updateMetadata).toHaveBeenCalledTimes(1);
      expect(metadata).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_delayed',
        claudeTranscriptPath: transcriptPath,
      }));
      expect(metadata.claudeLastAssistantUuid).toBeUndefined();
      expect(reportSessionMetadataToDaemon).toHaveBeenCalledWith({
        sessionId: 'happy-session-1',
        metadata: expect.objectContaining({
          claudeSessionId: 'sess_delayed',
          claudeTranscriptPath: transcriptPath,
        }),
      });
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('publishes direct-session metadata when transcript storage is direct', async () => {
    const transcript = createTempClaudeTranscript('sess_1', { projectId: 'proj-a' });
    vi.stubEnv('HAPPIER_TRANSCRIPT_STORAGE', 'direct');
    vi.stubEnv('CLAUDE_CONFIG_DIR', transcript.configDir);
    let metadata: Metadata = createMetadataStub({ machineId: 'machine-1' } as Partial<Metadata>);

    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
    });

    const session = createSession(client);

    try {
      session.onSessionFound('sess_1', hookWithTranscript(transcript.transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.directSessionV1).toMatchObject({
        v: 1,
        providerId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'sess_1',
        source: { kind: 'claudeConfig', configDir: transcript.tempDir, projectId: 'proj-a' },
      });
    } finally {
      session.cleanup();
      vi.unstubAllEnvs();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('does not carry over transcriptPath when sessionId changes and hook lacks transcriptPath', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const transcriptDir = join(tempDir, 'projects', 'project-a');
    mkdirSync(transcriptDir, { recursive: true });
    const sess2TranscriptPath = join(transcriptDir, 'sess_2.jsonl');
    writeClaudeTranscriptInit(sess2TranscriptPath, 'sess_2');
    let metadata: Metadata = createMetadataStub();

    const client = createSessionClientStub({
      updateMetadata: (updater) => {
        metadata = updater(metadata);
      },
    });

    const session = createSession(client);

    try {
      const events: Array<{ sessionId: string; transcriptPath: string | null }> = [];
      session.addSessionFoundCallback((info) => events.push(info));

      session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));
      session.onSessionFound('sess_2');
      session.onSessionFound('sess_2', hookWithTranscript(sess2TranscriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(metadata.claudeSessionId).toBe('sess_2');
      expect(events).toEqual([
        { sessionId: 'sess_1', transcriptPath: '/tmp/sess_1.jsonl' },
        { sessionId: 'sess_2', transcriptPath: join(getProjectPath('/tmp', tempDir), 'sess_2.jsonl') },
        { sessionId: 'sess_2', transcriptPath: sess2TranscriptPath },
      ]);
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('clears stored assistant resume anchor when Claude session id changes', async () => {
    const transcript = createTempClaudeTranscript('sess_1');
    const client = createSessionClientStub();
    const session = createSession(client);

    try {
      session.onSessionFound('sess_1', hookWithTranscript(transcript.transcriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(client.updateMetadata).toHaveBeenCalled();
      const updater = vi.mocked(client.updateMetadata).mock.calls[0]?.[0];
      expect(typeof updater).toBe('function');

      const next = updater?.(createMetadataStub({
        claudeLastAssistantUuid: 'asst_stale',
      }));

      expect(next).not.toHaveProperty('claudeLastAssistantUuid');
      expect(next).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_1',
        claudeTranscriptPath: transcript.transcriptPath,
      }));
    } finally {
      session.cleanup();
      rmSync(transcript.tempDir, { recursive: true, force: true });
    }
  });

  it('clears stored assistant resume anchor when known Claude transcript path changes', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'happier-claude-session-'));
    vi.stubEnv('CLAUDE_CONFIG_DIR', tempDir);
    const firstTranscriptPath = join(tempDir, 'projects', 'project-a', 'sess_1.jsonl');
    const secondTranscriptPath = join(tempDir, 'projects', 'project-b', 'sess_1.jsonl');
    mkdirSync(join(tempDir, 'projects', 'project-a'), { recursive: true });
    mkdirSync(join(tempDir, 'projects', 'project-b'), { recursive: true });
    writeClaudeTranscriptInit(firstTranscriptPath, 'sess_1');
    writeClaudeTranscriptInit(secondTranscriptPath, 'sess_1');
    const client = createSessionClientStub();
    const session = createSession(client);

    try {
      session.onSessionFound('sess_1', hookWithTranscript(firstTranscriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      vi.mocked(client.updateMetadata).mockClear();

      session.onSessionFound('sess_1', hookWithTranscript(secondTranscriptPath));
      await session.drainCriticalMetadataWrites({ timeoutMs: 500 });
      expect(client.updateMetadata).toHaveBeenCalled();
      const updater = vi.mocked(client.updateMetadata).mock.calls[0]?.[0];
      expect(typeof updater).toBe('function');

      const next = updater?.(createMetadataStub({
        claudeSessionId: 'sess_1',
        claudeTranscriptPath: firstTranscriptPath,
        claudeLastAssistantUuid: 'asst_stale',
      }));

      expect(next).not.toHaveProperty('claudeLastAssistantUuid');
      expect(next).toEqual(expect.objectContaining({
        claudeSessionId: 'sess_1',
        claudeTranscriptPath: secondTranscriptPath,
      }));
    } finally {
      session.cleanup();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('clearSessionId clears transcriptPath as well', () => {
    const client = createSessionClientStub();

    const session = createSession(client);

    try {
      session.onSessionFound('sess_1', hookWithTranscript('/tmp/sess_1.jsonl'));
      expect(session.sessionId).toBe('sess_1');
      expect(session.transcriptPath).toBe('/tmp/sess_1.jsonl');

      session.clearSessionId();

      expect(session.sessionId).toBeNull();
      expect(session.transcriptPath).toBeNull();

      expect(client.updateMetadata).toHaveBeenCalled();
      const updater = vi.mocked(client.updateMetadata).mock.calls.at(-1)?.[0];
      expect(typeof updater).toBe('function');

      const next = updater?.(createMetadataStub({
        claudeLastAssistantUuid: 'asst_stale',
      }));
      expect(next).not.toHaveProperty('claudeLastAssistantUuid');
    } finally {
      session.cleanup();
    }
  });

  it('consumeOneTimeFlags consumes short -c and -r flags', () => {
    const client = createSessionClientStub();

    const session = createSession(client, ['-c', '-r', 'abc-123', '--foo', 'bar']);

    try {
      session.consumeOneTimeFlags();
      expect(session.claudeArgs).toEqual(['--foo', 'bar']);
    } finally {
      session.cleanup();
    }
  });

  it('emits ACP task lifecycle events when thinking toggles', () => {
    const sendAgentMessage = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage });

    const session = createSession(client);

    try {
      session.onThinkingChange(true);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      const [provider1, payload1] = sendAgentMessage.mock.calls[0] ?? [];
      expect(provider1).toBe('claude');
      expect(payload1?.type).toBe('task_started');
      expect(typeof payload1?.id).toBe('string');

      session.onThinkingChange(true);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);

      session.onThinkingChange(false);
      expect(sendAgentMessage).toHaveBeenCalledTimes(2);
      const [provider2, payload2] = sendAgentMessage.mock.calls[1] ?? [];
      expect(provider2).toBe('claude');
      expect(payload2).toEqual({ type: 'task_complete', id: payload1.id });
    } finally {
      session.cleanup();
    }
  });

  it('can update thinking state without emitting ACP task lifecycle events', () => {
    const sendAgentMessage = vi.fn();
    const keepAlive = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage, keepAlive });

    const session = createSession(client);

    try {
      session.setThinkingWithoutTaskLifecycle(true);
      expect(keepAlive).toHaveBeenLastCalledWith(true, 'local');
      expect(sendAgentMessage).not.toHaveBeenCalled();

      session.setThinkingWithoutTaskLifecycle(false);
      expect(keepAlive).toHaveBeenLastCalledWith(false, 'local');
      expect(sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      session.cleanup();
    }
  });

  it('opens and completes the task even when thinking was optimistically latched first', () => {
    // Incident 2d83312e: a remote-injected prompt fires the optimistic display latch
    // (setThinkingWithoutTaskLifecycle) BEFORE the canonical hook-driven onThinkingChange(true).
    // The task lifecycle must key off the task, not the thinking display flag, so the completed
    // turn still emits task_started + task_complete (→ latestTurnStatus completed → ready/push).
    const sendAgentMessage = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage });

    const session = createSession(client);

    try {
      // Optimistic latch on remote prompt injection: thinking=true, no task opened yet.
      session.setThinkingWithoutTaskLifecycle(true);
      expect(sendAgentMessage).not.toHaveBeenCalled();

      // Canonical turn goes active (hook). Even though thinking is already latched, the
      // formal task must open.
      session.onThinkingChange(true);
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
      const [, started] = sendAgentMessage.mock.calls[0] ?? [];
      expect(started?.type).toBe('task_started');

      // Turn end: task_complete must fire — this is the completed-status/notification trigger.
      session.onThinkingChange(false);
      expect(sendAgentMessage).toHaveBeenCalledTimes(2);
      const [, completed] = sendAgentMessage.mock.calls[1] ?? [];
      expect(completed).toEqual({ type: 'task_complete', id: started.id });
    } finally {
      session.cleanup();
    }
  });

  it('does not emit orphan ACP task_complete events', () => {
    const sendAgentMessage = vi.fn();
    const client = createSessionClientStub({ sendAgentMessage });

    const session = createSession(client);

    try {
      session.onThinkingChange(false);
      expect(sendAgentMessage).not.toHaveBeenCalled();
    } finally {
      session.cleanup();
    }
  });

  it('routes statusline runtime reconciles to the registered reconciler; a stale unregister never clobbers a newer one', () => {
    const client = createSessionClientStub();
    const session = createSession(client);

    try {
      // No reconciler registered: forwarding is a silent no-op.
      session.reconcileClaudeRuntimeFromStatusline({ model: 'claude-fable-5' });

      const first = vi.fn();
      const unregisterFirst = session.setClaudeStatuslineRuntimeReconciler(first);
      session.reconcileClaudeRuntimeFromStatusline({ model: 'claude-fable-5', reasoningEffort: 'high' });
      expect(first).toHaveBeenCalledWith({ model: 'claude-fable-5', reasoningEffort: 'high' });

      // A relaunched host registers a fresh reconciler; the stale unregister must not clear it.
      const second = vi.fn();
      session.setClaudeStatuslineRuntimeReconciler(second);
      unregisterFirst();
      session.reconcileClaudeRuntimeFromStatusline({ reasoningEffort: 'medium' });
      expect(second).toHaveBeenCalledWith({ reasoningEffort: 'medium' });
      expect(first).toHaveBeenCalledTimes(1);
    } finally {
      session.cleanup();
    }
  });
});
