import { buildSessionCreationCorrespondence } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createSessionOwnerMetadataV1,
  projectSessionSharedMetadataV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { captureSessionLaunchControlMetadata, createSessionMetadata } from '@/agent/runtime/createSessionMetadata';
import { HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY } from '@/agent/runtime/sessionConnectedServicesBindingsEnv';
import { HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY } from '@/agent/runtime/sessionConnectedServiceMaterializationIdentityEnv';
import { buildInactiveSessionResumeSpawnOptions } from '@/daemon/sessions/runtimeSnapshot/buildInactiveSessionResumeSpawnOptions';
import { buildMachineResumeRequest } from '@/session/services/requestInactiveSessionResume';
import { validateEnvVarRecordStrict } from '@/terminal/runtime/envVarSanitization';
import { prepareExecuteSpawnSessionRequest } from './prepareExecuteSpawnSessionRequest';

// Only Home HTTP reads are replaced. Creation, metadata envelopes, resume
// projection, Agent catalog, and daemon admission use their real owners.
const network = vi.hoisted(() => ({ fetchSessionByIdCompat: vi.fn(), fetchAccountEncryptionCurrentness: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionByIdCompat: network.fetchSessionByIdCompat,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(),
  fetchAccountEncryptionCurrentness: network.fetchAccountEncryptionCurrentness,
}));

