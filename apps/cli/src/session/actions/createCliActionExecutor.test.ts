import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  spawnDaemonSession,
  fetchSessionById,
  updateSessionMetadataWithRetry,
  sendSessionMessage,
} = vi.hoisted(() => ({
  spawnDaemonSession: vi.fn(),
  fetchSessionById: vi.fn(),
  updateSessionMetadataWithRetry: vi.fn(),
  sendSessionMessage: vi.fn(),
}));

vi.mock('@/daemon/controlClient', () => ({
  spawnDaemonSession,
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById,
}));

vi.mock('@/session/metadata/updateSessionMetadataWithRetry', () => ({
  updateSessionMetadataWithRetry,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

import { createCliActionExecutor } from './createCliActionExecutor';

const env = process.env;

function createPlainExecutor(extra: Partial<Parameters<typeof createCliActionExecutor>[0]> = {}) {
  return createCliActionExecutor({
    token: 'token',
    credentials: {
      token: 'token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array([1, 2, 3, 4]),
      },
    },
    sessionId: 'sess-1',
    mode: 'plain',
    ctx: {
      encryptionKey: new Uint8Array([1, 2, 3, 4]),
      encryptionVariant: 'legacy',
    },
    ...extra,
  });
}

describe('createCliActionExecutor', () => {
  beforeEach(() => {
    spawnDaemonSession.mockReset();
    fetchSessionById.mockReset();
    updateSessionMetadataWithRetry.mockReset();
    sendSessionMessage.mockReset();
    process.env = { ...env };
    delete process.env.HAPPIER_ACTIONS_SETTINGS_V1;
  });

  it('resolves execution backend options on the MCP surface', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toMatchObject({
      ok: true,
      result: {
        actionId: 'subagents.plan.start',
        fieldPath: 'backendTargetKeys',
        optionsSourceId: 'execution.backends.enabled',
      },
    });
    expect((result as any).result.options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'agent:claude',
          label: expect.any(String),
        }),
      ]),
    );
  });

  it('resolves review engine options on the MCP surface', async () => {
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'action.options.resolve',
      {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: 'review.start',
        fieldPath: 'engineIds',
        optionsSourceId: 'review.engines.available',
        options: [{ value: 'coderabbit', label: 'CodeRabbit' }],
      },
    });
  });

  it('resolves session mode options from raw session metadata on the MCP surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          sessionModesV1: {
            currentModeId: 'build',
            availableModes: [
              { id: 'build', name: 'Build' },
              { id: 'plan', name: 'Plan' },
            ],
          },
        },
      },
    });

    const result = await executor.execute(
      'action.options.resolve',
      {
        optionsSourceId: 'session.modes.available',
        sessionId: 'sess-1',
      },
      { surface: 'mcp', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        actionId: null,
        fieldPath: null,
        optionsSourceId: 'session.modes.available',
        options: [
          { value: 'build', label: 'Build' },
          { value: 'plan', label: 'Plan' },
        ],
      },
    });
  });

  it('rejects actions disabled on the CLI surface by action settings', async () => {
    process.env.HAPPIER_ACTIONS_SETTINGS_V1 = JSON.stringify({
      v: 1,
      actions: {
        'review.start': { enabled: true, disabledSurfaces: ['cli'], disabledPlacements: [] },
      },
    });
    const executor = createPlainExecutor();

    const result = await executor.execute(
      'review.start',
      {
        sessionId: 'sess-1',
        engineIds: ['coderabbit'],
        instructions: 'Review this change.',
        permissionMode: 'read_only',
        changeType: 'committed',
        base: { kind: 'none' },
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: false,
      errorCode: 'action_disabled',
      error: 'action_disabled',
    });
  });

  it('spawns a new session from the current session context on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });
    spawnDaemonSession.mockResolvedValue({ success: true, sessionId: 'sess-new' });
    fetchSessionById.mockResolvedValue({
      id: 'sess-new',
      createdAt: 1,
      updatedAt: 2,
      active: true,
      activeAt: 2,
      pendingCount: 0,
      metadataVersion: 1,
      metadata: {
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
        summary: { text: 'Spawned session' },
      },
    });
    updateSessionMetadataWithRetry.mockResolvedValue({
      version: 2,
      metadata: {
        machineId: 'machine-1',
        path: '/repo/current',
        host: 'leeroy-mbp',
        tag: 'voice-qa',
      },
    });
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-new',
      localId: 'local-1',
      waited: false,
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        tag: 'voice-qa',
        agentId: 'claude',
        modelId: 'gpt-5',
        initialMessage: 'Hello from CLI action',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result.ok).toBe(true);
    expect(spawnDaemonSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo/current',
      machineId: 'machine-1',
      backendTarget: { kind: 'builtInAgent', agentId: 'claude' },
      modelId: 'gpt-5',
      initialPrompt: 'Hello from CLI action',
    }));
    expect(updateSessionMetadataWithRetry).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-new',
      token: 'token',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      result: {
        type: 'success',
        sessionId: 'sess-new',
        created: true,
        session: {
          id: 'sess-new',
        },
      },
    });
  });

  it('returns host_not_found when session.spawn_new targets a different host on the CLI surface', async () => {
    const executor = createPlainExecutor({
      rawSession: {
        metadata: {
          machineId: 'machine-1',
          path: '/repo/current',
          host: 'leeroy-mbp',
        },
      },
    });

    const result = await executor.execute(
      'session.spawn_new',
      {
        host: 'other-host',
        initialMessage: 'Hello',
      },
      { surface: 'cli', defaultSessionId: 'sess-1' },
    );

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'error',
        errorCode: 'host_not_found',
        errorMessage: 'host_not_found',
        host: 'other-host',
      },
    });
    expect(spawnDaemonSession).not.toHaveBeenCalled();
  });
});
