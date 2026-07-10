import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID } from './lifecycleEvents.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';
import { createFakeControlPort } from './tuiControls/fakeControlPort.js';

const RESUME_CHOICE_DIALOG = [
  'This session is 18h 2m old and 560.4k tokens.',
  '',
  '❯ 1. Resume from summary',
  '  2. Resume full session',
].join('\n');

const IDLE_COMPOSER = [
  '──────────────────────────────',
  '❯ ',
  '──────────────────────────────',
].join('\n');

const EFFORT_HIGH_DIALOG = [
  'Change effort level?',
  'Switching to high means the full history will be processed with high effort.',
  '',
  '❯ 1. Yes, switch to high',
  '  2. No, go back',
].join('\n');

const USAGE_LIMIT_DIALOG = [
  "You've hit your session limit",
  '/rate-limit-options',
  '',
  'What do you want to do?',
  '❯ 1. Stop and wait for limit to reset',
  '  2. Upgrade your plan',
].join('\n');

const SAFEGUARD_PAUSE_DIALOG = [
  'Session paused',
  "Fable 5's safeguards flagged this message.",
  '',
  '❯ 1. Switch to Opus 4.8',
  '  2. Edit prompt and retry with Fable 5',
].join('\n');

const RESUME_CHOICE_QUESTION = 'How should Claude resume this session?';
const SAFEGUARD_CHOICE_QUESTION = 'How should Claude continue?';

