import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import { createClaudeUnifiedTerminalTurnOperations } from './turnOperations.testkit.js';

describe('Claude unified native-resume lifecycle integration', () => {
  afterEach(() => vi.useRealTimers());

  it('does not retain the provisional resume turn from a task notification alone', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const hasProviderAcceptedUserMessageDelivery = vi.fn(() => false);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHasProviderAcceptedUserMessageDelivery: hasProviderAcceptedUserMessageDelivery,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-1',
      },
    }));
    const runtimeEvents: Array<{ kind?: string }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await envelope.operations.startProviderSession();
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);

      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-1', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-1',
        source: 'resume',
      });
      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: 'claude-resume-1' });
      await vi.advanceTimersByTimeAsync(799);
      await hookRequest.onSessionHook('claude-resume-1', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-resume-1',
        prompt: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
      });
      await vi.advanceTimersByTimeAsync(800);

      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      expect(runtimeEvents.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);
      expect(hasProviderAcceptedUserMessageDelivery).not.toHaveBeenCalled();
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('retains the provisional resume turn when the provider transcript accepts resume-summary compaction', async () => {
    vi.useFakeTimers();
    type TranscriptLineHandler = (input: Readonly<{
      line: string;
      sourcePath: string;
      sequence: number;
    }>) => void | Promise<void>;
    let transcriptLineHandler: TranscriptLineHandler | null = null;
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
          id: definition.id,
          dispose: vi.fn(async () => undefined),
        })),
        fileFollow: {
          follow: vi.fn(async (input: Readonly<{ onLine: TranscriptLineHandler }>) => {
            transcriptLineHandler = input.onLine;
            return {
              id: 'resume-summary-compact-follow',
              drainNow: vi.fn(async () => undefined),
              close: vi.fn(async () => undefined),
            };
          }),
        },
      },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-summary-compact',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-summary-compact',
      },
    }));
    const runtimeEvents: Array<{ kind?: string }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await envelope.operations.startProviderSession();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-summary-compact', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-summary-compact',
        transcript_path: '/tmp/claude-resume-summary-compact.jsonl',
        source: 'resume',
      });
      if (!transcriptLineHandler) throw new Error('provider transcript follow was not bound');

      await vi.advanceTimersByTimeAsync(799);
      await transcriptLineHandler({
        line: JSON.stringify({
          type: 'user',
          uuid: 'compact-command-1',
          sessionId: 'claude-resume-summary-compact',
          message: {
            content: '<command-name>/compact</command-name>\n<command-message>compact</command-message>',
          },
        }),
        sourcePath: '/tmp/claude-resume-summary-compact.jsonl',
        sequence: 1,
      });
      await vi.advanceTimersByTimeAsync(800);

      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      expect(runtimeEvents.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(0);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('holds a subsequent prompt until the explicit resume identity is authenticated by SessionStart', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-prompt-gate',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-prompt-gate',
      },
    }));

    try {
      await envelope.operations.startProviderSession();
      await envelope.operations.sendTurnPrompt('wait for authenticated resume identity');
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();

      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-prompt-gate', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-prompt-gate',
        source: 'resume',
      });
      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: 'claude-resume-prompt-gate' });
      await vi.waitFor(() => {
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      });
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('fails visibly without adopting or delivering after an explicit resume SessionStart identity mismatch', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-mismatch',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-requested',
      },
    }));
    const runtimeEvents: Array<{ kind?: string; issue?: { code?: string } }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event as never));

    try {
      await envelope.operations.startProviderSession();
      await envelope.operations.sendTurnPrompt('queued before the wrong resume identity appears');
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-unexpected', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-unexpected',
        source: 'resume',
      });

      expect(envelope.operations.readSessionIdentity()).not.toEqual({ sessionId: 'claude-resume-unexpected' });
      expect(runtimeEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'turn-failed',
          issue: expect.objectContaining({
            code: 'claude_unified_resume_identity_mismatch',
          }),
        }),
      ]));
      await expect(envelope.operations.sendTurnPrompt('must not reach the wrong resumed session')).rejects.toMatchObject({
        code: 'claude_unified_resume_identity_mismatch',
      });
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('allows authenticated compact rotation after the explicit resume identity is established', async () => {
    const resumedTranscriptPath = '/transcripts/resumed.jsonl';
    const compactedTranscriptPath = '/transcripts/compacted.jsonl';
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcriptFollow = vi.fn(async (input: Readonly<{ path: string }>) => Object.freeze({
      id: `explicit-resume-rotation:${input.path}`,
      drainNow: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    }));
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      transcripts: {
        append: vi.fn(async () => undefined),
        defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
          id: definition.id,
          dispose: vi.fn(async () => undefined),
        })),
        fileFollow: { follow: transcriptFollow },
      },
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-resume-compact-rotation',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-before-compact',
      },
    }));
    const runtimeEvents: Array<{ kind?: string }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await envelope.operations.startProviderSession();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-before-compact', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-before-compact',
        transcript_path: resumedTranscriptPath,
        source: 'resume',
      });
      await hookRequest.onSessionHook('claude-resume-after-compact', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-after-compact',
        transcript_path: compactedTranscriptPath,
        source: 'compact',
      });

      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: 'claude-resume-after-compact' });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-failed')).toHaveLength(0);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('keeps a delayed native resume notification inert until authenticated provider reaction', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const hasProviderAcceptedUserMessageDelivery = vi.fn(() => false);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHasProviderAcceptedUserMessageDelivery: hasProviderAcceptedUserMessageDelivery,
    });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-delayed-resume',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId: 'claude-resume-delayed',
      },
    }));
    const runtimeEvents: Array<{ kind?: string }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await envelope.operations.startProviderSession();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook('claude-resume-delayed', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-delayed',
        source: 'resume',
      });

      await vi.advanceTimersByTimeAsync(800);
      expect(runtimeEvents.filter((event) => event.kind === 'turn-cancelled')).toHaveLength(1);

      await hookRequest.onSessionHook('claude-resume-delayed', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-resume-delayed',
        prompt: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
      });

      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(1);
      await hookRequest.onSessionHook('claude-resume-delayed', {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-resume-delayed',
      });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(2);
      expect(hasProviderAcceptedUserMessageDelivery).not.toHaveBeenCalled();
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it('opens one canonical foreground turn only after Claude reacts to an ordinary task notification', async () => {
    type TranscriptLineHandler = (input: Readonly<{
      line: string;
      sourcePath: string;
      sequence: number;
    }>) => void | Promise<void>;
    let transcriptLineHandler: TranscriptLineHandler | null = null;
    const transcripts = {
      append: vi.fn(async () => undefined),
      defineSource: vi.fn(async (definition: Readonly<{ id: string }>) => ({
        id: definition.id,
        dispose: vi.fn(async () => undefined),
      })),
      fileFollow: {
        follow: vi.fn(async (input: Readonly<{ onLine: TranscriptLineHandler }>) => {
          transcriptLineHandler = input.onLine;
          return {
            id: 'task-notification-reaction-follow',
            drainNow: vi.fn(async () => undefined),
            close: vi.fn(async () => undefined),
          };
        }),
      },
    };
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service, { transcripts });
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-task-notification-reaction',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    }));
    const runtimeEvents: Array<{ kind?: string }> = [];
    envelope.operations.subscribeRuntimeEvents((event) => runtimeEvents.push(event));

    try {
      await envelope.operations.startProviderSession();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');

      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-primary',
        transcript_path: '/tmp/claude-primary.jsonl',
        source: 'startup',
      });
      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'Stop',
        session_id: 'claude-primary',
      });
      const initialTurnStarts = runtimeEvents.filter((event) => event.kind === 'turn-start').length;
      const initialTurnCompletions = runtimeEvents.filter((event) => event.kind === 'turn-complete').length;

      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'claude-primary',
        prompt_id: 'notification-prompt',
        prompt: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
      });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(initialTurnStarts);

      if (!transcriptLineHandler) throw new Error('provider transcript follow was not bound');
      await transcriptLineHandler({
        line: JSON.stringify({
          type: 'user',
          uuid: 'notification-row',
          promptId: 'notification-prompt',
          sessionId: 'claude-primary',
          isSidechain: false,
          origin: { kind: 'task-notification' },
          message: {
            content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
          },
        }),
        sourcePath: '/tmp/claude-primary.jsonl',
        sequence: 1,
      });
      await transcriptLineHandler({
        line: JSON.stringify({
          type: 'assistant',
          uuid: 'reaction-row',
          parentUuid: 'notification-row',
          session_id: 'claude-primary',
          isSidechain: false,
          message: {
            stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_reaction', name: 'Bash', input: {} }],
          },
        }),
        sourcePath: '/tmp/claude-primary.jsonl',
        sequence: 2,
      });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(initialTurnStarts + 1);

      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-primary',
        tool_use_id: 'toolu_reaction',
      });
      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'PostToolUse',
        session_id: 'claude-primary',
        tool_use_id: 'toolu_reaction',
      });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(initialTurnStarts + 1);

      await hookRequest.onSessionHook('claude-primary', {
        hook_event_name: 'Stop',
        session_id: 'claude-primary',
      });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-complete')).toHaveLength(initialTurnCompletions + 1);
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
