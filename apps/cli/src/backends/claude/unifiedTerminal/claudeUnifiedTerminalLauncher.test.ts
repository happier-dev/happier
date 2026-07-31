import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostHandle } from '@/integrations/terminalHost/_types';
import { TerminalHostStartupError } from '@/integrations/terminalHost/errors';
import type { TerminalAttachmentInfo } from '@/terminal/attachment/terminalAttachmentInfo';
import type { AccountSettings } from '@happier-dev/protocol';
import type { Metadata } from '@/api/types';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';

import type { Session } from '../session';
import type { EnhancedMode } from '../loop';

const mocks = vi.hoisted(() => ({
  runClaudeUnifiedTerminalSession: vi.fn(),
  runTmuxAttach: vi.fn(async () => 0),
  runZellijAttach: vi.fn(async () => 0),
  dispatchActivityNotificationAsync: vi.fn(async () => undefined),
  reportConnectedServiceRuntimeAuthFailureToDaemon: vi.fn(async () => ({
    handled: false,
    report: null,
    statusCode: null,
    statusMessage: null,
  })),
}));

vi.mock('./runClaudeUnifiedTerminalSession', () => ({
  runClaudeUnifiedTerminalSession: mocks.runClaudeUnifiedTerminalSession,
}));

vi.mock('@/terminal/attachment/tmuxAttach', () => ({
  runTmuxAttach: mocks.runTmuxAttach,
}));

vi.mock('@/terminal/attachment/zellijAttach', () => ({
  runZellijAttach: mocks.runZellijAttach,
}));

vi.mock('@/activity/notifications/dispatchActivityNotification', () => ({
  dispatchActivityNotificationAsync: mocks.dispatchActivityNotificationAsync,
}));

vi.mock('@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon', () => ({
  reportConnectedServiceRuntimeAuthFailureToDaemon: mocks.reportConnectedServiceRuntimeAuthFailureToDaemon,
}));

import { claudeUnifiedTerminalLauncher } from './claudeUnifiedTerminalLauncher';
import { ClaudeUnifiedTerminalManagedSettingsOptionError } from './buildClaudeUnifiedTerminalSpawn';
import { ClaudeUnifiedTerminalReadinessTimeoutError } from './createClaudeUnifiedTerminalReadinessBridge';
import { createFakeControlPort } from './tuiControls/fakeControlPort';
import { parseClaudeScreenState } from './tuiControls/screenState';

const originalStdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

const RESUME_CHOICE_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

function setProcessTty(value: boolean): void {
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value });
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value });
}

function restoreProcessTty(): void {
  if (originalStdinIsTTY) {
    Object.defineProperty(process.stdin, 'isTTY', originalStdinIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, 'isTTY');
  }
  if (originalStdoutIsTTY) {
    Object.defineProperty(process.stdout, 'isTTY', originalStdoutIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, 'isTTY');
  }
}

function createSession(overrides: Readonly<{
  terminalRuntime?: Session['terminalRuntime'];
  metadata?: Metadata;
}> = {}): Session {
  return {
    path: '/workspace/project',
    client: {
      sessionId: 'happy-session-id',
      sendSessionEvent: vi.fn(),
      sendClaudeSessionMessage: vi.fn(),
      getMetadataSnapshot: vi.fn(() => overrides.metadata ?? {}),
      recordClaudeJsonlMessageConsumed: vi.fn(),
      deferDeliveredUserMessageWatermarkToProviderAcceptance: vi.fn(),
      confirmUserMessageDeliveredToProvider: vi.fn(),
      hasUserMessageProviderAcceptance: vi.fn(() => false),
      registerSessionRuntimeControls: vi.fn(() => vi.fn()),
      updateAgentState: vi.fn((updater: (state: unknown) => unknown) => updater({ capabilities: {} })),
      fetchCommittedClaudeJsonlMessageBaseline: vi.fn(async () => ({ keys: new Set<string>(), complete: true, oldestCoveredAtMs: null })),
      fetchRecentTranscriptTextItemsForAcpImport: vi.fn(async () => []),
      sessionTurnLifecycle: {
        beginTurn: vi.fn(async () => ({ turnId: 'turn-1' })),
        completeTurn: vi.fn(async () => undefined),
        cancelTurn: vi.fn(async () => undefined),
        failTurn: vi.fn(async () => undefined),
      },
      rpcHandlerManager: {
        registerHandler: vi.fn(),
      },
      flush: vi.fn(async () => undefined),
      // Pending-queue drain surface consumed by the launcher's session input consumer.
      // Defaults keep legacy tests inert: nothing pending, metadata wait never fires.
      shouldAttemptPendingMaterialization: vi.fn(() => false),
      popPendingMessage: vi.fn(async () => false),
      reconcilePendingQueueState: vi.fn(async () => false),
      waitForMetadataUpdate: vi.fn(() => new Promise<boolean>(() => undefined)),
    },
    pushSender: null,
    accountSettings: null,
    sessionId: 'claude-session-id',
    lastPermissionMode: 'default',
    lastPermissionModeUpdatedAt: 0,
    adoptLastPermissionModeFromMetadata: vi.fn(() => true),
    transcriptPath: null,
    claudeArgs: [],
    terminalRuntime: overrides.terminalRuntime ?? null,
    hookSettingsPath: undefined,
    hookPluginDir: null,
    queue: {
      size: vi.fn(() => 0),
      waitForMessagesSignal: vi.fn(async () => true),
      waitForMessagesAndGetAsString: vi.fn(),
      unshift: vi.fn(),
    },
    getOrCreateHappierMcpBridge: vi.fn(async () => ({ mcpConfigJson: '{}' })),
    addClaudeSessionHookCallback: vi.fn(),
    removeClaudeSessionHookCallback: vi.fn(),
    onSessionFound: vi.fn(),
    onThinkingChange: vi.fn(),
    setThinkingWithoutTaskLifecycle: vi.fn(),
    noteUserAbortRequested: vi.fn(),
    abortCurrentTaskTurn: vi.fn(),
  } as unknown as Session;
}

function readFirstInvocationOrder(
  spy: Readonly<{ mock: Readonly<{ invocationCallOrder: readonly number[] }> }>,
  label: string,
): number {
  const order = spy.mock.invocationCallOrder[0];
  if (typeof order !== 'number') {
    throw new Error(`Expected ${label} to have been called`);
  }
  return order;
}

function getFailTurnSpy(session: Session) {
  const failTurn = session.client.sessionTurnLifecycle?.failTurn;
  if (!failTurn) {
    throw new Error('test fixture missing sessionTurnLifecycle.failTurn');
  }
  return vi.mocked(failTurn);
}

