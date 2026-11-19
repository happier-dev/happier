import { afterEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { RpcError } from '@happier-dev/protocol/rpcErrors';
import {
  deriveSessionCreationTagV1,
  SessionCreationCorrespondenceV1Schema,
  SessionMetadataTuplePatchV1Schema,
} from '@happier-dev/protocol';

const { callMachineRpc } = vi.hoisted(() => ({ callMachineRpc: vi.fn() }));
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>(),
  callMachineRpc,
}));

import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { requestInactiveSessionResume } from './requestInactiveSessionResume';
import { logger } from '@/ui/logger';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { resolveSessionStartupTimeoutMs } from '@/daemon/spawn/waitForSessionWebhook';
import { resolveCliAgentStartContextV1 } from '@/session/actions/resolveCliAgentStartContextV1';
import { clearSessionExplicitStopIntentAfterResume } from './sessionExplicitStopIntent';
import { accountSettingsParse } from '@happier-dev/protocol';
import { buildConnectedServiceCredentialSpawnErrorResult } from '@/daemon/connectedServices/diagnostics/buildConnectedServiceDiagnosticSpawnErrorResult';

const machineKey = new Uint8Array(32).fill(1);
const credentials = {
  token: 'account-token',
  encryption: { type: 'dataKey' as const, publicKey: machineKey, machineKey },
};

function rawSession(overrides: Record<string, unknown> = {}): RawSessionRecord {
  return {
    id: 'session-1', active: false, machineId: 'machine-1', path: '/repo', seq: 17, ...overrides,
  } as unknown as RawSessionRecord;
}

const metadata = {
  machineId: 'machine-1',
  path: '/repo',
  runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
  claudeSessionId: 'provider-session-1',
};

it('retains native sign-in recovery and request identity when inactive resume is refused', async () => {
  const result = await requestInactiveSessionResume({ credentials, sessionId: 'session-1',
    rawSession: rawSession(), metadata, localId: 'resume-auth-request',
    machineRpcTransport: async () => ({ type: 'error', errorCode: 'agent_signed_out',
      agentId: 'claude', errorMessage: 'Sign in before starting a session.' }),
  });
  expect(result).toMatchObject({ ok: false, code: 'resume_failed', errorDetail: {
    kind: 'launch_error', code: 'agent_signed_out',
    failureCause: { phase: 'authentication', failureReason: 'authentication_required', requestId: 'resume-auth-request' },
  } });
});

const providerMetadata = {
  ...metadata,
  providerBindingV1: {
    v: 1,
    connectionId: 'pc_work',
    contributionKey: 'plugin.gateway/gateway',
    connectionRevision: 2,
    protocol: 'openai-responses',
    materialization: 'engineConfig',
    adapterBindingKey: 'gateway',
    compatibilityFingerprint: 'compatibility-v1',
    bindingSecurityFingerprint: 'security-v1',
    displaySnapshot: {
      providerName: 'Gateway',
      connectionName: 'Work',
      connectionRole: 'named',
      connectionDisplayNameMode: 'custom',
    },
  },
  modelSelectionIntentV1: {
    v: 1,
    updatedAt: 100,
    selection: {
      agentTargetKey: 'agent:happier.agent.claude/claude',
      providerConnectionId: 'pc_work',
      modelId: 'provider-model',
    },
  },
} as const;

function metadataWithLaunchCorrespondence() {
  const sessionCreationTag = deriveSessionCreationTagV1({
    callerCreationNamespace: 'user',
    creationKey: 'creation-resume-rpc',
  });
  const correspondence = SessionCreationCorrespondenceV1Schema.parse({
    v: 1,
    sessionCreationTag,
    recipe: {
      execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
      organization: { folderId: null, tagIds: [] },
      agentTarget: {
        kind: 'agent',
        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
      },
      modelSelection: null,
      profileId: 'profile-shared',
      secretReferenceOverlay: {
        v: 1,
        bindings: {
          ANTHROPIC_API_KEY: {
            ref: 'happier:shared-secret:v1:shared-anthropic',
            revision: 5,
          },
        },
      },
      requestedPermissionMode: null,
      agentModeId: null,
      configuration: null,
      connectedServices: null,
      capabilitySelection: null,
      transcriptStorage: null,
      terminal: null,
      agentSessionStartupInstructionsMarkerV1: null,
      checkout: null,
    },
  });
  return {
    correspondence,
    metadata: { ...metadata, sessionCreationCorrespondenceV1: correspondence },
  };
}

