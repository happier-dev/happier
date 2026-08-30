import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TerminalHostAdapter, TerminalHostHandle } from '@/integrations/terminalHost/_types';
import type { TerminalControlPort } from '@/integrations/terminalHost/controlTypes';
import type { RawJSONLines } from '../types';
import { createPermissionHandlerSessionStub } from '../utils/permissionHandler.testkit';
import { getProjectPath } from '../utils/path';
import type { SessionHookData } from '../utils/startHookServer';
import { createClaudeProviderActivityLedger } from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeProviderRuntimeActivityAdapter } from '../providerActivity/createClaudeProviderRuntimeActivityAdapter';
import { ClaudeUnifiedDialogChoiceBroker } from './dialogChoice/claudeUnifiedDialogChoiceBroker';
import { createClaudeUnifiedResumeChoiceStartupResolver } from './resumeChoice/claudeUnifiedResumeChoiceStartupResolver';
import { runClaudeUnifiedTerminalSession } from './runClaudeUnifiedTerminalSession';

const interactiveClaudeScreen = [
  'Some previous Claude output',
  '',
  'What would you like to work on?',
  '> ',
].join('\n');

const effortChangeDialog = [
  'Change effort level?',
  'This conversation is cached for the current effort level.',
  'Switching to high means the full history gets re-read before Claude can continue.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const swiftLspRecommendationDialog = [
  'LSP plugin recommendation',
  '',
  'LSP provides code intelligence like go-to-definition and error checking',
  '',
  'Plugin: swift-lsp',
  'Swift language server (SourceKit-LSP) for code intelligence',
  'Triggered by: .swift files',
  '',
  'Would you like to install this LSP plugin?',
  '❯ 1. Yes, install swift-lsp',
  '  2. No, not now',
  '  3. Never for swift-lsp',
  '  4. Disable all LSP recommendations',
].join('\n');

