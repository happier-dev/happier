import type {
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { describe, expect, it, vi } from 'vitest';

import { openCursorAcpSession } from './connection.js';

function createFixture(request: AgentSessionOpenRequest) {
  const composedSession: AgentSessionRuntime = {
    send: vi.fn(async () => ({ status: 'admitted' as const })),
    watch: () => ({ dispose: () => undefined }),
    dispose: vi.fn(),
  };
  const open = vi.fn(async (
    _request: AgentSessionOpenRequest,
    _options: AgentAcpRuntimeOptions,
  ) => composedSession);
  const daemonSettings = {
    get: vi.fn(async () => null),
  };
  const settings = {
    forScope: vi.fn(() => daemonSettings),
  };
  const context = {
    protocols: { acp: { open } },
    session: { id: request.sessionId },
    ui: { askQuestions: vi.fn(), confirm: vi.fn() },
    workState: { publisher: vi.fn(() => ({ publish: vi.fn() })) },
    services: {
      logger: { debug: vi.fn() },
      settings,
      sessions: {
        current: { media: { registerSourceRoot: vi.fn() } },
        subagents: { observe: vi.fn() },
      },
    },
  } as unknown as AgentSessionRuntimeContext;
  return { composedSession, context, daemonSettings, settings, open };
}

describe('openCursorAcpSession', () => {
  it('uses canonical Cursor settings and preserves provider resume identity', async () => {
    const request: AgentSessionOpenRequest = {
      kind: 'resume',
      sessionId: 'host-session',
      providerSessionId: 'cursor-session',
      cwd: '/tmp/cursor',
      configuration: {
        mode: { value: null, updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: 'yolo', updatedAtMs: 1 },
        options: {},
      },
    };
    const { context, daemonSettings, settings, open } = createFixture(request);
    vi.mocked(daemonSettings.get).mockImplementation(async (id: string) => {
      if (id === 'cursorBinaryPath') return ' /opt/cursor-agent ';
      if (id === 'cursorAgentFallbackEnabled') return false;
      if (id === 'cursorApiEndpoint') return ' https://cursor.example.test ';
      return null;
    });

    await openCursorAcpSession(request, context);

    expect(settings.forScope).toHaveBeenCalledWith({ kind: 'daemon' });

    expect(open).toHaveBeenCalledWith(request, expect.objectContaining({
      transport: {
        kind: 'stdio',
        executable: { kind: 'systemTool', id: 'cursor-agent-no-fallback' },
        preferredPath: '/opt/cursor-agent',
        args: ['-e', 'https://cursor.example.test', '--force', 'acp'],
      },
    }));
  });

  it('keeps Cursor quirks on the public ACP definition hooks', async () => {
    const request: AgentSessionOpenRequest = {
      kind: 'create',
      sessionId: 'host-session',
      cwd: '/tmp/cursor',
    };
    const { composedSession, context, open } = createFixture(request);

    const session = await openCursorAcpSession(request, context);
    const options = open.mock.calls[0]?.[1];

    expect(session).not.toBe(composedSession);
    expect(options?.transport).toMatchObject({ args: ['acp'] });
    expect(options?.definition).toMatchObject({
      auth: { methodId: 'cursor_login' },
      parameterizedModelPicker: true,
      modelConfigOptionId: 'model',
      mcp: { policy: 'pass_through' },
    });
    expect(options?.definition?.toolNameResolver?.({
      toolName: 'other',
      input: { _toolName: 'createPlan' },
    })).toBe('ExitPlanMode');
    expect(options?.definition?.sanitizeToolUpdateContent?.({
      content: [{ type: 'diff', oldText: '--- a/file.ts\nold', newText: '+++ b/file.ts\nnew' }],
    })).toEqual({ content: [{ type: 'diff', oldText: 'old', newText: 'new' }] });
  });
});
