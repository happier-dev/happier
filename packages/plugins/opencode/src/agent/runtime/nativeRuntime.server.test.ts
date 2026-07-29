import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import type {
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agent-runtime';

const { openOpenCodeServerSession } = vi.hoisted(() => ({
  openOpenCodeServerSession: vi.fn(),
}));

vi.mock('./server/nativeSession.js', () => ({
  openOpenCodeServerSession,
}));

import { createOpenCodeAgentRuntime } from './nativeRuntime.js';

function createSession(): AgentSessionRuntime {
  return {
    send: vi.fn(async () => ({ status: 'admitted' as const })),
    cancel: vi.fn(async ({ turnId }) => ({
      status: 'requested' as const,
      turnId,
    })),
    watch: () => ({ dispose: () => undefined }),
    dispose: vi.fn(async () => undefined),
  };
}

describe('createOpenCodeAgentRuntime server dispatch', () => {
  it('routes the canonical configuration override through the common ACP composer', async () => {
    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'happier-acp',
      cwd: '/repo',
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: null, updatedAtMs: 0 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {
          opencodeBackendMode: { value: 'acp', updatedAtMs: 1 },
        },
      },
    };
    const context = {
      protocols: {
        acp: { open: openAcp },
      },
    } as unknown as AgentSessionRuntimeContext;

    await expect(runtime.sessions.open(request, context)).resolves.toBe(session);
    expect(openAcp).toHaveBeenCalledWith(request, expect.objectContaining({
      transport: expect.objectContaining({
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'opencode-cli' },
        args: ['acp'],
      }),
    }));
    expect(openOpenCodeServerSession).not.toHaveBeenCalled();
  });

  it('projects the host-materialized Provider config into the ACP launch environment', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-opencode-acp-provider-'));
    const relativePath = 'opencode/opencode.json';
    const configContent = '{"model":"happier_test/gateway-model"}';
    await mkdir(join(rootPath, 'opencode'));
    await writeFile(join(rootPath, relativePath), configContent, 'utf8');

    const session = createSession();
    const openAcp = vi.fn(async () => session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'happier-acp-provider',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret' },
        unset: ['OPENCODE_CONFIG_CONTENT'],
      },
      configuration: {
        mode: { value: null, updatedAtMs: 0 },
        model: { value: 'gateway-model', updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 0 },
        options: {
          opencodeBackendMode: { value: 'acp', updatedAtMs: 1 },
        },
      },
      providerBinding: {
        connectionId: ProviderConnectionIdSchema.parse('pc_openrouter_work'),
        model: { id: 'gateway-model', name: 'Gateway model' },
        materialization: {
          v: 1,
          kind: 'configFile',
          rootPath,
          relativePaths: [relativePath],
        },
      },
    };

    try {
      await expect(runtime.sessions.open(request, {
        protocols: { acp: { open: openAcp } },
      } as unknown as AgentSessionRuntimeContext)).resolves.toBe(session);

      expect(openAcp).toHaveBeenCalledWith(
        expect.objectContaining({
          launchEnvironment: {
            values: {
              HAPPIER_OPENCODE_PROVIDER_API_KEY: 'provider-secret',
              OPENCODE_CONFIG_CONTENT: configContent,
            },
            unset: [],
          },
        }),
        expect.any(Object),
      );
      expect(openOpenCodeServerSession).not.toHaveBeenCalled();
    } finally {
      await rm(rootPath, { recursive: true, force: true });
    }
  });

  it('exposes mode-aware native catalog, recovery, and continuation controls', async () => {
    const session = createSession();
    const readSkills = vi.fn(async () => [{
      name: 'reviewer',
      displayName: 'reviewer',
      description: 'Review code',
      path: '/repo/.agents/skills/reviewer/SKILL.md',
      enabled: true,
    }]);
    openOpenCodeServerSession.mockImplementationOnce(async (...args: unknown[]) => {
      const bindActiveSkillsReader = args[3] as
        | ((
          sessionId: string,
          reader: (options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>,
        ) => Readonly<{ dispose(): void }>)
        | undefined;
      if (!bindActiveSkillsReader) {
        throw new Error('expected explicit OpenCode active skills reader binding');
      }
      const binding = bindActiveSkillsReader('happier-session', readSkills);
      vi.mocked(session.dispose).mockImplementationOnce(async () => binding.dispose());
      return session;
    });
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    await runtime.sessions.open({
      kind: 'create',
      sessionId: 'happier-session',
      cwd: '/repo',
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
        unset: [],
      },
    }, {
      workState: { publish: vi.fn() },
    } as unknown as AgentSessionRuntimeContext);
    const activeContext = {
      session: {
        id: 'happier-session',
        cwd: '/repo',
        activity: 'active',
        providerSessionId: 'provider-session',
        connectedAccounts: [],
      },
    } as unknown as Parameters<
      NonNullable<typeof runtime.sessions.catalog>['list']
    >[1];
    expect(activeContext.session).not.toHaveProperty('requestExtension');

    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      activeContext,
    )).resolves.toEqual({
      status: 'ok',
      kind: 'skills',
      items: [{
        id: 'reviewer',
        name: 'reviewer',
        displayName: 'reviewer',
        description: 'Review code',
        path: '/repo/.agents/skills/reviewer/SKILL.md',
        enabled: true,
      }],
    });
    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      {
        ...activeContext,
        session: {
          ...activeContext.session,
          activity: 'inactive',
        },
      },
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_catalog_inactive_unsupported' },
    });
    await session.dispose();
    await expect(runtime.sessions.catalog?.list(
      { kind: 'skills' },
      activeContext,
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_catalog_inactive_unsupported' },
    });
    await expect(runtime.sessions.usageLimitRecovery?.execute(
      { kind: 'checkNow' },
      activeContext,
    )).resolves.toEqual({
      status: 'waiting',
      retryAfterMs: 600_000,
    });
    await expect(runtime.sessions.continuation?.verify(
      {
        kind: 'resume',
        sessionId: 'happier-session',
        providerSessionId: 'provider-session',
        cwd: '/repo',
      },
      activeContext,
    )).resolves.toMatchObject({
      status: 'unsupported',
      diagnostic: { code: 'opencode_continuation_probe_unsupported' },
    });
  });

  it.each([
    {
      kind: 'create',
      sessionId: 'happier-create',
      cwd: '/repo',
    },
    {
      kind: 'resume',
      sessionId: 'happier-resume',
      providerSessionId: 'provider-resume',
      cwd: '/repo',
    },
    {
      kind: 'fork',
      sessionId: 'happier-fork',
      cwd: '/repo-child',
      source: {
        sessionId: 'happier-parent',
        providerSessionId: 'provider-parent',
        cwd: '/repo',
        target: {
          turnId: 'turn-parent',
          providerCheckpoint: {
            kind: 'opencode_exclusive_message_id',
            messageId: 'provider-next-user',
          },
        },
      },
    },
  ] satisfies AgentSessionOpenRequest[])(
    'routes native $kind through the server session owner without a compatibility runtime',
    async (request) => {
      const session = createSession();
      openOpenCodeServerSession.mockResolvedValueOnce(session);
      const runtime = createOpenCodeAgentRuntime({
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
      });
      const context = {
        workState: { publish: vi.fn() },
      } as unknown as AgentSessionRuntimeContext;

      await expect(runtime.sessions.open({
        ...request,
        launchEnvironment: {
          values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
          unset: [],
        },
      }, context)).resolves.toBe(session);

      expect(openOpenCodeServerSession).toHaveBeenCalledWith(
        expect.objectContaining(request),
        context,
        context.workState,
        expect.any(Function),
      );
    },
  );

  it.each(['rejected', 'unavailable'] as const)(
    'returns terminal run evidence when the initial execution input is %s',
    async (status) => {
      const session = createSession();
      vi.mocked(session.send).mockResolvedValueOnce({
        status,
        diagnostic: { code: `opencode_${status}`, severity: 'error' },
        ...(status === 'rejected' ? { retryable: false } : { retryable: true }),
      });
      openOpenCodeServerSession.mockResolvedValueOnce(session);
      const runtime = createOpenCodeAgentRuntime({
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
      });

      const run = await runtime.executionRuns!.open({
        kind: 'create',
        runId: `run-${status}`,
        cwd: '/repo',
        profile: {
          pluginId: 'happier.agent.opencode',
          contributionType: 'agents',
          contributionId: 'opencode',
        },
        input: { text: 'Run it' },
        launchEnvironment: {
          values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
          unset: [],
        },
      }, {
        plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
        contribution: {
          id: 'opencode',
          qualifiedId: 'happier.agent.opencode/agents/opencode',
        },
        agent: { id: 'opencode' },
        signal: new AbortController().signal,
      } as unknown as AgentSessionRuntimeContext);
      const events: Array<{ kind: string; diagnostic?: { code: string } }> = [];
      run.watch((event) => events.push(event));

      expect(events).toEqual([
        expect.objectContaining({ kind: 'run-start' }),
        expect.objectContaining({
          kind: 'run-failed',
          diagnostic: expect.objectContaining({ code: `opencode_${status}` }),
        }),
      ]);
      await expect(run.stop()).resolves.toEqual({ status: 'notRunning' });
    },
  );

  it('clears run activity and emits failure when a later send is rejected', async () => {
    const session = createSession();
    vi.mocked(session.send)
      .mockResolvedValueOnce({ status: 'admitted' })
      .mockResolvedValueOnce({
        status: 'rejected',
        diagnostic: { code: 'opencode_later_rejected', severity: 'error' },
        retryable: false,
      });
    openOpenCodeServerSession.mockResolvedValueOnce(session);
    const runtime = createOpenCodeAgentRuntime({
      plugin: { id: 'happier.agent.opencode', version: '0.0.0' },
      agent: { id: 'opencode' },
      signal: new AbortController().signal,
    });
    const run = await runtime.executionRuns!.open({
      kind: 'create',
      runId: 'run-later-rejected',
      cwd: '/repo',
      profile: {
        pluginId: 'happier.agent.opencode',
        contributionType: 'agents',
        contributionId: 'opencode',
      },
      input: { text: 'First' },
      launchEnvironment: {
        values: { HAPPIER_OPENCODE_BACKEND_MODE: 'server' },
        unset: [],
      },
    }, {} as AgentSessionRuntimeContext);
    const events: Array<{ kind: string }> = [];
    run.watch((event) => events.push(event));

    await expect(run.send({ text: 'Second' })).resolves.toMatchObject({
      status: 'rejected',
    });

    expect(events.at(-1)).toMatchObject({ kind: 'run-failed' });
    await expect(run.stop()).resolves.toEqual({ status: 'notRunning' });
  });
});
