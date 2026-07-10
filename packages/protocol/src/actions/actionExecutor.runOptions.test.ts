import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';
import { buildAcpConfigOptionOverridesV1 } from '../sessions/metadata/metadataOverridesV1.js';

function createDeps(overrides: Partial<ActionExecutorDeps> = {}): ActionExecutorDeps {
  return {
    executionRunStart: vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' })),
    executionRunList: vi.fn(async () => ({})),
    executionRunGet: vi.fn(async () => ({})),
    executionRunSend: vi.fn(async () => ({})),
    executionRunStop: vi.fn(async () => ({})),
    executionRunAction: vi.fn(async () => ({})),
    executionRunWait: vi.fn(async () => ({})),
    sessionOpen: vi.fn(async () => ({})),
    sessionFork: vi.fn(async () => ({})),
    sessionRollback: vi.fn(async () => ({})),
    sessionSpawnNew: vi.fn(async () => ({})),
    sessionSpawnPicker: vi.fn(async () => ({})),
    pathsListRecent: vi.fn(async () => ({ items: [] })),
    machinesList: vi.fn(async () => ({ items: [] })),
    serversList: vi.fn(async () => ({ items: [] })),
    reviewEnginesList: vi.fn(async () => ({ items: [] })),
    agentsBackendsList: vi.fn(async () => ({ items: [] })),
    agentsModelsList: vi.fn(async () => ({ items: [] })),
    sessionSendMessage: vi.fn(async () => ({})),
    sessionPermissionRespond: vi.fn(async () => ({})),
    sessionUserActionAnswer: vi.fn(async () => ({})),
    sessionModeSet: vi.fn(async () => ({})),
    sessionModesList: vi.fn(async () => ({ items: [] })),
    sessionTargetPrimarySet: vi.fn(async () => ({})),
    sessionTargetTrackedSet: vi.fn(async () => ({})),
    sessionList: vi.fn(async () => ({})),
    sessionActivityGet: vi.fn(async () => ({})),
    sessionRecentMessagesGet: vi.fn(async () => ({})),
    resetGlobalVoiceAgent: vi.fn(),
    ...overrides,
  };
}

const RUN_START_BASE = {
  sessionId: 's1',
  intent: 'delegate',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
  instructions: 'do it',
  permissionMode: 'read_only',
  retentionPolicy: 'ephemeral',
  runClass: 'bounded',
  ioMode: 'request_response',
} as const;

describe('createActionExecutor run options parity (model + effort)', () => {
  it('threads modelId + sessionConfigOptionOverrides on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'high' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ modelId: 'gpt-5.5', sessionConfigOptionOverrides: overrides }),
      undefined,
    );
  });

  it('merges the configOptions shorthand into sessionConfigOptionOverrides and strips it', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, configOptions: { reasoning_effort: 'high' } },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.configOptions).toBeUndefined();
    const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
    expect(overrides.overrides.reasoning_effort.value).toBe('high');
  });

  it('fails closed when configOptions conflicts with sessionConfigOptionOverrides', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));
    const overrides = buildAcpConfigOptionOverridesV1({
      updatedAt: 1,
      overrides: { reasoning_effort: { updatedAt: 1, value: 'low' } },
    });

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, sessionConfigOptionOverrides: overrides, configOptions: { reasoning_effort: 'high' } },
      { defaultSessionId: 's1' },
    );

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('threads modelId + merged effort into every delegate.start per-target run request', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex', 'agent:claude'],
        instructions: 'do it',
        permissionMode: 'read_only',
        modelId: 'gpt-5.5',
        configOptions: { reasoning_effort: 'high' },
      },
      { defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    expect(executionRunStart).toHaveBeenCalledTimes(2);
    for (const call of executionRunStart.mock.calls) {
      const request = call[1] as Record<string, unknown>;
      expect(request.modelId).toBe('gpt-5.5');
      const overrides = request.sessionConfigOptionOverrides as { overrides: Record<string, { value: unknown }> };
      expect(overrides.overrides.reasoning_effort.value).toBe('high');
    }
  });

  it('normalizes a simple-string connectedServices selection on execution.run.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'openai-codex:group:happier' },
      { defaultSessionId: 's1' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'connected', selection: 'group', groupId: 'happier' } },
    });
  });

  it('fails closed and starts no run when connectedServices is malformed', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'execution.run.start' as any,
      { ...RUN_START_BASE, connectedServices: 'not-a-service:bogus:x' },
      { defaultSessionId: 's1' },
    );

    expect(res).toEqual({ ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' });
    expect(executionRunStart).not.toHaveBeenCalled();
  });

  it('normalizes per-target simple-string connectedServices on delegate.start', async () => {
    const executionRunStart = vi.fn(async () => ({ runId: 'run_1', callId: 'call_1', sidechainId: 'call_1' }));
    const executor = createActionExecutor(createDeps({ executionRunStart }));

    const res = await executor.execute(
      'subagents.delegate.start' as any,
      {
        sessionId: 's1',
        backendTargetKeys: ['agent:codex'],
        instructions: 'do it',
        permissionMode: 'read_only',
        connectedServicesByBackendTargetKey: { 'agent:codex': 'openai-codex:native' },
      },
      { defaultSessionId: 's1', callerPermissionMode: 'workspace_write' },
    );

    expect(res.ok).toBe(true);
    const request = executionRunStart.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(request.connectedServices).toEqual({
      v: 1,
      bindingsByServiceId: { 'openai-codex': { source: 'native' } },
    });
  });
});
