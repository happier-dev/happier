import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.js';

describe('createClaudeUnifiedTerminalTurnOperations', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

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
          transcript_path: '/projects/demo/transcript.jsonl',
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

  it('steers a delivered prompt into a running turn when the screen is provably generating', async () => {
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

      terminalHost.service.captureInputState = vi.fn(async () => ({
        stable: true,
        currentInput: '✻ Pondering… (esc to interrupt)\n│ > │',
        observedAt: 200,
      }));

      await nativeRuntime.steerPrompt('be more concise');
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(2);

      // The short provider-acceptance timeout must NOT run while the turn is in flight.
      await vi.advanceTimersByTimeAsync(20_000);
      // Turn-end evidence arms acceptance; Claude then auto-submits the queued steer.
      await nativeRuntime.observeTerminalLifecycle({ agentId: 'claude', type: 'completion_candidate' });
      const accepted = await nativeRuntime.confirmProviderAcceptance({ promptText: 'be more concise' });
      expect(accepted).toBe(true);
    } finally {
      await runtime.resetOrDisposeRuntime().catch(() => undefined);
    }
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

  it('never steers slash-command prompts mid-turn', async () => {
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
      steerPrompt(prompt: string): Promise<void>;
    }>;

    try {
      await expect(nativeRuntime.steerPrompt('/compact')).rejects.toThrow(/steer/u);
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
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
  });

  describe('user_draft starvation (incident 294-veto loop, lane X1)', () => {
    function createDraftRuntime(options?: Readonly<{ startupReadiness?: Record<string, number> }>) {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
        ctx,
        directory: '/tmp/claude-project',
        happierSessionId: 'happy-session-draft',
        hostPreference: 'zellij',
        launchEnv: {},
        permissionMode: 'default',
        ...(options?.startupReadiness ? { startupReadiness: options.startupReadiness } : {}),
      }));
      return { terminalHost, ctx, envelope, runtime: envelope.operations };
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

    it('NEVER clears a genuine user draft (non-matching text fails closed to the deferred path)', async () => {
      vi.useFakeTimers();
      const { terminalHost, runtime } = createDraftRuntime();
      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > my own typed draft │',
          observedAt: 300,
        }));

        await runtime.sendTurnPrompt('queued prompt');

        expect(terminalHost.service.interruptTurn).not.toHaveBeenCalled();
        expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
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
      const { terminalHost, runtime } = createDraftRuntime({
        // Keep the startup-readiness window from terminalizing the prompt while the draft blocks:
        // the real incident host had SessionStart evidence holding the wait to the ceiling.
        startupReadiness: { baseTimeoutMs: 120_000, extendedTimeoutMs: 120_000, progressGraceMs: 120_000 },
      });
      try {
        terminalHost.service.captureInputState = vi.fn(async () => ({
          stable: true,
          currentInput: '│ > my own typed draft │',
          observedAt: 300,
        }));
        const published: Array<{ kind: string; error?: { code?: string; cause?: Record<string, unknown> } }> = [];
        runtime.subscribeRuntimeEvents((event) => {
          published.push(event as never);
        });

        await runtime.sendTurnPrompt('queued prompt behind the draft');
        await vi.advanceTimersByTimeAsync(20_000);

        const escalations = published.filter(
          (event) => event.kind === 'backend-error' && event.error?.code === 'claude_unified_terminal_user_draft_blocking',
        );
        expect(escalations).toHaveLength(1);
        expect(escalations[0]?.error?.cause).toMatchObject({ ownDraft: false, draftLength: 18 });

        // Single escalation per episode: more starved polls never re-notify.
        await vi.advanceTimersByTimeAsync(20_000);
        expect(published.filter(
          (event) => event.kind === 'backend-error' && event.error?.code === 'claude_unified_terminal_user_draft_blocking',
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
            source: 'provider_process_exit',
            code: 'claude.process_exited',
          }),
        }));
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