const resumeChoiceDialog = [
  'This session is 18h 2m old and 560.4k tokens.',
  'To reduce startup time, Claude can resume from the saved summary or load the full session.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

function composerScreen(draft: string, generating = false): string {
  return [
    ...(generating ? ['● Working…', '✶ Compacting… (esc to interrupt)'] : []),
    '╭───────────────────────────────────────────────╮',
    `│ > ${draft}`,
    '╰───────────────────────────────────────────────╯',
    '  ⏵⏵ accept edits on (shift+tab to cycle)',
  ].join('\n');
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('runClaudeUnifiedTerminalSession resumed hook activation', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('fails closed before prompt injection when Claude starts a different session than the explicit resume', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-resume-identity-mismatch-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const requestedSessionId = '11111111-1111-4111-8111-111111111111';
    const unexpectedSessionId = '22222222-2222-4222-8222-222222222222';
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${requestedSessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    const abortController = new AbortController();
    const onSessionFound = vi.fn(() => abortController.abort());
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let pendingPulled = false;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-resume-identity-mismatch-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const injectUserPrompt = vi.fn<TerminalHostAdapter['injectUserPrompt']>(async (_handle, input) => ({
      status: 'injected',
      at: Date.now(),
      bytesWritten: input.text.length,
    }));
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => {
        const hook = subscribedHook;
        if (!hook) throw new Error('provider launched before the hook subscription was installed');
        hook({
          hook_event_name: 'SessionStart',
          session_id: unexpectedSessionId,
          transcript_path: join(projectDir, `${unexpectedSessionId}.jsonl`),
          source: 'startup',
        });
        return handle;
      }),
      injectUserPrompt,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    try {
      await expect(runClaudeUnifiedTerminalSession({
        path: workspaceDir,
        happySessionId: 'resume-identity-mismatch-session',
        sessionId: requestedSessionId,
        transcriptPath,
        expectedProviderResumeSessionId: requestedSessionId,
        hookPluginDir: join(dir, 'owned-happier-hook-plugin'),
        signal: abortController.signal,
        nextMessage: async () => {
          if (pendingPulled) return await new Promise(() => undefined);
          pendingPulled = true;
          return {
            message: 'This must stay pending when Claude starts the wrong conversation.',
            mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
            userMessageLocalIds: ['resume-identity-mismatch-local-id'],
          };
        },
        onSessionFound,
        resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
        buildSpawn: async () => ({
          spawnArgv: ['/bin/claude', '--resume', requestedSessionId],
          spawnEnv: {},
        }),
        createSessionName: () => 'happier-claude-resume-identity-mismatch-test',
        subscribeClaudeSessionHooks: (callback) => {
          subscribedHook = callback;
          return () => {
            subscribedHook = undefined;
          };
        },
        lifecycleCompletionQuiescenceMs: 0,
        dialogTurnEndScreenProbeDelaysMs: [],
      })).rejects.toMatchObject({
        code: 'claude_unified_resume_identity_mismatch',
      });

      expect(onSessionFound).not.toHaveBeenCalled();
      expect(injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      abortController.abort();
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('does not interrupt provider-owned resume-summary compaction before delivering the queued Pending row once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-resume-summary-compaction-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const claudeSessionId = '55555555-5555-4555-8555-555555555555';
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    const { session } = createPermissionHandlerSessionStub('resume-summary-compaction-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session);
    const abortController = new AbortController();
    const pendingPrompt = 'Continue the queued transcript viewport investigation.';
    let screenText = resumeChoiceDialog;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let pendingPulled = false;
    let resumeAnswerSubmitted = false;
    let compactPromptSubmitted = false;
    const onPromptAcceptedByProvider = vi.fn();
    const onTerminalPromptInjected = vi.fn();
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-resume-summary-compaction-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const controlPort: TerminalControlPort = {
      hostKind: 'tmux',
      async captureScreen() {
        return {
          status: 'captured',
          capture: { text: screenText, capturedAtMs: Date.now(), hostKind: 'tmux' },
        };
      },
      async sendLiteralText(text) {
        expect(text).toBe('1');
        resumeAnswerSubmitted = true;
        screenText = composerScreen('/compact ', true);
        const hook = subscribedHook;
        if (!hook) throw new Error('resume answer ran before the provider hook bridge subscribed');
        hook({
          hook_event_name: 'SessionStart',
          session_id: claudeSessionId,
          transcript_path: transcriptPath,
          source: 'resume',
        });
        hook({
          hook_event_name: 'UserPromptSubmit',
          session_id: claudeSessionId,
          transcript_path: transcriptPath,
          prompt: '/compact',
        });
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'resume-summary-native-compact-row',
          sessionId: claudeSessionId,
          timestamp: new Date().toISOString(),
          isSidechain: false,
          message: { role: 'user', content: '/compact' },
        })}\n`);
        compactPromptSubmitted = true;
        return { status: 'sent', at: Date.now() };
      },
      async sendRawSequence() {
        return { status: 'sent', at: Date.now() };
      },
      async sendSpecialKey(key) {
        throw new Error(`Unexpected startup-compaction key: ${key}`);
        return { status: 'sent', at: Date.now() };
      },
    };
    const injectUserPrompt = vi.fn<TerminalHostAdapter['injectUserPrompt']>(async (_handle, input) => {
      expect(input.text).toBe(pendingPrompt);
      return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
    });
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: screenText,
        observedAt: Date.now(),
      })),
      createControlPort: vi.fn(() => controlPort),
      interruptTurn: vi.fn(async () => {
        throw new Error('Provider-owned startup compaction must not be interrupted');
      }),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      happySessionId: 'resume-summary-compaction-session',
      sessionId: claudeSessionId,
      transcriptPath,
      hookPluginDir: join(dir, 'owned-happier-hook-plugin'),
      signal: abortController.signal,
      nextMessage: async () => {
        if (pendingPulled) return await new Promise(() => undefined);
        pendingPulled = true;
        return {
          message: pendingPrompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          userMessageLocalIds: ['resume-summary-pending-local-id'],
          pendingProviderAction: 'interrupt_and_send',
        };
      },
      onPromptAcceptedByProvider,
      onTerminalPromptInjected,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-resume-summary-compaction-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      dialogChoiceBroker: broker,
      createStartupDialogResolver: ({
        controlPort: startupPort,
        startupMode,
        isRuntimeControlInFlight,
        onResumeSummaryCompactionSubmitted,
      }) =>
        createClaudeUnifiedResumeChoiceStartupResolver({
          choice: 'resume_from_summary',
          broker,
          port: startupPort,
          wait: async () => undefined,
          settleMs: 0,
          startupMode,
          isRuntimeControlInFlight,
          onResumeSummaryCompactionSubmitted,
        }),
      lifecycleCompletionQuiescenceMs: 0,
      dialogTurnStallScreenProbeQuietMs: 1_000,
      dialogTurnStallScreenProbeMaxAttempts: 0,
      dialogTurnEndScreenProbeDelaysMs: [],
    });

    try {
      await waitUntil(() => resumeAnswerSubmitted);
      await waitUntil(() => compactPromptSubmitted);
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(adapter.interruptTurn).not.toHaveBeenCalled();
      expect(injectUserPrompt).not.toHaveBeenCalled();

      const hook = subscribedHook;
      if (!hook) throw new Error('provider hook bridge unsubscribed during compaction');
      hook({
        hook_event_name: 'PreCompact',
        session_id: claudeSessionId,
        transcript_path: transcriptPath,
      });
      screenText = composerScreen('');
      hook({
        hook_event_name: 'PostCompact',
        session_id: claudeSessionId,
        transcript_path: transcriptPath,
      });
      await waitUntil(() => injectUserPrompt.mock.calls.length === 1);
      await waitUntil(() => onTerminalPromptInjected.mock.calls.length === 1);
      expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'resume-summary-pending-accepted-row',
        promptId: 'resume-summary-pending-prompt-id',
        sessionId: claudeSessionId,
        timestamp: new Date().toISOString(),
        isSidechain: false,
        message: { role: 'user', content: pendingPrompt },
      })}\n`);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1);
      expect(adapter.interruptTurn).not.toHaveBeenCalled();
      expect(injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: pendingPrompt,
        maxUserMessageSeq: null,
        userMessageLocalIds: ['resume-summary-pending-local-id'],
      });
    } finally {
      abortController.abort();
      await sessionPromise;
      await broker.dispose();
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('settles an after-write timeout from the exact resumed-session JSONL prompt after the native continuation hook', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-late-exact-acceptance-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const claudeSessionId = '77777777-7777-4777-8777-777777777777';
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const prompt = 'Prompt accepted after a resumed terminal write times out before Enter is verified.';
    const nextPrompt = 'Next durable prompt drains after exact acceptance.';
    const abortController = new AbortController();
    const onPromptAcceptedByProvider = vi.fn();
    const onTerminalInjectionFailure = vi.fn(async () => (
      { action: 'claimed_pending_delivery' as const }
    ));
    let resolveFirstInjectionAttempt: (() => void) | undefined;
    const firstInjectionAttempted = new Promise<void>((resolve) => {
      resolveFirstInjectionAttempt = resolve;
    });
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let pendingPullCount = 0;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-late-exact-acceptance-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const injectUserPrompt = vi.fn<TerminalHostAdapter['injectUserPrompt']>(async () => {
      if (injectUserPrompt.mock.calls.length === 1) {
        resolveFirstInjectionAttempt?.();
        return {
          status: 'failed',
          reason: 'timeout',
          phase: 'after_write_before_enter',
          duplicateRisk: 'possible',
          recoverable: true,
        } as const;
      }
      return {
        status: 'injected',
        at: Date.now(),
        bytesWritten: nextPrompt.length,
      } as const;
    });
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt,
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      happySessionId: 'late-exact-acceptance-session',
      sessionId: claudeSessionId,
      transcriptPath,
      hookPluginDir: join(dir, 'owned-happier-hook-plugin'),
      signal: abortController.signal,
      nextMessage: async () => {
        pendingPullCount += 1;
        if (pendingPullCount > 2) return await new Promise(() => undefined);
        return {
          message: pendingPullCount === 1 ? prompt : nextPrompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          userMessageLocalIds: [pendingPullCount === 1 ? 'late-exact-pending-local' : 'next-pending-local'],
        };
      },
      onPromptAcceptedByProvider,
      onTerminalInjectionFailure,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-late-exact-acceptance-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      lifecycleCompletionQuiescenceMs: 0,
      dialogTurnEndScreenProbeDelaysMs: [],
    });

    try {
      await firstInjectionAttempted;
      const hook = subscribedHook;
      if (!hook) throw new Error('Claude session hook subscription was not registered before injection');
      hook({
        hook_event_name: 'SessionStart',
        session_id: claudeSessionId,
        transcript_path: transcriptPath,
        source: 'resume',
      });
      hook({
        hook_event_name: 'UserPromptSubmit',
        session_id: claudeSessionId,
        prompt_id: 'late-exact-prompt-id',
        prompt,
      });
      expect(onPromptAcceptedByProvider).not.toHaveBeenCalled();

      const acceptedTimestamp = new Date().toISOString();
      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'user',
        uuid: 'late-exact-accepted-user-row',
        promptId: 'late-exact-prompt-id',
        sessionId: claudeSessionId,
        timestamp: acceptedTimestamp,
        isSidechain: false,
        message: { role: 'user', content: prompt },
      })}\n`);
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1);
      await waitUntil(() => injectUserPrompt.mock.calls.length === 2);
      expect(onTerminalInjectionFailure).toHaveBeenCalledOnce();
      expect(onTerminalInjectionFailure).toHaveBeenCalledWith(expect.objectContaining({
        failureState: 'failed_ambiguous',
        phase: 'after_write_before_enter',
        userMessageLocalIds: ['late-exact-pending-local'],
      }));
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: null,
        userMessageLocalIds: ['late-exact-pending-local'],
      });
      expect(injectUserPrompt).toHaveBeenNthCalledWith(
        2,
        handle,
        expect.objectContaining({ text: nextPrompt }),
      );
    } finally {
      abortController.abort();
      await sessionPromise;
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });

  it('publishes a dialog that appears only after successful pending prompt injection', async () => {
    const { session, client } = createPermissionHandlerSessionStub('post-injection-dialog-session');
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => 'claude_dialog_choice_post_injection',
      nowMs: () => 123,
    });
    const abortController = new AbortController();
    let screenText = interactiveClaudeScreen;
    let injected = false;
    let consumed = false;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-post-injection-dialog-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const controlPort: TerminalControlPort = {
      hostKind: 'tmux',
      async captureScreen() {
        return {
          status: 'captured',
          capture: { text: screenText, capturedAtMs: Date.now(), hostKind: 'tmux' },
        };
      },
      async sendLiteralText() {
        return { status: 'sent', at: Date.now() };
      },
      async sendRawSequence() {
        return { status: 'sent', at: Date.now() };
      },
      async sendSpecialKey() {
        return { status: 'sent', at: Date.now() };
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        expect(input.text).toBe('/effort high');
        injected = true;
        setTimeout(() => {
          screenText = effortChangeDialog;
        }, 1);
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: screenText,
        observedAt: Date.now(),
      })),
      createControlPort: vi.fn(() => controlPort),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: '/effort high',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          userMessageLocalIds: ['pending-effort-dialog-local-id'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-post-injection-dialog-test',
      dialogChoiceBroker: broker,
      dialogOwnershipGraceMs: 10,
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => injected);
      await waitUntil(() => Boolean(
        client.getAgentStateSnapshot().requests.claude_dialog_choice_post_injection,
      ));
      expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_post_injection).toMatchObject({
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: expect.objectContaining({
          happierDialog: expect.objectContaining({
            kind: 'recognized',
            dialogId: 'effort_change',
          }),
        }),
      });
    } finally {
      abortController.abort();
      await sessionPromise;
      await broker.dispose();
    }
  });

  it('publishes one private generic Swift LSP question when primary PostToolUse observes the modal', async () => {
    const { session, client } = createPermissionHandlerSessionStub('post-tool-use-lsp-dialog-session');
    const sendToAllDevicesAsync = vi.fn(async () => undefined);
    Object.assign(session, { pushSender: { sendToAllDevicesAsync } });
    const broker = new ClaudeUnifiedDialogChoiceBroker(session, {
      createRequestId: () => 'claude_dialog_choice_swift_lsp',
      nowMs: Date.now,
    });
    const abortController = new AbortController();
    const sentLiteral: string[] = [];
    const sentRaw: string[] = [];
    const sentKeys: string[] = [];
    let screenText = interactiveClaudeScreen;
    let controlCaptureCount = 0;
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let injected = false;
    let consumed = false;
    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-post-tool-use-lsp-dialog-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const controlPort: TerminalControlPort = {
      hostKind: 'tmux',
      async captureScreen() {
        controlCaptureCount += 1;
        return {
          status: 'captured',
          capture: { text: screenText, capturedAtMs: Date.now(), hostKind: 'tmux' },
        };
      },
      async sendLiteralText(text) {
        sentLiteral.push(text);
        return { status: 'sent', at: Date.now() };
      },
      async sendRawSequence(sequence) {
        sentRaw.push(sequence);
        return { status: 'sent', at: Date.now() };
      },
      async sendSpecialKey(key) {
        sentKeys.push(key);
        return { status: 'sent', at: Date.now() };
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        injected = true;
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: screenText,
        observedAt: Date.now(),
      })),
      createControlPort: vi.fn(() => controlPort),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: '/workspace/project',
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: 'Inspect the Swift project.',
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          userMessageLocalIds: ['pending-swift-lsp-dialog-local-id'],
        };
      },
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-post-tool-use-lsp-dialog-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      dialogChoiceBroker: broker,
      dialogOwnershipGraceMs: 0,
      dialogTurnStallScreenProbeQuietMs: 60_000,
      dialogTurnEndScreenProbeDelaysMs: [],
      lifecycleCompletionQuiescenceMs: 0,
    });

    try {
      await waitUntil(() => typeof subscribedHook === 'function', 10_000);
      subscribedHook?.({ hook_event_name: 'SessionStart', session_id: 'claude-session-id' });
      await waitUntil(() => injected, 10_000);
      screenText = swiftLspRecommendationDialog;
      const captureCountBeforeHook = controlCaptureCount;
      const hook = subscribedHook;
      if (!hook) throw new Error('Claude session hook subscription was not registered');
      hook({
        hook_event_name: 'PostToolUse',
        session_id: 'claude-session-id',
        tool_use_id: 'toolu_swift_lsp_install',
      });

      await waitUntil(() => Boolean(
        client.getAgentStateSnapshot().requests.claude_dialog_choice_swift_lsp,
      ));
      expect(Object.keys(client.getAgentStateSnapshot().requests)).toEqual([
        'claude_dialog_choice_swift_lsp',
      ]);
      expect(client.getAgentStateSnapshot().requests.claude_dialog_choice_swift_lsp).toMatchObject({
        tool: 'AskUserQuestion',
        kind: 'user_action',
        arguments: {
          happierDialog: {
            kind: 'unrecognized',
            mode: 'generic',
            dialogId: 'unrecognized_confirmation',
            signature: expect.any(String),
            secondaryAction: 'open_terminal',
          },
          questions: [{
            id: 'claudeUnifiedTerminalGenericDialog',
            header: 'Claude needs attention',
            question: [
              'Swift language server (SourceKit-LSP) for code intelligence',
              'Triggered by: .swift files',
              'Would you like to install this LSP plugin?',
            ].join('\n'),
            multiSelect: false,
            options: [
              { choice: '1', label: 'Yes, install swift-lsp', description: 'Send this exact visible choice to Claude.' },
              { choice: '2', label: 'No, not now', description: 'Send this exact visible choice to Claude.' },
              { choice: '3', label: 'Never for swift-lsp', description: 'Send this exact visible choice to Claude.' },
              { choice: '4', label: 'Disable all LSP recommendations', description: 'Send this exact visible choice to Claude.' },
            ],
          }],
        },
      });
      expect(client.getAgentStateSnapshot().completedRequests).toEqual({});
      await Promise.resolve();
      expect(sendToAllDevicesAsync).not.toHaveBeenCalled();
      expect(controlCaptureCount - captureCountBeforeHook).toBe(2);
      expect(sentLiteral).toEqual([]);
      expect(sentRaw).toEqual([]);
      expect(sentKeys).toEqual([]);
    } finally {
      abortController.abort();
      await sessionPromise;
      await broker.dispose();
    }
  });

  it('keeps a known resumed session alive when owned UserPromptSubmit precedes exact transcript acceptance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-resumed-hook-activation-'));
    tempDirs.push(dir);
    const workspaceDir = join(dir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const claudeSessionId = '44444444-4444-4444-8444-444444444444';
    const claudeConfigDir = join(dir, 'claude-config');
    const projectDir = getProjectPath(workspaceDir, claudeConfigDir);
    await mkdir(projectDir, { recursive: true });
    const transcriptPath = join(projectDir, `${claudeSessionId}.jsonl`);
    await writeFile(transcriptPath, '');
    const previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;

    const prompt = 'Reply exactly RESUMED_HOOK_ACTIVATION_OK and do not use tools.';
    const assistantText = 'RESUMED_HOOK_ACTIVATION_OK';
    const abortController = new AbortController();
    const onMessage = vi.fn<(message: RawJSONLines) => void>();
    const onTranscriptMessageSuppressed = vi.fn<(message: RawJSONLines) => void>();
    const onPromptAcceptedByProvider = vi.fn();
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const onReady = vi.fn(() => resolveReady());
    let subscribedHook: ((data: SessionHookData) => void) | undefined;
    let injected = false;
    let consumed = false;
    let runtimeOfferedBeforeInjection = false;
    let workflowArmedBeforeInjection = false;
    const onWorkflowActivityObserverReady = vi.fn();
    const runtimeActivityReport = vi.fn(async () => {});
    const runtimeActivityAdapter = createClaudeProviderRuntimeActivityAdapter({
      providerActivityLedger: createClaudeProviderActivityLedger(),
      contributionHandle: {
        report: runtimeActivityReport,
        markUnknown: vi.fn(async () => {}),
        dispose: vi.fn(async () => {}),
      },
    });

    const handle: TerminalHostHandle = {
      kind: 'tmux',
      sessionName: 'happier-claude-resumed-hook-activation-test',
      paneId: '%1',
      attachMetadata: {
        attachStrategy: 'terminal_host',
        topology: 'shared',
        locality: 'same_machine',
        liveProbe: 'required',
      },
    };
    const adapter: TerminalHostAdapter = {
      kind: 'tmux',
      createOrAttachHost: vi.fn(async () => handle),
      injectUserPrompt: vi.fn(async (_handle, input) => {
        runtimeOfferedBeforeInjection = runtimeActivityReport.mock.calls.length > 0;
        workflowArmedBeforeInjection = onWorkflowActivityObserverReady.mock.calls.length > 0;
        // The live failure happened long after the known-resume follower was established. Keep this
        // test on that same boundary instead of racing controller startup.
        await new Promise((resolve) => setTimeout(resolve, 100));
        const hook = subscribedHook;
        if (!hook) throw new Error('Claude session hook subscription was not registered before injection');
        hook({
          hook_event_name: 'UserPromptSubmit',
          session_id: claudeSessionId,
          transcript_path: transcriptPath,
          prompt_id: 'resumed-hook-prompt-id',
          prompt: input.text,
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        await appendFile(transcriptPath, `${JSON.stringify({
          type: 'user',
          uuid: 'resumed-hook-accepted-user-row',
          promptId: 'resumed-hook-prompt-id',
          sessionId: claudeSessionId,
          timestamp: new Date().toISOString(),
          isSidechain: false,
          message: { role: 'user', content: input.text },
        })}\n`);
        injected = true;
        return { status: 'injected', at: Date.now(), bytesWritten: input.text.length } as const;
      }),
      evaluateLiveness: vi.fn(async () => ({ paneAlive: true, observedAt: Date.now() })),
      captureInputState: vi.fn(async () => ({
        stable: true,
        currentInput: interactiveClaudeScreen,
        observedAt: Date.now(),
      })),
      interruptTurn: vi.fn(async () => {}),
      dispose: vi.fn(async () => {}),
    };

    let sessionOutcome: 'pending' | 'resolved' | 'rejected' = 'pending';
    let sessionError: unknown;
    const sessionPromise = runClaudeUnifiedTerminalSession({
      path: workspaceDir,
      sessionId: claudeSessionId,
      hookPluginDir: join(dir, 'owned-happier-hook-plugin'),
      signal: abortController.signal,
      nextMessage: async () => {
        if (consumed) return await new Promise(() => undefined);
        consumed = true;
        return {
          message: prompt,
          mode: { permissionMode: 'default', claudeUnifiedTerminalHost: 'tmux' },
          maxUserMessageSeq: 2039,
          userMessageLocalIds: ['resumed-hook-local-id'],
        };
      },
      onMessage,
      onTranscriptMessageSuppressed,
      onPromptAcceptedByProvider,
      onReady,
      resolveHostAdapter: async () => ({ status: 'resolved', adapter, reason: 'test' }),
      buildSpawn: async () => ({ spawnArgv: ['/bin/claude'], spawnEnv: {} }),
      createSessionName: () => 'happier-claude-resumed-hook-activation-test',
      subscribeClaudeSessionHooks: (callback) => {
        subscribedHook = callback;
        return () => {
          subscribedHook = undefined;
        };
      },
      lifecycleCompletionQuiescenceMs: 0,
      runtimeActivityAdapter,
      onWorkflowActivityObserverReady,
    }).then(
      () => { sessionOutcome = 'resolved'; },
      (error: unknown) => {
        sessionOutcome = 'rejected';
        sessionError = error;
      },
    );

    try {
      await waitUntil(() => injected);
      expect(runtimeOfferedBeforeInjection).toBe(true);
      expect(workflowArmedBeforeInjection).toBe(true);
      expect(onWorkflowActivityObserverReady).toHaveBeenCalledTimes(1);
      expect(runtimeActivityReport).toHaveBeenCalledWith(
        { state: 'idle', activeCount: 0 },
        'claude-unified-provider-observer-installed',
      );
      await waitUntil(() => onPromptAcceptedByProvider.mock.calls.length === 1 || sessionOutcome !== 'pending');
      expect(sessionOutcome, `session stopped before assistant delivery: ${String(sessionError)}`).toBe('pending');
      expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);

      await appendFile(transcriptPath, `${JSON.stringify({
        type: 'assistant',
        uuid: 'resumed-hook-assistant-row',
        sessionId: claudeSessionId,
        timestamp: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: assistantText }],
          stop_reason: 'end_turn',
        },
      })}\n`);
      const hook = subscribedHook;
      if (!hook) throw new Error('Claude session hook subscription was disposed before Stop');
      hook({
        hook_event_name: 'Stop',
        session_id: claudeSessionId,
        transcript_path: transcriptPath,
        last_assistant_message: assistantText,
        background_tasks: [],
      });

      await waitUntil(() => onMessage.mock.calls.some(([message]) => message.uuid === 'resumed-hook-assistant-row'));
      await ready;
      expect(onPromptAcceptedByProvider).toHaveBeenCalledTimes(1);
      expect(onPromptAcceptedByProvider).toHaveBeenCalledWith({
        message: prompt,
        maxUserMessageSeq: 2039,
        userMessageLocalIds: ['resumed-hook-local-id'],
      });
      expect(onTranscriptMessageSuppressed).toHaveBeenCalledWith(expect.objectContaining({
        type: 'user',
        uuid: 'resumed-hook-accepted-user-row',
        promptId: 'resumed-hook-prompt-id',
      }));
      expect(onMessage).not.toHaveBeenCalledWith(expect.objectContaining({
        type: 'user',
        uuid: 'resumed-hook-accepted-user-row',
      }));
      expect(sessionOutcome).toBe('pending');
    } finally {
      abortController.abort();
      await sessionPromise;
      if (previousClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
      }
    }
  });
});