describe('claudeUnifiedTerminalLauncher', () => {
  afterEach(() => {
    restoreProcessTty();
    vi.clearAllMocks();
  });

  it('foreground-attaches tty-started tmux unified sessions after the host is ready', async () => {
    setProcessTty(true);
    const terminal: NonNullable<TerminalAttachmentInfo['terminal']> = {
      mode: 'tmux',
      tmux: { target: 'happy:unified-window' },
    };
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happy',
      paneId: 'unified-window',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalHostReady?: (params: { handle: TerminalHostHandle; terminal: NonNullable<TerminalAttachmentInfo['terminal']> }) => void;
    }) => {
      opts.onTerminalHostReady?.({ handle, terminal });
    });

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(mocks.runTmuxAttach).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal,
    });
  });

  it('foreground-attaches tty-started zellij unified sessions after the host is ready', async () => {
    setProcessTty(true);
    const terminal = {
      mode: 'zellij',
      zellij: { sessionName: 'happy-zellij', paneId: 'terminal_7' },
    } as NonNullable<TerminalAttachmentInfo['terminal']>;
    const handle: TerminalHostHandle = {
      kind: 'zellij',
      sessionName: 'happy-zellij',
      paneId: 'terminal_7',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalHostReady?: (params: { handle: TerminalHostHandle; terminal: NonNullable<TerminalAttachmentInfo['terminal']> }) => void;
    }) => {
      opts.onTerminalHostReady?.({ handle, terminal });
    });

    await claudeUnifiedTerminalLauncher(createSession(), {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runZellijAttach).toHaveBeenCalledWith({
      sessionId: 'happy-session-id',
      terminal,
    });
  });

  it('uses the active tmux runtime as the unified terminal host for tmux-launched sessions', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: {
        mode: 'tmux',
        requested: 'tmux',
        tmuxTarget: 'happy:unified-window',
      },
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }),
    );
  });

  it('uses the active tmux runtime as the unified terminal host for tmux-launched initial prompts', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: {
        mode: 'tmux',
        requested: 'tmux',
        tmuxTarget: 'happy:unified-window',
      },
    });
    session.claudeArgs = ['--print', 'hello'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      initialMode?: EnhancedMode;
      nextMessage?: () => Promise<{ message: string; mode: EnhancedMode } | null>;
    }) => {
      expect(opts.initialMode).toBeUndefined();
      const first = await opts.nextMessage?.();
      expect(first).toEqual(expect.objectContaining({
        message: 'hello',
        mode: expect.objectContaining({
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }));
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });
  });

  it('uses tmux session metadata as the unified terminal host when runtime flags are absent', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: null,
      metadata: {
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:unified-window' },
        },
      } as Metadata,
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          claudeUnifiedTerminalHost: 'tmux',
        }),
      }),
    );
  });

  it('uses zellij session metadata as the unified terminal host when runtime flags are absent', async () => {
    setProcessTty(false);
    const session = createSession({
      terminalRuntime: null,
      metadata: {
        terminal: {
          mode: 'zellij',
          requested: 'zellij',
          zellij: { sessionName: 'happy-zellij', paneId: 'terminal_7' },
        },
      } as Metadata,
    });
    mocks.runClaudeUnifiedTerminalSession.mockResolvedValueOnce(undefined);

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledWith(
      expect.objectContaining({
        initialMode: expect.objectContaining({
          claudeUnifiedTerminalHost: 'zellij',
        }),
      }),
    );
  });

  it('requeues a message the runner could not deliver back onto the session queue (silent queue-swallow fix)', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      returnUnconsumedMessage?: (input: { message: string; mode: unknown }) => void;
    }) => {
      opts.returnUnconsumedMessage?.({
        message: 'arrived during unwind',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.queue.unshift).toHaveBeenCalledWith(
      'arrived during unwind',
      { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
      { userMessageSeq: null, userMessageLocalIds: [] },
    );
  });

  it('passes a startup resume-choice resolver that uses the startup mode preference', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      createStartupDialogResolver?: (input: {
        controlPort: ReturnType<typeof createFakeControlPort>;
        startupMode: EnhancedMode;
      }) => ((input: {
        screenState: ReturnType<typeof parseClaudeScreenState>;
        observedAtMs: number;
        abortSignal: AbortSignal;
      }) => Promise<{ status: string }>);
    }) => {
      const port = createFakeControlPort({ captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER] });
      const resolver = opts.createStartupDialogResolver?.({
        controlPort: port,
        startupMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalResumeChoice: 'resume_full_session',
        },
      });
      expect(resolver).toBeDefined();
      await expect(resolver?.({
        screenState: parseClaudeScreenState(RESUME_CHOICE_DIALOG),
        observedAtMs: 1,
        abortSignal: new AbortController().signal,
      })).resolves.toEqual({ status: 'handled' });
      expect(port.sentLiteral).toEqual(['2']);
      expect(port.sentKeys).toEqual(['Enter']);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
        claudeUnifiedTerminalResumeChoice: 'resume_full_session',
      },
    });
  });

  it('defers the delivered watermark until provider acceptance and preserves seq on handback', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    };
    const client = session.client as unknown as {
      deferDeliveredUserMessageWatermarkToProviderAcceptance: ReturnType<typeof vi.fn>;
      confirmUserMessageDeliveredToProvider: ReturnType<typeof vi.fn>;
    };
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
      unshift: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'queued before acceptance',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 17,
      userMessageLocalIds: ['l17'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage?: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      returnUnconsumedMessage?: (input: { message: string; mode: typeof mode; maxUserMessageSeq?: number | null; userMessageLocalIds?: readonly string[] }) => void;
      onPromptAcceptedByProvider?: (input: { message: string; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] }) => void;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch).toMatchObject({
        message: 'queued before acceptance',
        maxUserMessageSeq: 17,
        userMessageLocalIds: ['l17'],
      });
      expect(client.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();

      opts.returnUnconsumedMessage?.({
        message: 'queued before acceptance',
        mode,
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
      expect(client.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();

      opts.onPromptAcceptedByProvider?.({
        message: 'queued before acceptance',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(client.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
    expect(queue.unshift).toHaveBeenCalledWith(
      'queued before acceptance',
      mode,
      { userMessageSeq: 17, userMessageLocalIds: ['l17'] },
    );
    expect(client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith(17, { localIds: ['l17'] });
  });

  it('passes core provider-acceptance state to the unified terminal runner', async () => {
    setProcessTty(false);
    const session = createSession();
    const client = session.client as unknown as {
      hasUserMessageProviderAcceptance: ReturnType<typeof vi.fn>;
    };
    client.hasUserMessageProviderAcceptance.mockReturnValueOnce(true);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      isPromptDeliveryAccepted?: (batch: {
        message: string;
        maxUserMessageSeq?: number | null;
        userMessageLocalIds?: readonly string[];
      }) => boolean;
    }) => {
      expect(opts.isPromptDeliveryAccepted?.({
        message: 'already accepted',
        maxUserMessageSeq: 739,
        userMessageLocalIds: ['prompt-739'],
      })).toBe(true);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(client.hasUserMessageProviderAcceptance).toHaveBeenCalledWith({
      userMessageSeq: 739,
      localIds: ['prompt-739'],
    });
  });

  it('registers terminal composer clear through additive session runtime controls', async () => {
    setProcessTty(false);
    const session = createSession();
    const unregister = vi.fn();
    const client = session.client as unknown as {
      registerSessionRuntimeControls: ReturnType<typeof vi.fn>;
    };
    client.registerSessionRuntimeControls.mockReturnValueOnce(unregister);

    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      registerTerminalComposerClearRuntimeControl?: (
        handler: (request: Readonly<{ sessionId: string }>) => Promise<unknown>,
      ) => (() => void) | void;
    }) => {
      expect(typeof opts.registerTerminalComposerClearRuntimeControl).toBe('function');
      const handler = vi.fn(async () => ({ ok: true, status: 'already_empty', sessionId: 'happy-session-id' }));
      const dispose = opts.registerTerminalComposerClearRuntimeControl?.(handler);

      expect(client.registerSessionRuntimeControls).toHaveBeenCalledWith({
        clearTerminalComposer: handler,
      });
      dispose?.();
      expect(unregister).toHaveBeenCalledTimes(1);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });
  });

  it('terminalizes deterministic pre-provider rejections through the delivered watermark', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = {
      permissionMode: 'default',
      claudeUnifiedTerminalEnabled: true,
      claudeUnifiedTerminalHost: 'tmux',
    };
    const client = session.client as unknown as {
      deferDeliveredUserMessageWatermarkToProviderAcceptance: ReturnType<typeof vi.fn>;
      confirmUserMessageDeliveredToProvider: ReturnType<typeof vi.fn>;
    };
    const queue = session.queue as unknown as {
      size: ReturnType<typeof vi.fn>;
      waitForMessagesAndGetAsString: ReturnType<typeof vi.fn>;
      unshift: ReturnType<typeof vi.fn>;
    };
    queue.size.mockReturnValueOnce(1).mockReturnValue(0);
    queue.waitForMessagesAndGetAsString.mockResolvedValueOnce({
      message: 'bad\u0000prompt',
      mode,
      isolate: false,
      hash: 'unified-mode',
      maxUserMessageSeq: 73,
      userMessageLocalIds: ['l73'],
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage?: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      onPromptTerminallyRejectedBeforeProvider?: (input: {
        message: string;
        maxUserMessageSeq: number | null;
        userMessageLocalIds: readonly string[];
        reason: 'invalid_prompt_text';
      }) => void;
    }) => {
      const batch = await opts.nextMessage?.();
      expect(batch).toMatchObject({
        message: 'bad\u0000prompt',
        maxUserMessageSeq: 73,
        userMessageLocalIds: ['l73'],
      });
      expect(client.confirmUserMessageDeliveredToProvider).not.toHaveBeenCalled();

      opts.onPromptTerminallyRejectedBeforeProvider?.({
        message: 'bad\u0000prompt',
        maxUserMessageSeq: batch?.maxUserMessageSeq ?? null,
        userMessageLocalIds: batch?.userMessageLocalIds ?? [],
        reason: 'invalid_prompt_text',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(client.deferDeliveredUserMessageWatermarkToProviderAcceptance).toHaveBeenCalledTimes(1);
    expect(queue.unshift).not.toHaveBeenCalled();
    expect(client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledTimes(1);
    expect(client.confirmUserMessageDeliveredToProvider).toHaveBeenCalledWith(73, { localIds: ['l73'] });
  });

  it('suppresses Claude transcript user echoes for accepted UI prompts', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onMessage?: (message: unknown) => void;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'user-echo',
        message: { role: 'user', content: 'hello from ui' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'assistant-reply',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledTimes(1);
    expect(session.client.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'user-echo',
    }));
    expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-reply',
    }));
  });

  it('suppresses historical persisted user echoes during unified resume replay without suppressing fresh terminal input', async () => {
    setProcessTty(false);
    const session = createSession();
    const fetchRecentTranscriptTextItemsForAcpImport = session.client.fetchRecentTranscriptTextItemsForAcpImport;
    if (!fetchRecentTranscriptTextItemsForAcpImport) {
      throw new Error('test fixture missing fetchRecentTranscriptTextItemsForAcpImport');
    }
    vi.mocked(fetchRecentTranscriptTextItemsForAcpImport).mockResolvedValueOnce([
      { role: 'user', text: 'repeatable prompt' },
      { role: 'agent', text: 'old reply' },
    ]);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'user',
        uuid: 'historical-user-echo',
        timestamp: '2000-01-01T00:00:00.000Z',
        message: { role: 'user', content: 'repeatable prompt' },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'fresh-terminal-user',
        timestamp: new Date(Date.now() + 1_000).toISOString(),
        message: { role: 'user', content: 'repeatable prompt' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'assistant-reply',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.fetchRecentTranscriptTextItemsForAcpImport).toHaveBeenCalledWith({ take: 500 });
    expect(session.client.recordClaudeJsonlMessageConsumed).toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'historical-user-echo',
    }));
    expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledTimes(2);
    expect(session.client.sendClaudeSessionMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'user',
      uuid: 'fresh-terminal-user',
    }));
    expect(session.client.sendClaudeSessionMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'assistant',
      uuid: 'assistant-reply',
    }));
  });

  it('does not persist Claude compact summary or compact local-command artifacts from unified transcripts', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-summary-1',
        isCompactSummary: true,
        isVisibleInTranscriptOnly: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context.',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'local-command-caveat-1',
        isMeta: true,
        message: {
          role: 'user',
          content: '<local-command-caveat>Caveat: local command messages follow.</local-command-caveat>',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-command-1',
        message: {
          role: 'user',
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-stdout-1',
        message: {
          role: 'user',
          content:
            '<local-command-stdout>\u001b[2mCompacted (ctrl+o to see full summary)\u001b[22m\n' +
            "\u001b[2mPreCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully\u001b[22m\n" +
            "\u001b[2mPostCompact [python3 '/Users/leeroy/.claude/hooks/claude-island-state.py'] completed successfully\u001b[22m</local-command-stdout>",
        },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sendClaudeSessionMessage).not.toHaveBeenCalled();
  });

  it('does not emit a stale compaction started event after a compact boundary completed event', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onMessage?: (message: unknown) => void;
    }) => {
      opts.onMessage?.({
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-1',
        session_id: 'claude-session-id',
        content: 'Conversation compacted',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'compact-command-1',
        message: {
          role: 'user',
          content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
        },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    const compactionEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event)
      .filter((event) => (event as { type?: unknown }).type === 'context-compaction');

    expect(compactionEvents.map((event) => (event as { phase?: unknown }).phase)).toEqual(['completed']);
  });

  it('starts the canonical Claude turn only after a new-turn terminal injection is accepted', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
    }) => {
      expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.setThinkingWithoutTaskLifecycle).toHaveBeenCalledWith(true);
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(true);
  });

  it('completes the canonical Claude turn when unified lifecycle reports ready', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.completeTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });
    expect(readFirstInvocationOrder(vi.mocked(session.client.sessionTurnLifecycle!.completeTurn!), 'completeTurn')).toBeGreaterThan(
      readFirstInvocationOrder(vi.mocked(session.client.sessionTurnLifecycle!.beginTurn), 'beginTurn'),
    );
  });

  it('starts and completes a canonical Claude turn for terminal-originated unified prompts', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onProviderPromptStarted?: () => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onProviderPromptStarted?.();
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
      expect(session.client.sessionTurnLifecycle?.completeTurn).toHaveBeenCalledWith({ provider: 'claude' });
    });
  });

  it('does not start a second canonical turn for in-flight steering injections', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'in_flight_steer';
        turnStateAtInjection: 'running';
      }) => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'steer this turn',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'in_flight_steer',
        turnStateAtInjection: 'running',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.beginTurn).not.toHaveBeenCalled();
    expect(session.setThinkingWithoutTaskLifecycle).not.toHaveBeenCalledWith(true);
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(true);
  });

  it('uses a CLI positional prompt as the first terminal-injected unified input', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'run pwd'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      claudeArgs?: readonly string[];
      initialMode?: unknown;
      allowFirstInputBeforeSessionStart?: boolean;
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      expect(opts.claudeArgs).toEqual(['--model', 'opus']);
      expect(opts.initialMode).toBeUndefined();
      expect(opts.allowFirstInputBeforeSessionStart).toBe(true);
      const first = await opts.nextMessage();
      expect(first).toEqual({
        message: 'run pwd',
        mode: expect.objectContaining({
          permissionMode: 'acceptEdits',
          claudeUnifiedTerminalHost: 'zellij',
        }),
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
  });

  it('retries a CLI positional prompt when terminal-host startup fails before runner handback', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'run pwd'];
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after cleanup',
    });
    let runCount = 0;
    const observedPrompts: Array<string | null> = [];
    mocks.runClaudeUnifiedTerminalSession.mockImplementation(async (opts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      runCount += 1;
      const next = await opts.nextMessage();
      observedPrompts.push(next?.message ?? null);
      expect(next).toEqual(expect.objectContaining({
        message: 'run pwd',
        mode: expect.objectContaining({
          permissionMode: 'acceptEdits',
          claudeUnifiedTerminalHost: 'zellij',
        }),
      }));
      if (runCount === 1) {
        throw startupError;
      }
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(observedPrompts).toEqual(['run pwd', 'run pwd']);
  });

  it('imports CLI positional prompt transcript rows because Happier has no submitted-message echo to suppress', async () => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = ['--model', 'opus', 'source cli prompt'];
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onMessage?: (message: unknown) => void;
    }) => {
      const first = await opts.nextMessage();
      expect(first).toEqual(expect.objectContaining({
        message: 'source cli prompt',
      }));
      if (!first) throw new Error('Expected CLI positional prompt');

      await opts.onTerminalPromptInjected?.({
        message: first.message,
        mode: first.mode,
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      opts.onMessage?.({
        type: 'user',
        uuid: 'cli-positional-user',
        message: { role: 'user', content: 'source cli prompt' },
      });
      opts.onMessage?.({
        type: 'assistant',
        uuid: 'cli-positional-assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'acceptEdits',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(session.client.recordClaudeJsonlMessageConsumed).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'user',
      uuid: 'cli-positional-user',
    }));
    expect(session.client.sendClaudeSessionMessage).toHaveBeenCalledTimes(2);
    expect(session.client.sendClaudeSessionMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'user',
      uuid: 'cli-positional-user',
    }));
    expect(session.client.sendClaudeSessionMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'assistant',
      uuid: 'cli-positional-assistant',
    }));
  });

  it('allows the first session-queue prompt before Claude lifecycle starts', async () => {
    setProcessTty(false);
    const session = createSession();
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValueOnce({
      message: 'daemon queued prompt',
      mode: {
        permissionMode: 'safe-yolo',
        claudeUnifiedTerminalEnabled: true,
        localId: 'daemon-initial-prompt:happy-session-id',
      },
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      allowFirstInputBeforeSessionStart?: boolean;
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      expect(opts.allowFirstInputBeforeSessionStart).toBe(true);
      await expect(opts.nextMessage()).resolves.toEqual({
        message: 'daemon queued prompt',
        mode: expect.objectContaining({
          permissionMode: 'safe-yolo',
          claudeUnifiedTerminalEnabled: true,
        }),
        maxUserMessageSeq: null,
        userMessageLocalIds: [],
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: undefined,
    });
  });

  it('materializes server-side pending messages while waiting for input instead of waiting only on the local queue (daemon-owned drain, QA C-F2/A-F3)', async () => {
    setProcessTty(false);
    const session = createSession();
    // Server holds one queued pending row; the local queue is empty until materialization
    // commits it (the transcript update path then delivers it into the queue).
    let queueSize = 0;
    vi.mocked(session.queue.size).mockImplementation(() => queueSize);
    const materializeNextPendingMessageSafely = vi.fn(async () => {
      queueSize = 1;
      return { type: 'materialized' as const };
    });
    (session.client as unknown as Record<string, unknown>).materializeNextPendingMessageSafely =
      materializeNextPendingMessageSafely;
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueSize = 0;
      return { message: 'queued on server', mode: { permissionMode: 'default' }, hash: 'h1' } as never;
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (runOpts: {
      nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
    }) => {
      await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
        message: 'queued on server',
      }));
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    expect(materializeNextPendingMessageSafely).toHaveBeenCalledWith({
      reconcileWhenEmpty: 'skip',
    });
  });

  it('attempts pending materialization while parked after host death (queued messages must not require a manual Send now)', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    const materializeNextPendingMessageSafely = vi.fn(async () => ({ type: 'no_pending' as const }));
    (session.client as unknown as Record<string, unknown>).materializeNextPendingMessageSafely =
      materializeNextPendingMessageSafely;
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValueOnce({ message: 'try again', mode: { permissionMode: 'default' }, hash: 'h1' } as never)
      .mockResolvedValue(null as never);
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(hostDeadError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'try again' }));
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    // The parked wait must include the daemon-owned pending drain, not just the local queue.
    expect(materializeNextPendingMessageSafely).toHaveBeenCalled();
  });

  it('forwards the resolved default coding prompt into unified terminal spawn options', async () => {
    setProcessTty(false);
    const session = createSession();
    Object.defineProperty(session, 'defaultSystemPromptText', {
      configurable: true,
      value: 'Resolved default coding prompt',
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      systemPromptText?: string | null;
    }) => {
      expect(opts.systemPromptText).toBe('Resolved default coding prompt');
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });
  });

  it('uses the committed assistant snapshot for unified ready notifications after terminal injection starts a turn', async () => {
    setProcessTty(false);
    const session = createSession();
    const sendToAllDevices = vi.fn();
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'ready-turn-1');
    const getTurnAssistantTextSnapshot = vi.fn((params: { turnToken?: string | null; startSeqExclusive?: number | null }) => (
      params.turnToken === 'ready-turn-1' && params.startSeqExclusive === 42
        ? {
            turnToken: 'ready-turn-1',
            text: 'Latest unified assistant response',
            observedAtMs: 123,
            seq: 45,
            localId: 'assistant-message-1',
            sidechainId: null,
            provider: 'claude',
            source: 'committed' as const,
          }
        : null
    ));
    (session as any).pushSender = { sendToAllDevices };
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 42);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 42 });
    expect(getTurnAssistantTextSnapshot).toHaveBeenCalledWith({
      turnToken: 'ready-turn-1',
      startSeqExclusive: 42,
    });
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Claude',
      'Latest unified assistant response',
      { sessionId: 'happy-session-id' },
    );
  });

  it('uses the committed assistant snapshot for terminal-originated unified ready notifications', async () => {
    setProcessTty(false);
    const session = createSession();
    const sendToAllDevices = vi.fn();
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'terminal-turn-1');
    const getTurnAssistantTextSnapshot = vi.fn((params: { turnToken?: string | null; startSeqExclusive?: number | null }) => (
      params.turnToken === 'terminal-turn-1' && params.startSeqExclusive === 7
        ? {
            turnToken: 'terminal-turn-1',
            text: 'Direct terminal assistant response',
            observedAtMs: 456,
            seq: 9,
            localId: 'assistant-message-terminal',
            sidechainId: null,
            provider: 'claude',
            source: 'committed' as const,
          }
        : null
    ));
    (session as any).pushSender = { sendToAllDevices };
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 7);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onProviderPromptStarted?: () => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onProviderPromptStarted?.();
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(beginTurnAssistantTextSnapshot).toHaveBeenCalledWith({ startSeqExclusive: 7 });
    expect(getTurnAssistantTextSnapshot).toHaveBeenCalledWith({
      turnToken: 'terminal-turn-1',
      startSeqExclusive: 7,
    });
    expect(sendToAllDevices).toHaveBeenCalledWith(
      'Claude',
      'Direct terminal assistant response',
      { sessionId: 'happy-session-id' },
    );
  });

  it('honors account notification settings and secrets for unified ready notifications', async () => {
    setProcessTty(false);
    const session = createSession();
    const settingsSecretsReadKeys = [new Uint8Array(32).fill(5)];
    const accountSettings = {
      notificationsSettingsV1: {
        v: 1,
        pushEnabled: true,
        ready: true,
        readyIncludeMessageText: false,
        permissionRequest: true,
      },
    } as AccountSettings;
    const beginTurnAssistantTextSnapshot = vi.fn(() => 'ready-turn-no-preview');
    const getTurnAssistantTextSnapshot = vi.fn(() => ({
      turnToken: 'ready-turn-no-preview',
      text: 'This text must not be included',
      observedAtMs: 123,
      seq: 45,
      localId: 'assistant-message-hidden',
      sidechainId: null,
      provider: 'claude',
      source: 'committed' as const,
    }));
    (session as any).pushSender = { sendToAllDevicesAsync: vi.fn() };
    (session as any).accountSettings = accountSettings;
    (session as any).accountSettingsSecretsReadKeys = settingsSecretsReadKeys;
    (session.client as any).getLastObservedMessageSeq = vi.fn(() => 42);
    (session.client as any).beginTurnAssistantTextSnapshot = beginTurnAssistantTextSnapshot;
    (session.client as any).getTurnAssistantTextSnapshot = getTurnAssistantTextSnapshot;
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onReady?: () => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'hello from ui',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onReady?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(mocks.dispatchActivityNotificationAsync).toHaveBeenCalledWith(expect.objectContaining({
        settings: accountSettings,
        settingsSecretsReadKeys,
        event: expect.objectContaining({
          topic: 'ready',
          assistantPreviewText: null,
        }),
      }));
    });
    expect(getTurnAssistantTextSnapshot).not.toHaveBeenCalled();
  });

  it('surfaces unified StopFailure usage-limit details through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onUsageLimitDetails?: (details: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onUsageLimitDetails).toBeTypeOf('function');
      opts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        providerLimitId: 'rate_limit',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'claude',
          usageLimit: expect.objectContaining({
            providerLimitId: 'rate_limit',
          }),
        }),
      });
    });
  });

  it('surfaces unified overloaded capacity details through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onUsageLimitDetails?: (details: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onUsageLimitDetails).toBeTypeOf('function');
      opts.onUsageLimitDetails?.({
        v: 1,
        resetAtMs: null,
        retryAfterMs: null,
        quotaScope: 'account',
        recoverability: 'wait',
        limitCategory: 'capacity',
        providerLimitId: 'server_overloaded',
        planType: null,
        utilization: null,
        overage: null,
        action: null,
        connectedService: null,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
          usageLimit: expect.objectContaining({
            limitCategory: 'capacity',
            providerLimitId: 'server_overloaded',
          }),
        }),
      });
    });
  });

  it('surfaces unified transcript auth failures through the session runtime issue path', async () => {
    setProcessTty(false);
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'claude-main',
      fallbackProfileId: 'claude-main',
      generation: 1,
    }]);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onRuntimeAuthFailureEvent).toBeTypeOf('function');
      await opts.onRuntimeAuthFailureEvent?.({
        type: 'assistant',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      });
    });

    try {
      await claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'auto',
        },
      });
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
    }

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'auth_error',
          source: 'auth_error',
          provider: 'claude',
        }),
      });
    });
  });

  it('keeps provider auth evidence primary when terminal host death follows in the same failure window', async () => {
    setProcessTty(false);
    const previousSelectionEnv = process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
    process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = JSON.stringify([{
      kind: 'group',
      serviceId: 'claude-subscription',
      groupId: 'claude',
      activeProfileId: 'claude-main',
      fallbackProfileId: 'claude-main',
      generation: 1,
    }]);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onRuntimeAuthFailureEvent?: (error: unknown) => void | Promise<void>;
    }) => {
      expect(opts.onRuntimeAuthFailureEvent).toBeTypeOf('function');
      await opts.onRuntimeAuthFailureEvent?.({
        type: 'assistant',
        isApiErrorMessage: true,
        error: 'authentication_failed',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Not logged in · Please run /login' }],
        },
      });
      throw hostDeadError;
    });

    try {
      await expect(claudeUnifiedTerminalLauncher(session, {
        initialMode: {
          permissionMode: 'default',
          claudeUnifiedTerminalHost: 'zellij',
        },
      })).rejects.toBe(hostDeadError);
    } finally {
      if (previousSelectionEnv === undefined) {
        delete process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY];
      } else {
        process.env[HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY] = previousSelectionEnv;
      }
    }

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'auth_error',
        source: 'auth_error',
        provider: 'claude',
      }),
    });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_process_exit',
        source: 'provider_process_exit',
      }),
    });
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('Claude unified terminal host is not alive'),
    }));
    expect(session.client.flush).toHaveBeenCalledTimes(1);
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('surfaces unified transcript provider API errors through the session runtime issue path', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (acceptedPrompt: {
        message: string;
        mode: { permissionMode: 'default'; claudeUnifiedTerminalEnabled: true };
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onPromptTurnTerminal?: (event: {
        reason: 'failed';
        source: string;
        detail?: string;
      }) => void | Promise<void>;
    }) => {
      expect(opts.onPromptTurnTerminal).toBeTypeOf('function');
      await opts.onTerminalPromptInjected?.({
        message: 'hello',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onPromptTurnTerminal?.({
        reason: 'failed',
        source: 'claude_transcript_api_error',
        detail: 'api_error',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    await vi.waitFor(() => {
      expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
        provider: 'claude',
        issue: expect.objectContaining({
          code: 'provider_status_error',
          source: 'provider_status_error',
          provider: 'claude',
        }),
      });
    });
  });

  it('cancels aborted terminal prompt turns without also marking them failed', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalPromptInjected?: (acceptedPrompt: {
        message: string;
        mode: { permissionMode: 'default'; claudeUnifiedTerminalEnabled: true };
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
      onPromptTurnTerminal?: (event: {
        reason: 'aborted';
        source: string;
      }) => void | Promise<void>;
    }) => {
      await opts.onTerminalPromptInjected?.({
        message: 'stop the current work',
        mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await opts.onPromptTurnTerminal?.({
        reason: 'aborted',
        source: 'claude_hook_stop',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'auto',
      },
    });

    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.abortCurrentTaskTurn).toHaveBeenCalled();
  });

  it('surfaces terminal host death through the primary turn runtime issue path and exits gracefully instead of escaping as a fatal command error', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(hostDeadError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_process_exit',
        source: 'provider_process_exit',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('Claude unified terminal host is not alive'),
    }));
    expect(session.client.sendSessionEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'message',
      message: expect.stringContaining('before Happier could send your prompt'),
    }));
    expect(session.client.flush).toHaveBeenCalled();
    expect(readFirstInvocationOrder(vi.mocked(session.client.flush), 'flush')).toBeGreaterThan(
      readFirstInvocationOrder(getFailTurnSpy(session), 'failTurn'),
    );
    expect(readFirstInvocationOrder(vi.mocked(session.client.flush), 'flush')).toBeGreaterThan(
      readFirstInvocationOrder(vi.mocked(session.client.sendSessionEvent), 'sendSessionEvent'),
    );
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('parks for the next message and relaunches the unified host after terminal host death', async () => {
    setProcessTty(false);
    const session = createSession();
    const hostDeadError = Object.assign(new Error('Claude unified terminal host is not alive'), {
      code: 'claude_unified_terminal_host_dead',
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValueOnce({ message: 'try again', mode: { permissionMode: 'default' }, hash: 'h1' } as never)
      .mockResolvedValue(null as never);
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(hostDeadError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({ message: 'try again' }));
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
  });

  it('surfaces terminal injection failures through the primary turn runtime issue path and exits gracefully instead of escaping as a fatal command error (incident cmq7pyqkj)', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal injection failed: timeout'), {
      code: 'claude_unified_terminal_injection_failed',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(injectionError);

    // The runner must NEVER exit fatally on a classified injection failure: it surfaces the
    // structured runtime issue and (with no queued message and a closed/aborted queue) exits
    // gracefully — never rethrows into `[claude] Fatal command error` (incident cmq7pyqkj).
    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
  });

  it('surfaces invalid prompt text once without parking, requeueing, or relaunching', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'invalid_prompt_text',
      phase: 'before_write',
      duplicateRisk: 'none',
      recoverable: false,
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValue({
      message: 'bad\u0000prompt',
      mode: { permissionMode: 'default' },
      hash: 'h1',
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(injectionError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
    expect(session.queue.unshift).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
  });

  it.each([
    ['separate --settings value', ['--settings', '/tmp/user-settings.json']],
    ['inline --settings=value', ['--settings={"permissions":{"allow":[]}}']],
  ])('surfaces managed %s rejection as a structured runtime issue without generic fatal escape', async (_label, claudeArgs) => {
    setProcessTty(false);
    const session = createSession();
    session.claudeArgs = claudeArgs;
    const settingsError = new ClaudeUnifiedTerminalManagedSettingsOptionError([
      { code: 'managed_settings_option', option: '--settings' },
    ]);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(settingsError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.client.flush).toHaveBeenCalled();
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
  });

  it('keeps the session alive after a fatal mid-turn injection failure: surfaces the issue, waits for the next message, and relaunches (incident cmq7pyqkj)', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValueOnce({ message: 'resume after failure', mode: { permissionMode: 'default' }, hash: 'h1' } as never)
      .mockResolvedValue(null as never);
    const secondRunFirstBatch: Array<{ message: string } | null> = [];
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(injectionError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: unknown } | null>;
      }) => {
        secondRunFirstBatch.push(await runOpts.nextMessage());
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(2);
    expect(secondRunFirstBatch).toEqual([expect.objectContaining({ message: 'resume after failure' })]);
    // The failed turn was surfaced as a structured runtime issue before parking.
    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
  });

  it('does not park and relaunch the same prompt after recoverable provider-acceptance timeout exhaustion', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
      reason: 'timeout',
      phase: 'after_enter_unknown',
      duplicateRisk: 'likely',
      recoverable: true,
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockResolvedValue({
      message: 'same unconfirmed prompt',
      mode: { permissionMode: 'default' },
      hash: 'h1',
      maxUserMessageSeq: 41,
    } as never);
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (runOpts: {
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => Promise<void> | void;
    }) => {
      await runOpts.onTerminalPromptInjected?.({
        message: 'same unconfirmed prompt',
        mode: { permissionMode: 'default' },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      throw injectionError;
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(1);
    expect(session.queue.waitForMessagesAndGetAsString).not.toHaveBeenCalled();
    expect(session.client.sessionTurnLifecycle?.beginTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('requeues a parked message when relaunch fails during terminal-host startup before runner handback', async () => {
    setProcessTty(false);
    const session = createSession();
    const mode = { permissionMode: 'default' };
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after cleanup',
    });
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValueOnce({
        message: 'retry after startup failure',
        mode,
        hash: 'h1',
        maxUserMessageSeq: 31,
      } as never)
      .mockResolvedValue(null as never);
    mocks.runClaudeUnifiedTerminalSession
      .mockRejectedValueOnce(injectionError)
      .mockImplementationOnce(async (runOpts: {
        nextMessage: () => Promise<{ message: string; mode: typeof mode; maxUserMessageSeq: number | null; userMessageLocalIds: readonly string[] } | null>;
      }) => {
        await expect(runOpts.nextMessage()).resolves.toEqual(expect.objectContaining({
          message: 'retry after startup failure',
          maxUserMessageSeq: 31,
        }));
        throw startupError;
      });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.queue.unshift).toHaveBeenCalledWith(
      'retry after startup failure',
      mode,
      { userMessageSeq: 31, userMessageLocalIds: [] },
    );
  });

  it('stops park/relaunch after the bounded budget of consecutive failures instead of looping forever (A4-MED-3)', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt injection failed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_terminal',
    });
    // A deterministically failing host with an always-available bounced message (the HIGH-2
    // handback re-pends the failed batch) must not relaunch unboundedly.
    vi.mocked(session.queue.waitForMessagesAndGetAsString)
      .mockResolvedValue({ message: 'poison message', mode: { permissionMode: 'default' }, hash: 'h1' } as never);
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValue(injectionError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    // 1 initial run + 3 budgeted relaunches.
    expect(mocks.runClaudeUnifiedTerminalSession).toHaveBeenCalledTimes(4);
    const events = vi.mocked(session.client.sendSessionEvent).mock.calls.map(([event]) => event as Record<string, unknown>);
    expect(events.some((event) => event.type === 'message' && String(event.message).includes('Not retrying automatically'))).toBe(true);
  });

  it('surfaces a startup readiness timeout as a structured runtime issue and exits without a generic fatal command error (D18 standalone class)', async () => {
    setProcessTty(false);
    const session = createSession();
    const readinessError = new ClaudeUnifiedTerminalReadinessTimeoutError({
      timeoutMs: 15_000,
      handle: {
        kind: 'zellij',
        sessionName: 'happier-claude-session-test',
        paneId: '1',
        attachMetadata: {
          attachStrategy: 'terminal_host',
          topology: 'shared',
          locality: 'same_machine',
          liveProbe: 'required',
        },
      },
      diagnostics: {
        elapsedMs: 16_000,
        hostAlive: true,
        sessionStartObserved: true,
        lastLivenessPaneAlive: true,
        lastScreenTail: 'Initializing Claude Code…',
      },
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(readinessError);

    // Resolves (no re-throw) so the readiness timeout never becomes a `[claude] Fatal command error`
    // / silent dead session, while still surfacing the structured runtime issue to the UI.
    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('surfaces terminal-host startup failures as structured runtime issues and exits without generic fatal handling', async () => {
    setProcessTty(false);
    const session = createSession();
    const startupError = new TerminalHostStartupError({
      hostKind: 'zellij',
      reason: 'pane_disappeared_after_bootstrap_cleanup',
      message: 'zellij launched terminal pane disappeared after bootstrap cleanup',
    });
    mocks.runClaudeUnifiedTerminalSession.mockRejectedValueOnce(startupError);

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 1 });

    expect(session.client.sessionTurnLifecycle?.failTurn).toHaveBeenCalledWith({
      provider: 'claude',
      issue: expect.objectContaining({
        code: 'provider_session_error',
        source: 'provider_session_error',
        provider: 'claude',
      }),
      allocateWhenIdle: true,
    });
    expect(session.onThinkingChange).toHaveBeenCalledWith(false);
    expect(session.client.flush).toHaveBeenCalled();
  });

  it('does not surface recoverable ambiguous terminal injection failures as primary turn failures', async () => {
    setProcessTty(false);
    const session = createSession();
    const injectionError = Object.assign(new Error('Claude unified terminal prompt submission could not be confirmed'), {
      code: 'claude_unified_terminal_injection_failed',
      failureState: 'failed_ambiguous',
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onTerminalInjectionFailure?: (error: Error) => void | Promise<void>;
    }) => {
      await opts.onTerminalInjectionFailure?.(injectionError);
    });

    await expect(claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    })).resolves.toEqual({ type: 'exit', code: 0 });

    expect(session.client.sessionTurnLifecycle?.failTurn).not.toHaveBeenCalled();
    expect(session.onThinkingChange).not.toHaveBeenCalledWith(false);
  });

  it('registers UI abort as a terminal-host turn interrupt for CLI-started unified sessions', async () => {
    setProcessTty(false);
    const session = createSession();
    const turnInterrupt = vi.fn(async () => {});
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
      setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void;
      onTerminalPromptInjected?: (accepted: {
        message: string;
        mode: unknown;
        acceptedAs: 'new_turn';
        turnStateAtInjection: 'idle';
      }) => void | Promise<void>;
    }) => {
      runnerSignal = opts.signal;
      opts.setTurnInterrupt?.(turnInterrupt);
      await opts.onTerminalPromptInjected?.({
        message: 'please stop this',
        mode: {
          permissionMode: 'default',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'auto',
        },
        acceptedAs: 'new_turn',
        turnStateAtInjection: 'idle',
      });
      await abortHandler?.();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.client.rpcHandlerManager.registerHandler).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(turnInterrupt).toHaveBeenCalledTimes(1);
    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(session.client.sessionTurnLifecycle?.cancelTurn).toHaveBeenCalledWith({ provider: 'claude' });
    expect(runnerSignal?.aborted).toBe(false);
    expect(session.client.sendSessionEvent).toHaveBeenCalledWith({ type: 'message', message: 'Aborted by user' });
  });

  it('does not stop the unified terminal host when UI abort is requested before an interrupt handler is ready', async () => {
    setProcessTty(false);
    const session = createSession();
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
    }) => {
      runnerSignal = opts.signal;
      expect(await abortHandler?.()).toBe(true);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(runnerSignal?.aborted).toBe(false);
  });

  it('does not stop the unified terminal host when terminal turn interruption fails', async () => {
    setProcessTty(false);
    const session = createSession();
    const turnInterrupt = vi.fn(async () => {
      throw new Error('terminal unavailable');
    });
    let abortHandler: (() => Promise<boolean>) | undefined;
    let runnerSignal: AbortSignal | undefined;
    vi.mocked(session.client.rpcHandlerManager.registerHandler).mockImplementation((method, handler) => {
      if (method === 'abort') {
        abortHandler = handler as () => Promise<boolean>;
      }
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      signal?: AbortSignal;
      setTurnInterrupt?: (handler: (() => Promise<void>) | null) => void;
    }) => {
      runnerSignal = opts.signal;
      opts.setTurnInterrupt?.(turnInterrupt);
      expect(await abortHandler?.()).toBe(true);
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(turnInterrupt).toHaveBeenCalledTimes(1);
    expect(session.noteUserAbortRequested).toHaveBeenCalledTimes(1);
    expect(session.abortCurrentTaskTurn).toHaveBeenCalledTimes(1);
    expect(runnerSignal?.aborted).toBe(false);
  });

  it('wires blocked-apply starvation honesty (F2): escalation surfaces ONE user-visible session message', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: { consecutiveBlockedApplies: number }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({ consecutiveBlockedApplies: 6 });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    const messageEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string })
      .filter((event) => event.type === 'message');
    expect(messageEvents).toHaveLength(1);
  });

  it('wires blocked-apply user-draft starvation to the clearable terminal composer event', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      tuiRuntimeControl?: {
        onBlockedApplyStarvation?: (info: { consecutiveBlockedApplies: number; blockedReason?: string | null }) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.onBlockedApplyStarvation?.({
        consecutiveBlockedApplies: 6,
        blockedReason: 'user_draft',
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string; reason?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toEqual([
      expect.objectContaining({
        type: 'terminal-composer-draft-blocked',
        reason: 'idle_draft_guard',
      }),
    ]);
    expect(session.client.updateAgentState).toHaveBeenCalledWith(expect.any(Function));
    const published = vi.mocked(session.client.updateAgentState).mock.calls
      .map(([updater]) => updater({ capabilities: {} } as never) as { capabilities?: Record<string, unknown> });
    expect(published.some((state) =>
      state.capabilities?.terminalComposerDraftPresent === true
      && state.capabilities?.terminalComposerClearSupported === true
    )).toBe(true);
  });

  it('wires idle draft-guard starvation honesty: escalation surfaces ONE user-visible session message', async () => {
    setProcessTty(false);
    const session = createSession();
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      onDraftGuardStarvation?: (info: {
        consecutiveDeferrals: number;
        guardStatus: 'foreign_draft';
        originKind: 'ui_pending';
        draftLength: number;
      }) => void;
    }) => {
      opts.onDraftGuardStarvation?.({
        consecutiveDeferrals: 4,
        guardStatus: 'foreign_draft',
        originKind: 'ui_pending',
        draftLength: 32,
      });
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'zellij',
      },
    });

    const draftBlockedEvents = vi.mocked(session.client.sendSessionEvent).mock.calls
      .map(([event]) => event as { type?: string; reason?: string; message?: string })
      .filter((event) => event.type === 'terminal-composer-draft-blocked');
    expect(draftBlockedEvents).toHaveLength(1);
    expect(draftBlockedEvents[0]).toMatchObject({
      reason: 'idle_draft_guard',
      message: expect.stringContaining('terminal composer'),
    });
    expect(session.client.updateAgentState).toHaveBeenCalledWith(expect.any(Function));
    const published = vi.mocked(session.client.updateAgentState).mock.calls
      .map(([updater]) => updater({ capabilities: {} } as never) as { capabilities?: Record<string, unknown> });
    expect(published.some((state) =>
      state.capabilities?.terminalComposerClearSupported === true
      && state.capabilities?.terminalComposerDraftPresent === true
    )).toBe(true);
  });

  it('applies metadata-only permission changes through the standalone unified runtime-control bridge', async () => {
    setProcessTty(false);
    const session = createSession();
    const applyMode = vi.fn(async () => ({ promptMayProceed: true, attempted: true } as const));
    let metadataWakeCount = 0;
    let queueReady = false;
    vi.mocked(session.client.getMetadataSnapshot).mockReturnValue({
      permissionMode: 'yolo',
      permissionModeUpdatedAt: 25,
    } as never);
    vi.mocked(session.client.waitForMetadataUpdate).mockImplementation(async () => {
      metadataWakeCount += 1;
      if (metadataWakeCount === 1) {
        queueReady = true;
        return true;
      }
      return false;
    });
    vi.mocked(session.queue.size).mockImplementation(() => queueReady ? 1 : 0);
    vi.mocked(session.queue.waitForMessagesAndGetAsString).mockImplementation(async () => {
      queueReady = false;
      return {
        message: 'after metadata',
        mode: {
          permissionMode: 'yolo',
          claudeUnifiedTerminalEnabled: true,
          claudeUnifiedTerminalHost: 'tmux',
        },
        isolate: false,
        hash: 'mode-yolo',
        maxUserMessageSeq: 25,
        userMessageLocalIds: [],
      };
    });
    mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
      nextMessage: () => Promise<{ message: string } | null>;
      tuiRuntimeControl?: {
        registerMetadataRuntimeModeApplier?: (
          apply: (mode: Record<string, unknown>) => Promise<{ promptMayProceed: boolean; attempted: boolean }>,
        ) => void;
      };
    }) => {
      opts.tuiRuntimeControl?.registerMetadataRuntimeModeApplier?.(applyMode);
      await opts.nextMessage();
    });

    await claudeUnifiedTerminalLauncher(session, {
      initialMode: {
        permissionMode: 'default',
        claudeUnifiedTerminalHost: 'tmux',
      },
    });

    expect(applyMode).toHaveBeenCalledWith(expect.objectContaining({
      permissionMode: 'yolo',
      claudeUnifiedTerminalEnabled: true,
    }));
  });

  // QA-B B6 (live 2026-06-12, session cmqawdqzj): gate OFF dropped a permission-mode change
  // between turns SILENTLY (no requires_restart notice, prompt ran under the stale mode). The
  // standalone launcher must surface the same legacy notices as the daemon launcher.
  it('gate OFF: surfaces the legacy requires_restart notice when a batch mode changes (B6)', async () => {
    setProcessTty(false);
    const previousGateEnv = process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
    process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = '0';
    try {
      const session = createSession();
      mocks.runClaudeUnifiedTerminalSession.mockImplementationOnce(async (opts: {
        nextMessage: () => Promise<{ message: string; mode: Record<string, unknown> } | null>;
        tuiRuntimeControl?: { featureEnabled: boolean };
      }) => {
        expect(opts.tuiRuntimeControl?.featureEnabled).toBe(false);
        await opts.nextMessage();
        await opts.nextMessage();
      });
      vi.mocked(session.queue.waitForMessagesAndGetAsString)
        .mockResolvedValueOnce({ message: 'first', mode: { permissionMode: 'default', claudeUnifiedTerminalEnabled: true }, isolate: false, hash: 'h1', maxUserMessageSeq: null, userMessageLocalIds: [] })
        .mockResolvedValueOnce({ message: 'second', mode: { permissionMode: 'plan', claudeUnifiedTerminalEnabled: true }, isolate: false, hash: 'h2', maxUserMessageSeq: null, userMessageLocalIds: [] });

      await claudeUnifiedTerminalLauncher(session, {});

      const events = vi.mocked(session.client.sendSessionEvent).mock.calls.map(([event]) => event as Record<string, unknown>);
      const messageEvents = events.filter((event) => event.type === 'message');
      expect(messageEvents.some((event) => String(event.message).includes('apply when Claude restarts'))).toBe(true);
      const outcomeEvents = events.filter((event) => event.type !== 'message');
      expect(JSON.stringify(outcomeEvents)).toContain('requires_restart');
    } finally {
      if (previousGateEnv === undefined) delete process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED;
      else process.env.HAPPIER_FEATURE_CLAUDE_UNIFIED_TUI_RUNTIME_CONTROL__ENABLED = previousGateEnv;
    }
  });
});
