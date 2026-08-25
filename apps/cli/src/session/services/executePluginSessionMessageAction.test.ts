import { derivePluginSessionInputLocalIdV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';

describe('executePluginSessionMessageAction', () => {
  it('forwards the semantic subagent launch without accepting private transport fields', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' as const, localId: 'plugin-input-v1:launch' },
    }));
    const signal = new AbortController().signal;

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.agent',
      contributionLocalId: 'launch-teammate',
      resolveCallerMaterialization: () => ({
        pluginId: 'acme.agent',
        machineId: 'machine-1',
        materializationId: 'materialization-current',
      }),
      sessionId: 'session-1',
      request: {
        kind: 'sessionSubagentLaunch',
        launch: {
          kind: 'agent_team_create',
          teamId: 'reviewers',
          description: 'Review the current change.',
        },
        idempotencyKey: 'launch-reviewers',
      },
      signal,
    })).resolves.toEqual({ status: 'accepted', localId: 'plugin-input-v1:launch' });

    expect(execute).toHaveBeenCalledWith(
      'session.message.send',
      {
        sessionId: 'session-1',
        kind: 'sessionSubagentLaunch',
        launch: {
          kind: 'agent_team_create',
          teamId: 'reviewers',
          description: 'Review the current change.',
        },
        idempotencyKey: 'launch-reviewers',
      },
      expect.objectContaining({ surface: 'plugin' }),
    );
  });

  it('delegates SessionHandle.send through the canonical Action with host-stamped caller identity', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' as const, localId: 'plugin-input-v1:accepted' },
    }));
    const signal = new AbortController().signal;

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      resolveCallerMaterialization: () => ({
        pluginId: 'acme.channels',
        machineId: 'machine-1',
        materializationId: 'materialization-current',
      }),
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal,
    })).resolves.toEqual({
      status: 'accepted',
      localId: 'plugin-input-v1:accepted',
    });
    expect(execute).toHaveBeenCalledWith(
      'session.message.send',
      {
        sessionId: 'session-1',
        message: 'Forward this',
        idempotencyKey: 'message-42',
      },
      {
        surface: 'plugin',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
          materialization: {
            pluginId: 'acme.channels',
            machineId: 'machine-1',
            materializationId: 'materialization-current',
          },
        },
        signal,
      },
    );
  });

  it('does not relabel a noncanonical Action failure as an admission rejection', async () => {
    const execute = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'invalid_parameters',
      error: 'invalid_parameters',
    }));
    const materialization = {
      pluginId: 'acme.channels',
      machineId: 'machine-1',
      materializationId: 'materialization-current',
    } as const;
    const localId = derivePluginSessionInputLocalIdV1({
      caller: {
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      resolveCallerMaterialization: () => materialization,
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_action_execution_failed',
    });
  });

  it('reports a malformed successful Action result as admission outcome unknown', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' },
    }));
    const materialization = {
      pluginId: 'acme.channels',
      machineId: 'machine-1',
      materializationId: 'materialization-current',
    } as const;
    const localId = derivePluginSessionInputLocalIdV1({
      caller: {
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      resolveCallerMaterialization: () => materialization,
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_admission_result_malformed',
    });
  });

  it('reports an Action execution failure after dispatch begins as admission outcome unknown', async () => {
    const execute = vi.fn(async () => {
      throw new Error('Action response channel closed');
    });
    const materialization = {
      pluginId: 'acme.channels',
      machineId: 'machine-1',
      materializationId: 'materialization-current',
    } as const;
    const localId = derivePluginSessionInputLocalIdV1({
      caller: {
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      resolveCallerMaterialization: () => materialization,
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_action_execution_failed',
    });
  });

  it('preserves strict outcome-unknown certainty through the genuine Action executor catch boundary', async () => {
    const materialization = {
      pluginId: 'acme.channels',
      machineId: 'machine-1',
      materializationId: 'materialization-current',
    } as const;
    const localId = derivePluginSessionInputLocalIdV1({
      caller: {
        pluginId: 'acme.channels',
        contributionLocalId: 'inbound',
      },
      sessionId: 'session-1',
      idempotencyKey: 'message-42',
    });
    // This narrow fixture exercises the real executor through its typed CLI harness.
    const { executor } = createCliActionExecutorHarness({
      token: 'token',
      sessionId: 'session-1',
      mode: 'plain',
      ctx: null,
    }, {
      sessionSendMessage: vi.fn(async () => {
        throw new Error('Session admission response channel closed after dispatch');
      }),
    });

    await expect(executePluginSessionMessageAction({
      execute: executor.execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      resolveCallerMaterialization: () => materialization,
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'outcomeUnknown',
      localId,
      code: 'session_input_action_execution_failed',
    });
  });

  it('fails closed rather than reconstructing a caller materialization from the plugin id', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' as const, localId: 'plugin-input-v1:accepted' },
    }));

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'rejected',
      code: 'session_input_untrusted_assertion',
    });

    expect(execute).not.toHaveBeenCalled();
  });
});
