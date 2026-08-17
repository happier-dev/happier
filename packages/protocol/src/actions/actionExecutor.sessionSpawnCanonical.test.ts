import { describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES } from '../rpc/index.js';
import { RpcError } from '../rpc/errors.js';
import { deriveSessionCreationTagV1 } from '../sessions/creation/sessionCreationIdentityV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

const canonicalInput = {
  creationKey: 'plugin-operation-7',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('session.spawn_new canonical execution', () => {
  it('host-stamps plugin creation identity and forwards only canonical intent', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    });

    expect(result).toEqual({
      ok: true,
      result: {
        type: 'pending',
        retryWithSameCreationKey: true,
        outcome: 'accepted',
      },
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith({
      ...canonicalInput,
      creationKey: 'plugin-operation-7',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'plugin:plugin.example',
        creationKey: 'plugin-operation-7',
      }),
      callerSurface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
      actionRequestId: 'attempt-1',
    });
  });

  it('uses the host-stamped Automation Run namespace without exposing it in Action input', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:run-42',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        origin: 'event',
      },
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'automation-run:run-42',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'automation:automation-7',
        creationKey: 'automation-run:run-42',
      }),
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        origin: 'event',
      },
    }));
  });

  it('rejects an Automation Run caller whose V2 creation key is not that Run', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
      creationKey: 'automation-run:other-run',
    }, {
      surface: 'cli',
      actionCaller: {
        kind: 'automationRun',
        automationId: 'automation-7',
        runId: 'run-42',
        origin: 'event',
      },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('derives a stable user creation key only from durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'unknown' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'cli',
      actionRequestId: 'request-9',
    });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:request-9',
      actionCaller: { kind: 'host' },
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'action-request:request-9',
      }),
    }));
  });

  it('preserves a typed method-unavailable Session-spawn transport error', async () => {
    const sessionSpawnNew = vi.fn(async () => {
      throw new RpcError('RPC method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE);
    });
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', canonicalInput, {
      surface: 'voice',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      error: 'RPC method not available',
    });
  });

  it('rejects a live V2/legacy hybrid before invoking spawn', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', {
      ...inputWithoutCreationKey,
      // `tag` is accepted only while replaying a provenance-bounded predecessor
      // approval artifact. It is never a live public Action field.
      tag: '  predecessor metadata label  ',
    }, {
      surface: 'cli',
      actionRequestId: 'legacy-request-7',
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('replays a provenance-pinned predecessor approval only through the host normalizer', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const predecessorActionArgs = {
      // Pinned predecessor artifact vocabulary: remote-dev@1649b084249241dd68806d5150f498e944632442.
      tag: 'predecessor metadata label',
      agentId: 'codex',
      modelId: 'gpt-5',
      directory: '/workspace/project',
      machineId: 'machine-1',
      prompt: 'Inspect this repository.',
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const normalizeSessionSpawnNewLegacyApprovalReplay = vi.fn(async () => ({
      input: {
        ...canonicalInput,
        creationKey: 'approval-artifact:approval-remote-dev-1',
        initialMessage: predecessorActionArgs.prompt,
      },
      legacyMetadataLabel: predecessorActionArgs.tag,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      normalizeSessionSpawnNewLegacyApprovalReplay,
    } as unknown as ActionExecutorDeps);

    const decisionResult = await executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-1',
      decision: 'approve',
    }, { surface: 'cli' });

    expect(decisionResult.ok).toBe(true);
    expect(normalizeSessionSpawnNewLegacyApprovalReplay).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: 'approval-remote-dev-1',
      serverId: 'server-1',
      request: expect.objectContaining({ actionArgs: predecessorActionArgs }),
    }));
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'approval-artifact:approval-remote-dev-1',
      legacyMetadataLabel: 'predecessor metadata label',
      sessionCreationTag: deriveSessionCreationTagV1({
        callerCreationNamespace: 'user',
        creationKey: 'approval-artifact:approval-remote-dev-1',
      }),
    }));
  });

  it('does not invoke the approval replay normalizer for a live canonical Action', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const normalizeSessionSpawnNewLegacyApprovalReplay = vi.fn(async () => null);
    const executor = createActionExecutor({
      sessionSpawnNew,
      normalizeSessionSpawnNewLegacyApprovalReplay,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('session.spawn_new', {
      ...canonicalInput,
    }, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'feature-a',
      },
    });

    expect(result.ok).toBe(true);
    expect(normalizeSessionSpawnNewLegacyApprovalReplay).not.toHaveBeenCalled();
  });

  it('does not expose an unsupported legacy approval artifact to Session-spawn observers', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const observeActionExecution = vi.fn(async () => undefined);
    const predecessorActionArgs = {
      agentId: 'codex',
      directory: '/workspace/project',
      machineId: 'machine-1',
      environmentVariables: { TOKEN: 'must-not-reach-observation' },
    } as const;
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'cli' },
      requestedSurface: 'cli',
      actionId: 'session.spawn_new',
      actionArgs: predecessorActionArgs,
      summary: 'Create session',
      serverId: 'server-1',
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const normalizeSessionSpawnNewLegacyApprovalReplay = vi.fn(async () => null);
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsGet,
      approvalsUpdate,
      normalizeSessionSpawnNewLegacyApprovalReplay,
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    const result = await executor.execute('approval.request.decide', {
      artifactId: 'approval-remote-dev-env-1',
      decision: 'approve',
    }, { surface: 'cli' });

    expect(result.ok).toBe(true);
    expect(normalizeSessionSpawnNewLegacyApprovalReplay).toHaveBeenCalledOnce();
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(observeActionExecution).not.toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      input: expect.objectContaining({ environmentVariables: predecessorActionArgs.environmentVariables }),
    }));
    expect(persistedApproval).toMatchObject({
      status: 'failed',
      execution: { ok: false, errorCode: 'invalid_parameters' },
    });
  });

  it('requires a target-owned directory approval before spawning and carries that exact proof into replay', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory,
    };
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const sessionSpawnNewDirectoryApprovalPreflight = vi.fn(async () => ({
      type: 'approval_required' as const,
      approval: directoryApproval,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { artifactId: 'approval-directory-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: { request: Record<string, unknown> }) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      sessionSpawnNewDirectoryApprovalPreflight,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', canonicalInput, {
      surface: 'cli',
    })).resolves.toEqual({
      ok: true,
      result: {
        kind: 'approval_request_created',
        artifactId: 'approval-directory-1',
        actionId: 'session.spawn_new',
      },
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      approval: { flow: 'deferred', result: 'required' },
      sessionCreationDirectoryApproval: directoryApproval,
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-1',
      decision: 'approve',
    }, { surface: 'cli' })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNewDirectoryApprovalPreflight).toHaveBeenCalledTimes(2);
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      sessionCreationDirectoryApproval: directoryApproval,
    }));
  });

  it('rejects creation without either caller key or durable Action request identity', async () => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({ sessionSpawnNew } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...withoutCreationKey } = canonicalInput;

    const result = await executor.execute('session.spawn_new', withoutCreationKey, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });
});
