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

const apiSpawnInput = {
  creationKey: 'api-operation-7',
  directory: '/workspace/project',
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
} as const;

describe('session.spawn_new canonical execution', () => {
  it('binds API session spawn placement only from host-stamped daemon context', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toMatchObject({ ok: true });

    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it.each([
    ['missing target', {}],
    ['Session target', { externalActionTarget: { kind: 'session' as const, sessionId: 'session-1' } }],
  ])('rejects API session spawn with a %s before creating a Session', async (_name, targetContext) => {
    const sessionSpawnNew = vi.fn();
    const executor = createActionExecutor({
      sessionSpawnNew,
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      ...targetContext,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    });

    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('persists and replays the host-bound canonical target for an API spawn approval', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: unknown = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: unknown }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'api'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', apiSpawnInput, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-spawn-1' },
    });
    expect(persistedApproval).toMatchObject({
      actionId: 'session.spawn_new',
      actionArgs: expect.objectContaining({
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-spawn-1',
      decision: 'approve',
    }, { surface: 'cli' })).resolves.toMatchObject({ ok: true });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays an API spawn approval when its creation identity came from the host request id', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-api-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'api'
      ),
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...apiInputWithoutCreationKey } = apiSpawnInput;

    await expect(executor.execute('session.spawn_new', apiInputWithoutCreationKey, {
      surface: 'api',
      actionCaller: { kind: 'host' },
      serverId: 'server-host',
      externalActionTarget: { kind: 'machine', machineId: 'machine-host' },
      actionRequestId: 'api-request-identity-7',
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-api-request-id-spawn-1' },
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-api-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:api-request-identity-7',
        executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:api-request-identity-7',
      executionTarget: { serverId: 'server-host', machineId: 'machine-host' },
    }));
  });

  it('replays a manually-created spawn approval with its host request identity', async () => {
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'pending' as const,
      retryWithSameCreationKey: true as const,
      outcome: 'accepted' as const,
    }));
    let persistedApproval: Record<string, unknown> | null = null;
    const approvalsCreate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { artifactId: 'approval-manual-request-id-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);
    const { creationKey: _creationKey, ...inputWithoutCreationKey } = canonicalInput;

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.spawn_new',
      actionArgs: inputWithoutCreationKey,
      summary: 'Create a session',
      createdBy: { surface: 'system' },
    }, {
      surface: 'cli',
      actionRequestId: 'manual-request-identity-7',
    })).resolves.toMatchObject({ ok: true });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-manual-request-id-spawn-1',
      decision: 'approve',
    }, { surface: 'cli' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });

    expect(persistedApproval).toMatchObject({
      actionArgs: expect.objectContaining({
        creationKey: 'action-request:manual-request-identity-7',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      }),
      status: 'executed',
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'action-request:manual-request-identity-7',
    }));
  });

  it('projects compact spawn input schemas and hints when API callers discover Action specs', async () => {
    const executor = createActionExecutor({
      isActionApprovalRequired: () => false,
    } as unknown as ActionExecutorDeps);
    const context = {
      surface: 'api' as const,
      authority: 'account_automation' as const,
      actionCaller: { kind: 'host' as const },
    };

    const getResult = await executor.execute('action.spec.get', {
      id: 'session.spawn_new',
    }, context);
    const searchResult = await executor.execute('action.spec.search', {
      query: 'session.spawn_new',
      limit: 1,
    }, context);

    expect(getResult).toMatchObject({
      ok: true,
      result: {
        actionSpec: {
          kindVersion: 1,
          description: 'Create a new coding session in a directory on the requested machine, using the selected Agent.',
          inputSchema: {
            properties: {
              directory: expect.objectContaining({ type: 'string' }),
            },
          },
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputSchema: { properties: { executionTarget: expect.anything() } },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        },
      },
    });
    expect(getResult).not.toMatchObject({
      result: {
        actionSpec: {
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        },
      },
    });
    expect(searchResult).toMatchObject({
      ok: true,
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          description: 'Create a new coding session in a directory on the requested machine, using the selected Agent.',
          inputHints: expect.objectContaining({
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'directory' }),
            ]),
          }),
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.serverId' }),
            ]),
          },
        })],
      },
    });
    expect(searchResult).not.toMatchObject({
      result: {
        actionSpecs: [expect.objectContaining({
          id: 'session.spawn_new',
          inputHints: {
            fields: expect.arrayContaining([
              expect.objectContaining({ path: 'executionTarget.machineId' }),
            ]),
          },
        })],
      },
    });
  });

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
        cause: { kind: 'manual', invokedAt: 1 },
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
        cause: { kind: 'manual', invokedAt: 1 },
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
        cause: { kind: 'manual', invokedAt: 1 },
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
        initialInput: { text: predecessorActionArgs.prompt },
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

  it('forwards a UI directory-approval replay to the exact target Action owner before it mutates the artifact', async () => {
    const directoryApproval = {
      v: 1 as const,
      executionTarget: canonicalInput.executionTarget,
      directory: canonicalInput.directory,
    };
    const targetDecisionResult = {
      ok: true,
      status: 'executed',
      execution: {
        executedAtMs: 3,
        ok: true,
        result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'accepted' },
      },
    };
    const sessionSpawnNew = vi.fn(async () => {
      throw new Error('ui_must_not_forward_directory_approval_as_spawn_input');
    });
    const sessionSpawnNewDirectoryApprovalReplay = vi.fn(async () => targetDecisionResult);
    let persistedApproval: Record<string, unknown> = {
      v: 1,
      status: 'open',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      requestedSurface: 'mcp',
      actionId: 'session.spawn_new',
      actionArgs: canonicalInput,
      summary: 'Create session',
      serverId: canonicalInput.executionTarget.serverId,
      sessionCreationDirectoryApproval: directoryApproval,
    };
    const approvalsGet = vi.fn(async () => persistedApproval);
    const approvalsUpdate = vi.fn(async ({ request }: Readonly<{ request: Record<string, unknown> }>) => {
      persistedApproval = request;
      return { ok: true as const };
    });
    const executor = createActionExecutor({
      sessionSpawnNew,
      sessionSpawnNewDirectoryApprovalReplay,
      approvalsGet,
      approvalsUpdate,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-directory-target-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      serverId: canonicalInput.executionTarget.serverId,
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: targetDecisionResult });

    expect(sessionSpawnNewDirectoryApprovalReplay).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'approval-directory-target-1',
      executionTarget: canonicalInput.executionTarget,
      signal: controller.signal,
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
    expect(approvalsUpdate).not.toHaveBeenCalled();
    expect(persistedApproval).toMatchObject({ status: 'open' });
  });

  it('lets the canonical target-action approval owner claim a decision before generic Artifact handling', async () => {
    const targetActionApprovalReplay = vi.fn(async () => ({
      ok: true as const,
      result: { ok: true, status: 'executed' },
    }));
    const approvalsGet = vi.fn(async () => {
      throw new Error('generic_approval_store_must_not_read_target_action_artifact');
    });
    const executor = createActionExecutor({
      targetActionApprovalReplay,
      approvalsGet,
    } as unknown as ActionExecutorDeps);
    const controller = new AbortController();

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'target-action-approval-1',
      decision: 'approve',
    }, {
      surface: 'ui',
      signal: controller.signal,
    })).resolves.toEqual({ ok: true, result: { ok: true, status: 'executed' } });

    expect(targetActionApprovalReplay).toHaveBeenCalledExactlyOnceWith({
      artifactId: 'target-action-approval-1',
      decision: 'approve',
      signal: controller.signal,
    });
    expect(approvalsGet).not.toHaveBeenCalled();
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