describe('connected-account session creation → inactive resume admission', () => {
  beforeEach(() => {
    network.fetchSessionByIdCompat.mockReset();
    network.fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
  });

  it('restores the admitted guest target on a sparse inactive resume', async () => {
    const inPlaceWorkspace = { v: 2 as const, kind: 'managed' as const, serverId: 'home', workspaceId: 'guest-ref',
      managedId: 'guest', rootPath: '/guest/project', controller: { machineId: 'machine-connected', installationId: 'install' } };
    const correspondence = buildSessionCreationCorrespondence({
      identity: { callerCreationNamespace: 'user', creationKey: 'managed-project' },
      recipe: { execution: { machineId: 'machine-connected', directory: { kind: 'managed' } },
        organization: { folderId: null, tagIds: [] }, inPlaceWorkspace,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    });
    const { metadata } = createSessionMetadata({
      flavor: 'codex', machineId: 'machine-connected', directory: '/controller/session-scratch', startedBy: 'daemon',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
    });
    const currentMetadata = { ...metadata, sessionCreationCorrespondenceV1: correspondence };
    const owner = createSessionOwnerMetadataV1({ metadata: currentMetadata });
    if (!owner.ok) throw new Error('Invalid resume fixture metadata');
    network.fetchSessionByIdCompat.mockResolvedValue({ id: 'in-place-resume', active: false, seq: 1, encryptionMode: 'plain',
      metadataVersion: 1, agentStateVersion: 0, agentState: null, dataEncryptionKey: null, metadataLayoutVersion: 1,
      metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: currentMetadata })),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
    });
    expect(await prepareExecuteSpawnSessionRequest({
      request: { credentials: { token: 'synthetic-owner', encryption: null }, options: {
        directory: '/controller/session-scratch', existingSessionId: 'in-place-resume',
      } }, validateEnvVarRecordStrict,
    })).toMatchObject({ directory: '/controller/session-scratch', directoryKind: 'managed',
      managedTargetPlacement: { managedId: 'guest', workspaceRoot: '/guest/project' },
    });
  });

  it.each(['flat', 'owner'] as const)('restores the accepted Team binding and current person permission on sparse %s resume and stale recovery', async layout => {
    const agentTargetKey = 'agent:happier.agent.codex/codex';
    const acceptedTeamCredentialBinding = { v: 1 as const, slot: { kind: 'provider_model' as const },
      resourceId: 'team-pool', expectedResourceRevision: 2, deliveryMode: 'brokered' as const, teamId: 'team-1' };
    const { metadata } = createSessionMetadata({
      flavor: 'codex', machineId: 'machine-connected', directory: '/project', startedBy: 'daemon',
      runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} },
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {} }),
      permissionMode: 'read-only', permissionModeUpdatedAt: 200,
      modelSelectionIntent: { v: 1, updatedAt: 100,
        selection: { agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.6-luna' } },
    });
    const row = (currentMetadata: typeof metadata) => {
      const owner = createSessionOwnerMetadataV1({ metadata: currentMetadata });
      if (!owner.ok) throw new Error('Invalid resume fixture metadata');
      return { id: 'session-team-resume', seq: 1, active: false, encryptionMode: 'plain',
        metadataVersion: 1, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
        acceptedTeamCredentialBinding,
        ...(layout === 'owner' ? { metadataLayoutVersion: 1,
          metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata: currentMetadata })),
          ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
        } : { metadata: JSON.stringify(currentMetadata) }) };
    };
    network.fetchSessionByIdCompat.mockResolvedValue(row(metadata));
    const resume = (controls = {}) => prepareExecuteSpawnSessionRequest({
      request: { credentials: { token: 'synthetic-owner', encryption: null }, options: {
        directory: '/project', existingSessionId: 'session-team-resume', ...controls,
      } }, validateEnvVarRecordStrict,
    });
    const first = await resume();
    expect(first).toMatchObject({ normalizedExistingSessionId: 'session-team-resume',
      permissionMode: 'read-only', permissionModeUpdatedAt: 200,
      modelSelection: { v: 1, updatedAt: 100, ref: { agentTargetKey, providerConnectionId: null, modelId: 'gpt-5.6-luna' } },
      teamCredentialBindings: [acceptedTeamCredentialBinding] });
    // A later person choice must also beat an automatic child using the prior
    // launch's permission; runtime publication retains this original timestamp.
    network.fetchSessionByIdCompat.mockResolvedValue(row({ ...metadata, permissionMode: 'yolo', permissionModeUpdatedAt: 300 }));
    expect(await resume({ permissionMode: 'read-only', permissionModeUpdatedAt: 200 })).toMatchObject({
      permissionMode: 'yolo', permissionModeUpdatedAt: 300,
      teamCredentialBindings: [acceptedTeamCredentialBinding],
    });
    // An explicit new choice still wins. This is not a blanket persisted-wins rule.
    expect(await resume({ permissionMode: 'read-only', permissionModeUpdatedAt: 400 })).toMatchObject({
      permissionMode: 'read-only', permissionModeUpdatedAt: 400,
    });
    network.fetchSessionByIdCompat.mockResolvedValue({ ...row(metadata), acceptedTeamCredentialBinding: null });
    expect(await resume()).not.toHaveProperty('teamCredentialBindings');
  });

  it.each([
    ['claude', 'happier.agent.claude/claude-subscription', 'flat', false],
    ['claude', 'happier.agent.claude/claude-subscription', 'owner', false],
    ['codex', 'happier.agent.codex/openai-codex', 'flat', false],
    ['codex', 'happier.agent.codex/openai-codex', 'owner', false],
    ['claude', 'happier.agent.claude/claude-subscription', 'owner', true],
    ['codex', 'happier.agent.codex/openai-codex', 'owner', true],
  ] as const)('restores %s account %s before its first provider turn (layout=%s, sparse request=%s)', async (agentId, serviceKey, layout, sparse) => {
    const connectedServices = { v: 2, bindingsByServiceId: {
      [serviceKey]: { source: 'connected', selection: 'profile', profileId: 'work-account' },
    } };
    const identity = { v: 1, id: 'csm_first_connected_launch', createdAt: 123, source: 'first_spawn' };
    const { metadata } = createSessionMetadata({
      flavor: agentId, machineId: 'machine-connected', directory: '/project', startedBy: 'daemon',
      runtimeDescriptorV1: { v: 1, agentId, agent: {} },
      launchControlMetadata: captureSessionLaunchControlMetadata({ processEnvironment: {
        [HAPPIER_SESSION_CONNECTED_SERVICES_BINDINGS_ENV_KEY]: JSON.stringify(connectedServices),
        [HAPPIER_SESSION_CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_ENV_KEY]: JSON.stringify(identity),
      } }),
    });
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error(`Invalid creation metadata: ${owner.unsupportedFields.join(',')}`);
    const row = {
      id: 'session-connected', seq: 1, active: false, encryptionMode: 'plain',
      metadataVersion: 1, agentStateVersion: 0, agentState: null, dataEncryptionKey: null,
      ...(layout === 'owner' ? {
        metadataLayoutVersion: 1,
        metadata: JSON.stringify(projectSessionSharedMetadataV1({ metadata })),
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
      } : { metadata: JSON.stringify(metadata) }),
    };
    network.fetchSessionByIdCompat.mockResolvedValue(row);

    const clientOptions = buildInactiveSessionResumeSpawnOptions({ sessionId: row.id, rawSession: row, metadata });
    expect(clientOptions).not.toBeNull();
    if (!clientOptions) return;
    const request = buildMachineResumeRequest(clientOptions, row.id);
    const prepared = await prepareExecuteSpawnSessionRequest({
      request: { credentials: { token: 'synthetic-owner', encryption: null }, options: {
        directory: request.directory, existingSessionId: request.sessionId,
        backendTarget: request.backendTarget, agentTarget: request.agentTarget,
        ...(sparse ? {} : { connectedServices: request.connectedServices }),
        runtimeDescriptorV1: request.runtimeDescriptorV1,
      } },
      validateEnvVarRecordStrict,
    });
    expect(prepared).toMatchObject({
      normalizedExistingSessionId: row.id, effectiveResume: '',
      connectedServices: metadata.connectedServices,
      connectedServiceMaterializationIdentityV1: identity,
    });
  });
});