describe('requestInactiveSessionResume', () => {
  it.each(['present_user', 'account_automation'] as const)('respects a person hold for %s Resume intent', async executionAuthority => {
    const stop = { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 100 } as const;
    const heldMetadata = { ...metadata, sessionExplicitStopV1: stop };
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const result = await requestInactiveSessionResume({ credentials, sessionId: 'session-1',
      requestId: 'explicit-resume', rawSession: rawSession(), metadata: heldMetadata, executionAuthority });
    if (executionAuthority === 'present_user') {
      expect(result).toEqual({ ok: true });
      expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session',
        sessionId: 'session-1', executionAuthorization: { provenance: 'user_request', requestId: 'explicit-resume' } });
    } else {
      expect(result).toMatchObject({ ok: false, code: 'held_by_person' });
      expect(callMachineRpc).not.toHaveBeenCalled();
    }
    expect(heldMetadata.sessionExplicitStopV1).toEqual(stop);
  });

  it.each([undefined, 'account_automation'] as const)('fails closed for a held Session when Resume names %s authority', async executionAuthority => {
    const stop = { v: 1, cause: 'explicit_stop', requestId: 'person-stop', requestedAtMs: 100 } as const;
    const heldMetadata = { ...metadata, sessionExplicitStopV1: stop };
    const result = await requestInactiveSessionResume({ credentials, sessionId: 'session-1', requestId: 'unknown-author',
      rawSession: rawSession(), metadata: heldMetadata, ...(executionAuthority ? { executionAuthority } : {}) });
    expect(result).toMatchObject({ ok: false, code: 'held_by_person' });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(heldMetadata.sessionExplicitStopV1).toEqual(stop);
  });

  it('does not mint user-request authority when a Resume names no authority', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'unknown-author',
      rawSession: rawSession(), metadata })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('executionAuthorization');
  });

  it.each([false, true])('keeps malformed Stop authority distinct from archive (archived=%s)', async archived => {
    const result = await requestInactiveSessionResume({ credentials, sessionId: 'session-1', requestId: 'malformed-stop',
      rawSession: rawSession(archived ? { archivedAt: 123 } : {}),
      metadata: { ...metadata, sessionExplicitStopV1: { v: 1 } },
    });
    expect(result).toMatchObject({ ok: false, code: archived ? 'session_archived' : 'authority_unavailable' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it.each(['success', 'refused', 'automatic', 'manager_child', 'foreign_manager', 'unbound_manager', 'person_hold'] as const)('does not spend native Stop clear authority after transport acceptance (%s)', async outcome => {
    const stop = { v: 1, cause: 'explicit_stop', requestId: 'stop-request', requestedAtMs: 100,
      ...(outcome !== 'person_hold' ? { managerSessionId: 'direct-manager' } : {}),
    } as const;
    const heldMetadata = { ...metadata, sessionExplicitStopV1: stop };
    const saved = rawSession({ encryptionMode: 'plain', dataEncryptionKey: null, metadataLayoutVersion: 0,
      metadataVersion: 1, agentStateVersion: 0, agentState: null, ownerMetadata: null,
      metadata: JSON.stringify(heldMetadata), manager: { sessionId: 'direct-manager' } });
    const get = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    } });
    const patch = vi.spyOn(axios, 'patch').mockResolvedValue({ status: 200, data: { success: true,
      metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 0 } } });
    callMachineRpc.mockResolvedValue(outcome === 'refused'
      ? { type: 'error', errorMessage: 'rejected' } : { type: 'success', sessionId: 'session-1' });
    const agentStartContext = resolveCliAgentStartContextV1({
      sessionId: outcome === 'foreign_manager' ? 'unrelated-session' : 'direct-manager', machineId: 'machine-1',
      directory: '/repo', backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
      metadata: {}, starterDepth: 0, turnDepth: 1, callerPermissionMode: 'default',
      settings: accountSettingsParse({}), roles: {},
    });
    if (!agentStartContext || 'ok' in agentStartContext) throw new Error('Expected admitted caller context');
    try {
      const result = await requestInactiveSessionResume({ credentials: { token: 'plain-owner', encryption: null },
        sessionId: 'session-1', requestId: 'resume-held', rawSession: saved, metadata: heldMetadata,
        ...(outcome === 'automatic' || outcome === 'manager_child' || outcome === 'foreign_manager' || outcome === 'unbound_manager' || outcome === 'person_hold'
          ? { executionAuthority: 'account_automation' as const } : { executionAuthority: 'present_user' as const }),
        ...(outcome === 'manager_child' || outcome === 'foreign_manager' || outcome === 'unbound_manager' || outcome === 'person_hold' ? { actionContext: {
          surface: 'agent' as const, authority: 'account_automation' as const,
          actionCaller: { kind: 'session' as const, sessionId: outcome === 'foreign_manager' ? 'unrelated-session' : 'direct-manager',
            starterDepth: 0, turnDepth: 1 }, actionRequestId: 'resume-held',
          ...(outcome !== 'unbound_manager' ? { agentStartContext } : {}),
        } } : {}),
      });
      if (outcome === 'success' || outcome === 'manager_child') {
        expect(result).toEqual({ ok: true });
        if (outcome === 'manager_child') expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('executionAuthorization');
      } else {
        expect(result).toMatchObject({ ok: false });
      }
      expect(patch, 'Only the admitted native launch may consume its observed hold').not.toHaveBeenCalled();
      if (outcome === 'automatic' || outcome === 'foreign_manager' || outcome === 'unbound_manager' || outcome === 'person_hold') expect(callMachineRpc).not.toHaveBeenCalled();
    } finally { get.mockRestore(); patch.mockRestore(); }
  });

  it('preserves a later Stop when the exact native clear retries a stale metadata tuple', async () => {
    const stop = { v: 1, cause: 'explicit_stop', requestId: 'stop-before-resume', requestedAtMs: 100 } as const;
    const newer = { ...stop, requestId: 'stop-during-resume', requestedAtMs: 101 };
    const savedMetadata = { ...metadata, sessionExplicitStopV1: stop };
    const plainCredentials = { token: 'plain-owner', encryption: null };
    const initial = buildSessionMetadataEnvelopeFields({ credentials: plainCredentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: savedMetadata, agentState: null });
    const latest = buildSessionMetadataEnvelopeFields({ credentials: plainCredentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { ...metadata, sessionExplicitStopV1: newer }, agentState: null });
    const saved = createSessionRecordFixture({ id: 'session-1', machineId: 'machine-1', encryptionMode: 'plain',
      dataEncryptionKey: null, metadataLayoutVersion: 1, metadataVersion: 1, share: null,
      metadata: initial.sharedMetadata.ciphertext, ownerMetadata: initial.ownerMetadata, agentState: initial.agentState });
    const refreshed = { ...saved, metadataVersion: 2, active: true,
      metadata: latest.sharedMetadata.ciphertext, ownerMetadata: latest.ownerMetadata };
    let storedStop: unknown = newer;
    let conflict = true;
    const get = vi.spyOn(axios, 'get').mockImplementation(async url => String(url).endsWith('/encryption/currentness')
      ? { status: 200, data: { mode: 'plain', version: 1, signingKeyFingerprint: null,
          contentKeyFingerprint: null, updatedAt: 1 } }
      : { status: 200, data: { session: refreshed } });
    const patch = vi.spyOn(axios, 'patch').mockImplementation(async (_url, body) => {
      if (conflict) {
        conflict = false;
        return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: 2 }, agentState: { version: 0 } } };
      }
      const update = SessionMetadataTuplePatchV1Schema.parse(body);
      if (update.mode !== 'owner' || update.ownerMetadata.t !== 'plain') {
        throw new Error('Expected a plain owner tuple after the concurrent Stop');
      }
      storedStop = update.ownerMetadata.v.runtime
        ? Reflect.get(update.ownerMetadata.v.runtime, 'sessionExplicitStopV1') : undefined;
      return { status: 200, data: { success: true, metadataLayoutVersion: 1,
        sharedMetadata: { version: 3 }, agentState: { version: 1 } } };
    });
    try {
      await clearSessionExplicitStopIntentAfterResume({ credentials: plainCredentials,
        sessionId: 'session-1', rawSession: saved, metadata: savedMetadata });
      expect(conflict).toBe(false);
      expect(storedStop).toEqual(newer);
    } finally { get.mockRestore(); patch.mockRestore(); }
  });

  it('uses the same resume owner for machine-local automatic Follow wake without a second RPC or user authorization', async () => {
    const accepted: unknown[] = [];
    const spawnSession = async (options: unknown) => {
      accepted.push(options);
      return { type: 'success' as const, sessionId: 'session-1' };
    };
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', requestId: 'follow-resume',
      rawSession: rawSession(), metadata, executionAuthority: 'account_automation', spawnSession,
    })).resolves.toEqual({ ok: true });
    expect(accepted).toEqual([expect.objectContaining({ existingSessionId: 'session-1', machineId: 'machine-1', directory: '/repo',
      initialTranscriptAfterSeq: 17 })]);
    expect(accepted[0]).not.toHaveProperty('executionAuthorization');
    expect(callMachineRpc).not.toHaveBeenCalled();
  });
  it('delivers the invocation initial goal in the existing resume request without changing saved launch controls', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'goal-request',
      rawSession: rawSession(), metadata, initialGoal: { objective: 'Finish the task', tokenBudget: null },
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      type: 'resume-session', sessionId: 'session-1',
      initialGoal: { objective: 'Finish the task', tokenBudget: null }, initialTranscriptAfterSeq: 17,
    });
  });
  it('does not fabricate a fresh user-message authorization for an automated goal wake', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'goal-request',
      rawSession: rawSession(), metadata, initialGoal: { objective: 'Finish the task' },
      executionAuthority: 'account_automation',
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('executionAuthorization');
  });
  it.each([100, 200, 300])('resumes with predecessor launch intent and timestamp-selected controls (%s)', async (incomingAt) => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const modelRef = (modelId: string) => ({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId });
    const request = {
      credentials, sessionId: 'session-1', localId: 'workflow-input', rawSession: rawSession(),
      metadata: { ...metadata, permissionMode: 'read-only', permissionModeUpdatedAt: 200,
        modelSelectionIntentV1: { v: 1, updatedAt: 200, selection: modelRef('saved-model') } },
      incomingOptions: { permissionMode: 'default' as const, permissionModeUpdatedAt: incomingAt,
        modelSelection: { v: 1 as const, updatedAt: incomingAt, ref: modelRef('incoming-model') },
        environmentVariables: { PREDECESSOR_RUN: 'literal value' }, resume: 'incoming-native-session',
      },
    };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      type: 'resume-session', sessionId: 'session-1', resume: 'incoming-native-session',
      environmentVariables: { PREDECESSOR_RUN: 'literal value' },
      permissionMode: incomingAt < 200 ? 'read-only' : 'default',
      permissionModeUpdatedAt: Math.max(incomingAt, 200),
      modelSelection: { ref: { modelId: incomingAt < 200 ? 'saved-model' : 'incoming-model' }, updatedAt: Math.max(incomingAt, 200) },
    });
  });

  it('carries incoming Team model identity through the machine resume transport', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const modelSelection = { v: 2 as const, updatedAt: 300, ref: {
      source: 'team_resource' as const, agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'team-model',
      resourceId: 'shared-model', teamId: 'team-1', expectedResourceRevision: 4, deliveryMode: 'brokered' as const,
    } };
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'workflow-team-input',
      rawSession: rawSession(), metadata, incomingOptions: { modelSelection },
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', modelSelection });
  });

  it('resumes with the predecessor explicit offline launch family while retaining canonical Session identity', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    const request = { credentials, sessionId: 'session-1', localId: 'workflow-launch', rawSession: rawSession(),
      metadata: metadataWithLaunchCorrespondence().metadata,
      incomingOptions: { profileId: 'incoming-profile', terminal: { mode: 'plain' as const },
        windowsRemoteSessionLaunchMode: 'windows_terminal' as const, windowsTerminalWindowName: 'Incoming window',
        agentModeId: 'incoming-mode', transcriptStorage: 'persisted' as const,
        connectedServices: { v: 2 as const, bindingsByServiceId: {} },
        capabilitySelection: { mcp: { v: 1 as const, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
      } };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', sessionId: 'session-1', directory: '/repo',
      profileId: 'incoming-profile', terminal: { mode: 'plain' }, windowsRemoteSessionLaunchMode: 'windows_terminal',
      windowsTerminalWindowName: 'Incoming window', agentModeId: 'incoming-mode', transcriptStorage: 'persisted',
      connectedServices: { v: 2, bindingsByServiceId: {} },
      capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: [], forceExcludeServerIds: [] } },
    });
  });

  it('applies an explicit same-Agent driver choice while retaining the Session native recovery identity', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-1' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'workflow-driver', rawSession: rawSession(),
      metadata: { ...metadata, runtimeDescriptorV1: { v: 1, agentId: 'codex',
        agent: { backendMode: 'appServer', providerSessionId: 'existing-native', appServerEndpoint: '/native/socket' } },
        claudeSessionId: undefined, codexSessionId: 'existing-native' },
      incomingOptions: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } } },
    })).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ type: 'resume-session', sessionId: 'session-1',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp', providerSessionId: 'existing-native', appServerEndpoint: '/native/socket' } },
    });
  });

  it('refuses an authored driver descriptor that changes the existing Session Agent', async () => {
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'workflow-wrong-agent', rawSession: rawSession(), metadata,
      incomingOptions: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: { backendMode: 'acp' } } },
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('sends explicit fresh-folder consent without granting automatic managed-folder recreation', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });
    const request = {
      credentials, sessionId: 'session-1', localId: 'fresh-folder-1', rawSession: rawSession(),
      metadata: { ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } },
      approvedNewDirectoryCreation: true,
    };
    await expect(requestInactiveSessionResume(request)).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({ approvedNewDirectoryCreation: true });
    callMachineRpc.mockClear();
    const { approvedNewDirectoryCreation: _consent, ...withoutConsent } = request;
    await requestInactiveSessionResume(withoutConsent);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request.approvedNewDirectoryCreation).not.toBe(true);
  });

  it.each(['returned', 'thrown'] as const)('retains requester admission refusal facts from a %s spawn', async transport => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const errorDetail = { kind: 'launch_error', code: 'requester_session_custody_unavailable', message: 'Requester Session custody is unavailable' } as const;
    const refusal = { type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage: errorDetail.message,
      errorDetail, runtimeFailureReason: 'runner_authority_unavailable' } as const;
    if (transport === 'returned') callMachineRpc.mockResolvedValue(refusal);
    else callMachineRpc.mockRejectedValue(Object.assign(new RpcError(refusal.errorMessage, refusal.errorCode), {
      details: { errorDetail, runtimeFailureReason: refusal.runtimeFailureReason },
    }));
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'refused-requester',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toMatchObject({
      ok: false, code: 'resume_failed', spawnErrorCode: 'SPAWN_VALIDATION_FAILED',
      runtimeFailureReason: 'runner_authority_unavailable', errorDetail,
    });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      cause: 'SPAWN_VALIDATION_FAILED', runtimeReason: 'runner_authority_unavailable',
    }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });

  it('omits unknown runtime refusal facts without leaking them into resume diagnostics', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED',
      errorMessage: 'Request refused', runtimeFailureReason: 'private-path-or-credential' });
    const result = await requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'unknown-refusal',
      rawSession: rawSession(), metadata });
    expect(result).not.toHaveProperty('runtimeFailureReason');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-path-or-credential');
  });

  it('preserves plugin_disabled from a launch refusal without polling readiness', async () => {
    callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'SPAWN_FAILED',
      errorMessage: 'Plugin disabled',
      errorDetail: { kind: 'launch_error', code: 'plugin_disabled', message: 'Plugin disabled' } });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'disabled-agent',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toMatchObject({ ok: false, code: 'plugin_disabled' });
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });

  it.each(['returned', 'thrown'] as const)('retains the credential refusal and remedy from a %s spawn without waiting for readiness', async transport => {
    const refusal = buildConnectedServiceCredentialSpawnErrorResult({ agentId: 'codex', error: {
      name: 'ConnectedServiceCredentialResolutionError', kind: 'missing_credential',
      serviceId: 'happier.agent.codex/openai-codex', profileId: 'codex3',
    } });
    expect(refusal?.errorDetail).toBeDefined();
    if (transport === 'returned') callMachineRpc.mockResolvedValue(refusal);
    else callMachineRpc.mockRejectedValue(Object.assign(new RpcError('Validation refused', 'SPAWN_VALIDATION_FAILED'), {
      details: { errorDetail: refusal?.errorDetail },
    }));
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'reconnect-agent',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toMatchObject({
      ok: false, code: 'resume_failed', errorDetail: refusal?.errorDetail,
    });
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
  });

  it('preserves the missing-directory recovery outcome', async () => {
    callMachineRpc.mockResolvedValue({ type: 'error', errorCode: 'SESSION_DIRECTORY_MISSING', errorMessage: 'Missing folder' });
    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(),
      metadata: { ...metadata, sessionDirectoryV1: { v: 1, kind: 'managed' } },
    })).resolves.toMatchObject({ ok: false, code: 'SESSION_DIRECTORY_MISSING' });
  });

  afterEach(() => {
    callMachineRpc.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('accepts the canonical resume success response while sending identity-only execution authorization', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
      executionAuthority: 'present_user',
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-1',
      request: expect.objectContaining({
        type: 'resume-session',
        sessionId: 'session-1',
        executionAuthorization: { provenance: 'user_request', requestId: 'local-1' },
      }),
    }));
    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('spawnNonce');
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('agentRuntimeDescriptorV1');
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).not.toHaveProperty('codexBackendMode');
  });

  it('carries immutable launch profile and Saved Secret references through the resume RPC', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success' });
    const persisted = metadataWithLaunchCorrespondence();

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: persisted.metadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        sessionCreationTag: persisted.correspondence.sessionCreationTag,
        sessionCreationCorrespondence: persisted.correspondence,
        profileId: 'profile-shared',
        secretReferenceOverlay: persisted.correspondence.recipe.secretReferenceOverlay,
      }),
    }));
  });

  it('refuses an externally linked inactive session before spawn so takeover owns hosted admission', async () => {
    // An externally linked Session's hosted runtime is owned by the External
    // Sessions takeover operation. Automatic resume must not spawn it.
    const linkedMetadata = {
      ...metadata,
      externalSessionV1: {
        v: 1,
        agentId: 'claude',
        machineId: 'machine-1',
        remoteSessionId: 'vendor-session-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
        linkedAtMs: 1_000,
      },
    };

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata: linkedMetadata,
    })).resolves.toMatchObject({ ok: false, code: 'takeover_required' });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('refuses an inactive session whose external link exists but is unresolved instead of spawning it', async () => {
    // A link that cannot be trusted is not absence of a link: fail closed.
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: { ...metadata, externalSessionV1: { v: 1 } },
    })).resolves.toMatchObject({ ok: false, code: 'takeover_required' });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects an archived session before contacting its recorded machine', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ archivedAt: 123 }),
      metadata,
    })).resolves.toEqual({
      ok: false,
      code: 'session_archived',
      message: 'Archived sessions must be unarchived before resume',
    });

    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('accepts an already-running runner without waiting for an unadmitted resume nonce', async () => {
    callMachineRpc.mockImplementation(async ({ method }: { method: string }) => method === RPC_METHODS.SPAWN_HAPPY_SESSION
      ? { type: 'success', sessionId: 'session-1' }
      : { status: 'not_found' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toEqual({ ok: true });
  });

  it.each(['account_automation', 'present_user'] as const)('keeps resume and nonce readiness on the supplied exact Machine transport (%s)', async executionAuthority => {
    vi.useFakeTimers();
    callMachineRpc.mockRejectedValue(new Error('The ordinary replacement-aware route must not observe this admitted startup'));
    let spawnNonce = '';
    const transport = vi.fn<NonNullable<Parameters<typeof requestInactiveSessionResume>[0]['machineRpcTransport']>>(async (method, request) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        if (!request || typeof request !== 'object' || !('spawnNonce' in request) || typeof request.spawnNonce !== 'string') {
          throw new Error('Missing canonical resume creation identity');
        }
        spawnNonce = request.spawnNonce;
        return { type: 'success', sessionId: 'session-1', spawnNonce };
      }
      if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE) {
        expect(request).toMatchObject({ spawnNonce });
        return { status: 'success', sessionId: 'session-1' };
      }
      throw new Error(`Unexpected exact Machine operation: ${method}`);
    });
    const resumed = requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, waitForReady: true, machineRpcTransport: transport, executionAuthority });
    await vi.runAllTimersAsync();
    await expect(resumed).resolves.toEqual({ ok: true });
    expect(transport.mock.calls).toMatchObject([
      [RPC_METHODS.SPAWN_HAPPY_SESSION, expect.objectContaining({ sessionId: 'session-1', spawnNonce }),
        expect.objectContaining({ timeoutMs: resolveSessionStartupTimeoutMs() })],
      [RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE, expect.objectContaining({ spawnNonce }),
        expect.objectContaining({ timeoutMs: null, reattachOnReconnect: { readRequest: expect.any(Function) } })],
    ]);
    for (const [, , options] of transport.mock.calls) {
      if (executionAuthority === 'account_automation') expect(options).toHaveProperty('authorityCeiling', 'account_automation');
      else expect(options).not.toHaveProperty('authorityCeiling');
    }
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('waits for a 1231ms accepted resume to become ready without submitting the resume twice', async () => {
    vi.useFakeTimers();
    vi.stubEnv('HAPPIER_SPAWN_SESSION_ID_RESOLVE_TIMEOUT_MS', '5000');
    callMachineRpc.mockImplementation(async (params: Readonly<{ method: string }>) => {
      if (params.method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        return {
          type: 'success',
          sessionId: 'session-1',
          spawnNonce: 'spawn-nonce-1',
        };
      }
      if (
        params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE
        || params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1231));
        return { status: 'success', sessionId: 'session-1' };
      }
      throw new Error(`Unexpected machine RPC method: ${params.method}`);
    });
    let settled = false;
    const input = {
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata,
      waitForReady: true,
    } as const;

    const result = requestInactiveSessionResume(input).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1230);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(20);

    await expect(result).resolves.toEqual({ ok: true });
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.SPAWN_HAPPY_SESSION)).toHaveLength(1);
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE)).toHaveLength(1);
    expect(callMachineRpc.mock.calls.filter(([params]) => params.method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE)).toHaveLength(0);
    expect(callMachineRpc.mock.calls[0]?.[0]?.request).toMatchObject({
      spawnNonce: expect.stringMatching(/^inactive-session\.resume:/u),
    });
  });

  it('fails closed on conflicting machine identity without issuing a resume', async () => {
    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession({ machineId: 'machine-other' }),
      metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).not.toHaveBeenCalled();
  });

  it('rejects a success response that explicitly names a different session', async () => {
    callMachineRpc.mockResolvedValue({ type: 'success', sessionId: 'session-other' });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
  });

  it('reports a machine that failed the resume as a failure, not as an unsupported capability', async () => {
    // The observed defect: a filesystem error from the machine's own resume
    // work came back as `unsupported`, which reads as "this Session can never
    // be resumed" and shapes the recovery the caller offers. The machine tried
    // and failed; retrying it is exactly the right next move.
    callMachineRpc.mockResolvedValue({
      type: 'error',
      errorMessage: "Connected services resolution failed: ENOTEMPTY: directory not empty, rmdir '/tmp/cs'",
    });

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('reports a machine that threw during the resume as a failure, not as an unsupported capability', async () => {
    callMachineRpc.mockRejectedValue(new Error('socket closed'));

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
  });

  it('uses one current-only Provider-safe RPC so an older daemon refuses inactive wake before side effects', async () => {
    // A daemon that does not carry the method at all IS a capability statement,
    // and it is the only failure here that is.
    callMachineRpc.mockRejectedValueOnce(new RpcError('method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
    expect(callMachineRpc).not.toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION,
    }));
  });

  it.each(['account', 'team'] as const)('uses the Provider-safe RPC for an incoming V2 %s model source', async (source) => {
    callMachineRpc.mockRejectedValueOnce(new RpcError('method not available', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE));
    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
      incomingOptions: { modelSelection: { v: 2, updatedAt: 300, ref: source === 'account' ? {
        source: 'account_provider_connection', agentTargetKey: 'agent:happier.agent.claude/claude',
        modelId: 'model-a', providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
      } : {
        source: 'team_resource', agentTargetKey: 'agent:happier.agent.claude/claude',
        modelId: 'model-a', resourceId: 'shared-model', teamId: 'team-1', expectedResourceRevision: 4,
        deliveryMode: 'brokered',
      } } },
    })).resolves.toMatchObject({ ok: false, code: 'unsupported' });
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({ method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE }));
  });

  it('wakes a Provider-bound inactive session through the atomic Provider-safe RPC', async () => {
    callMachineRpc.mockResolvedValueOnce({ type: 'success' });

    await expect(requestInactiveSessionResume({
      credentials,
      sessionId: 'session-1',
      localId: 'local-1',
      rawSession: rawSession(),
      metadata: providerMetadata,
    })).resolves.toEqual({ ok: true });

    expect(callMachineRpc).toHaveBeenCalledTimes(1);
    expect(callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      method: RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    }));
  });

  it.each(['returned', 'thrown'] as const)('preserves a typed Machine access refusal (%s)', async transport => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    if (transport === 'returned') callMachineRpc.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Forbidden' });
    else callMachineRpc.mockRejectedValueOnce(new RpcError('Forbidden', RPC_ERROR_CODES.FORBIDDEN));
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'authority_unavailable' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cause: RPC_ERROR_CODES.FORBIDDEN, outcomeCode: 'authority_unavailable',
    }));
  });

  it('retains custody when resume times out', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'MACHINE_RPC_TIMEOUT' }));

    await expect(requestInactiveSessionResume({
      credentials, sessionId: 'session-1', localId: 'local-1', rawSession: rawSession(), metadata,
    })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      requestId: 'local-1', sessionId: 'session-1', machineId: 'machine-1',
      phase: 'spawn_rpc', cause: 'MACHINE_RPC_TIMEOUT', outcomeCode: 'timeout',
      spawnRpcRequestId: callMachineRpc.mock.calls[0]?.[0]?.requestId,
      transport: 'machine_rpc',
      elapsedMs: expect.any(Number), cancelled: false,
    }));
  });

  it('distinguishes an accepted launch readiness timeout from the initial RPC timeout', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockResolvedValueOnce({ type: 'success', spawnNonce: 'accepted-launch' });
    callMachineRpc.mockResolvedValueOnce({ status: 'error', errorCode: 'SESSION_WEBHOOK_TIMEOUT', errorMessage: 'private native detail' });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, waitForReady: true })).resolves.toMatchObject({ ok: false, code: 'timeout' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'nonce_readiness', cause: 'SESSION_WEBHOOK_TIMEOUT', outcomeCode: 'timeout',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private native detail');
  });

  it('does not log arbitrary transport codes or error prose in readiness diagnostics', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    callMachineRpc.mockRejectedValue(Object.assign(new Error('private transport detail'), { code: 'private-code' }));
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cause: 'unclassified', outcomeCode: 'resume_failed',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private transport detail|private-code|account-token/);
  });

  it('logs only closed spawn refusal reasons in the existing readiness diagnostic', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    for (const [errorMessage, spawnRefusalReason] of [
      ['team_credential_provider_selection_not_current', 'team_credential_provider_selection_not_current'],
      ['provider_connection_changed', 'provider_connection_changed'],
      ['broker_unavailable', 'broker_unavailable'],
      ['private_native_refusal', 'unknown'],
      ['team_credential_provider_selection_not_current\nprivate credential detail', 'unknown'],
      ['private credential detail at /private/workspace', 'unknown'],
    ]) {
      diagnostic.mockClear();
      callMachineRpc.mockResolvedValueOnce({ type: 'error', errorCode: 'SPAWN_VALIDATION_FAILED', errorMessage });
      await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
        rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
      expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
        phase: 'spawn_rpc', cause: 'SPAWN_VALIDATION_FAILED', outcomeCode: 'resume_failed', spawnRefusalReason,
      }));
      expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/private_native_refusal|private credential detail|account-token/);
    }
  });

  it('reports the typed post-admission daemon refusal without logging private prose', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const errorDetail = { kind: 'launch_error', code: 'session_startup_observation_unavailable',
      message: 'Session startup cannot be observed' };
    callMachineRpc.mockResolvedValueOnce({ type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE',
      errorMessage: 'private native detail', errorDetail });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'resume_failed', errorDetail });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cause: 'DAEMON_RPC_UNAVAILABLE', outcomeCode: 'resume_failed',
      spawnRefusalReason: 'session_startup_observation_unavailable',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private native detail');
  });

  it.each(['DAEMON_RPC_UNAVAILABLE', 'SPAWN_VALIDATION_FAILED'] as const)('keeps the named requester custody cause through %s', async errorCode => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const cause = 'requester_session_custody_record_read_failed';
    const errorDetail = { kind: 'launch_error', code: 'requester_session_custody_unavailable',
      message: 'Requester Session custody unavailable', failureCause: { phase: 'client_start', failureReason: 'unknown', code: cause } };
    callMachineRpc.mockResolvedValueOnce({ type: 'error', errorCode, errorMessage: 'private file error', errorDetail });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata })).resolves.toMatchObject({ ok: false, code: 'resume_failed',
        spawnErrorCode: errorCode, spawnRefusalReason: cause, errorDetail });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      cause: errorCode, spawnRefusalReason: cause,
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private file error');
  });

  it('identifies caller cancellation without logging the abort reason', async () => {
    const diagnostic = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const cancellation = new AbortController();
    callMachineRpc.mockImplementationOnce(async () => {
      cancellation.abort(new Error('private abort reason'));
      throw cancellation.signal.reason;
    });
    await expect(requestInactiveSessionResume({ credentials, sessionId: 'session-1', localId: 'local-1',
      rawSession: rawSession(), metadata, signal: cancellation.signal })).resolves.toMatchObject({ ok: false, code: 'resume_failed' });
    expect(diagnostic).toHaveBeenCalledWith('[SessionResume] Readiness refused', expect.objectContaining({
      phase: 'spawn_rpc', cancelled: true, cause: 'unclassified', outcomeCode: 'resume_failed',
    }));
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private abort reason');
  });
});
