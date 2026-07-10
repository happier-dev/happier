import { appendFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type {
  TerminalPromptInput,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import type { RuntimeEventV1 } from '@happier-dev/plugin-sdk';

import { createClaudeBackendEngine } from './engine.js';
import { claudeHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';
import {
  createEventsFixture,
  createPluginContextFixture,
  createSdkExecFixture,
  createSessionHooksFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from './engine.testkit.js';

describe('createClaudeBackendEngine', () => {
  it('exposes the plugin-owned Claude handoff surface through the backend engine', () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);

    expect(createClaudeBackendEngine(ctx).handoffSurface).toBe(claudeHandoffSurface);
  });

  it('creates a plugin-owned Agent SDK fallback when the canonical unified terminal feature gate is disabled', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      enabledFeatures: [],
      exec: exec.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
      isolation: {
        env: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
            { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
          ]),
          HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CLAUDE_CONFIG_DIR']),
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          ANTHROPIC_API_KEY: 'ambient-api-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh-token',
          CUSTOM_RUNTIME_ENV: 'keep',
        },
      },
    });

    expect(sessionRuntime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      permissions: { capability: 'responds' },
      dispose: expect.any(Function),
    });
    expect(ctx.features.isEnabled).toHaveBeenCalledWith('agents.claude.unifiedTerminal');
    expect(terminalHost.service.resolve).not.toHaveBeenCalled();
    expect(terminalHost.service.createOrAttachHost).not.toHaveBeenCalled();

    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello claude');
    await vi.waitFor(() => {
      expect(exec.written).toContainEqual({
        type: 'user',
        message: {
          role: 'user',
          content: 'hello claude',
        },
      });
    });
    const waitForCompletion = runtime.waitForTurnCompletion();
    await exec.emit({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-provider-session-1',
    });
    await exec.emit({
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      total_cost_usd: 0,
      duration_ms: 1,
      duration_api_ms: 1,
      is_error: false,
      session_id: 'claude-provider-session-1',
    });
    await exec.resolveExit();
    await expect(waitForCompletion).resolves.toBeUndefined();
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-provider-session-1' });
    await runtime.resetOrDisposeRuntime();

    expect(exec.spawnClient).toHaveBeenCalledWith(expect.objectContaining({
      launch: expect.objectContaining({
        kind: 'agent-cli',
        agentId: 'claude',
        cwd: '/tmp/claude-project',
        env: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CUSTOM_RUNTIME_ENV: 'keep',
        },
      }),
      transport: { kind: 'stdio', framing: { kind: 'strict-lf-json' } },
      protocol: { kind: 'json-stream' },
    }), expect.anything());
    expect(exec.spawnClient.mock.calls[0]?.[0].launch.args).toEqual(expect.arrayContaining([
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--permission-mode',
      'auto',
    ]));
  });

  it('records provider account usage from Claude Agent SDK rate-limit events', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const recordSnapshot = vi.fn(async (input: Readonly<{ snapshot: Readonly<{ recordId: string }> }>) => ({
      status: 'recorded' as const,
      recordId: input.snapshot.recordId,
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      enabledFeatures: [],
      exec: exec.service,
      accountUsage: { recordSnapshot },
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      isolation: {
        env: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
        },
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hit the weekly limit');
    await exec.emit({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        rate_limit_type: 'weekly',
        resets_at: '2026-02-16T00:00:00Z',
        utilization: 100,
      },
    });

    expect(recordSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy-session-1',
      snapshot: expect.objectContaining({
        providerId: 'claude',
        source: 'runtimeSignal',
        confidence: 'unknown',
        state: 'loaded_data',
        accountSubject: expect.objectContaining({
          kind: 'provisionalLocalSubject',
        }),
        meters: [expect.objectContaining({
          meterId: 'weekly',
          utilizationPct: 100,
          resetAtMs: Date.parse('2026-02-16T00:00:00Z'),
          details: expect.objectContaining({
            limitCategory: 'usage_limit',
          }),
        })],
      }),
    });
    await runtime.resetOrDisposeRuntime({ reason: 'test-cleanup' });
  });

  it('creates a plugin-owned Agent SDK fallback when the Claude provider setting is disabled', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: false,
      },
    });

    expect(sessionRuntime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      permissions: { capability: 'responds' },
      dispose: expect.any(Function),
    });
    expect(ctx.features.isEnabled).toHaveBeenCalledWith('agents.claude.unifiedTerminal');
    expect(terminalHost.service.resolve).not.toHaveBeenCalled();
    expect(terminalHost.service.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('uses the Claude provider setting when session metadata does not carry the unified terminal setting', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      settingsValues: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {},
    });

    expect(sessionRuntime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      permissions: { capability: 'responds' },
      dispose: expect.any(Function),
    });
    expect(ctx.features.isEnabled).toHaveBeenCalledWith('agents.claude.unifiedTerminal');
    expect(ctx.settings.get).toHaveBeenCalledWith('claudeUnifiedTerminalEnabled');

    const created = sessionRuntime;

    const runtime = expectRuntimeEnvelope(created).operations;
    await runtime.startOrLoadSession();
    expect(terminalHost.service.resolve).toHaveBeenCalledWith({ preference: 'auto' });
    expect(terminalHost.service.createOrAttachHost).toHaveBeenCalled();
    await runtime.resetOrDisposeRuntime();
  });

  it('preserves fast Agent SDK fallback completion for later waiters', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      enabledFeatures: [],
      exec: exec.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.sendTurnPrompt('fast claude');
    await exec.emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: 'claude-provider-session-fast-error',
    });
    await exec.resolveExit();

    await expect(runtime.waitForTurnCompletion()).rejects.toThrow(/error_during_execution/);
    await runtime.resetOrDisposeRuntime();
  });

  it('creates a plugin-owned unified terminal public session runtime', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
      isolation: {
        env: {
          HAPPIER_CONNECTED_SERVICE_SELECTIONS_JSON: JSON.stringify([
            { kind: 'profile', serviceId: 'claude-subscription', profileId: 'work' },
          ]),
          HAPPIER_CONNECTED_SERVICE_MATERIALIZED_ENV_KEYS_JSON: JSON.stringify(['CLAUDE_CONFIG_DIR']),
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          ANTHROPIC_API_KEY: 'ambient-api-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'ambient-oauth-token',
          CLAUDE_CODE_OAUTH_REFRESH_TOKEN: 'ambient-refresh-token',
          CUSTOM_RUNTIME_ENV: 'keep',
        },
      },
    });

    expect(sessionRuntime).toMatchObject({
      identity: { read: expect.any(Function) },
      events: { subscribe: expect.any(Function) },
      send: expect.any(Function),
      permissions: { capability: 'responds' },
      dispose: expect.any(Function),
    });

    const created = sessionRuntime;
    const envelope = expectRuntimeEnvelope(created);
    const runtime = envelope.operations;

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello claude');

    expect(terminalHost.service.resolve).toHaveBeenCalledWith({ preference: 'zellij' });
    expect(terminalHost.service.createOrAttachHost).toHaveBeenCalledWith({
      preference: 'zellij',
      sessionName: 'happier-claude-happy-session-1',
      workingDirectory: '/tmp/claude-project',
      isolatedEnv: true,
      launch: {
        kind: 'agent-cli',
        agentId: 'claude',
        args: [
          '--plugin-dir',
          '/tmp/happier-claude-hook-plugin',
          '--allow-dangerously-skip-permissions',
          '--permission-mode',
          'auto',
        ],
        cwd: '/tmp/claude-project',
        env: {
          CLAUDE_CONFIG_DIR: '/tmp/claude-config',
          CUSTOM_RUNTIME_ENV: 'keep',
        },
      },
    });
    expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledWith(
      terminalHost.handle,
      expect.objectContaining({
        text: 'hello claude',
        multiline: false,
        origin: expect.objectContaining({
          kind: 'ui_pending',
          nonce: expect.stringContaining('happy-session-1'),
        }),
      }) satisfies Partial<TerminalPromptInput>,
    );
    const waitForAcceptance = runtime.waitForTurnCompletion();
    await Promise.race([
      waitForAcceptance.then(
        () => {
          throw new Error('waitForTurnCompletion resolved before provider acceptance');
        },
        (error: unknown) => {
          throw error;
        },
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
    await events.emit('@happier/session/provider-hook', {
      agentId: 'opencode',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
    });
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'other-session',
      eventName: 'UserPromptSubmit',
    });
    await Promise.race([
      waitForAcceptance.then(
        () => {
          throw new Error('waitForTurnCompletion resolved after unrelated provider hook');
        },
        (error: unknown) => {
          throw error;
        },
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      turnId: 'turn-1',
    });
    await Promise.race([
      waitForAcceptance.then(
        () => {
          throw new Error('waitForTurnCompletion resolved before provider completion');
        },
        (error: unknown) => {
          throw error;
        },
      ),
      new Promise<void>((resolve) => setTimeout(resolve, 0)),
    ]);
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'Stop',
      turnId: 'turn-1',
    });
    await expect(waitForAcceptance).resolves.toBeUndefined();

    await runtime.cancelTurn();
    expect(terminalHost.service.interruptTurn).toHaveBeenCalledWith(terminalHost.handle);

    await runtime.resetOrDisposeRuntime();
    expect(terminalHost.service.dispose).toHaveBeenCalledWith(terminalHost.handle);
  });

  it('applies supported Agent SDK runtime config updates to the next Claude query', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const exec = createSdkExecFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      enabledFeatures: [],
      exec: exec.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.updateSessionRuntimeConfig({
      modelId: 'claude-opus-4-8',
      fallbackModel: 'claude-sonnet-4-6',
    } as Readonly<Record<string, unknown>>);
    await runtime.sendTurnPrompt('hello claude');

    const args = exec.spawnClient.mock.calls[0]?.[0].launch.args;
    expect(args).toEqual(expect.arrayContaining([
      '--model',
      'claude-opus-4-8',
      '--fallback-model',
      'claude-sonnet-4-6',
      '--permission-mode',
      'auto',
    ]));

    await runtime.resetOrDisposeRuntime();
  });

  it('starts the host session hook producer and launches Claude with the generated hook plugin dir', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const sessionHooks = createSessionHooksFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHooks: sessionHooks.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: null });
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-engine-transcript-'));
    const transcriptPath = join(transcriptDir, 'claude-provider-session-1.jsonl');
    await writeFile(transcriptPath, '', 'utf8');
    const startHookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
      onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
    }> | undefined;
    await startHookRequest?.onSessionHook?.('claude-provider-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-provider-session-1',
      transcript_path: transcriptPath,
    });
    expect(runtime.readSessionIdentity()).toEqual({ sessionId: 'claude-provider-session-1' });
    await appendFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'assistant',
        uuid: 'assistant-row-1',
        message: { stop_reason: 'end_turn' },
      })}\n`,
      'utf8',
    );
    await vi.waitFor(() => {
      expect(sessionHooks.service.publishProviderTranscript).toHaveBeenCalledWith({
        providerId: 'claude',
        sessionId: 'happy-session-1',
        providerSessionId: 'claude-provider-session-1',
        kind: 'assistant_stop',
        turnId: 'assistant-row-1',
        stopReason: 'end_turn',
        providerPayload: {
          type: 'assistant',
          uuid: 'assistant-row-1',
          message: { stop_reason: 'end_turn' },
        },
      });
    });

    await runtime.resetOrDisposeRuntime({ reason: 'test-cleanup' });

    expect(sessionHooks.service.startServer).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude',
      sessionId: 'happy-session-1',
      lifecycle: { kind: 'session', sessionId: 'happy-session-1' },
      onSessionHook: expect.any(Function),
    }));
    expect(sessionHooks.service.resolveForwarderAssets).toHaveBeenCalledTimes(1);
    expect(sessionHooks.service.createPluginDir).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'claude',
      lifecycle: { kind: 'session', sessionId: 'happy-session-1' },
      files: [
        expect.objectContaining({ path: '.claude-plugin/plugin.json' }),
        expect.objectContaining({
          path: 'hooks/hooks.json',
          json: expect.objectContaining({
            hooks: expect.objectContaining({
              SessionStart: expect.any(Array),
              UserPromptSubmit: expect.any(Array),
              StopFailure: expect.any(Array),
            }),
          }),
        }),
      ],
    }));
    expect(terminalHost.service.createOrAttachHost).toHaveBeenCalledWith(expect.objectContaining({
      launch: expect.objectContaining({
        args: expect.arrayContaining(['--plugin-dir', '/tmp/happier-claude-hook-plugin']),
      }),
    }));
    expect(sessionHooks.service.disposePluginDir).toHaveBeenCalledWith('/tmp/happier-claude-hook-plugin');
    expect(sessionHooks.serverDispose).toHaveBeenCalledTimes(1);
  });

  it('still disposes the hook server when generated hook plugin cleanup fails', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const sessionHooks = createSessionHooksFixture();
    sessionHooks.service.disposePluginDir.mockRejectedValueOnce(new Error('plugin cleanup failed'));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHooks: sessionHooks.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello claude');
    const completion = runtime.waitForTurnCompletion().then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    await expect(runtime.resetOrDisposeRuntime()).rejects.toThrow('plugin cleanup failed');

    expect(sessionHooks.service.disposePluginDir).toHaveBeenCalledWith('/tmp/happier-claude-hook-plugin');
    expect(sessionHooks.serverDispose).toHaveBeenCalledTimes(1);
    await expect(Promise.race([
      completion,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toMatch(/disposed/);
  });

  it('keeps hook transcript publication alive for final JSONL evidence during terminal disposal', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const sessionHooks = createSessionHooksFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHooks: sessionHooks.service,
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-claude-unified-engine-final-'));
    const transcriptPath = join(transcriptDir, 'claude-provider-session-1.jsonl');
    await writeFile(transcriptPath, '', 'utf8');
    const startHookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
      onSessionHook?: (providerSessionId: string, payload: Readonly<Record<string, unknown>>) => void | Promise<void>;
    }> | undefined;
    await startHookRequest?.onSessionHook?.('claude-provider-session-1', {
      hook_event_name: 'SessionStart',
      session_id: 'claude-provider-session-1',
      transcript_path: transcriptPath,
    });
    vi.mocked(terminalHost.service.dispose).mockImplementation(async () => {
      await appendFile(
        transcriptPath,
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'assistant-row-final-dispose',
          message: { stop_reason: 'end_turn' },
        })}\n`,
        'utf8',
      );
    });

    await runtime.resetOrDisposeRuntime({ reason: 'test-cleanup' });

    expect(sessionHooks.service.publishProviderTranscript).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'assistant_stop',
      turnId: 'assistant-row-final-dispose',
    }));
    expect(terminalHost.service.dispose.mock.invocationCallOrder[0])
      .toBeLessThan(sessionHooks.serverStop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY);
  });

  it('routes unified permission hooks through the session permission surface', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const sessionHooks = createSessionHooksFixture();
    const requestDecision = vi.fn(async () => ({
      decision: 'approved' as const,
      answers: { 'Continue?': 'Yes' },
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHooks: sessionHooks.service,
      sessionPermissions: {
        requestDecision,
        getMode: () => 'default',
      },
    });
    const engine = createClaudeBackendEngine(ctx);

    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
        claudeUnifiedTerminalHost: 'zellij',
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    const startHookRequest = sessionHooks.service.startServer.mock.calls[0]?.[0] as Readonly<{
      onPermissionHook?: (payload: Readonly<Record<string, unknown>>) => Promise<unknown>;
      defaultPermissionHookResponse?: (payload: Readonly<Record<string, unknown>>) => unknown;
      sessionHookSecret?: string;
      permissionHookSecret?: string;
    }> | undefined;
    const pluginDirRequest = sessionHooks.service.createPluginDir.mock.calls[0]?.[0] as Readonly<{
      files: readonly Readonly<{ path: string; json?: unknown }>[];
    }> | undefined;

    expect(startHookRequest).toMatchObject({
      onPermissionHook: expect.any(Function),
      defaultPermissionHookResponse: expect.any(Function),
      sessionHookSecret: expect.any(String),
      permissionHookSecret: expect.any(String),
    });
    expect(pluginDirRequest?.files[1]?.json).toMatchObject({
      hooks: expect.objectContaining({
        PermissionRequest: expect.any(Array),
        PreToolUse: expect.any(Array),
      }),
    });
    expect(JSON.stringify(pluginDirRequest?.files[1]?.json)).toContain('--secret-file');
    expect(JSON.stringify(pluginDirRequest?.files[1]?.json)).toContain('/tmp/happier-claude-hook-session.secret');
    expect(JSON.stringify(pluginDirRequest?.files[1]?.json)).toContain('/tmp/happier-claude-hook-permission.secret');
    expect(JSON.stringify(pluginDirRequest?.files[1]?.json)).not.toContain(startHookRequest?.sessionHookSecret ?? 'missing-session-secret');
    expect(JSON.stringify(pluginDirRequest?.files[1]?.json)).not.toContain(startHookRequest?.permissionHookSecret ?? 'missing-permission-secret');

    await expect(startHookRequest?.onPermissionHook?.({
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [] },
      tool_use_id: 'toolu_ask_1',
    })).resolves.toMatchObject({
      continue: true,
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          questions: [],
          answers: { 'Continue?': 'Yes' },
        },
      },
    });
    expect(requestDecision).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'claude',
      requestId: 'toolu_ask_1',
      toolCallId: 'toolu_ask_1',
      toolName: 'AskUserQuestion',
      input: { questions: [] },
    }), expect.any(Object));

    await runtime.resetOrDisposeRuntime({ reason: 'test-cleanup' });
  });

  it('publishes provider capacity failures from Claude StopFailure lifecycle evidence', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const recordSnapshot = vi.fn(async (input: Readonly<{ snapshot: Readonly<{ recordId: string }> }>) => ({
      status: 'recorded' as const,
      recordId: input.snapshot.recordId,
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      accountUsage: { recordSnapshot },
    });
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const envelope = expectRuntimeEnvelope(created);
    const runtime = envelope.operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('trigger capacity failure');
    const completion = runtime.waitForTurnCompletion();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
    });
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'StopFailure',
      providerPayload: {
        error: 'server_error',
        apiErrorStatus: 529,
        last_assistant_message: 'API Error: 529 Overloaded.',
      },
    });

    await expect(completion).rejects.toThrow(/529|overloaded/iu);
    const failedEvents = runtimeEvents.filter((event) => event.kind === 'turn-failed');
    expect(failedEvents).toEqual([
      expect.objectContaining({
        kind: 'turn-failed',
        sessionId: 'happy-session-1',
        issue: expect.objectContaining({
          source: 'agent_status_error',
          code: 'claude.provider.capacity',
          agentId: 'claude',
          usageLimit: expect.objectContaining({
            limitCategory: 'capacity',
            providerLimitId: 'server_overloaded',
          }),
        }),
      }),
    ]);
    expect(recordSnapshot).toHaveBeenCalledWith({
      sessionId: 'happy-session-1',
      snapshot: expect.objectContaining({
        providerId: 'claude',
        source: 'runtimeSignal',
        confidence: 'unknown',
        state: 'loaded_data',
        accountSubject: expect.objectContaining({
          kind: 'provisionalLocalSubject',
        }),
        meters: [expect.objectContaining({
          meterId: 'server_overloaded',
          isCapacityLimited: true,
          limitScope: 'provider',
          details: expect.objectContaining({
            limitCategory: 'capacity',
          }),
        })],
      }),
    });
  });

  it('does not publish a canonical turn failure before Claude accepts the queued prompt', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('queued before provider acceptance');
    const completion = runtime.waitForTurnCompletion();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'SessionEnd',
    });

    await expect(completion).rejects.toThrow(/process exited|runtime failed|disposed/i);
    expect(runtimeEvents).toEqual([]);
  });

  it('defers prompt injection instead of throwing when terminal liveness probing fails', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    vi.mocked(terminalHost.service.evaluateLiveness).mockRejectedValueOnce(new Error('probe failed'));
    runtime.beginTurnLifecycle();
    await expect(runtime.sendTurnPrompt('hello claude')).resolves.toBeUndefined();
    expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

    const completion = runtime.waitForTurnCompletion().then(
      () => 'resolved',
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    await expect(Promise.race([
      completion,
      new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toBe('pending');

    await runtime.resetOrDisposeRuntime();
    await expect(completion).resolves.toMatch(/disposed/);
  });

  it('surfaces provider acceptance timeout without failing or disposing the unified terminal runtime', async () => {
    vi.useFakeTimers();
    try {
      const terminalHost = createTerminalHostFixture();
      const events = createEventsFixture();
      const ctx = createPluginContextFixture(terminalHost.service, events.service);
      const engine = createClaudeBackendEngine(ctx);
      const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
        cwd: '/tmp/claude-project',
        sessionId: 'happy-session-1',
        metadata: {
          claudeUnifiedTerminalEnabled: true,
        },
      });
      const created = sessionRuntime;
      const runtime = expectRuntimeEnvelope(created).operations;

      await runtime.startOrLoadSession();
      vi.mocked(terminalHost.service.evaluateLiveness).mockResolvedValueOnce({
        paneAlive: false,
        observedAt: 123,
      });
      runtime.beginTurnLifecycle();
      await expect(runtime.sendTurnPrompt('hello claude')).resolves.toBeUndefined();
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      const completion = runtime.waitForTurnCompletion().then(
        () => 'resolved',
        (error: unknown) => error instanceof Error ? error.message : String(error),
      );
      let completionSettled = false;
      void completion.finally(() => {
        completionSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(completionSettled).toBe(false);

      await runtime.resetOrDisposeRuntime();
      await expect(completion).resolves.toMatch(/disposed/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not complete a queued UI prompt from provider completion before Claude accepts it', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      permissionMode: 'safe-yolo',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('queued before provider completion');
    const completion = runtime.waitForTurnCompletion();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'Stop',
    });

    await expect(Promise.race([
      completion.then(() => 'completed' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toBe('pending');
  });

  it('uses compact boundary transcript evidence to complete accepted compact prompts', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('/compact');
    const completion = runtime.waitForTurnCompletion();

    await events.emit('@happier/session/provider-transcript', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      kind: 'compact_boundary',
      turnId: 'compact-boundary-1',
    });

    await expect(completion).resolves.toBeUndefined();
    expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
  });

  it('materializes terminal-origin UserPromptSubmit prompt text through the transcript seam', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      providerPayload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'typed directly in Claude',
      },
    });

    expect(transcripts.append).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      {
        kind: 'transcript-user-text',
        sessionId: 'happy-session-1',
        emittedAtMs: expect.any(Number),
        text: 'typed directly in Claude',
        localId: 'happy-session-1:claude-terminal-origin-1',
        meta: {
          provider: 'claude',
          source: 'cli',
          sentFrom: 'cli',
          terminalOrigin: true,
        },
      },
    ]));
  });

  it('suppresses accepted UI prompt transcript echoes while materializing fresh terminal-origin transcript prompts', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello from UI');
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      providerPayload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hello from UI',
      },
    });
    await events.emit('@happier/session/provider-transcript', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      kind: 'text',
      text: 'hello from UI',
    });
    await events.emit('@happier/session/provider-transcript', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      kind: 'text',
      text: 'typed later in terminal',
    });

    const userTextEvents = runtimeEvents.filter((event) => event.kind === 'transcript-user-text');
    expect(transcripts.append).not.toHaveBeenCalled();
    expect(userTextEvents).toEqual([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: 'typed later in terminal',
      }),
    ]);
  });

  it('does not treat mismatched terminal-origin prompt evidence as queued UI prompt acceptance', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    runtime.beginTurnLifecycle();
    await runtime.sendTurnPrompt('hello from UI');
    const completion = runtime.waitForTurnCompletion();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      providerPayload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'typed directly in Claude',
      },
    });
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'Stop',
    });

    expect(transcripts.append).not.toHaveBeenCalled();
    expect(runtimeEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'transcript-user-text',
        text: 'typed directly in Claude',
      }),
    ]));
    await expect(Promise.race([
      completion.then(() => 'completed'),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
    ])).resolves.toBe('pending');
  });

  it('materializes repeated identical terminal-origin hook prompts as distinct user rows', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const engine = createClaudeBackendEngine(ctx);
    const sessionRuntime = await engine.runtimeCore?.createSessionRuntime({
      cwd: '/tmp/claude-project',
      sessionId: 'happy-session-1',
      metadata: {
        claudeUnifiedTerminalEnabled: true,
      },
    });
    const created = sessionRuntime;
    const runtime = expectRuntimeEnvelope(created).operations;
    const runtimeEvents: RuntimeEventV1[] = [];
    runtime.subscribeRuntimeEvents((event) => {
      runtimeEvents.push(event);
    });

    await runtime.startOrLoadSession();
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      providerPayload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'repeat this',
      },
    });
    await events.emit('@happier/session/provider-hook', {
      providerId: 'claude',
      sessionId: 'happy-session-1',
      eventName: 'UserPromptSubmit',
      providerPayload: {
        hook_event_name: 'UserPromptSubmit',
        prompt: 'repeat this',
      },
    });

    const userTextEvents = runtimeEvents.filter((event) => event.kind === 'transcript-user-text');
    expect(transcripts.append).not.toHaveBeenCalled();
    expect(userTextEvents).toEqual([
      expect.objectContaining({
        text: 'repeat this',
        localId: 'happy-session-1:claude-terminal-origin-1',
      }),
      expect.objectContaining({
        text: 'repeat this',
        localId: 'happy-session-1:claude-terminal-origin-2',
      }),
    ]);
  });
});