describe('createClaudeUnifiedTerminalTurnOperations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function readLaunchArgs(terminalHost: ReturnType<typeof createTerminalHostFixture>): string[] {
    return (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0]?.launch?.args as string[];
  }

  function countArg(args: readonly string[], flag: string): number {
    return args.filter((arg) => arg === flag).length;
  }

  function hasSplitFlagValue(args: readonly string[], flag: string, value: string): boolean {
    return args.some((arg, index) => arg === flag && args[index + 1] === value);
  }

  function createManualTranscriptFollowFixture() {
    type OnLine = (input: Readonly<{
      line: string;
      sourcePath: string;
      sequence: number;
    }>) => void | Promise<void>;
    let onLine: OnLine | null = null;
    let sequence = 0;
    return {
      service: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
          id: definition.id,
          dispose: vi.fn(async () => undefined),
        })),
        fileFollow: {
          follow: vi.fn(async (input: Readonly<{ onLine: OnLine }>) => {
            onLine = input.onLine;
            return {
              id: 'manual-transcript-follow',
              drainNow: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            };
          }),
        },
      },
      async emitRow(row: Readonly<Record<string, unknown>>) {
        if (!onLine) throw new Error('manual transcript follow was not bound');
        sequence += 1;
        await onLine(Object.freeze({
          line: JSON.stringify(row),
          sourcePath: '/tmp/claude-provider-session-1.jsonl',
          sequence,
        }));
      },
    };
  }

  it('reports a typed applied outcome before launch and a non-applied outcome once the terminal is running', async () => {
    // gap 27: the unified terminal can only fold model/effort into launch args before the Claude
    // TUI starts. Before launch it APPLIES (captured into launch args); after the host handle
    // exists it cannot live-apply (TUI control is gated off) and must report a non-applied outcome
    // so the host keeps the override pending instead of marking it applied forever.
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      const preLaunch = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });
      expect(preLaunch).toEqual(expect.objectContaining({ status: 'applied' }));

      await runtime.startOrLoadSession();

      const afterLaunch = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'medium' },
      });
      expect(afterLaunch).toBeTruthy();
      expect((afterLaunch as { status: string }).status).not.toBe('applied');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('checks terminal host liveness at runtime action boundaries, not as an idle heartbeat', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.startOrLoadSession();
      expect(terminalHost.service.evaluateLiveness).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(terminalHost.service.evaluateLiveness).toHaveBeenCalledTimes(1);

      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      expect(terminalHost.service.evaluateLiveness).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not re-inject an ambiguous prompt once the host session reports provider acceptance', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    let providerAccepted = false;
    const hasProviderAcceptedUserMessageDelivery = vi.fn(() => providerAccepted);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHasProviderAcceptedUserMessageDelivery: hasProviderAcceptedUserMessageDelivery,
    });
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.startOrLoadSession();
      await runtime.sendTurnPrompt('acceptance already observed', { userMessageSeq: 739 });

      await vi.waitFor(() => {
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      });

      providerAccepted = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(hasProviderAcceptedUserMessageDelivery).toHaveBeenCalledWith(expect.objectContaining({
        userMessageSeq: 739,
      }));
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('applies pre-launch runtime config to the first Claude terminal launch', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'safe-yolo',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      await runtime.updateSessionRuntimeConfig({ configOption: { id: 'reasoning_effort', value: 'xhigh' } });
      await runtime.startOrLoadSession();

      expect(terminalHost.service.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
        launch: expect.objectContaining({
          args: expect.arrayContaining([
            '--model',
            'claude-opus-4-8',
            '--effort',
            'xhigh',
            '--permission-mode',
            'auto',
          ]),
        }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('launches with the Claude yolo allow flag without bypass permissions by default', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-default-yolo-allow',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.startOrLoadSession();

      const launchArgs = readLaunchArgs(terminalHost);
      expect(countArg(launchArgs, '--allow-dangerously-skip-permissions')).toBe(1);
      expect(hasSplitFlagValue(launchArgs, '--permission-mode', 'bypassPermissions')).toBe(false);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('launches yolo sessions with the allow flag and bypass permissions', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-yolo-allow',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'yolo',
    })).operations;

    try {
      await runtime.startOrLoadSession();

      const launchArgs = readLaunchArgs(terminalHost);
      expect(countArg(launchArgs, '--allow-dangerously-skip-permissions')).toBe(1);
      expect(hasSplitFlagValue(launchArgs, '--permission-mode', 'bypassPermissions')).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('launches in plan when a pre-launch modeId=plan toggle arrives, winning over safe-yolo', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-plan',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'safe-yolo',
    })).operations;

    try {
      // A plan toggle delivered before launch must win over the raw permission mode so the TUI
      // launches in plan rather than safe-yolo→auto (the dropped-plan bug).
      await runtime.updateSessionRuntimeConfig({ modeId: 'plan' });
      await runtime.startOrLoadSession();

      const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]?.launch?.args as string[];
      expect(launchArgs).toEqual(expect.arrayContaining(['--permission-mode', 'plan']));
      expect(launchArgs).not.toContain('auto');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('accepts the legacy `effort` config-option id as an alias for reasoning_effort', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      // Legacy alias: real UI/provider metadata uses `reasoning_effort`, but persisted/older
      // sessions may still carry the bare `effort` id. It must still reach --effort (using a
      // non-default level so it is not suppressed as already-effective).
      await runtime.updateSessionRuntimeConfig({ configOption: { id: 'effort', value: 'xhigh' } });
      await runtime.startOrLoadSession();

      expect(terminalHost.service.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
        launch: expect.objectContaining({
          args: expect.arrayContaining(['--effort', 'xhigh']),
        }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('merges ultracode into a single --settings launch overlay for xhigh-capable models', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      const outcome = await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      });
      expect(outcome).toEqual(expect.objectContaining({ status: 'applied' }));
      await runtime.startOrLoadSession();

      const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]?.launch?.args as string[];
      expect(launchArgs).toEqual(expect.arrayContaining(['--settings', '{"ultracode":true}']));
      expect(launchArgs.filter((arg) => arg === '--settings')).toHaveLength(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  describe('statusline forwarder overlay (statusline dev port, S6)', () => {
    function createStatuslineSessionHooksFixture(params?: Readonly<{
      sessionHookSecretFile?: string | null;
      statuslineForwarderScript?: string | null;
    }>) {
      const startServerOptions: Array<Record<string, unknown>> = [];
      const secretFile = params?.sessionHookSecretFile === null
        ? undefined
        : params?.sessionHookSecretFile ?? '/tmp/hook-secrets/claude-1/session.secret';
      const statuslineScript = params?.statuslineForwarderScript === null
        ? undefined
        : params?.statuslineForwarderScript ?? '/app/scripts/statusline_forwarder.cjs';
      return {
        startServerOptions,
        service: {
          startServer: vi.fn(async (options: Record<string, unknown>) => {
            startServerOptions.push(options);
            return {
              port: 43123,
              ...(secretFile ? { sessionHookSecretFile: secretFile } : {}),
              stop: vi.fn(),
              dispose: vi.fn(async () => undefined),
            };
          }),
          resolveForwarderAssets: vi.fn(async () => ({
            nodeExecutable: '/managed/bin/node',
            sessionForwarderScript: '/app/scripts/session_hook_forwarder.cjs',
            permissionForwarderScript: '/app/scripts/permission_hook_forwarder.cjs',
            ...(statuslineScript ? { statuslineForwarderScript: statuslineScript } : {}),
          })),
          createPluginDir: vi.fn(async () => '/tmp/happier-claude-hook-plugin'),
          disposePluginDir: vi.fn(async () => undefined),
          publishProviderTranscript: vi.fn(async () => undefined),
        },
      };
    }

    async function createConfigDirWithStatusline(): Promise<string> {
      const { mkdtemp, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'claude-statusline-config-'));
      await writeFile(join(dir, 'settings.json'), JSON.stringify({
        statusLine: { type: 'command', command: 'my-status --fancy', padding: 4 },
      }), 'utf8');
      return dir;
    }

    it('merges a secret-free statusline forwarder command into the single --settings overlay and chains the user original', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
      });
      const configDir = await createConfigDirWithStatusline();
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-statusline',
        hostPreference: 'zellij',
        launchEnv: { CLAUDE_CONFIG_DIR: configDir },
        permissionMode: 'default',
      })).operations;

    try {
        await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
        await runtime.updateSessionRuntimeConfig({ configOption: { id: 'ultracode', value: 'true' } });
        await runtime.startOrLoadSession();

        const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
          .mock.calls[0]?.[0]?.launch?.args as string[];
        const settingsFlags = launchArgs.filter((arg) => arg === '--settings');
        expect(settingsFlags).toHaveLength(1);

        const overlay = JSON.parse(launchArgs[launchArgs.indexOf('--settings') + 1]!) as {
          ultracode?: boolean;
          statusLine?: { type: string; command: string; padding?: number };
        };
        expect(overlay.ultracode).toBe(true);
        expect(overlay.statusLine?.type).toBe('command');
        expect(overlay.statusLine?.padding).toBe(4);
        expect(overlay.statusLine?.command).toContain('statusline_forwarder.cjs');
        expect(overlay.statusLine?.command).toContain('43123');
        expect(overlay.statusLine?.command).toContain('--secret-file "/tmp/hook-secrets/claude-1/session.secret"');

        const b64Match = overlay.statusLine?.command.match(/--original-b64 ([A-Za-z0-9+/=]+)/);
        expect(b64Match).not.toBeNull();
        expect(Buffer.from(b64Match![1]!, 'base64').toString('utf8')).toBe('my-status --fancy');

        // S7 hardening carry-over: the hook secret must never appear in Claude's argv.
        const secret = sessionHooks.startServerOptions[0]?.sessionHookSecret as string;
        expect(secret).toBeTruthy();
        expect(launchArgs.join(' ')).not.toContain(secret);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('keeps the launch unchanged when the host ships no statusline forwarder asset (fail-open)', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture({ statuslineForwarderScript: null });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-statusline-off',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

    try {
        await runtime.startOrLoadSession();

        const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
          .mock.calls[0]?.[0]?.launch?.args as string[];
        expect(launchArgs).not.toContain('--settings');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('drops the statusline overlay when no 0600 secret file is available (never an unauthenticated forwarder)', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture({ sessionHookSecretFile: null });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-statusline-nosecret',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
          .mock.calls[0]?.[0]?.launch?.args as string[];
        expect(launchArgs).not.toContain('--settings');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('feeds statusline payloads into sessionModelsV1 metadata and ignores foreign sessions once identity is known', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = await mkdtemp(join(tmpdir(), 'claude-statusline-identity-'));
      const transcriptPath = join(tempDir, 'session-live.jsonl');
      await writeFile(transcriptPath, '', 'utf8');

      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      let metadata: Record<string, unknown> = {};
      const writeMetadata = vi.fn(async (request: {
        kind: 'update';
        handler: (current: Record<string, unknown>) => Record<string, unknown>;
      }) => {
        metadata = { ...request.handler(metadata) };
      });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteMetadata: writeMetadata,
        transcriptFileFollowAllowedPathRoots: [tempDir],
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-statusline-apply',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const options = sessionHooks.startServerOptions[0] as {
          onStatuslineUpdate?: (data: Record<string, unknown>) => void | Promise<void>;
          onSessionHook?: (providerSessionId: string, data: Record<string, unknown>) => void | Promise<void>;
        };
        expect(options.onStatuslineUpdate).toBeTypeOf('function');

        await options.onStatuslineUpdate!({
          session_id: 'claude-session-live',
          model: { id: 'claude-fable-5', display_name: 'Fable 5' },
          context_window: { context_window_size: 1_000_000 },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writeMetadata).toHaveBeenCalledTimes(1);
        const state = metadata.sessionModelsV1 as {
          currentModelId: string;
          availableModels: Array<{ id: string; contextWindowTokens?: number }>;
        };
        expect(state.currentModelId).toBe('claude-fable-5');
        expect(state.availableModels[0]).toMatchObject({ id: 'claude-fable-5', contextWindowTokens: 1_000_000 });

        // Adopt identity, then reject a foreign payload.
        await options.onSessionHook?.('claude-session-live', {
          session_id: 'claude-session-live',
          transcript_path: transcriptPath,
          hook_event_name: 'SessionStart',
        });
        await options.onStatuslineUpdate!({
          session_id: 'claude-session-foreign',
          transcript_path: '/elsewhere/transcript.jsonl',
          model: { id: 'claude-haiku-4-5' },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writeMetadata).toHaveBeenCalledTimes(1);
        expect((metadata.sessionModelsV1 as { currentModelId: string }).currentModelId).toBe('claude-fable-5');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('feeds assistant JSONL model deltas into the statusline effective-model owner', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = await mkdtemp(join(tmpdir(), 'claude-unified-jsonl-model-'));
      const transcriptPath = join(tempDir, 'session.jsonl');
      await writeFile(transcriptPath, '', 'utf8');

      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      let metadata: Record<string, unknown> = {
        sessionModelsV1: {
          v: 1,
          provider: 'claude',
          updatedAt: 1,
          currentModelId: 'claude-sonnet-4-6',
          availableModels: [{ id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' }],
        },
      };
      const writeMetadata = vi.fn(async (request: {
        kind: 'update';
        handler: (current: Record<string, unknown>) => Record<string, unknown>;
      }) => {
        metadata = { ...request.handler(metadata) };
      });
      const sessionSend = vi.fn(async () => undefined);
      const manualTranscript = createManualTranscriptFollowFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteMetadata: writeMetadata,
        sessionSend,
        transcripts: manualTranscript.service,
        transcriptFileFollowAllowedPathRoots: [tempDir],
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-jsonl-model',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();
        const options = sessionHooks.startServerOptions[0] as {
          onSessionHook?: (providerSessionId: string, data: Record<string, unknown>) => void | Promise<void>;
        };
        await options.onSessionHook?.('claude-jsonl-model-session', {
          session_id: 'claude-jsonl-model-session',
          transcript_path: transcriptPath,
          hook_event_name: 'SessionStart',
        });
        await manualTranscript.emitRow({
          type: 'assistant',
          uuid: 'assistant-model-delta-1',
          message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'ok' }] },
        });
        await manualTranscript.emitRow({
          type: 'assistant',
          uuid: 'assistant-model-delta-2',
          message: { role: 'assistant', model: 'claude-fable-5', content: [{ type: 'text', text: 'still ok' }] },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect((metadata.sessionModelsV1 as { currentModelId: string }).currentModelId).toBe('claude-fable-5');
        expect(sessionSend).toHaveBeenCalledTimes(1);
        expect(sessionSend).toHaveBeenCalledWith({
          kind: 'sessionEvent',
          event: expect.objectContaining({
            type: 'message',
            message: 'Model changed to claude-fable-5',
          }),
        });
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps the accepted transcript binding as canonical identity when a conflicting SessionStart arrives', async () => {
      const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = await mkdtemp(join(tmpdir(), 'claude-unified-identity-'));
      const acceptedTranscriptPath = join(tempDir, 'accepted.jsonl');
      const conflictingTranscriptPath = join(tempDir, 'conflicting.jsonl');
      await writeFile(acceptedTranscriptPath, '', 'utf8');
      await writeFile(conflictingTranscriptPath, '', 'utf8');

      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      let metadata: Record<string, unknown> = {};
      const writeMetadata = vi.fn(async (request: {
        kind: 'update';
        handler: (current: Record<string, unknown>) => Record<string, unknown>;
      }) => {
        metadata = { ...request.handler(metadata) };
      });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteMetadata: writeMetadata,
        transcriptFileFollowAllowedPathRoots: [tempDir],
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-identity-binding',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const options = sessionHooks.startServerOptions[0] as {
          onStatuslineUpdate?: (data: Record<string, unknown>) => void | Promise<void>;
          onSessionHook?: (providerSessionId: string, data: Record<string, unknown>) => void | Promise<void>;
        };

        await options.onSessionHook?.('claude-session-accepted', {
          session_id: 'claude-session-accepted',
          transcript_path: acceptedTranscriptPath,
          hook_event_name: 'SessionStart',
        });
        expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-session-accepted' });

        await options.onStatuslineUpdate?.({
          session_id: 'claude-session-accepted',
          model: { id: 'claude-fable-5', display_name: 'Fable 5' },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((metadata.sessionModelsV1 as { currentModelId: string }).currentModelId).toBe('claude-fable-5');

        await options.onSessionHook?.('claude-session-conflicting', {
          session_id: 'claude-session-conflicting',
          transcript_path: conflictingTranscriptPath,
          hook_event_name: 'SessionStart',
        });
        expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-session-accepted' });

        await options.onStatuslineUpdate?.({
          session_id: 'claude-session-conflicting',
          model: { id: 'claude-opus-wrong-session', display_name: 'Wrong Session' },
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect((metadata.sessionModelsV1 as { currentModelId: string }).currentModelId).toBe('claude-fable-5');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('adopts and publishes the SessionStart id before the transcript file is readable', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = await mkdtemp(join(tmpdir(), 'claude-unified-deferred-identity-'));
      const transcriptPath = join(tempDir, 'missing-at-session-start.jsonl');

      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      const writeStateField = vi.fn(async () => undefined);
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteStateField: writeStateField,
        transcriptFileFollowAllowedPathRoots: [tempDir],
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-deferred-identity',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const options = sessionHooks.startServerOptions[0] as {
          onSessionHook?: (providerSessionId: string, data: Record<string, unknown>) => void | Promise<void>;
        };

        await options.onSessionHook?.('claude-session-before-jsonl', {
          session_id: 'claude-session-before-jsonl',
          transcript_path: transcriptPath,
          hook_event_name: 'SessionStart',
        });

        expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-session-before-jsonl' });
        expect(writeStateField).toHaveBeenCalledWith({
          fieldId: 'identity.providerSessionId',
          value: {
            metadataKey: 'claudeSessionId',
            value: 'claude-session-before-jsonl',
          },
          reason: 'claude-unified-session-start',
        });
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('does not repeatedly retry SessionStart id publication when execution-run state has no session target', async () => {
      const { mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const tempDir = await mkdtemp(join(tmpdir(), 'claude-unified-unsupported-state-'));
      const transcriptPath = join(tempDir, 'missing-at-session-start.jsonl');

      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      const unsupportedStateWrite = Object.assign(new Error('no session target'), {
        code: 'execution_run_session_state_unsupported',
        result: { reason: 'no_session_target' },
      });
      const writeStateField = vi.fn(async () => {
        throw unsupportedStateWrite;
      });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteStateField: writeStateField,
        transcriptFileFollowAllowedPathRoots: [tempDir],
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-unsupported-state',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const options = sessionHooks.startServerOptions[0] as {
          onSessionHook?: (providerSessionId: string, data: Record<string, unknown>) => void | Promise<void>;
        };

        await options.onSessionHook?.('claude-session-before-jsonl', {
          session_id: 'claude-session-before-jsonl',
          transcript_path: transcriptPath,
          hook_event_name: 'SessionStart',
        });
        await vi.waitFor(() => {
          expect(writeStateField).toHaveBeenCalledTimes(1);
        });

        await options.onSessionHook?.('claude-session-before-jsonl', {
          session_id: 'claude-session-before-jsonl',
          transcript_path: transcriptPath,
          hook_event_name: 'SessionStart',
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(writeStateField).toHaveBeenCalledTimes(1);
        expect(ctx.logger.debug).not.toHaveBeenCalledWith(
          '[ClaudeUnifiedTerminal] failed to publish provider session id',
          unsupportedStateWrite,
        );
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('converges post-launch overrides against statusline-verified effective truth without writing desired-state surfaces (Y)', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      let metadata: Record<string, unknown> = {};
      const writeMetadata = vi.fn(async (request: {
        kind: 'update';
        handler: (current: Record<string, unknown>) => Record<string, unknown>;
      }) => {
        metadata = { ...request.handler(metadata) };
      });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
        sessionWriteMetadata: writeMetadata,
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-statusline-truth',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        // Launch WITHOUT model/effort overrides: launch baseline is null/null.
        await runtime.startOrLoadSession();
        const options = sessionHooks.startServerOptions[0] as {
          onStatuslineUpdate?: (data: Record<string, unknown>) => void | Promise<void>;
        };

        // Statusline proves the effective truth (lastVerified analogue).
        await options.onStatuslineUpdate!({
          session_id: 'claude-session-live',
          model: { id: 'claude-opus-4-8' },
          effort: { level: 'high' },
        });

        // An override matching the VERIFIED truth converges even though it diverges from launch.
        const converged = await runtime.updateSessionRuntimeConfig({
          modelId: 'claude-opus-4-8',
          configOption: { id: 'reasoning_effort', value: 'HIGH' },
        });
        expect(converged).toEqual({ status: 'applied', timing: 'skipped_already_effective' });

        // A diverging override stays honestly non-applied.
        const divergent = await runtime.updateSessionRuntimeConfig({
          configOption: { id: 'reasoning_effort', value: 'medium' },
        });
        expect(divergent).toEqual(expect.objectContaining({ status: 'requires_interactive_control' }));

        // An effort-only statusline change must reconcile too (model|effort dedup, not model|window).
        await options.onStatuslineUpdate!({
          session_id: 'claude-session-live',
          model: { id: 'claude-opus-4-8' },
          effort: { level: 'medium' },
        });
        const convergedAfterEffortChange = await runtime.updateSessionRuntimeConfig({
          configOption: { id: 'reasoning_effort', value: 'medium' },
        });
        expect(convergedAfterEffortChange).toEqual({ status: 'applied', timing: 'skipped_already_effective' });

        // Never-desired invariant: statusline only enriches sessionModelsV1 — no desired-state
        // surfaces (modelOverride / permissionMode / mode overrides) are ever written.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(Object.keys(metadata)).toEqual(['sessionModelsV1']);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('starts the hook server with the effectively-unlimited (7d) permission ceiling aligned to the installed hook timeout', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-ceiling',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();

        const options = sessionHooks.startServerOptions[0] as {
          permissionRequestTimeoutMs?: number | null;
          permissionRequestTimeoutMsForTool?: (toolName: string | null) => number | null | undefined;
        };
        // Finite, but effectively unlimited (7 days) and matching the installed hook timeout so a
        // late answer past the ceiling honestly expires rather than approving into a dead socket.
        expect(options.permissionRequestTimeoutMs).toBe(604800 * 1000);
        // Interactive tools (AskUserQuestion/ExitPlanMode) inherit the SAME finite host ceiling —
        // never `null`. A `null` host wait outlives Claude's installed 7d hook timeout, so a late
        // answer would resolve "approved" into a dead forwarder socket instead of honestly
        // expiring (incident class: stuck session after forwarder death).
        expect(options.permissionRequestTimeoutMsForTool?.('AskUserQuestion')).not.toBeNull();
        expect(options.permissionRequestTimeoutMsForTool?.('ExitPlanMode')).not.toBeNull();
        // All tools fall back to the aligned finite ceiling.
        expect(options.permissionRequestTimeoutMsForTool?.('Bash')).not.toBeNull();
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('honors the env override for the permission ceiling', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const sessionHooks = createStatuslineSessionHooksFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionHooks: sessionHooks.service,
      });
      const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-ceiling-env',
        hostPreference: 'zellij',
        launchEnv: { HAPPIER_CLAUDE_PERMISSION_HOOK_TIMEOUT_SECONDS: '90' },
        permissionMode: 'default',
      })).operations;

      try {
        await runtime.startOrLoadSession();
        const options = sessionHooks.startServerOptions[0] as { permissionRequestTimeoutMs?: number | null };
        expect(options.permissionRequestTimeoutMs).toBe(90_000);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });
  });

  it('resolves ultracode OFF at launch when the model cannot honor it', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' });
      await runtime.updateSessionRuntimeConfig({ configOption: { id: 'ultracode', value: 'true' } });
      await runtime.startOrLoadSession();

      const launchArgs = (terminalHost.service.createOrAttachHost as ReturnType<typeof vi.fn>)
        .mock.calls[0]?.[0]?.launch?.args as string[];
      expect(launchArgs).not.toContain('--settings');
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('defers zellij prompt injection when the screen is stable but not yet interactive', async () => {
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: [
        'Loading conversation...',
        'Rendering resumed transcript history',
        'Running 6 Explore agents...',
      ].join('\n'),
      observedAt: 101,
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');

      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('defers tmux prompt injection when the screen is stable but not yet interactive', async () => {
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.resolve = vi.fn(async () => ({ status: 'resolved', hostKind: 'tmux' }));
    terminalHost.service.createOrAttachHost = vi.fn(async () => ({
      kind: 'tmux',
      sessionName: 'happy-session-1',
      paneId: '%1',
    }));
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: [
        'Loading conversation...',
        'Rendering resumed transcript history',
        'Running 6 Explore agents...',
      ].join('\n'),
      observedAt: 101,
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'tmux',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');

      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('recognizes the real boxed composer as injection-ready (no false-negative defer)', async () => {
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: [
        '╭──────────────────────────────╮',
        '│ >                            │',
        '╰──────────────────────────────╯',
      ].join('\n'),
      observedAt: 101,
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('exposes the host in-flight steer hooks', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const steerRuntime = envelope.nativeRuntime as unknown as Readonly<{
      supportsInFlightSteer?: () => boolean;
      isTurnInFlight?: () => boolean;
      steerPrompt?: (prompt: string) => Promise<void>;
    }>;
    try {
      expect(steerRuntime.supportsInFlightSteer?.()).toBe(true);
      expect(typeof steerRuntime.steerPrompt).toBe('function');
      expect(steerRuntime.isTurnInFlight?.()).toBe(false);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('confirms the owed-delivery watermark only at provider acceptance, never at injection (ported HF-1 / A3-HIGH-1)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string }>): Promise<boolean>;
      setOnPromptAcceptedByProvider(
        handler: (info: Readonly<{ localIds?: readonly string[]; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>) => void,
      ): void;
    }>;
    const accepted: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }> = [];
    nativeRuntime.setOnPromptAcceptedByProvider((info) => accepted.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude', {
        localId: 'local-12',
        localIds: ['local-12'],
        userMessageSeq: 12,
        userMessageSeqs: [12],
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      // Injection alone is NOT acceptance: a death in this window must keep the watermark behind.
      expect(accepted).toEqual([]);

      await expect(nativeRuntime.confirmProviderAcceptance()).resolves.toBe(true);
      expect(accepted).toEqual([{
        localIds: ['local-12'],
        userMessageSeq: 12,
        userMessageSeqs: [12],
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not report ambiguous provider acceptance as a durable pending block reason for canonical local-id prompts', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-provider-timeout',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: string;
    }> = [];
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('timeout before provider acceptance', {
        localId: 'local-timeout',
        localIds: ['local-timeout'],
        userMessageSeq: null,
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);

      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(rejected).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports primary provider unavailability as the durable pending block reason before provider acceptance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-provider-unavailable',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: string;
    }> = [];
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('usage limited before provider acceptance', {
        localId: 'local-provider-unavailable',
        localIds: ['local-provider-unavailable'],
        userMessageSeq: null,
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'usage limit reached',
        evidence: {
          error: 'rate_limit',
          resetAtMs: 70_000,
          last_assistant_message: "You've hit your session limit",
        },
        source: 'hook',
      });

      await expect(completion).rejects.toThrow(/usage limit|session limit|awaiting provider acceptance/u);
      expect(rejected).toEqual([{
        localIds: ['local-provider-unavailable'],
        userMessageSeq: null,
        deliveryBlockedReason: 'provider_unavailable_before_acceptance',
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('reports terminal-host startup failure as a durable pending block before provider acceptance', async () => {
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.createOrAttachHost = vi.fn(async () => {
      throw Object.assign(new Error('zellij host failed to start'), {
        code: 'terminal_host_startup_failed',
        hostKind: 'zellij',
        reason: 'launch_failed',
      });
    });
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-terminal-host-unreachable',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: string;
    }> = [];
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await expect(runtime.sendTurnPrompt('host startup failure before provider acceptance', {
        localId: 'local-terminal-host-unreachable',
        localIds: ['local-terminal-host-unreachable'],
        userMessageSeq: null,
      })).rejects.toThrow(/terminal|host|zellij/u);

      expect(rejected).toEqual([{
        localIds: ['local-terminal-host-unreachable'],
        userMessageSeq: null,
        deliveryBlockedReason: 'terminal_host_unreachable',
      }]);
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'turn-start' }),
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            agentId: 'claude',
            code: 'claude.provider.failure',
            source: 'agent_session_error',
          }),
        }),
      ]));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('clears a provider-unavailable durable blocker when the screen becomes writable again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: USAGE_LIMIT_DIALOG,
      observedAt: Date.now(),
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-provider-unavailable-screen-clear',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      startupReadiness: { baseTimeoutMs: 10, extendedTimeoutMs: 10, progressGraceMs: 10, pollIntervalMs: 5 },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
      setOnPromptDeliveryBlockerCleared(
        handler: (info?: Readonly<{ deliveryBlockedReason?: string }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: string;
    }> = [];
    const cleared: Array<{ deliveryBlockedReason?: string }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
    nativeRuntime.setOnPromptDeliveryBlockerCleared((info) => cleared.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('usage limited before provider acceptance', {
        localId: 'local-provider-unavailable-screen',
        localIds: ['local-provider-unavailable-screen'],
        userMessageSeq: null,
      });
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(20);

      await expect(completion).rejects.toThrow(/provider_unavailable_before_acceptance|awaiting provider acceptance/u);
      expect(rejected).toEqual([{
        localIds: ['local-provider-unavailable-screen'],
        userMessageSeq: null,
        deliveryBlockedReason: 'provider_unavailable_before_acceptance',
      }]);
      expect(cleared).toEqual([]);

      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: IDLE_COMPOSER,
        observedAt: Date.now(),
      }));

      await runtime.sendTurnPrompt('after provider limit clears');

      expect(cleared).toEqual([{
        deliveryBlockedReason: 'provider_unavailable_before_acceptance',
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('reports after-enter host ambiguity as a durable pending block reason for canonical local-id prompts', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    vi.mocked(terminalHost.service.injectUserPrompt).mockImplementation(async (_handle, input) => ({
      status: 'failed',
      reason: 'host_unreachable',
      phase: 'after_enter_unknown',
      recoverable: true,
      duplicateRisk: 'possible',
      observedAt: 1_200,
      hostKind: 'windows_console',
      hostSessionName: 'happier-claude-happy-session-ambiguous',
      bytesWritten: input.text.length,
    } as never));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-ambiguous-host-loss',
      hostPreference: 'auto',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
      deliveryBlockedReason?: string;
    }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('host loss after Enter', {
        localId: 'local-after-enter-host-loss',
        localIds: ['local-after-enter-host-loss'],
        userMessageSeq: 24,
        userMessageSeqs: [24],
      });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(rejected).toEqual([{
        localIds: ['local-after-enter-host-loss'],
        userMessageSeq: 24,
        userMessageSeqs: [24],
        deliveryBlockedReason: 'ambiguous_terminal_delivery',
      }]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('hands back unaccepted prompts with their seq when the runtime is disposed (ported HF-2)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnUndeliverablePrompts(
        handler: (prompts: ReadonlyArray<Readonly<{
          text: string;
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
        }>>) => void,
      ): void;
    }>;
    const undeliverable: Array<Array<{
      text: string;
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello claude', {
      localId: 'local-7',
      localIds: ['local-7'],
      userMessageSeq: 7,
      userMessageSeqs: [7],
    });

    await runtime.resetOrDisposeRuntime().catch(() => undefined);

    expect(undeliverable).toEqual([[
      {
        text: 'hello claude',
        localIds: ['local-7'],
        userMessageSeq: 7,
        userMessageSeqs: [7],
      },
    ]]);
  });

  it('terminalizes invalid prompt text with its seq before provider custody without undeliverable handback', async () => {
    const terminalHost = createTerminalHostFixture();
    vi.mocked(terminalHost.service.injectUserPrompt).mockImplementation(async (_handle, input) => ({
      status: 'failed',
      reason: 'invalid_prompt_text',
      phase: 'before_write',
      recoverable: false,
      duplicateRisk: 'none',
      observedAt: 1_200,
      hostKind: 'zellij',
      hostSessionName: 'happier-claude-happy-session-invalid',
    } as never));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-invalid',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>) => void,
      ): void;
      setOnUndeliverablePrompts(
        handler: (
          prompts: ReadonlyArray<Readonly<{ text: string; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>>,
        ) => void,
      ): void;
    }>;
    const terminallyRejected: Array<{ userMessageSeq: number | null; userMessageSeqs?: readonly number[] }> = [];
    const undeliverable: Array<Array<{ text: string; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => terminallyRejected.push({ ...info }));
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('bad\u0000prompt', { userMessageSeq: 19 });

      expect(terminallyRejected).toEqual([{ userMessageSeq: 19, userMessageSeqs: [19] }]);
      await expect(runtime.waitForTurnCompletion()).rejects.toMatchObject({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }

    expect(undeliverable).toEqual([]);
  });

  it('does not fail the parent turn on a sidechain-attributed StopFailure (ported R-11 / HF-3)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      // A SUBAGENT auth/usage StopFailure must not terminalize the parent canonical turn.
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'subagent usage limit reached',
        source: 'hook',
        sidechainAgentId: 'agent-x',
      });

      // The parent turn then completes normally; a failed turn would make this throw.
      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('routes a non-sidechain auth-failure StopFailure into runtime-auth recovery', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const refreshRuntimeAuth = vi.fn(async () => ({ status: 'unavailable' as const, reason: 'runtime_auth_selection_unavailable' as const }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionAuth: { services: { refreshRuntimeAuth } },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-auth',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    try {
      await runtime.sendTurnPrompt('prompt that fails on auth');
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'OAuth token has expired',
        evidence: { error: 'invalid_grant', message: 'OAuth token has expired' },
        source: 'hook',
      });
      await completion.catch(() => undefined);
      await Promise.resolve();
      expect(refreshRuntimeAuth).toHaveBeenCalledTimes(1);
      expect(refreshRuntimeAuth).toHaveBeenCalledWith(expect.objectContaining({
        agentId: 'claude',
        serviceId: 'claude-subscription',
        classification: expect.objectContaining({ kind: 'auth_expired', limitCategory: 'auth_invalid' }),
      }));
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not route a sidechain auth StopFailure, nor a usage-limit StopFailure, into runtime-auth recovery', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const refreshRuntimeAuth = vi.fn(async () => ({ status: 'unavailable' as const, reason: 'runtime_auth_selection_unavailable' as const }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionAuth: { services: { refreshRuntimeAuth } },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-auth-neg',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    try {
      await runtime.sendTurnPrompt('first prompt');
      // Sidechain auth StopFailure must never drive parent-session recovery.
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'subagent OAuth token expired',
        evidence: { error: 'invalid_grant', message: 'OAuth token has expired' },
        source: 'hook',
        sidechainAgentId: 'agent-x',
      });
      // Usage-limit StopFailure stays on the usage path, not auth recovery.
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'usage limit reached',
        evidence: { error: 'rate_limit', last_assistant_message: "You've hit your session limit" },
        source: 'hook',
      });
      await completion.catch(() => undefined);
      await Promise.resolve();
      expect(refreshRuntimeAuth).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('completes the foreground turn after a completion candidate while a provider background task is running', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const thinkingStates: boolean[] = [];
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-background-task',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
      setThinking: (thinking) => {
        thinkingStates.push(thinking);
      },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string }>): Promise<boolean>;
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      isTurnInFlight(): boolean;
    }>;
    let completionSettled = false;

    try {
      await runtime.startOrLoadSession();
      await runtime.sendTurnPrompt('first prompt');
      await expect(nativeRuntime.confirmProviderAcceptance({ promptText: 'first prompt' })).resolves.toBe(true);
      expect(nativeRuntime.isTurnInFlight()).toBe(true);
      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-started-1',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });

      const completion = runtime.waitForTurnCompletion().then(() => {
        completionSettled = true;
      });
      completion.catch(() => undefined);
      const thinkingTrueCountBeforeCompletionCandidate = thinkingStates.filter((value) => value === true).length;

      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });

      await vi.waitFor(() => {
        expect(completionSettled).toBe(true);
      });
      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(
        thinkingStates.slice(thinkingTrueCountBeforeCompletionCandidate).filter((value) => value === true),
      ).toHaveLength(0);
      await completion;

      const thinkingTrueCountAfterCompletion = thinkingStates.filter((value) => value === true).length;

      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-progress-1',
        subtype: 'task_progress',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });

      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-completed-1',
        subtype: 'task_notification',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
        status: 'completed',
      });

      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(thinkingStates.filter((value) => value === true)).toHaveLength(thinkingTrueCountAfterCompletion);
      expect(thinkingStates.at(-1)).toBe(false);
      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites).toEqual(expect.arrayContaining([
          expect.objectContaining({
            fieldId: 'runtime.activity',
            value: expect.objectContaining({
              v: 1,
              activeCount: 1,
              sourceClass: 'provider_detached_task',
            }),
          }),
        ]));
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not create provider runtime activity from unknown sidechain hooks', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const thinkingStates: boolean[] = [];
    const writeStateField = vi.fn(async () => undefined);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-sidechain-activity',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
      setThinking: (thinking) => {
        thinkingStates.push(thinking);
      },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      isTurnInFlight(): boolean;
    }>;

    try {
      await runtime.startOrLoadSession();
      const thinkingTrueCountBeforeSidechainHook = thinkingStates.filter((value) => value === true).length;
      dateNow.mockReturnValue(70_000);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-1',
        source: 'hook',
      });

      await Promise.resolve();
      const runtimeActivityWrites = writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity');
      expect(runtimeActivityWrites).toEqual([]);
      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(thinkingStates.filter((value) => value === true)).toHaveLength(thinkingTrueCountBeforeSidechainHook);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-1',
        source: 'hook',
      });
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        source: 'hook',
        sidechainAgentId: 'agent-1',
        detail: 'rate_limit',
      });

      await Promise.resolve();
      expect(writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity')).toEqual([]);
      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(thinkingStates.filter((value) => value === true)).toHaveLength(thinkingTrueCountBeforeSidechainHook);
    } finally {
      dateNow.mockRestore();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('renews provider runtime activity from sidechain hooks for known provider-task sources', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const thinkingStates: boolean[] = [];
    const writeStateField = vi.fn(async () => undefined);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-sidechain-terminal-activity',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
      setThinking: (thinking) => {
        thinkingStates.push(thinking);
      },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      isTurnInFlight(): boolean;
    }>;

    try {
      await runtime.startOrLoadSession();
      const thinkingTrueCountBeforeSidechainHook = thinkingStates.filter((value) => value === true).length;
      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-started-1',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });
      await vi.waitFor(() => {
        expect(writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity')
          .at(-1)?.value?.activeCount).toBe(1);
      });

      writeStateField.mockClear();
      dateNow.mockReturnValue(500_000);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'sidechain_activity',
        sidechainAgentId: 'agent-1',
        source: 'hook',
      });
      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: expect.objectContaining({
            v: 1,
            activeCount: 1,
            observedAtMs: 500_000,
            sourceClass: 'provider_detached_task',
          }),
          reason: 'runtime_activity_source_renewed',
        }));
      });
      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(thinkingStates.filter((value) => value === true)).toHaveLength(thinkingTrueCountBeforeSidechainHook);
    } finally {
      dateNow.mockRestore();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('clears provider runtime activity from sidechain terminal hooks without touching foreground lifecycle', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const thinkingStates: boolean[] = [];
    const writeStateField = vi.fn(async () => undefined);
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-sidechain-terminal-activity',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
      setThinking: (thinking) => {
        thinkingStates.push(thinking);
      },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      isTurnInFlight(): boolean;
    }>;

    try {
      await runtime.startOrLoadSession();
      const thinkingTrueCountBeforeSidechainHook = thinkingStates.filter((value) => value === true).length;

      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-started-1',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });
      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: expect.objectContaining({
            v: 1,
            activeCount: 1,
            sourceClass: 'provider_detached_task',
          }),
        }));
      });

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'sidechain_terminal',
        sidechainAgentId: 'agent-1',
        source: 'hook',
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
      expect(nativeRuntime.isTurnInFlight()).toBe(false);
      expect(thinkingStates.filter((value) => value === true)).toHaveLength(thinkingTrueCountBeforeSidechainHook);
    } finally {
      dateNow.mockRestore();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('clears provider runtime activity from raw transcript origin and queued-command task notifications', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-background-task-transcript',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
    })).operations;

    try {
      await runtime.startOrLoadSession();

      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-started-1',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-1',
      });
      await transcripts.emitRow({
        type: 'user',
        uuid: 'task-origin-completed-1',
        origin: {
          kind: 'task-notification',
          taskId: 'agent-1',
          status: 'completed',
        },
        message: {
          content: [{ type: 'text', text: 'Task completed' }],
        },
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });

      await transcripts.emitRow({
        type: 'system',
        uuid: 'task-started-2',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'agent-2',
      });
      await transcripts.emitRow({
        type: 'queue-operation',
        operation: 'enqueue',
        uuid: 'queued-task-completed-2',
        content:
          '<task-notification><task-id>agent-2</task-id><status>completed</status></task-notification>',
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        const activeWrites = runtimeActivityWrites.filter((request) => request?.value?.activeCount === 1);
        const clearWrites = runtimeActivityWrites.filter((request) => request?.value?.activeCount === 0);
        expect(activeWrites).toHaveLength(2);
        expect(clearWrites).toHaveLength(2);
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: {
            v: 1,
            activeCount: 0,
            observedAtMs: null,
            expiresAtMs: null,
            sourceClass: null,
          },
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not mint provider runtime activity from replayed raw transcript task rows', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-transcript-replay',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
    })).operations;

    try {
      await runtime.startOrLoadSession();

      await transcripts.emitRow({
        type: 'system',
        uuid: 'replayed-task-started-1',
        subtype: 'task_started',
        session_id: 'claude-provider-session-1',
        task_id: 'replayed-agent-1',
        isReplay: true,
      });

      const runtimeActivityWrites = writeStateField.mock.calls
        .map((call) => call[0])
        .filter((request) => request?.fieldId === 'runtime.activity');
      expect(runtimeActivityWrites.every((request) => request?.value?.activeCount !== 1)).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('confirms provider acceptance when transcript evidence arrives before terminal injection resolves', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-early-transcript',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptAcceptedByProvider(
        handler: (info: Readonly<{ localIds?: readonly string[]; userMessageSeq: number | null; userMessageSeqs?: readonly number[] }>) => void,
      ): void;
    }>;
    const accepted: Array<{
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }> = [];
    const runtimeEvents: unknown[] = [];
    nativeRuntime.setOnPromptAcceptedByProvider((info) => accepted.push({ ...info }));
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    let transcriptEvent: Promise<void> | null = null;
    terminalHost.service.injectUserPrompt = vi.fn(async (_handle, input) => {
      // Production host-event publication schedules subscribers without waiting for
      // them; keep this transcript evidence asynchronous relative to injection.
      transcriptEvent = events.emit(CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID, {
        agentId: 'claude',
        sessionId: 'happy-session-early-transcript',
        providerSessionId: 'claude-session-1',
        kind: 'user_prompt',
        text: input.text.replace(/\r\n/g, '\n'),
        turnId: 'early-transcript-turn',
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        status: 'injected',
        injectedAt: 123,
        bytesWritten: input.text.length,
        hostKind: terminalHost.handle.kind,
        hostSessionName: terminalHost.handle.sessionName,
        paneId: terminalHost.handle.paneId,
      };
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello\r\nclaude', {
        localId: 'local-early',
        localIds: ['local-early'],
        userMessageSeq: 971,
        userMessageSeqs: [971],
      });
      if (!transcriptEvent) {
        throw new Error('Expected transcript evidence to be emitted during injection');
      }
      await transcriptEvent;

      await vi.waitFor(() => {
        expect(accepted).toEqual([{
          localIds: ['local-early'],
          userMessageSeq: 971,
          userMessageSeqs: [971],
        }]);
      });
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'transcript-user-text')).toEqual([]);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes provider transcript user interrupts as turn cancellation instead of turn failure', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-abort',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_aborted',
        turnId: null,
        reason: 'user_interrupt',
        detail: '[Request interrupted by user]',
        source: 'transcript',
      });

      await expect(completion).rejects.toThrow(/cancelled|interrupted/u);
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-cancelled')).toHaveLength(1);
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-failed')).toHaveLength(0);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps a non-compact active turn running across provider compaction completion', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    let completionSettled = false;

    try {
      await runtime.sendTurnPrompt('long running work');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'long running work',
        observedAtMs: 123,
        source: 'hook',
      });

      const completion = runtime.waitForTurnCompletion().then(() => {
        completionSettled = true;
      });

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'compaction_completed',
        source: 'transcript',
      });
      await Promise.resolve();
      expect(completionSettled).toBe(false);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate',
      });
      await completion;
      expect(completionSettled).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('dedupes repeated compact boundary lifecycle events by provider event id', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await runtime.sendTurnPrompt('/compact');
      const completion = runtime.waitForTurnCompletion();

      const observation = {
        agentId: 'claude',
        type: 'compaction_completed',
        agentEventId: 'claude:compact_boundary:claude-session-1:compact-boundary-1',
        source: 'transcript',
      };
      await nativeRuntime.observeTerminalLifecycle(observation);
      await nativeRuntime.observeTerminalLifecycle(observation);

      await completion;
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-complete')).toHaveLength(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('steers a delivered prompt after bounded custody probes survive transient screen misses', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      confirmProviderAcceptance(evidence?: Readonly<{ promptText?: string }>): Promise<boolean>;
      steerPrompt(prompt: string): Promise<void>;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      let captureCount = 0;
      terminalHost.service.captureInputState = vi.fn(async () => {
        captureCount += 1;
        if (captureCount === 3) {
          throw new Error('transient capture failure');
        }
        return {
          stable: true,
          currentInput: captureCount <= 2
            ? '✻ Pondering… (esc to interrupt)\n│ > │'
            : '✻ Pondering… (esc to interrupt)\nPress up to edit queued messages\n│ > │',
          observedAt: 200,
        };
      });

      await nativeRuntime.steerPrompt('be more concise');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(400);
      await vi.advanceTimersByTimeAsync(1_200);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(terminalHost.service.captureInputState).toHaveBeenCalledTimes(4);

      // The short provider-acceptance timeout must NOT run while the turn is in flight.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      // Turn-end evidence arms acceptance; Claude then auto-submits the queued steer.
      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      const accepted = await nativeRuntime.confirmProviderAcceptance({ promptText: 'be more concise' });
      expect(accepted).toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not treat a queued banner as terminal custody while the composer still has a draft', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-queued-banner-draft',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      steerPrompt(prompt: string): Promise<void>;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      let captureCount = 0;
      terminalHost.service.captureInputState = vi.fn(async () => {
        captureCount += 1;
        return {
          stable: true,
          currentInput: captureCount === 1
            ? '✻ Pondering… (esc to interrupt)\n│ > │'
            : [
              '✻ Pondering… (esc to interrupt)',
              'Press up to edit queued messages',
              '│ > be more concise │',
            ].join('\n'),
          observedAt: 200,
        };
      });

      await nativeRuntime.steerPrompt('be more concise');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(400);

      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('terminalizes queued-banner custody when provider acceptance never proves the steered prompt', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-queued-banner-loss',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      steerPrompt(prompt: string, options?: Readonly<{ userMessageSeq?: number | null }>): Promise<void>;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      let captureCount = 0;
      terminalHost.service.captureInputState = vi.fn(async () => {
        captureCount += 1;
        return {
          stable: true,
          currentInput: captureCount === 1
            ? '✻ Pondering… (esc to interrupt)\n│ > │'
            : [
              '✻ Pondering… (esc to interrupt)',
              'Press up to edit queued messages',
              '│ > │',
            ].join('\n'),
          observedAt: 200,
        };
      });

      await nativeRuntime.steerPrompt('be more concise', { userMessageSeq: 31 });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(400);
      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      await expect(runtime.waitForTurnCompletion()).rejects.toMatchObject({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not hand back queued-banner custody on dispose before provider acceptance', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-queued-banner-handback',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      steerPrompt(prompt: string, options?: Readonly<{ userMessageSeq?: number | null }>): Promise<void>;
      setOnUndeliverablePrompts(
        handler: (prompts: ReadonlyArray<Readonly<{ text: string; userMessageSeq: number | null }>>) => void,
      ): void;
    }>;
    const undeliverable: Array<Array<{ text: string; userMessageSeq: number | null }>> = [];
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      let captureCount = 0;
      terminalHost.service.captureInputState = vi.fn(async () => {
        captureCount += 1;
        return {
          stable: true,
          currentInput: captureCount === 1
            ? '✻ Pondering… (esc to interrupt)\n│ > │'
            : [
              '✻ Pondering… (esc to interrupt)',
              'Press up to edit queued messages',
              '│ > │',
            ].join('\n'),
          observedAt: 200,
        };
      });

      await nativeRuntime.steerPrompt('be more concise', { userMessageSeq: 31 });
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }

    expect(undeliverable).toEqual([]);
  });

  it('refuses to steer when the screen shows a user draft (fail-closed veto)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      steerPrompt(prompt: string): Promise<void>;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: '✻ Pondering… (esc to interrupt)\n│ > user draft │',
        observedAt: 200,
      }));

      await expect(nativeRuntime.steerPrompt('be more concise')).rejects.toThrow(/steer/u);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps context-mutating slash commands deferred but steers native-queued slash commands', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      steerPrompt(prompt: string): Promise<void>;
    }>;

    try {
      await expect(nativeRuntime.steerPrompt('/compact')).rejects.toThrow(/steer/u);
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      await envelope.operations.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: '✻ Pondering… (esc to interrupt)\n│ > │',
        observedAt: 200,
      }));

      await nativeRuntime.steerPrompt('/model');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('surfaces a structured readiness-timeout issue instead of hanging or dying silently', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: 'Loading conversation...\nRendering resumed transcript history',
      observedAt: 101,
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      startupReadiness: {
        baseTimeoutMs: 1_000,
        extendedTimeoutMs: 4_000,
        progressGraceMs: 400,
        pollIntervalMs: 100,
      },
    }));
    const runtime = envelope.operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);

      // Pane alive but no SessionStart and a static screen: live-but-unconfirmed hosts
      // fast-fail after base + progress grace instead of extending to the hard ceiling.
      await vi.advanceTimersByTimeAsync(2_500);

      await expect(completion).rejects.toThrow(/readiness/iu);
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          sessionId: 'happy-session-1',
        }),
      ]));
      // The session-turn lifecycle only commits failures for KNOWN turns: the readiness
      // timeout must publish begin+fail (turn-start then turn-failed, same turnId), not a
      // dangling turn-failed that the lifecycle drops (SILENT-F1 port).
      const failedEvent = runtimeEvents.find(
        (event): event is Readonly<{ kind: string; turnId: string }> =>
          typeof event === 'object' && event !== null
          && (event as { kind?: unknown }).kind === 'turn-failed'
          && typeof (event as { turnId?: unknown }).turnId === 'string',
      );
      expect(failedEvent).toBeTruthy();
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-start',
          sessionId: 'happy-session-1',
          turnId: failedEvent?.turnId,
        }),
      ]));
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('extends the startup window while SessionStart proves the host alive, then injects when ready', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: 'Loading conversation...\nRendering resumed transcript history',
      observedAt: 101,
    }));
    const sessionHooks = {
      startServer: vi.fn(async () => ({
        port: 43123,
        stop: vi.fn(),
        dispose: vi.fn(async () => undefined),
      })),
      resolveForwarderAssets: vi.fn(async () => ({
        nodeExecutable: '/bin/node',
        sessionForwarderScript: '/app/session_hook_forwarder.cjs',
        permissionForwarderScript: '/app/permission_hook_forwarder.cjs',
      })),
      createPluginDir: vi.fn(async () => '/tmp/happier-claude-hook-plugin'),
      disposePluginDir: vi.fn(async () => undefined),
      publishProviderTranscript: vi.fn(async () => undefined),
    };
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { sessionHooks });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      startupReadiness: {
        baseTimeoutMs: 1_000,
        extendedTimeoutMs: 8_000,
        progressGraceMs: 400,
        pollIntervalMs: 100,
      },
    }));
    const runtime = envelope.operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');

      // SessionStart hook = host-alive evidence (NOT injection readiness).
      const startServerOptions = sessionHooks.startServer.mock.calls[0]?.[0] as {
        onSessionHook: (providerSessionId: string, payload: unknown) => Promise<void>;
      };
      await startServerOptions.onSessionHook('claude-provider-session-1', {
        hook_event_name: 'SessionStart',
      });

      // Static screen well past base + grace: a SessionStart-confirmed host holds
      // through the stall up to the hard ceiling instead of fast-failing.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      // The composer finally renders; the next poll injects.
      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: '│ > │',
        observedAt: 4_000,
      }));
      await vi.advanceTimersByTimeAsync(500);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('answers the startup resume-choice dialog from the configured auto preference before injection', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    let resumeDialogResolved = false;
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: resumeDialogResolved ? IDLE_COMPOSER : RESUME_CHOICE_DIALOG,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER],
      onSendSpecialKey: (key) => {
        if (key === 'Enter') resumeDialogResolved = true;
      },
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-auto',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      resumeChoice: 'resume_full_session',
      tuiControl: { timings: { commandSettleMs: 0 } },
      startupReadiness: {
        baseTimeoutMs: 1_000,
        extendedTimeoutMs: 4_000,
        progressGraceMs: 400,
        pollIntervalMs: 100,
      },
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      await vi.advanceTimersByTimeAsync(200);

      expect(fakePort.sentLiteral).toEqual(['2']);
      expect(fakePort.sentKeys).toEqual(['Enter']);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('answers an orphan startup effort dialog before injecting the queued prompt', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    let effortDialogResolved = false;
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: effortDialogResolved ? IDLE_COMPOSER : EFFORT_HIGH_DIALOG,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [EFFORT_HIGH_DIALOG, IDLE_COMPOSER],
      onSendSpecialKey: (key) => {
        if (key === 'Enter') effortDialogResolved = true;
      },
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-orphan-effort',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      tuiControl: { timings: { commandSettleMs: 0 } },
      startupReadiness: {
        baseTimeoutMs: 1_000,
        extendedTimeoutMs: 4_000,
        progressGraceMs: 400,
        pollIntervalMs: 100,
      },
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'high' },
      });

      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      await vi.advanceTimersByTimeAsync(200);

      expect(fakePort.sentLiteral).toEqual(['1']);
      expect(fakePort.sentKeys).toEqual(['Enter']);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes a user-action resume-choice question and pauses startup timeout while awaiting the answer', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    let resumeDialogResolved = false;
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: resumeDialogResolved ? IDLE_COMPOSER : RESUME_CHOICE_DIALOG,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [RESUME_CHOICE_DIALOG, IDLE_COMPOSER],
      onSendSpecialKey: (key) => {
        if (key === 'Enter') resumeDialogResolved = true;
      },
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    type ResumeChoiceDecision = Readonly<{ decision: 'approved'; answers: Readonly<Record<string, string>> }>;
    let resolveDecision: ((value: ResumeChoiceDecision) => void) | null = null;
    const requestDecision = vi.fn((_request: unknown, options?: Readonly<{ signal?: AbortSignal }>) => new Promise<ResumeChoiceDecision>((resolve, reject) => {
      resolveDecision = resolve;
      options?.signal?.addEventListener('abort', () => {
        reject(new Error('resume choice aborted'));
      });
    }));
    const events = createEventsFixture();
    const runtimeEvents: unknown[] = [];
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-ask',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      resumeChoice: 'ask_every_time',
      tuiControl: { timings: { commandSettleMs: 0 } },
      startupReadiness: {
        baseTimeoutMs: 1_000,
        extendedTimeoutMs: 2_000,
        progressGraceMs: 400,
        pollIntervalMs: 100,
      },
    })).operations;
    runtime.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');
      await vi.advanceTimersByTimeAsync(5_000);

      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({
          questions: [expect.objectContaining({ question: RESUME_CHOICE_QUESTION })],
        }),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      expect(runtimeEvents).not.toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'turn-failed' })]));

      resolveDecision?.({
        decision: 'approved',
        answers: { [RESUME_CHOICE_QUESTION]: 'Resume full session' },
      });
      await vi.advanceTimersByTimeAsync(300);

      expect(fakePort.sentLiteral).toEqual(['2']);
      expect(fakePort.sentKeys).toEqual(['Enter']);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('answers a safeguard pause discovered by the stale-turn screen probe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    let currentScreen = IDLE_COMPOSER;
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: currentScreen,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [SAFEGUARD_PAUSE_DIALOG, IDLE_COMPOSER],
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [SAFEGUARD_CHOICE_QUESTION]: 'Switch to Opus 4.8' },
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-safeguard-stale',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      tuiControl: { timings: { commandSettleMs: 0 } },
      staleTurnRecovery: { windowMs: 100, pollIntervalMs: 10 },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      notifyPromptQueuedDuringTurn(): void;
    }>;

    try {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 1_000,
        source: 'hook',
      });
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);

      currentScreen = SAFEGUARD_PAUSE_DIALOG;
      nativeRuntime.notifyPromptQueuedDuringTurn();
      await vi.advanceTimersByTimeAsync(500);

      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({
          questions: [expect.objectContaining({ question: SAFEGUARD_CHOICE_QUESTION })],
        }),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(fakePort.sentLiteral).toEqual(['1']);
      expect(fakePort.sentKeys).toEqual(['Enter']);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('surfaces and answers a dialog that pops after the turn settles via the bounded turn-end idle probe', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    let currentScreen = IDLE_COMPOSER;
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: currentScreen,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [SAFEGUARD_PAUSE_DIALOG, IDLE_COMPOSER],
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { [SAFEGUARD_CHOICE_QUESTION]: 'Switch to Opus 4.8' },
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-turn-end-probe',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      tuiControl: { timings: { commandSettleMs: 0 } },
      dialogResolution: { turnEndProbeDelaysMs: [0, 20] },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;

    try {
      await runtime.startOrLoadSession();
      // A terminal-origin turn runs and then settles; a queued control pops a dialog into the now
      // idle session with NO further screen observation from the readiness/stale-turn loops.
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'user typed directly in the terminal',
        observedAtMs: 1_000,
        source: 'hook',
      });
      currentScreen = SAFEGUARD_PAUSE_DIALOG;
      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      await vi.advanceTimersByTimeAsync(50);

      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'claude',
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({
          questions: [expect.objectContaining({ question: SAFEGUARD_CHOICE_QUESTION })],
        }),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      expect(fakePort.sentLiteral).toEqual(['1']);
      expect(fakePort.sentKeys).toEqual(['Enter']);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('escalates once and projects a durable runtime_config_blocked block when a dialog blocks a queued prompt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.captureInputState = vi.fn(async () => ({
      stable: true,
      currentInput: SAFEGUARD_PAUSE_DIALOG,
      observedAt: Date.now(),
    }));
    const fakePort = createFakeControlPort({
      captures: [SAFEGUARD_PAUSE_DIALOG, SAFEGUARD_PAUSE_DIALOG],
    });
    terminalHost.service.controlPort = vi.fn(async () => fakePort);
    // The published dialog is never answered, so the block persists until the escalation window.
    const requestDecision = vi.fn(() => new Promise<never>(() => undefined));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-dialog-block',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      tuiControl: { timings: { commandSettleMs: 0 } },
      dialogResolution: { injectionBlockEscalationMs: 1_000 },
      startupReadiness: {
        baseTimeoutMs: 30_000,
        extendedTimeoutMs: 120_000,
        progressGraceMs: 20_000,
        pollIntervalMs: 100,
      },
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnPromptTerminallyRejectedBeforeProvider(
        handler: (info: Readonly<{
          localIds?: readonly string[];
          userMessageSeq: number | null;
          deliveryBlockedReason?: string;
        }>) => void,
      ): void;
    }>;
    const rejected: Array<{ localIds?: readonly string[]; deliveryBlockedReason?: string }> = [];
    nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('queued behind a blocking dialog', {
        localId: 'local-dialog-block',
        localIds: ['local-dialog-block'],
        userMessageSeq: null,
      });
      await vi.advanceTimersByTimeAsync(1_300);

      // Route-on-block: the recognized dialog was published for a decision before deferring.
      expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
        toolName: 'AskUserQuestion',
        input: expect.objectContaining({
          questions: [expect.objectContaining({ question: SAFEGUARD_CHOICE_QUESTION })],
        }),
      }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
      // Durable block projection reuses the runtime_config_blocked reason (one-shot).
      expect(rejected).toEqual([
        expect.objectContaining({
          localIds: ['local-dialog-block'],
          deliveryBlockedReason: 'runtime_config_blocked',
        }),
      ]);
      // The prompt was never injected while the dialog owned input.
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('fails the turn when terminal liveness reports a dead pane before injection', async () => {
    const terminalHost = createTerminalHostFixture();
    terminalHost.service.evaluateLiveness = vi.fn(async () => ({
      paneAlive: false,
      paneDead: true,
      observedAt: 101,
    }));
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('hello claude');

      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      await expect(runtime.waitForTurnCompletion()).rejects.toThrow(/awaiting provider acceptance/u);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('surfaces a failed terminal turn before provider acceptance and does not replay the injected prompt', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-terminal-failed-before-acceptance',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      setOnUndeliverablePrompts(
        handler: (prompts: ReadonlyArray<Readonly<{
          text: string;
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
        }>>) => void,
      ): void;
    }>;
    const runtimeEvents: unknown[] = [];
    const undeliverable: Array<Array<{
      text: string;
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('terminal fails before provider acceptance', {
        localId: 'local-terminal-failed-before-acceptance',
        localIds: ['local-terminal-failed-before-acceptance'],
        userMessageSeq: null,
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'terminal failed before provider acceptance',
        source: 'hook',
      });

      await expect(completion).rejects.toThrow(/terminal failed before provider acceptance|awaiting provider acceptance/u);
      const failedEvent = runtimeEvents.find(
        (event): event is Readonly<{ kind: string; turnId: string }> =>
          typeof event === 'object' && event !== null
          && (event as { kind?: unknown }).kind === 'turn-failed'
          && typeof (event as { turnId?: unknown }).turnId === 'string',
      );
      expect(failedEvent).toBeTruthy();
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-start',
          sessionId: 'happy-session-terminal-failed-before-acceptance',
          turnId: failedEvent?.turnId,
        }),
        expect.objectContaining({
          kind: 'turn-failed',
          sessionId: 'happy-session-terminal-failed-before-acceptance',
          turnId: failedEvent?.turnId,
        }),
      ]));

      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      expect(undeliverable).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('does not replay an injected prompt when pending delivery drains before the failed terminal turn', async () => {
    let pendingDeliveryDrainedWithoutProviderAcceptance = false;
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHasProviderAcceptedUserMessageDelivery: vi.fn(() => pendingDeliveryDrainedWithoutProviderAcceptance),
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-terminal-failed-after-pending-drain',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      setOnUndeliverablePrompts(
        handler: (prompts: ReadonlyArray<Readonly<{
          text: string;
          localIds?: readonly string[];
          userMessageSeq: number | null;
          userMessageSeqs?: readonly number[];
        }>>) => void,
      ): void;
    }>;
    const undeliverable: Array<Array<{
      text: string;
      localIds?: readonly string[];
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    try {
      runtime.beginTurnLifecycle();
      await runtime.sendTurnPrompt('terminal fails after pending delivery drained', {
        localId: 'local-terminal-failed-after-pending-drain',
        localIds: ['local-terminal-failed-after-pending-drain'],
        userMessageSeq: null,
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);
      pendingDeliveryDrainedWithoutProviderAcceptance = true;
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'turn_failed',
        turnId: null,
        reason: 'stop_failure_hook',
        detail: 'terminal failed after pending delivery drained',
        source: 'hook',
      });

      await expect(completion).rejects.toThrow(/terminal failed after pending delivery drained|awaiting provider acceptance/u);
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      expect(undeliverable).toEqual([]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('rejects waitForTurnCompletion with a CLASSIFIED injection-failure error when provider acceptance never arrives (failed_terminal exit contract, incident pid-82626)', async () => {
    // T2b regression seam (a): when an injected prompt is never accepted and the single
    // ambiguous retry is exhausted, the turn must reject with a CLASSIFIED error (stable code +
    // failureState) so host loops can park instead of treating it as an opaque fatal.
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-injection-contract',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.sendTurnPrompt('prompt that is never accepted by the provider');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      // First acceptance timeout → failed_ambiguous → ONE automatic retry re-injects.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      // Second acceptance timeout → failed_terminal (retry exhausted).
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(runtime.waitForTurnCompletion()).rejects.toMatchObject({
        code: 'claude_unified_terminal_injection_failed',
        failureState: 'failed_terminal',
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('hands back server-owned pending input after ambiguous provider-acceptance timeout without reinjecting', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-terminal-unknown',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      setOnUndeliverablePrompts(
        handler: (
          prompts: ReadonlyArray<Readonly<{
            text: string;
            userMessageSeq: number | null;
            userMessageSeqs?: readonly number[];
          }>>,
        ) => void,
      ): void;
    }>;
    const undeliverable: Array<Array<{
      text: string;
      userMessageSeq: number | null;
      userMessageSeqs?: readonly number[];
    }>> = [];
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });
    nativeRuntime.setOnUndeliverablePrompts((prompts) => undeliverable.push(prompts.map((prompt) => ({ ...prompt }))));

    try {
      await runtime.sendTurnPrompt('prompt that may already be in Claude custody', {
        userMessageSeq: 27,
        userMessageSeqs: [27],
      });
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.resolve();

      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      expect(runtimeEvents).toContainEqual(expect.objectContaining({
        kind: 'backend-error',
        error: expect.objectContaining({
          cause: expect.objectContaining({
            failureState: 'failed_ambiguous',
            reason: 'ambiguous_provider_acceptance',
          }),
        }),
      }));

      await vi.advanceTimersByTimeAsync(5_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }

    expect(undeliverable).toEqual([[
      {
        text: 'prompt that may already be in Claude custody',
        userMessageSeq: 27,
        userMessageSeqs: [27],
      },
    ]]);
  });

  it('does not run a fatal idle-readiness watchdog after provider acceptance', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    let completionSettled = false;

    try {
      await runtime.sendTurnPrompt('accepted before idle readiness');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'accepted before idle readiness',
        observedAtMs: 123,
        source: 'hook',
      });

      const completion = runtime.waitForTurnCompletion().then(() => {
        completionSettled = true;
      });
      await vi.advanceTimersByTimeAsync(60_000);

      expect(completionSettled).toBe(false);
      expect(terminalHost.service.evaluateLiveness).toHaveBeenCalledTimes(1);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate',
      });
      await completion;
      expect(completionSettled).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes canonical turn-start, throttled active-turn progress, and turn-complete events', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
    }>;
    const runtimeEvents: unknown[] = [];
    const unsubscribe = runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      await runtime.sendTurnPrompt('long running work');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'long running work',
        observedAtMs: 1_000,
        source: 'hook',
      });

      await vi.advanceTimersByTimeAsync(59_000);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate_invalidated',
      });
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-progress')).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1_001);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate_invalidated',
      });
      const progressEvents = runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-progress');
      expect(progressEvents).toHaveLength(1);
      expect(progressEvents[0]).toEqual(expect.objectContaining({
        kind: 'turn-progress',
        sessionId: 'happy-session-1',
        turnId: expect.stringContaining('happy-session-1'),
        emittedAtMs: 61_001,
      }));
      const turnId = (progressEvents[0] as { turnId: string }).turnId;
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-start')).toEqual([
        expect.objectContaining({
          kind: 'turn-start',
          sessionId: 'happy-session-1',
          turnId,
          emittedAtMs: 1_000,
        }),
      ]);

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate',
      });
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-complete')).toEqual([
        expect.objectContaining({
          kind: 'turn-complete',
          sessionId: 'happy-session-1',
          turnId,
          emittedAtMs: 61_001,
        }),
      ]);
      await vi.advanceTimersByTimeAsync(61_000);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate_invalidated',
      });
      await vi.advanceTimersByTimeAsync(61_000);
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate_invalidated',
      });
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'turn-progress')).toHaveLength(1);
    } finally {
      unsubscribe();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports already-effective convergence when a post-launch update matches the launch config (L5d)', async () => {
    // Anti-hot-loop convergence: a pending override whose requested values equal the
    // launch-effective config can never be "applied harder" — without this short-circuit the
    // host override-synchronizer keeps it pending and re-attempts it at every metadata event /
    // turn boundary forever. A request that genuinely differs stays pending
    // (requires_interactive_control) because live TUI control is gated off.
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      await runtime.updateSessionRuntimeConfig({ configOption: { id: 'reasoning_effort', value: 'high' } });
      await runtime.startOrLoadSession();

      // Same model as launch → converged, not pending.
      await expect(runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' })).resolves.toEqual(
        expect.objectContaining({ status: 'applied', timing: 'skipped_already_effective' }),
      );
      // Same effort as launch (case-insensitive) → converged.
      await expect(runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'High' },
      })).resolves.toEqual(
        expect.objectContaining({ status: 'applied', timing: 'skipped_already_effective' }),
      );
      // Different model → genuinely pending.
      await expect(runtime.updateSessionRuntimeConfig({ modelId: 'claude-sonnet-4-6' })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
      // Different effort → genuinely pending.
      await expect(runtime.updateSessionRuntimeConfig({
        configOption: { id: 'reasoning_effort', value: 'medium' },
      })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
      // Mixed update where one directive diverges → pending (no partial convergence claims).
      await expect(runtime.updateSessionRuntimeConfig({
        modelId: 'claude-opus-4-8',
        configOption: { id: 'reasoning_effort', value: 'medium' },
      })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
      // Unrecognized directive (session mode) → pending, never claimed converged.
      await expect(runtime.updateSessionRuntimeConfig({ modeId: 'plan' })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('reports already-effective convergence for ultracode and fallback-model post-launch matches (L5d)', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    })).operations;

    try {
      await runtime.updateSessionRuntimeConfig({ modelId: 'claude-opus-4-8' });
      await runtime.updateSessionRuntimeConfig({ configOption: { id: 'ultracode', value: 'true' } });
      await runtime.startOrLoadSession();

      await expect(runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'true' },
      })).resolves.toEqual(
        expect.objectContaining({ status: 'applied', timing: 'skipped_already_effective' }),
      );
      await expect(runtime.updateSessionRuntimeConfig({
        configOption: { id: 'ultracode', value: 'false' },
      })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
      // No fallback model was set at launch; requesting a cleared fallback is already effective.
      await expect(runtime.updateSessionRuntimeConfig({ fallbackModel: null })).resolves.toEqual(
        expect.objectContaining({ status: 'applied', timing: 'skipped_already_effective' }),
      );
      await expect(runtime.updateSessionRuntimeConfig({ fallbackModel: 'claude-sonnet-4-6' })).resolves.toEqual(
        expect.objectContaining({ status: 'requires_interactive_control' }),
      );
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  describe('stale-turn recovery (incident cmq7pyqkj, L1)', () => {
    type StaleTurnNativeRuntime = Readonly<{
      observeTerminalLifecycle(observation: unknown): Promise<void>;
      notifyPromptQueuedDuringTurn(): void;
      isTurnInFlight(): boolean;
    }>;

    function createStaleTurnFixture(overrides?: Readonly<{
      captureInputState?: ReturnType<typeof vi.fn>;
    }>) {
      vi.useFakeTimers();
      const terminalHost = createTerminalHostFixture();
      if (overrides?.captureInputState) {
        terminalHost.service.captureInputState = overrides.captureInputState;
      }
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-1',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
        staleTurnRecovery: { windowMs: 1_000, pollIntervalMs: 100 },
      }));
      return {
        terminalHost,
        runtime: envelope.operations,
        nativeRuntime: envelope.nativeRuntime as unknown as StaleTurnNativeRuntime,
      };
    }

    async function startAcceptedTurn(
      runtime: ReturnType<typeof createStaleTurnFixture>['runtime'],
      nativeRuntime: StaleTurnNativeRuntime,
    ): Promise<void> {
      await runtime.sendTurnPrompt('first prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first prompt',
        observedAtMs: 123,
        source: 'hook',
      });
    }

    it('reconciles a stale turn and unblocks completion when a prompt is queued behind it', async () => {
      // Incident class: completion evidence lost (no lifecycle events), the host loop is blocked
      // in waitForTurnCompletion, and a mode-change/special message is queued behind the phantom
      // turn. With a queued-prompt demand signal, a bounded silent window plus idle-composer
      // screen evidence reconciles the turn so the queued prompt drains as a NEW turn.
      const { runtime, nativeRuntime } = createStaleTurnFixture();
      try {
        await startAcceptedTurn(runtime, nativeRuntime);
        let completionSettled = false;
        const completion = runtime.waitForTurnCompletion().then(() => {
          completionSettled = true;
        });

        nativeRuntime.notifyPromptQueuedDuringTurn();
        await vi.advanceTimersByTimeAsync(2_000);

        await completion;
        expect(completionSettled).toBe(true);
        expect(nativeRuntime.isTurnInFlight()).toBe(false);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('keeps waiting while the screen proves the turn is still generating (fail-closed)', async () => {
      const { runtime, nativeRuntime } = createStaleTurnFixture({
        captureInputState: vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > │',
          observedAt: 200,
        })),
      });
      try {
        await startAcceptedTurn(runtime, nativeRuntime);
        let completionSettled = false;
        const completion = runtime.waitForTurnCompletion().then(() => {
          completionSettled = true;
        });
        completion.catch(() => undefined);

        nativeRuntime.notifyPromptQueuedDuringTurn();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(completionSettled).toBe(false);
        expect(nativeRuntime.isTurnInFlight()).toBe(true);

        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await completion;
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('keeps waiting while screen capture fails (fail-closed)', async () => {
      const { runtime, nativeRuntime } = createStaleTurnFixture({
        captureInputState: vi.fn(async () => {
          throw new Error('capture failed');
        }),
      });
      try {
        await startAcceptedTurn(runtime, nativeRuntime);
        let completionSettled = false;
        const completion = runtime.waitForTurnCompletion().then(() => {
          completionSettled = true;
        });
        completion.catch(() => undefined);

        nativeRuntime.notifyPromptQueuedDuringTurn();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(completionSettled).toBe(false);

        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await completion;
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('treats fresh provider lifecycle activity as a live turn and restarts the silence window', async () => {
      const { runtime, nativeRuntime, terminalHost } = createStaleTurnFixture({
        captureInputState: vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > │',
          observedAt: 200,
        })),
      });
      try {
        await startAcceptedTurn(runtime, nativeRuntime);
        let completionSettled = false;
        const completion = runtime.waitForTurnCompletion().then(() => {
          completionSettled = true;
        });

        nativeRuntime.notifyPromptQueuedDuringTurn();
        await vi.advanceTimersByTimeAsync(600);
        // Live provider evidence mid-window: the silence clock restarts.
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude',
          type: 'completion_candidate_invalidated',
        });
        // Past the ORIGINAL window but within the restarted one — and the screen still
        // proves generating, so nothing reconciles even after the restarted window.
        await vi.advanceTimersByTimeAsync(600);
        expect(completionSettled).toBe(false);

        // The screen finally proves the turn ended; the restarted window expires → reconcile.
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: 'What would you like to work on?',
          observedAt: 300,
        }));
        await vi.advanceTimersByTimeAsync(1_500);
        await completion;
        expect(completionSettled).toBe(true);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('does not arm stale-turn recovery without a queued-prompt demand signal', async () => {
      // The pinned no-idle-watchdog contract: a long, quiet, accepted turn with an idle-looking
      // screen must NOT be reconciled unless a prompt is actually starving behind it.
      const { runtime, nativeRuntime } = createStaleTurnFixture();
      try {
        await startAcceptedTurn(runtime, nativeRuntime);
        let completionSettled = false;
        const completion = runtime.waitForTurnCompletion().then(() => {
          completionSettled = true;
        });

        await vi.advanceTimersByTimeAsync(10_000);
        expect(completionSettled).toBe(false);

        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await completion;
        expect(completionSettled).toBe(true);
      } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('publishes provider runtime activity from Bash background command transcript results', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = createManualTranscriptFollowFixture();
    const writeStateField = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: transcripts.service,
      sessionWriteStateField: writeStateField,
    });
    const runtime = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-background-bash',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-provider-session-1',
        transcriptPath: '/tmp/claude-provider-session-1.jsonl',
      },
    })).operations;

    try {
      await runtime.startOrLoadSession();

      await transcripts.emitRow({
        type: 'user',
        uuid: 'bash-background-launch',
        session_id: 'claude-provider-session-1',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_bash',
            content:
              'Command running in background with ID: b9c3fz9oq. Output is being written to: /tmp/b9c3fz9oq.output.',
            is_error: false,
          }],
        },
        toolUseResult: {
          stdout: '',
          stderr: '',
          interrupted: false,
          isImage: false,
          noOutputExpected: false,
          backgroundTaskId: 'b9c3fz9oq',
        },
      });

      await vi.waitFor(() => {
        const runtimeActivityWrites = writeStateField.mock.calls
          .map((call) => call[0])
          .filter((request) => request?.fieldId === 'runtime.activity');
        expect(runtimeActivityWrites.at(-1)).toEqual(expect.objectContaining({
          fieldId: 'runtime.activity',
          value: expect.objectContaining({
            v: 1,
            activeCount: 1,
            sourceClass: 'provider_detached_task',
          }),
        }));
      });
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});

  describe('user_draft starvation (incident 294-veto loop, lane X1)', () => {
    function createDraftRuntime(options?: Readonly<{ startupReadiness?: Record<string, number> }>) {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      let agentState: Readonly<Record<string, unknown>> = {};
      const writeAgentState = vi.fn(async (request: {
        kind: string;
        handler?: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      }) => {
        if (request.kind === 'update' && request.handler) {
          agentState = request.handler(agentState);
        }
      });
      const sessionSend = vi.fn(async () => ({ ok: true }));
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionSend,
        sessionWriteAgentState: writeAgentState,
      });
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-draft',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
        ...(options?.startupReadiness ? { startupReadiness: options.startupReadiness } : {}),
      }));
      const capabilities = () => (agentState.capabilities ?? {}) as Readonly<Record<string, unknown>>;
      return { terminalHost, ctx, envelope, runtime: envelope.operations, sessionSend, capabilities };
    }

    it('clears an OWN exact-match leftover draft on a non-generating screen and injects the queued prompt', async () => {
      const { terminalHost, runtime, envelope } = createDraftRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });
        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await runtime.waitForTurnCompletion();

        // The injected text remained in the composer (lost Enter): an OWN leftover, idle screen.
        let cleared = false;
        terminalHost.service.interruptTurn = vi.fn(async () => {
          cleared = true;
        });
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: cleared ? 'What would you like to work on?\n│ > │' : '│ > first prompt │',
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('second prompt');

        expect(terminalHost.service.interruptTurn).toHaveBeenCalledTimes(1);
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
        expect((terminalHost.service.injectUserPrompt as ReturnType<typeof vi.fn>).mock.calls[1]?.[1]).toMatchObject({
          text: 'second prompt',
        });
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('treats a provider-claimed pending prompt already visible in the composer as owned', async () => {
      const { terminalHost, runtime } = createDraftRuntime();
      const providerClaimedPrompt = 'provider claimed pending prompt already in composer';
      let cleared = false;
      try {
        terminalHost.service.interruptTurn = vi.fn(async () => {
          cleared = true;
        });
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: cleared ? 'What would you like to work on?\n│ > │' : `│ > ${providerClaimedPrompt} │`,
          cursor: { x: cleared ? 5 : providerClaimedPrompt.length + 5, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt(providerClaimedPrompt, {
          localId: 'local-provider-claimed-composer',
          localIds: ['local-provider-claimed-composer'],
          providerClaimedPendingLocalIds: ['local-provider-claimed-composer'],
        });

        expect(terminalHost.service.interruptTurn).toHaveBeenCalledTimes(1);
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
        expect((terminalHost.service.injectUserPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
          text: providerClaimedPrompt,
        });
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('treats a short provider-claimed pending prompt prefix already visible in the composer as owned', async () => {
      const { terminalHost, runtime } = createDraftRuntime();
      const providerClaimedPrompt = `continue the provider-claimed pending message ${'x'.repeat(320)}`;
      const shortResidue = providerClaimedPrompt.slice(0, 19);
      let cleared = false;
      try {
        terminalHost.service.interruptTurn = vi.fn(async () => {
          cleared = true;
        });
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: cleared ? 'What would you like to work on?\n│ > │' : `│ > ${shortResidue} │`,
          cursor: { x: cleared ? 5 : shortResidue.length + 5, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt(providerClaimedPrompt, {
          localId: 'local-provider-claimed-short-composer',
          localIds: ['local-provider-claimed-short-composer'],
          providerClaimedPendingLocalIds: ['local-provider-claimed-short-composer'],
        });

        expect(terminalHost.service.interruptTurn).toHaveBeenCalledTimes(1);
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
        expect((terminalHost.service.injectUserPrompt as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toMatchObject({
          text: providerClaimedPrompt,
        });
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('NEVER clears a genuine user draft (non-matching text fails closed to the deferred path)', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime } = createDraftRuntime();
      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > my own typed draft │',
          cursor: { x: 24, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt');

        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
        expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('NEVER clears a genuine draft equal to one line of a previous multiline prompt', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, envelope } = createDraftRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      try {
        const multilinePrompt = 'first instruction line\nsecond instruction line\nthird instruction line';
        await runtime.sendTurnPrompt(multilinePrompt);
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: multilinePrompt, observedAtMs: 123, source: 'hook',
        });
        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await runtime.waitForTurnCompletion();

        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > second instruction line │',
          cursor: { x: 27, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt');

        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('NEVER clears a genuine draft equal to a previous prompt plus a one-letter suffix', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, envelope } = createDraftRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      try {
        const previousPrompt = 'please continue with the refactor';
        await runtime.sendTurnPrompt(previousPrompt);
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: previousPrompt, observedAtMs: 123, source: 'hook',
        });
        await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
        await runtime.waitForTurnCompletion();

        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: `│ > ${previousPrompt} d │`,
          cursor: { x: 37, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt');

        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('blocks sustained plain contextual placeholder captures as capture-style unavailable', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, sessionSend, envelope } = createDraftRuntime({
        startupReadiness: { baseTimeoutMs: 5_000, extendedTimeoutMs: 5_000, progressGraceMs: 0, pollIntervalMs: 1_000 },
      });
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        setOnPromptTerminallyRejectedBeforeProvider(
          handler: (info: Readonly<{
            localIds?: readonly string[];
            userMessageSeq: number | null;
            deliveryBlockedReason?: string;
          }>) => void,
        ): void;
      }>;
      const rejected: Array<{
        localIds?: readonly string[];
        userMessageSeq: number | null;
        deliveryBlockedReason?: string;
      }> = [];
      nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
      const published: Array<{ kind: string; error?: { code?: string } }> = [];
      runtime.subscribeRuntimeEvents((event) => {
        published.push(event as never);
      });

      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Welcome\n❯ check the output',
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt', {
          localId: 'local-capture-style-unavailable',
          localIds: ['local-capture-style-unavailable'],
          userMessageSeq: null,
        });
        await vi.advanceTimersByTimeAsync(6_000);

        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
        expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
        expect(published.filter(
          (event) => event.kind === 'backend-error' && event.error?.code === 'claude_unified_terminal_user_draft_blocking',
        )).toHaveLength(0);
        expect(sessionSend.mock.calls.filter(
          ([request]) => (request as { event?: { type?: string } }).event?.type === 'terminal-composer-draft-blocked',
        )).toHaveLength(1);
        expect(rejected).toEqual([]);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('keeps sustained active-turn user-draft starvation transient', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, sessionSend, envelope } = createDraftRuntime({
        startupReadiness: { baseTimeoutMs: 120_000, extendedTimeoutMs: 120_000, progressGraceMs: 120_000 },
      });
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
        setOnPromptTerminallyRejectedBeforeProvider(
          handler: (info: Readonly<{
            localIds?: readonly string[];
            userMessageSeq: number | null;
            deliveryBlockedReason?: string;
          }>) => void,
        ): void;
      }>;
      const rejected: Array<{
        localIds?: readonly string[];
        userMessageSeq: number | null;
        deliveryBlockedReason?: string;
      }> = [];
      nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude',
          type: 'prompt_submitted',
          promptText: 'first prompt',
          observedAtMs: 123,
          source: 'hook',
        });

        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > user typed draft │',
          cursor: { x: 22, y: 1 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt behind active draft', {
          localId: 'local-active-turn-draft',
          localIds: ['local-active-turn-draft'],
          userMessageSeq: null,
        });
        await vi.advanceTimersByTimeAsync(20_000);

        expect(rejected).toEqual([]);
        expect(sessionSend).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'sessionEvent',
          event: expect.objectContaining({
            type: 'terminal-composer-draft-blocked',
            reason: 'idle_draft_guard',
          }),
        }));
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('NEVER clears while the screen is generating, even for an own leftover (Escape would interrupt the turn)', async () => {
      const { terminalHost, runtime, envelope } = createDraftRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
        steerPrompt(prompt: string): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });

        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > first prompt │',
          cursor: { x: 18, y: 1 },
          observedAt: 300,
        }));

        await expect(nativeRuntime.steerPrompt('be concise')).rejects.toThrow(/user_draft/u);
        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('escalates ONCE per episode after sustained draft starvation with an honest blocking notice', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, sessionSend, capabilities, envelope } = createDraftRuntime({
        // Keep the startup-readiness window from terminalizing the prompt while the draft blocks:
        // the real incident host had SessionStart evidence holding the wait to the ceiling.
        startupReadiness: { baseTimeoutMs: 120_000, extendedTimeoutMs: 120_000, progressGraceMs: 120_000 },
      });
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        setOnPromptTerminallyRejectedBeforeProvider(
          handler: (info: Readonly<{
            localIds?: readonly string[];
            userMessageSeq: number | null;
            deliveryBlockedReason?: string;
          }>) => void,
        ): void;
      }>;
      const rejected: Array<{
        localIds?: readonly string[];
        userMessageSeq: number | null;
        deliveryBlockedReason?: string;
      }> = [];
      nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));
      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > my own typed draft │',
          cursor: { x: 24, y: 0 },
          observedAt: 300,
        }));
        const published: Array<{ kind: string; error?: { code?: string; cause?: Record<string, unknown> } }> = [];
        runtime.subscribeRuntimeEvents((event) => {
          published.push(event as never);
        });

        await runtime.sendTurnPrompt('queued prompt behind the draft', {
          localId: 'local-terminal-composer-draft',
          localIds: ['local-terminal-composer-draft'],
          userMessageSeq: null,
        });
        await vi.advanceTimersByTimeAsync(20_000);

        const escalations = published.filter(
          (event) => event.kind === 'backend-error' && event.error?.code === 'claude_unified_terminal_user_draft_blocking',
        );
        expect(escalations).toHaveLength(1);
        expect(escalations[0]?.error?.cause).toMatchObject({ ownDraft: false, draftLength: 18 });
        expect(sessionSend).toHaveBeenCalledWith(expect.objectContaining({
          kind: 'sessionEvent',
          event: expect.objectContaining({
            type: 'terminal-composer-draft-blocked',
            reason: 'idle_draft_guard',
            stateAtMs: expect.any(Number),
            message: expect.any(String),
          }),
        }));
        expect(capabilities().terminalComposerDraftPresent).toBe(true);
        expect(capabilities().inFlightSteerUnavailableReason).toBe('turn_settling');
        expect(rejected).toEqual([{
          localIds: ['local-terminal-composer-draft'],
          userMessageSeq: null,
          deliveryBlockedReason: 'terminal_composer_draft',
        }]);

        // Single escalation per episode: more starved polls never re-notify.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(published.filter(
          (event) => event.kind === 'backend-error' && event.error?.code === 'claude_unified_terminal_user_draft_blocking',
        )).toHaveLength(1);
        expect(sessionSend.mock.calls.filter(
          ([request]) => (request as { event?: { type?: string } }).event?.type === 'terminal-composer-draft-blocked',
        )).toHaveLength(1);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('backs off readiness recaptures after draft starvation escalates', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime } = createDraftRuntime({
        startupReadiness: { baseTimeoutMs: 120_000, extendedTimeoutMs: 120_000, progressGraceMs: 120_000 },
      });
      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > my own typed draft │',
          cursor: { x: 24, y: 0 },
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt behind the draft');
        await vi.advanceTimersByTimeAsync(20_000);
        const callsAfterEscalation = terminalHost.service.captureInputState.mock.calls.length;

        await vi.advanceTimersByTimeAsync(20_000);
        expect(terminalHost.service.captureInputState).toHaveBeenCalledTimes(callsAfterEscalation);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(terminalHost.service.captureInputState).toHaveBeenCalledTimes(callsAfterEscalation + 1);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });
  });

  describe('steer capability publication (Seam A)', () => {
    function createSteerCapabilityRuntime(options?: Readonly<{ startupReadiness?: Record<string, number> }>) {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      let agentState: Readonly<Record<string, unknown>> = {};
      // Boundary fixture: the SDK session.writeAgentState seam is the system boundary here.
      const writeAgentState = vi.fn(async (request: {
        kind: string;
        handler?: (current: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
      }) => {
        if (request.kind === 'update' && request.handler) {
          agentState = request.handler(agentState);
        }
      });
      const ctx = createPluginContextFixture(terminalHost.service, events.service, {
        sessionWriteAgentState: writeAgentState,
      });
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-steer-cap',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
        ...(options?.startupReadiness ? { startupReadiness: options.startupReadiness } : {}),
      }));
      const capabilities = () => (agentState.capabilities ?? {}) as Readonly<Record<string, unknown>>;
      return { terminalHost, envelope, runtime: envelope.operations, capabilities, writeAgentState };
    }

    it('publishes steer availability into agentState capabilities when the steer window is safe', async () => {
      const { terminalHost, runtime, envelope, capabilities } = createSteerCapabilityRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
        steerPrompt(prompt: string): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });

        // Provably generating with a clean composer: the steer-safe window.
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > │',
          observedAt: 300,
        }));

        await nativeRuntime.steerPrompt('be concise');

        expect(capabilities().inFlightSteerAvailable).toBe(true);
        expect(capabilities().inFlightSteerUnavailableReason ?? null).toBeNull();
        expect(typeof capabilities().inFlightSteerStateAt).toBe('number');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('publishes unsafe_window when a mid-turn steer is vetoed by the screen', async () => {
      const { terminalHost, runtime, envelope, capabilities } = createSteerCapabilityRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
        steerPrompt(prompt: string): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });

        // Generating screen with a composer draft: vetoed, but NOT yet starvation-escalated.
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > first prompt │',
          cursor: { x: 18, y: 1 },
          observedAt: 300,
        }));

        await expect(nativeRuntime.steerPrompt('be concise')).rejects.toThrow(/user_draft/u);

        expect(capabilities().inFlightSteerAvailable).toBe(false);
        expect(capabilities().inFlightSteerUnavailableReason).toBe('unsafe_window');
        expect(typeof capabilities().inFlightSteerStateAt).toBe('number');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('vetoes mid-turn steer with capture_style_unavailable for plain contextual placeholder captures', async () => {
      const { terminalHost, runtime, envelope, capabilities } = createSteerCapabilityRuntime();
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
        steerPrompt(prompt: string): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });

        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n❯ check the output',
          observedAt: 300,
        }));

        await expect(nativeRuntime.steerPrompt('be concise')).rejects.toThrow(/capture_style_unavailable/u);

        expect(capabilities().inFlightSteerAvailable).toBe(false);
        expect(capabilities().inFlightSteerUnavailableReason).toBe('unsafe_window');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('does not durable-block queued prompts for capture_style_unavailable placeholder captures', async () => {
      vi.useFakeTimers();
      const terminalHost = createTerminalHostFixture();
      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: '✻ Pondering… (esc to interrupt)\n❯ check the output',
        observedAt: Date.now(),
      }));
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-capture-style-transient',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
        startupReadiness: { baseTimeoutMs: 10, extendedTimeoutMs: 10, progressGraceMs: 10, pollIntervalMs: 5 },
      }));
      const runtime = envelope.operations;
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        setOnPromptTerminallyRejectedBeforeProvider(
          handler: (info: Readonly<{
            localIds?: readonly string[];
            userMessageSeq: number | null;
            userMessageSeqs?: readonly number[];
            deliveryBlockedReason?: string;
          }>) => void,
        ): void;
      }>;
      const rejected: Array<{
        localIds?: readonly string[];
        userMessageSeq: number | null;
        userMessageSeqs?: readonly number[];
        deliveryBlockedReason?: string;
      }> = [];
      nativeRuntime.setOnPromptTerminallyRejectedBeforeProvider((info) => rejected.push({ ...info }));

      try {
        await runtime.sendTurnPrompt('queued behind unknown capture style', {
          localId: 'local-capture-style',
          localIds: ['local-capture-style'],
          userMessageSeq: null,
        });
        await vi.advanceTimersByTimeAsync(50);

        expect(rejected).toEqual([]);
        expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
        vi.useRealTimers();
      }
    });

    it('publishes user_terminal_draft once the draft starvation escalates (X1)', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime, envelope, capabilities } = createSteerCapabilityRuntime({
        startupReadiness: { baseTimeoutMs: 120_000, extendedTimeoutMs: 120_000, progressGraceMs: 120_000 },
      });
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      try {
        await runtime.sendTurnPrompt('first prompt');
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude', type: 'prompt_submitted', promptText: 'first prompt', observedAtMs: 123, source: 'hook',
        });

        // Generating screen blocked by a genuine (non-own) draft, starving the queued prompt.
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '✻ Pondering… (esc to interrupt)\n│ > my own typed draft │',
          cursor: { x: 24, y: 1 },
          observedAt: 300,
        }));
        (envelope.nativeRuntime as unknown as { notifyPromptQueuedDuringTurn(): void }).notifyPromptQueuedDuringTurn();
        void runtime.sendTurnPrompt('queued prompt behind the draft').catch(() => undefined);
        await vi.advanceTimersByTimeAsync(20_000);

        expect(capabilities().inFlightSteerAvailable).toBe(false);
        expect(capabilities().inFlightSteerUnavailableReason).toBe('user_terminal_draft');
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });
  });

  it('publishes terminal-origin prompt transcript evidence instead of writing durable rows directly', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async () => ({ id: 'source-1', dispose: vi.fn(async () => undefined) })),
      fileFollow: {
        follow: vi.fn(),
      },
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-1',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtimeEvents: unknown[] = [];
    envelope.operations.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'terminal prompt',
        observedAtMs: 123,
        source: 'hook',
      });

      expect(transcripts.append).not.toHaveBeenCalled();
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'transcript-user-text',
          sessionId: 'happy-session-1',
          text: 'terminal prompt',
          meta: expect.objectContaining({
            provider: 'claude',
            terminalOrigin: true,
          }),
        }),
      ]));
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps hook terminal-origin prompt local ids unique after runtime recreation', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const runtimeEvents: unknown[] = [];
    const createRuntime = () => {
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-terminal-origin-restart',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      }));
      envelope.operations.subscribeRuntimeEvents((event) => {
        runtimeEvents.push(event);
      });
      return envelope;
    };

    const firstEnvelope = createRuntime();
    try {
      const firstNativeRuntime = firstEnvelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      await firstNativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'first terminal prompt',
        observedAtMs: 123,
        source: 'hook',
      });
    } finally {
      await firstEnvelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }

    const secondEnvelope = createRuntime();
    try {
      const secondNativeRuntime = secondEnvelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      await secondNativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'second terminal prompt',
        observedAtMs: 456,
        source: 'hook',
      });

      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'transcript-user-text')).toEqual([
        expect.objectContaining({
          text: 'first terminal prompt',
          localId: 'happy-session-terminal-origin-restart:claude-terminal-origin-1',
        }),
        expect.objectContaining({
          text: 'second terminal prompt',
          localId: 'happy-session-terminal-origin-restart:claude-terminal-origin-2',
        }),
      ]);
    } finally {
      await secondEnvelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('materializes a distinct same-text terminal-origin prompt inside the accepted-prompt echo window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-repeat-terminal-origin',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;

      await runtime.sendTurnPrompt('repeat prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'repeat prompt',
        observedAtMs: 1_050,
        source: 'hook',
      });
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate',
      });
      await runtime.waitForTurnCompletion();

      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        promptText: 'repeat prompt',
        observedAtMs: 1_100,
        source: 'hook',
      });

      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'transcript-user-text')).toEqual([
        expect.objectContaining({
          kind: 'transcript-user-text',
          sessionId: 'happy-session-repeat-terminal-origin',
          text: 'repeat prompt',
          meta: expect.objectContaining({
            provider: 'claude',
            terminalOrigin: true,
          }),
        }),
      ]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('materializes a transcript-origin same-text terminal prompt inside the accepted-prompt echo window when the provider row is distinct', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-repeat-transcript-origin',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;

      await runtime.sendTurnPrompt('repeat prompt');
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'prompt_submitted',
        turnId: 'ui-accepted-row',
        promptText: 'repeat prompt',
        observedAtMs: 1_050,
        source: 'hook',
      });
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'completion_candidate',
      });
      await runtime.waitForTurnCompletion();

      await events.emit(CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID, {
        agentId: 'claude',
        sessionId: 'happy-session-repeat-transcript-origin',
        providerSessionId: 'claude-session-1',
        kind: 'text',
        text: 'repeat prompt',
        turnId: 'terminal-row-2',
        observedAtMs: 1_100,
      });

      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'transcript-user-text')).toEqual([
        expect.objectContaining({
          kind: 'transcript-user-text',
          sessionId: 'happy-session-repeat-transcript-origin',
          text: 'repeat prompt',
          localId: 'happy-session-repeat-transcript-origin:claude-terminal-origin-provider:terminal-row-2',
          meta: expect.objectContaining({
            provider: 'claude',
            terminalOrigin: true,
          }),
        }),
      ]);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('uses queued-command transcript evidence to accept an ambiguous prompt without rendering a duplicate terminal prompt', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-queued-command',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtime = envelope.operations;
    const runtimeEvents: unknown[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    try {
      await runtime.sendTurnPrompt('please keep working');
      const completion = runtime.waitForTurnCompletion();
      completion.catch(() => undefined);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);

      await events.emit(CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID, {
        agentId: 'claude',
        sessionId: 'happy-session-queued-command',
        providerSessionId: 'claude-session-1',
        kind: 'queued_command',
        text: 'please keep working',
        providerPayload: {
          type: 'queue-operation',
          operation: 'enqueue',
          content: 'please keep working',
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);
      expect(runtimeEvents.filter((event) => (event as { kind?: string }).kind === 'transcript-user-text')).toEqual([]);

      await events.emit(CLAUDE_UNIFIED_PROVIDER_TRANSCRIPT_EVENT_ID, {
        agentId: 'claude',
        sessionId: 'happy-session-queued-command',
        providerSessionId: 'claude-session-1',
        kind: 'assistant_stop',
        stopReason: 'end_turn',
      });

      await expect(completion).resolves.toBeUndefined();
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  describe('idle session-scoped failures (SILENT-F1 port: idle host deaths must not be silent)', () => {
    function readTurnEvents(runtimeEvents: readonly unknown[]): Readonly<{
      turnStarts: ReadonlyArray<Readonly<{ kind: string; turnId: string }>>;
      turnFails: ReadonlyArray<Readonly<{ kind: string; turnId: string; issue?: unknown }>>;
    }> {
      const isTurnEvent = (event: unknown): event is Readonly<{ kind: string; turnId: string; issue?: unknown }> =>
        typeof event === 'object' && event !== null
        && 'kind' in event && 'turnId' in event
        && typeof (event as { turnId: unknown }).turnId === 'string';
      const turnEvents = runtimeEvents.filter(isTurnEvent);
      return {
        turnStarts: turnEvents.filter((event) => event.kind === 'turn-start'),
        turnFails: turnEvents.filter((event) => event.kind === 'turn-failed'),
      };
    }

    it('surfaces a structured failed turn (turn-start then turn-failed) when the host process exits while idle', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-idle-exit',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      }));
      const runtime = envelope.operations;
      const runtimeEvents: unknown[] = [];
      runtime.subscribeRuntimeEvents((event) => {
        runtimeEvents.push(event);
      });

      try {
        await runtime.startOrLoadSession();
        const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
          observeTerminalLifecycle(observation: unknown): Promise<void>;
        }>;
        // No turn in flight: the host process dies while the session is idle.
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude',
          type: 'process_exited',
          exitCode: 1,
          signal: null,
        });

        const { turnStarts, turnFails } = readTurnEvents(runtimeEvents);
        expect(turnFails).toHaveLength(1);
        expect(turnFails[0]).toEqual(expect.objectContaining({
          kind: 'turn-failed',
          sessionId: 'happy-session-idle-exit',
          issue: expect.objectContaining({
            source: 'agent_process_exit',
            code: 'claude.process_exited',
          }),
        }));
        expect((turnFails[0].issue as { sanitizedPreview?: string }).sanitizedPreview).not.toContain(
          'while a turn was in flight',
        );
        // The allocated turn must be KNOWN to the session-turn lifecycle: begin precedes fail.
        expect(turnStarts).toHaveLength(1);
        expect(turnStarts[0].turnId).toBe(turnFails[0].turnId);
        expect(runtimeEvents.indexOf(turnStarts[0])).toBeLessThan(runtimeEvents.indexOf(turnFails[0]));
        // The idle failure must not poison the next turn's completion contract.
        await expect(runtime.waitForTurnCompletion()).resolves.toBeUndefined();
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('keeps a late stop-failure report with no active turn silent (no allocation without opt-in)', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-late-report',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      }));
      const runtime = envelope.operations;
      const runtimeEvents: unknown[] = [];
      runtime.subscribeRuntimeEvents((event) => {
        runtimeEvents.push(event);
      });

      try {
        await runtime.startOrLoadSession();
        const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
          observeTerminalLifecycle(observation: unknown): Promise<void>;
        }>;
        await nativeRuntime.observeTerminalLifecycle({
          agentId: 'claude',
          type: 'turn_failed',
          turnId: null,
          reason: 'stop_failure_hook',
          detail: 'late duplicate stop-failure report',
          source: 'hook',
        });

        const { turnStarts, turnFails } = readTurnEvents(runtimeEvents);
        expect(turnStarts).toHaveLength(0);
        expect(turnFails).toHaveLength(0);
      } finally {
        await runtime.resetOrDisposeRuntime().catch(() => undefined);
      }
    });

    it('ignores a host process exit observed after disposal', async () => {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-disposed-exit',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
      }));
      const runtime = envelope.operations;
      const runtimeEvents: unknown[] = [];
      runtime.subscribeRuntimeEvents((event) => {
        runtimeEvents.push(event);
      });

      await runtime.startOrLoadSession();
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
      const nativeRuntime = envelope.nativeRuntime as unknown as Readonly<{
        observeTerminalLifecycle(observation: unknown): Promise<void>;
      }>;
      await nativeRuntime.observeTerminalLifecycle({
        agentId: 'claude',
        type: 'process_exited',
        exitCode: null,
        signal: 'SIGHUP',
      });

      const { turnStarts, turnFails } = readTurnEvents(runtimeEvents);
      expect(turnStarts).toHaveLength(0);
      expect(turnFails).toHaveLength(0);
    });
  });
});
