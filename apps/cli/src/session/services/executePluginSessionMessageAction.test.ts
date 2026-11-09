import axios from 'axios';
import {
  AccountEncryptionCurrentnessResponseSchema,
  SessionOwnerMetadataV1Schema,
  V2SessionByIdResponseSchema,
  derivePluginSessionInputLocalIdV1,
  type SessionPendingEnqueueByMachineRequestV1,
  type SessionPendingExecutionRunEnqueueByMachineRequestV2,
} from '@happier-dev/protocol';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { describe, expect, it, vi } from 'vitest';

import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';

const DEVELOPMENT_SOURCE_CUSTODY = Object.freeze({
  kind: 'development' as const,
  registeredRootId: 'registered-root-current',
});

describe('executePluginSessionMessageAction', () => {
  it.each(['command', 'forgeEvidence'] as const)('admits %s through the real CLI Action and protected machine input owner', async kind => {
    const command = { kind: 'agent_team_member_delete' as const, teamId: 'reviewers', memberId: 'worker-1', memberLabel: 'Reviewer' };
    const text = 'Shutdown teammate Reviewer · reviewers';
    const forgeEvidence = { v: 1 as const, items: [{ source: { kind: 'pullRequest' as const, label: 'acme/repo#42' },
      author: { kind: 'person' as const, label: 'Ada' }, text: 'Preserve this exact evidence outside the unrelated prompt.' }] };
    const sessionId = 'session-command-current';
    const pluginId = 'acme.agent';
    const contributionLocalId = 'manage-teammates';
    const idempotencyKey = `shutdown-${command.kind}`;
    const materialization = { pluginId, machineId: 'machine-1', materializationId: 'materialization-current' };
    const localId = derivePluginSessionInputLocalIdV1({ caller: { pluginId, contributionLocalId }, sessionId, idempotencyKey });
    const admitted: Array<SessionPendingEnqueueByMachineRequestV1 | SessionPendingExecutionRunEnqueueByMachineRequestV2> = [];
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const session = V2SessionByIdResponseSchema.parse({ session: {
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 2, active: true, activeAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }), metadataVersion: 1, metadataLayoutVersion: 1,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(SessionOwnerMetadataV1Schema.parse({
        v: 1, workspace: { path: '/repo/current', host: 'nl1', machineId: 'machine-1' },
      })),
      dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1,
    } });
    // Only HTTP and authenticated daemon transport are mocked. CLI admission,
    // target resolution, sealing and receipt projection remain real.
    const http = vi.spyOn(axios, 'get').mockImplementation(async (url) => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) {
        return { status: 200, data: currentness };
      }
      if (String(url).includes(`/v2/sessions/${sessionId}`)) {
        return { status: 200, data: session };
      }
      throw new Error(`Unexpected HTTP read: ${String(url)}`);
    });
    const { executor } = createCliActionExecutorHarness({
      token: 'token', credentials: { token: 'token', encryption: null }, sessionId, mode: 'plain', ctx: null,
      machineAdmissionTransport: async (input) => {
        admitted.push(input);
        return { status: 'accepted' as const, localId };
      },
    });
    const signal = new AbortController().signal;

    try {
      const receipt = await executePluginSessionMessageAction({
        execute: executor.execute,
        pluginId,
        contributionLocalId,
        occurrenceId: 'occurrence-current',
        sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
        resolveCallerMaterialization: () => materialization,
        sessionId,
        request: kind === 'command' ? { kind: 'sessionSubagentCommand', command, idempotencyKey }
          : { kind: 'userText', text, idempotencyKey, forgeEvidence },
        signal,
      });
      expect(receipt).toEqual({ status: 'accepted', localId });
      expect(admitted).toEqual([expect.objectContaining({
        sessionId,
        targetMachineId: 'machine-1',
        localId,
        requestedAction: { v: 1, kind: kind === 'command' ? 'send_now' : 'steer_if_active' },
        content: { t: 'plain', v: expect.objectContaining({
          role: 'user', content: { type: 'text', text },
          meta: expect.objectContaining({
            ...(kind === 'command' ? { happier: { kind: 'subagent_command.v1', payload: command }, displayText: text }
              : { forgeEvidence }),
            happierProvenanceV1: { v: 1, kind: 'pluginSession', pluginId, contributionLocalId, surface: 'unspecified' },
            happierInputRequestV1: { v: 1, producer: 'pluginSession', caller: { kind: 'plugin', pluginId, contributionLocalId }, permission: {} },
          }),
        }) },
      })]);
    } finally {
      http.mockRestore();
    }
  });

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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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
        toolAnswerDelivery: { toolCallId: 'question-1' },
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
        toolAnswerDelivery: { toolCallId: 'question-1' },
      },
      {
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
          occurrenceId: 'occurrence-current',
          sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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

  it('preserves an execution-run recipient and attachments through the plugin Session handle Action boundary', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' as const, localId: 'plugin-input-v1:targeted' },
    }));
    const signal = new AbortController().signal;

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
      resolveCallerMaterialization: () => ({
        pluginId: 'acme.channels',
        machineId: 'machine-1',
        materializationId: 'materialization-current',
      }),
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Continue this run',
        idempotencyKey: 'message-targeted-42',
        recipient: { kind: 'execution_run', runId: 'run-1' },
        attachments: [{
          attachmentLocalId: 'entry',
          value: {
            key: 'github:pull:42',
            value: { sourceId: 'github', entryId: '42' },
            presentation: { label: 'PR #42' },
          },
        }],
      },
      signal,
    })).resolves.toEqual({
      status: 'accepted',
      localId: 'plugin-input-v1:targeted',
    });
    expect(execute).toHaveBeenCalledWith(
      'session.message.send',
      {
        sessionId: 'session-1',
        message: 'Continue this run',
        idempotencyKey: 'message-targeted-42',
        recipient: { kind: 'execution_run', runId: 'run-1' },
        attachments: [{
          attachmentLocalId: 'entry',
          value: {
            key: 'github:pull:42',
            value: { sourceId: 'github', entryId: '42' },
            presentation: { label: 'PR #42' },
          },
        }],
      },
      expect.objectContaining({ surface: 'plugin' }),
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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
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

  it('uses host-stamped occurrence and source custody when machine materialization is unavailable', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: { status: 'accepted' as const, localId: 'plugin-input-v1:accepted' },
    }));

    await expect(executePluginSessionMessageAction({
      execute,
      pluginId: 'acme.channels',
      contributionLocalId: 'inbound',
      occurrenceId: 'occurrence-current',
      sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
      sessionId: 'session-1',
      request: {
        kind: 'userText',
        text: 'Forward this',
        idempotencyKey: 'message-42',
      },
      signal: new AbortController().signal,
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
      expect.objectContaining({
        surface: 'plugin',
        authority: 'account_automation',
        actionCaller: {
          kind: 'plugin',
          pluginId: 'acme.channels',
          contributionLocalId: 'inbound',
          occurrenceId: 'occurrence-current',
          sourceCustody: DEVELOPMENT_SOURCE_CUSTODY,
        },
      }),
    );
  });
});
