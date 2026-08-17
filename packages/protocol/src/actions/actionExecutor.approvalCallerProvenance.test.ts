import { describe, expect, it, vi } from 'vitest';

import { ApprovalRequestV1Schema, type ApprovalRequestV1 } from '../approvals/approvalRequestV1.js';
import { createActionExecutor } from './actionExecutor.js';
import type { ActionExecutorDeps } from './executor/types.js';

const sessionSpawnInput = {
  creationKey: 'plugin-approval-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent',
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
  initialMessage: 'Inspect this repository.',
} as const;

describe('createActionExecutor (durable plugin approval caller provenance)', () => {
  it('replays a plugin-approved Session spawn with the exact contribution and nested initial-input settlement', async () => {
    let storedRequest: ApprovalRequestV1 | null = null;
    const approvalsCreate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { artifactId: 'approval-plugin-spawn-1' };
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-1',
      executionTarget: sessionSpawnInput.executionTarget,
      organizationPlacement: sessionSpawnInput.organizationPlacement,
      initialInput: { status: 'accepted' as const, localId: 'initial-input-1' },
    }));
    const executor = createActionExecutor({
      approvalsCreate,
      approvalsGet,
      approvalsUpdate,
      sessionSpawnNew,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'plugin'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'plugin',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
      },
    })).resolves.toMatchObject({
      ok: true,
      result: { kind: 'approval_request_created', artifactId: 'approval-plugin-spawn-1' },
    });

    expect(storedRequest).toMatchObject({
      requestedSurface: 'plugin',
      createdBy: {
        surface: 'system',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
      },
      actionArgs: sessionSpawnInput,
    });

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-plugin-spawn-1',
      decision: 'approve',
    }, { surface: 'ui' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'executed',
        execution: {
          ok: true,
          result: {
            type: 'success',
            sessionId: 'session-1',
            initialInput: { status: 'accepted', localId: 'initial-input-1' },
          },
        },
      },
    });
    expect(sessionSpawnNew).toHaveBeenCalledWith(expect.objectContaining({
      initialMessage: 'Inspect this repository.',
      actionCaller: {
        kind: 'plugin',
        pluginId: 'plugin.example',
        contributionLocalId: 'session-spawn',
      },
    }));
  });

  it('fails an incomplete legacy plugin approval before it can start a Session', async () => {
    let storedRequest: ApprovalRequestV1 = {
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'system', pluginId: 'plugin.example' },
      requestedSurface: 'plugin',
      actionId: 'session.spawn_new',
      actionArgs: sessionSpawnInput,
      summary: 'Create session',
    };
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionSpawnNew = vi.fn(async () => ({
      type: 'success' as const,
      disposition: 'created' as const,
      sessionId: 'session-1',
      executionTarget: sessionSpawnInput.executionTarget,
      organizationPlacement: sessionSpawnInput.organizationPlacement,
      initialInput: { status: 'accepted' as const, localId: 'initial-input-1' },
    }));
    const executor = createActionExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionSpawnNew,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-plugin-spawn-legacy-1',
      decision: 'approve',
    }, { surface: 'ui' })).resolves.toMatchObject({
      ok: true,
      result: {
        status: 'failed',
        execution: { ok: false, errorCode: 'approval_plugin_caller_missing' },
      },
    });
    expect(sessionSpawnNew).not.toHaveBeenCalled();
  });

  it('does not create a durable automatic approval when a plugin caller lacks contribution provenance', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-missing-caller-1' }));
    const executor = createActionExecutor({
      approvalsCreate,
      isActionApprovalRequired: (actionId, context) => (
        actionId === 'session.spawn_new' && context.surface === 'plugin'
      ),
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('session.spawn_new', sessionSpawnInput, {
      surface: 'plugin',
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_action_caller_required',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('does not create an explicit approval-queue row when a plugin caller lacks contribution provenance', async () => {
    const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-plugin-missing-caller-2' }));
    const executor = createActionExecutor({ approvalsCreate } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.create', {
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
      createdBy: { surface: 'system' },
    }, {
      actionCaller: { kind: 'plugin', pluginId: 'plugin.example' },
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'plugin_action_caller_required',
    });
    expect(approvalsCreate).not.toHaveBeenCalled();
  });

  it('rejects a noncanonical plugin identity in a durable approval row', () => {
    expect(ApprovalRequestV1Schema.safeParse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: {
        surface: 'system',
        pluginId: ' plugin.example ',
        contributionLocalId: 'session-spawn',
      },
      requestedSurface: 'plugin',
      actionId: 'session.list',
      actionArgs: {},
      summary: 'List sessions',
    }).success).toBe(false);
  });

  it('replays a predecessor session_agent approval through the current agent surface', async () => {
    let storedRequest = ApprovalRequestV1Schema.parse({
      v: 1,
      status: 'open',
      createdAtMs: 100,
      updatedAtMs: 100,
      createdBy: { surface: 'session_agent', sessionId: 'requesting-session' },
      actionId: 'session.title.set',
      actionArgs: { sessionId: 'session-1', title: 'From predecessor' },
      summary: 'Set title',
    });
    const approvalsGet = vi.fn(async () => storedRequest);
    const approvalsUpdate = vi.fn(async ({ request }: { request: ApprovalRequestV1 }) => {
      storedRequest = request;
      return { ok: true as const };
    });
    const sessionTitleSet = vi.fn(async () => ({ updated: true }));
    const observeActionExecution = vi.fn(async () => undefined);
    const executor = createActionExecutor({
      approvalsGet,
      approvalsUpdate,
      sessionTitleSet,
      observeActionExecution,
    } as unknown as ActionExecutorDeps);

    await expect(executor.execute('approval.request.decide', {
      artifactId: 'approval-session-agent-predecessor-1',
      decision: 'approve',
    }, { surface: 'ui' })).resolves.toMatchObject({
      ok: true,
      result: { status: 'executed', execution: { ok: true } },
    });
    expect(sessionTitleSet).toHaveBeenCalledWith({ sessionId: 'session-1', title: 'From predecessor' });
    expect(observeActionExecution).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({
        surface: 'agent',
        defaultSessionId: 'requesting-session',
      }),
      caller: { kind: 'host' },
    }));
  });
});
