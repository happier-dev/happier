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
        followSource: vi.fn(async () => ({ dispose: async () => undefined })),
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
    vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
      id: 'resume-identity-file',
      drainNow: async () => undefined,
      close: async () => undefined,
    });
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
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      await hookRequest.onSessionHook('claude-resume-prompt-gate', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-prompt-gate',
        source: 'resume',
        transcript_path: '/tmp/claude-resume-prompt-gate.jsonl',
      });
      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: 'claude-resume-prompt-gate' });
      await vi.waitFor(() => {
        expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
      });
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });

  it.each(['writable', 'unavailable', 'replacement'] as const)('holds resumed Pending input through source admission with %s screen capture', async (capture) => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    let releaseAdmission!: () => void;
    const admission = new Promise<void>((resolve) => { releaseAdmission = resolve; });
    vi.mocked(ctx.agentRuntime.transcripts.fileFollow.follow).mockResolvedValue({
      id: 'resume-admission-file',
      drainNow: async () => undefined,
      close: async () => undefined,
    });
    vi.mocked(ctx.agentRuntime.transcripts.followSource).mockImplementation(async () => {
      await admission;
      return { dispose: async () => undefined };
    });
    if (capture === 'unavailable') {
      vi.mocked(terminalHost.service.captureInputState).mockRejectedValue(new Error('capture unavailable'));
    }
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-resume-admission',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      knownProviderSession: {
        providerSessionId: 'claude-resume-admission',
        transcriptPath: '/tmp/claude-resume-admission.jsonl',
      },
      launchIntent: { kind: 'resume_native', providerSessionId: 'claude-resume-admission' },
    }));
    let hook: Promise<void> | undefined;
    try {
      await envelope.operations.startProviderSession();
      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      if (capture === 'replacement') {
        vi.mocked(ctx.agentRuntime.transcripts.followSource).mockResolvedValueOnce({ dispose: async () => undefined });
        await hookRequest.onSessionHook('claude-resume-admission', {
          hook_event_name: 'SessionStart',
          session_id: 'claude-resume-admission',
          transcript_path: '/tmp/claude-resume-admission.jsonl',
          source: 'resume',
        });
      } else {
        await envelope.operations.sendTurnPrompt('queued resumed prompt', { localId: 'pending-resume' });
        expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      }
      hook = hookRequest.onSessionHook('claude-resume-admission', {
        hook_event_name: 'SessionStart',
        session_id: 'claude-resume-admission',
        transcript_path: capture === 'replacement' ? '/tmp/claude-resume-replaced.jsonl' : '/tmp/claude-resume-admission.jsonl',
        source: 'resume',
      });
      if (capture === 'replacement') {
        await vi.advanceTimersByTimeAsync(0);
        await envelope.operations.sendTurnPrompt('queued resumed prompt', { localId: 'pending-resume' });
      }
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ctx.agentRuntime.transcripts.followSource).toHaveBeenCalled();
      expect(terminalHost.service.injectUserPrompt).not.toHaveBeenCalled();
      releaseAdmission();
      await hook;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(terminalHost.service.injectUserPrompt).toHaveBeenCalledTimes(1);
    } finally {
      releaseAdmission();
      await hook;
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
        followSource: vi.fn(async () => ({ dispose: async () => undefined })),
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

  it.each([true, false])('uses native provenance to keep copied XML foreground and await native reaction (native: %s)', async (native) => {
    type TranscriptLineHandler = (input: Readonly<{
      line: string;
      sourcePath: string;
      sequence: number;
    }>) => void | Promise<void>;
    let transcriptLineHandler: TranscriptLineHandler | null = null;
    const transcripts = {
      followSource: vi.fn(async () => ({ dispose: async () => undefined })),
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
    const runtime = createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-task-notification-reaction',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
    });
    const envelope = expectRuntimeEnvelope(runtime);
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
      const notificationRow = {
          type: 'user',
          uuid: 'notification-row',
          promptId: 'notification-prompt',
          sessionId: 'claude-primary',
          isSidechain: false,
          ...(native ? { origin: { kind: 'task-notification' } } : {}),
          message: {
            content: '<task-notification><task-id>agent_1</task-id><status>completed</status></task-notification>',
          },
        };
      await transcriptLineHandler({
        line: JSON.stringify(notificationRow),
        sourcePath: '/tmp/claude-primary.jsonl',
        sequence: 1,
      });
      await runtime.observeSourceTranscript({ providerSessionId: 'claude-primary', sourceId: 'notification-row', row: notificationRow });
      expect(runtimeEvents.filter((event) => event.kind === 'turn-start')).toHaveLength(initialTurnStarts + (native ? 0 : 1));
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
  it('resumes a provider session whose id carries padding, without rewriting its bytes', async () => {
    // The requested resume id is compared against the id Claude reports back on the
    // SessionStart hook. Canonicalizing one side and not the other turns a correct
    // resume into an identity mismatch, and adopting the rewritten id would publish
    // a resume id Claude never minted.
    const providerSessionId = '  provider\nses/AB+cd==  ';
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const envelope = expectRuntimeEnvelope(createClaudeUnifiedTerminalTurnOperations({
      ctx,
      directory: '/tmp/claude-project',
      happierSessionId: 'happy-session-exact-resume-id',
      hostPreference: 'zellij',
      launchEnv: {},
      permissionMode: 'default',
      launchIntent: {
        kind: 'resume_native',
        providerSessionId,
      },
    }));

    try {
      await envelope.operations.startProviderSession();

      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook(providerSessionId, {
        hook_event_name: 'SessionStart',
        session_id: providerSessionId,
        source: 'resume',
      });

      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: providerSessionId });
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
    }
  });
});
