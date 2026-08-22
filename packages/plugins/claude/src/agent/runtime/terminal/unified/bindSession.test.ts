import { describe, expect, it, vi } from 'vitest';

import {
  createEventsFixture,
  createPluginContextFixture,
  createTerminalHostFixture,
  expectRuntimeEnvelope,
} from '../../engine.testkit.js';
import {
  bindClaudeUnifiedTerminalSession,
  resolveUnifiedTerminalResumeChoice,
  resolveUnifiedTerminalPermissionMode,
} from './bindSession.testkit.js';
import { getClaudeProjectPath } from '../../../surfaces/sessions/handoff/path.js';

type SessionParamsWithCredentials =
  Parameters<typeof bindClaudeUnifiedTerminalSession>[0]['sessionParams'] & Readonly<{
    credentials: Readonly<{
      token: string;
      encryption: Readonly<{ type: 'legacy'; secret: Uint8Array }>;
    }>;
  }>;

function modeMetadata(modeId: string, updatedAt = 1): Readonly<Record<string, unknown>> {
  return { acpSessionModeOverrideV1: { v: 1, updatedAt, modeId } };
}

describe('bindClaudeUnifiedTerminalSession', () => {
  it('returns a public session runtime without launching the terminal while binding', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
    };

    const runtime = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams,
    });

    expectRuntimeEnvelope(runtime);
    expect(terminalHost.service.resolve).not.toHaveBeenCalled();
    expect(terminalHost.service.createOrAttachHost).not.toHaveBeenCalled();
  });

  it('passes the persisted workflow headline into startup interruption reconciliation', async () => {
    vi.useFakeTimers();
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const writeSystemRecord = vi.fn(async () => undefined);
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionWriteSystemRecord: writeSystemRecord,
      sessionPublishWorkflowHeadline: vi.fn(async () => undefined),
    });
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const runtime = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams: {
        cwd: '/tmp/claude-project',
        permissionMode: 'default',
        credentials,
        metadata: {
          sessionWorkflowActivityHeadlineV1: {
            v: 1,
            backendId: 'claude',
            updatedAt: 1000,
            primaryRunId: 'wf_stale',
            activeRuns: [{
              runId: 'wf_stale',
              title: 'Stale workflow',
              status: 'active',
              updatedAt: 1000,
              recordRevision: '2',
              recordUpdatedAt: 1000,
              totalAgents: 4,
              completedAgents: 1,
            }],
          },
        },
      },
    });
    const envelope = expectRuntimeEnvelope(runtime);

    try {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(writeSystemRecord).toHaveBeenCalledWith(expect.objectContaining({
        payload: expect.objectContaining({
          runId: 'wf_stale',
          status: 'stopped',
          statusReason: 'interrupted',
        }),
      }));
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
      vi.useRealTimers();
    }
  });

  it('uses the active tmux terminal metadata instead of a stale zellij host setting', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
      metadata: {
        claudeUnifiedTerminalHost: 'zellij',
        terminal: {
          mode: 'tmux',
          requested: 'tmux',
          tmux: { target: 'happy:window-1' },
        },
      },
    };

    const runtime = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams,
    });

    const envelope = expectRuntimeEnvelope(runtime);
    await envelope.operations.startProviderSession();

    expect(terminalHost.service.resolve).toHaveBeenCalledWith({ preference: 'tmux' });

    await envelope.operations.resetOrDisposeRuntime();
  });

  it('uses the active zellij terminal metadata instead of a stale tmux host setting', async () => {
    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const ctx = createPluginContextFixture(terminalHost.service, events.service);
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
      metadata: {
        claudeUnifiedTerminalHost: 'tmux',
        terminal: {
          mode: 'zellij',
          requested: 'zellij',
          zellij: { sessionName: 'happy-session-1' },
        },
      },
    };

    const runtime = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams,
    });

    const envelope = expectRuntimeEnvelope(runtime);
    await envelope.operations.startProviderSession();

    expect(terminalHost.service.resolve).toHaveBeenCalledWith({ preference: 'zellij' });

    await envelope.operations.resetOrDisposeRuntime();
  });

  it('starts a live-only transcript follow for a known resumed Claude session before SessionStart', async () => {
    const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-known-resume-bind-'));
    const transcriptPath = join(tempDir, 'claude-known-resume.jsonl');
    await writeFile(transcriptPath, '', 'utf8');

    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const sessionHooks = {
      startServer: async () => ({
        port: 43123,
        stop: async () => undefined,
        dispose: async () => undefined,
      }),
      resolveForwarderAssets: async () => ({
        nodeExecutable: '/managed/bin/node',
        sessionForwarderScript: '/app/scripts/session_hook_forwarder.cjs',
        permissionForwarderScript: '/app/scripts/permission_hook_forwarder.cjs',
      }),
      createPluginDir: async () => '/tmp/happier-claude-hook-plugin',
      disposePluginDir: async () => undefined,
      publishProviderTranscript: async () => undefined,
    };
    const ctx = createPluginContextFixture(terminalHost.service, events.service, {
      sessionHooks,
      transcriptFileFollowAllowedPathRoots: [tempDir],
    });
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials = {
      cwd: '/tmp/claude-project',
      permissionMode: 'default',
      credentials,
      metadata: {
        claudeSessionId: 'claude-known-resume',
        claudeTranscriptPath: transcriptPath,
      },
    };

    const runtime = await bindClaudeUnifiedTerminalSession({
      ctx,
      sessionParams,
    });
    const envelope = expectRuntimeEnvelope(runtime);

    try {
      await envelope.operations.startProviderSession();

      expect(ctx.agentRuntime.transcripts.fileFollow.follow).toHaveBeenCalledWith(expect.objectContaining({
        path: transcriptPath,
        startAt: 'end',
        strategy: 'poll',
      }));
      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: 'claude-known-resume' });
      const launchRequest = vi.mocked(terminalHost.service.createOrAttachHost).mock.calls[0]?.[0];
      expect(launchRequest?.launch.args).not.toContain('--resume');
    } finally {
      await envelope.operations.resetOrDisposeRuntime().catch(() => undefined);
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('defers explicit resume transcript adoption until an exact authenticated SessionStart', async () => {
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tempDir = await mkdtemp(join(tmpdir(), 'claude-explicit-resume-bind-'));
    const configDir = join(tempDir, 'claude-config');
    const workspaceDir = join(tempDir, 'workspace');
    const providerSessionId = 'claude-explicit-resume';
    const transcriptDir = getClaudeProjectPath(workspaceDir, configDir);
    const transcriptPath = join(transcriptDir, `${providerSessionId}.jsonl`);

    const terminalHost = createTerminalHostFixture();
    const events = createEventsFixture();
    const transcriptFollow = vi.fn(async () => Object.freeze({
      id: 'explicit-resume-transcript-follow',
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
    const credentials = {
      token: 'host-token',
      encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(1) },
    };
    const sessionParams: SessionParamsWithCredentials & Readonly<{ resume: string }> = {
      cwd: workspaceDir,
      permissionMode: 'default',
      credentials,
      isolation: { env: { CLAUDE_CONFIG_DIR: configDir } },
      metadata: {},
      resume: providerSessionId,
    };

    try {
      const runtime = await bindClaudeUnifiedTerminalSession({
        ctx,
        sessionParams,
      });
      const envelope = expectRuntimeEnvelope(runtime);

      await envelope.operations.startProviderSession();

      expect(transcriptFollow).not.toHaveBeenCalled();
      expect(envelope.operations.readSessionIdentity()).not.toEqual({ sessionId: providerSessionId });
      const launchRequest = vi.mocked(terminalHost.service.createOrAttachHost).mock.calls[0]?.[0];
      const launchArgs = launchRequest?.launch.args ?? [];
      expect(launchArgs.filter((arg) => arg === '--resume')).toHaveLength(1);
      expect(launchArgs.slice(launchArgs.indexOf('--resume'), launchArgs.indexOf('--resume') + 2)).toEqual([
        '--resume',
        providerSessionId,
      ]);

      const hookRequest = vi.mocked(ctx.agentRuntime.sessionHooks.startServer).mock.calls[0]?.[0];
      if (!hookRequest?.onSessionHook) throw new Error('session hook server was not started');
      await hookRequest.onSessionHook(providerSessionId, {
        hook_event_name: 'SessionStart',
        session_id: providerSessionId,
        source: 'resume',
        transcript_path: transcriptPath,
      });

      expect(transcriptFollow).toHaveBeenCalledWith(expect.objectContaining({
        path: transcriptPath,
        startAt: 'end',
        strategy: 'poll',
      }));
      expect(envelope.operations.readSessionIdentity()).toEqual({ sessionId: providerSessionId });

      await envelope.operations.resetOrDisposeRuntime();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('resolveUnifiedTerminalPermissionMode', () => {
  it('passes through the raw permission mode when no agent mode is set', () => {
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: 'safe-yolo' })).toBe('auto');
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: 'default' })).toBe('default');
  });

  it('returns null when nothing is specified', () => {
    expect(resolveUnifiedTerminalPermissionMode({ permissionMode: null })).toBeNull();
  });

  it('lets the plan agent mode WIN over a safe-yolo permission mode (the dropped-plan bug)', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'safe-yolo',
      runtimeMetadata: modeMetadata('plan'),
    })).toBe('plan');
  });

  it('reads the plan agent mode from the initial spawn metadata too', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: null,
      initialMetadata: modeMetadata('plan'),
    })).toBe('plan');
  });

  it('prefers the runtime metadata snapshot over the initial spawn metadata', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'default',
      runtimeMetadata: modeMetadata('plan', 20),
      initialMetadata: modeMetadata('build', 5),
    })).toBe('plan');
  });

  it('a non-plan agent mode does not override the raw permission mode', () => {
    expect(resolveUnifiedTerminalPermissionMode({
      permissionMode: 'safe-yolo',
      runtimeMetadata: modeMetadata('build'),
    })).toBe('auto');
  });
});

describe('resolveUnifiedTerminalResumeChoice', () => {
  it('defaults to asking every time when no metadata is present', () => {
    expect(resolveUnifiedTerminalResumeChoice({})).toBe('ask_every_time');
  });

  it('accepts valid initial spawn metadata values', () => {
    expect(resolveUnifiedTerminalResumeChoice({
      initialMetadata: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' },
    })).toBe('resume_from_summary');
    expect(resolveUnifiedTerminalResumeChoice({
      initialMetadata: { claudeUnifiedTerminalResumeChoice: 'resume_full_session' },
    })).toBe('resume_full_session');
  });

  it('prefers runtime metadata over initial metadata and ignores malformed values', () => {
    expect(resolveUnifiedTerminalResumeChoice({
      runtimeMetadata: { claudeUnifiedTerminalResumeChoice: 'resume_full_session' },
      initialMetadata: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' },
    })).toBe('resume_full_session');
    expect(resolveUnifiedTerminalResumeChoice({
      runtimeMetadata: { claudeUnifiedTerminalResumeChoice: 'bogus' },
      initialMetadata: { claudeUnifiedTerminalResumeChoice: 'resume_from_summary' },
    })).toBe('resume_from_summary');
  });
});
