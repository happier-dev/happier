import axios from 'axios';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionMessageContentSchema, type SessionMessageContent } from '@/api/types';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  AccountEncryptionCurrentnessResponseSchema,
  ExternalActionMachineBootstrapV1Schema,
  SessionOwnerMetadataV1Schema,
  V2SessionByIdResponseSchema,
  derivePluginSessionInputLocalIdV1,
  buildTrustedHostSessionInputAdmissionV1,
  type SessionPendingEnqueueByMachineRequestV1,
  type SessionPendingExecutionRunEnqueueByMachineRequestV2,
} from '@happier-dev/protocol';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createSessionOwnerMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { describe, expect, it, vi } from 'vitest';

import { executePluginSessionMessageAction } from './executePluginSessionMessageAction';
import { createCliActionExecutorHarness } from '../actions/createCliActionExecutorHarness';

const DEVELOPMENT_SOURCE_CUSTODY = Object.freeze({
  kind: 'development' as const,
  registeredRootId: 'registered-root-current',
});

const CURRENT_MACHINE = ExternalActionMachineBootstrapV1Schema.parse({
  id: 'machine-1', managedMachineRef: null, active: true,
  revokedAt: null, replacedByMachineId: null,
});

describe('executePluginSessionMessageAction', () => {
  it.each(['authored', 'explicit', 'team', 'constrained', 'constrained-default', 'invalid',
    'host-allowed', 'host-denied', 'host-provider-denied', 'host-agent-denied', 'host-default-denied', 'credential-denied'] as const)('admits %s authored context through the canonical input boundary', async selection => {
    const constrained = selection === 'constrained' || selection === 'constrained-default' || selection === 'credential-denied';
    const hostConstrained = selection.startsWith('host-');
    const modelDenied = selection === 'host-denied' || selection === 'host-provider-denied'
      || selection === 'host-agent-denied' || selection === 'host-default-denied' || selection === 'credential-denied';
    const sessionId = 'authored-composer-message';
    const admitted: SessionMessageContent[] = [];
    const currentness = AccountEncryptionCurrentnessResponseSchema.parse({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const owner = createSessionOwnerMetadataV1({ metadata: { machineId: 'machine-1', path: '/repo/current', host: 'nl1',
      flavor: 'claude', permissionMode: 'read-only', modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'session-default' } } });
    if (!owner.ok) throw new Error(`Invalid metadata fixture: ${owner.unsupportedFields.join(', ')}`);
    const desiredModel = { v: 1 as const, updatedAt: 1234, ref: {
      agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: 'pc_ui', modelId: 'desired-model' } };
    const teamSelection = { v: 2 as const, updatedAt: 1234, ref: { source: 'team_resource' as const,
      teamId: 'team-1', resourceId: 'team-model', expectedResourceRevision: 7, deliveryMode: 'vendor-native' as const,
      agentTargetKey: desiredModel.ref.agentTargetKey, modelId: desiredModel.ref.modelId } };
    const session = V2SessionByIdResponseSchema.parse({ session: {
      id: sessionId, seq: 0, createdAt: 1, updatedAt: 2, active: false, activeAt: 2,
      encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }), metadataVersion: 1, metadataLayoutVersion: 1,
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
      dataEncryptionKey: null, share: null, agentState: null, agentStateVersion: 1,
    } });
    const http = vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
      if (String(url).includes(`/v2/sessions/${sessionId}`)) return { status: 200, data: session };
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: CURRENT_MACHINE } };
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [CURRENT_MACHINE] };
      throw new Error(`Unexpected HTTP read: ${String(url)}`);
    });
    // Substitute only account HTTP and authenticated Machine admission. Plain
    // host authoring uses account Pending; signed external roots use the Machine.
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (url, body: unknown) => {
      if (String(url).endsWith('/v1/actions/session.message.send/execution-authorization/verify')) {
        return { status: 200, data: { ok: true } };
      }
      if (!String(url).endsWith(`/v2/sessions/${sessionId}/pending`)) throw new Error(`Unexpected HTTP write: ${String(url)}`);
      if (!body || typeof body !== 'object') throw new Error('Expected Pending write body');
      admitted.push(SessionMessageContentSchema.parse(Reflect.get(body, 'content')));
      return { status: 200, data: { didWrite: true, message: { localId: 'authored-composer-local' } } };
    });
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const { executor } = createCliActionExecutorHarness({ token: 'token', credentials: { token: 'token', encryption: null },
      serverIdentityId: 'home-1', externalActionMachineInstallationId: 'installation-1',
      externalActionMachineRequestPrivateKey: keys.secretKey,
      sessionId, mode: 'plain', ctx: null, machineAdmissionTransport: async input => {
        admitted.push(SessionMessageContentSchema.parse(input.content));
        return { status: 'accepted' as const, localId: 'authored-composer-local' };
      } });
    try {
      const input = { sessionId, message: 'Composer prompt',
        localId: 'authored-composer-local', requestedAction: { v: 1, kind: 'send_now' }, reply: 'none',
        ...(hostConstrained || selection === 'credential-denied' ? { modelOverride: selection === 'host-default-denied' ? null
          : selection === 'host-denied' || selection === 'credential-denied' ? 'desired-model' : 'allowed-model',
          providerConnectionId: selection === 'host-provider-denied' ? 'pc_other' : null }
          : selection === 'team' ? { permissionModeOverride: 'default', modelSelection: teamSelection }
          : selection === 'explicit'
          ? { permissionModeOverride: 'safe-yolo', modelOverride: 'explicit-model', providerConnectionId: 'pc_explicit' }
          : selection === 'authored'
            ? { permissionModeOverride: 'default', modelSelection: desiredModel }
            : selection === 'constrained'
              ? { permissionModeOverride: 'read-only', modelOverride: 'allowed-model', providerConnectionId: null }
              : {}),
        messageMeta: { displayText: 'Displayed prompt', customSystemPrompt: 'Use the project convention.',
          appendSystemPrompt: 'Check the changed path.', permissionMode: constrained ? 'yolo' : 'default',
          sentFrom: 'web', source: 'cli', model: selection === 'invalid' ? 42 : 'desired-model',
          modelSelectionV1: selection === 'team' ? teamSelection : desiredModel,
          providerExtra: { choice: 'preserved' },
          happierProvenanceV1: { v: 1, kind: 'host', producer: 'voiceInput' },
          happierInputRequestV1: { v: 1, producer: 'voiceInput', caller: { kind: 'host' }, permission: {} },
        },
      };
      const credential = {
          accountId: 'account-1', principalId: 'token-1', credentialId: 'token-1', grant: {
            v: 1 as const, actions: { families: [], ids: ['session.message.send'] }, targets: { sessions: [sessionId], machines: [] },
            approve: false, origins: [], permissionModes: ['read-only'], models: [{
              agentTargetKey: desiredModel.ref.agentTargetKey, providerConnectionId: null, modelId: 'allowed-model' }], create: null,
          },
      };
      const target = { kind: 'session' as const, sessionId };
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: 'metadata-request', target, input });
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-admitted-proof', binding: {
        ...credential, custodianAccountId: 'account-1', serverIdentityId: 'home-1', machineId: 'machine-1',
        installationId: 'installation-1', actionId: 'session.message.send', requestId: envelope.requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target, accountEncryptionMode: 'plain',
      } });
      const requester = constrained ? await projectExternalActionRequesterHttpAuthorization({ authorization,
        serverId: 'metadata-home', serverIdentityId: 'home-1', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        target, installationId: 'installation-1', privateKey: keys.secretKey }) : undefined;
      if (constrained && !requester) throw new Error('Expected verified requester custody');
      const receipt = await executor.execute('session.message.send', input, {
        surface: constrained ? 'api' : 'ui', authority: constrained ? 'account_automation' : 'present_user', actionCaller: { kind: 'host' },
        ...(hostConstrained ? { callerInputConstraints: { permissionModes: null, models: [{
          agentTargetKey: selection === 'host-agent-denied' ? 'agent:happier.agent.codex/codex' : desiredModel.ref.agentTargetKey,
          providerConnectionId: null, modelId: 'allowed-model' }] } } : {}),
        ...(constrained ? { externalActionCredential: credential,
          externalActionExecutionAuthorization: requester ?? undefined, externalActionTarget: target } : {}),
      });
      if (modelDenied) {
        expect(receipt).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
        expect(admitted).toHaveLength(0);
        expect(writes.mock.calls.filter(([url]) => String(url).endsWith('/pending'))).toHaveLength(0);
        return;
      }
      if (selection === 'invalid') {
        expect(receipt, JSON.stringify({ receipt, readUrls: http.mock.calls.map(([url]) => String(url)) })).toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
        expect(admitted).toHaveLength(0);
        return;
      }
      expect(receipt, JSON.stringify({ receipt, readUrls: http.mock.calls.map(([url]) => String(url)) })).toMatchObject({ ok: true, result: { status: 'accepted', localId: 'authored-composer-local' } });
      expect(admitted).toHaveLength(1);
      const content = admitted[0]!;
      expect(content.t).toBe('plain');
      if (content.t !== 'plain') throw new Error('Expected plain fixture content');
      expect(content.v).toMatchObject({ role: 'user', content: { type: 'text', text: 'Composer prompt' },
        meta: { displayText: 'Displayed prompt', customSystemPrompt: 'Use the project convention.',
          appendSystemPrompt: 'Check the changed path.', providerExtra: { choice: 'preserved' },
          sentFrom: 'web', source: 'ui',
          ...(selection === 'team' ? { permissionMode: 'default', modelSelectionV1: teamSelection }
          : selection === 'constrained-default' ? {} : selection === 'constrained' || selection === 'host-allowed' ? {
            ...(selection === 'constrained' ? { permissionMode: 'read-only' } : {}), model: 'allowed-model',
            modelSelectionV1: { v: 1, updatedAt: 0, ref: {
              agentTargetKey: desiredModel.ref.agentTargetKey, providerConnectionId: null, modelId: 'allowed-model' } },
          } : {
            permissionMode: selection === 'explicit' ? 'safe-yolo' : 'default',
            modelSelectionV1: selection === 'explicit' ? { v: 1, updatedAt: 0, ref: {
              agentTargetKey: desiredModel.ref.agentTargetKey, providerConnectionId: 'pc_explicit', modelId: 'explicit-model' } } : desiredModel,
          }),
          happierProvenanceV1: buildTrustedHostSessionInputAdmissionV1(constrained ? 'api' : 'ui').provenance,
          happierInputRequestV1: buildTrustedHostSessionInputAdmissionV1(constrained ? 'api' : 'ui').request,
        } });
      if (constrained) {
        expect(content.v).not.toMatchObject({ meta: { permissionMode: 'yolo' } });
        expect(content.v).not.toMatchObject({ meta: { model: desiredModel.ref.modelId } });
        expect(content.v).not.toMatchObject({ meta: { modelSelectionV1: desiredModel } });
      }
      if (selection === 'constrained-default') {
        expect(content.v).not.toHaveProperty('meta.permissionMode');
        expect(content.v).not.toHaveProperty('meta.model');
        expect(content.v).not.toHaveProperty('meta.modelSelectionV1');
      }
      if (selection === 'team' || selection === 'authored' || selection === 'explicit') {
        expect(content.v).not.toHaveProperty('meta.model');
      }
    } finally { writes.mockRestore(); http.mockRestore(); }
  });

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
      if (String(url).endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: CURRENT_MACHINE } };
      if (String(url).endsWith('/v1/machines')) return { status: 200, data: [CURRENT_MACHINE] };
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
      expect(receipt, JSON.stringify({ receipt, readUrls: http.mock.calls.map(([url]) => String(url)) })).toEqual({ status: 'accepted', localId });
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
