import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

import { SessionInitialAccessServerError } from '@/api/session/sessionCreationInitialAccess';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { deriveSessionCreationTagV1, SessionCreationCorrespondenceV1Schema, SessionInitialTriggerAdmissionV1Schema, snapshotSessionRolesAtSpawnV1, readSessionWorkspaceWritesV1 } from '@happier-dev/protocol';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { bootstrapAccountSettingsContext } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';

// The Session row and Account currentness/settings reads are HTTP boundaries.
// Settings bootstrap and attach-context building stay real.
const network = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionByIdCompat: network.fetchSessionByIdCompat,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>()),
  fetchAccountEncryptionCurrentness: network.fetchAccountEncryptionCurrentness,
}));

import {
  commitDaemonLaunchSession,
  daemonLaunchRequiresCommittedSession,
  withoutFreshSessionCreationFields,
} from './commitDaemonLaunchSession';

const credentials = { token: 'token-1', encryption: null } as const;
const purpose = { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' };
const disclosedMember = { service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, accountId: 'source-member' };
const teamSlotBinding = {
  v: 1 as const,
  slot: { kind: 'connected_service_purpose' as const, purpose },
  resourceId: 'resource-1',
  expectedResourceRevision: 3,
  deliveryMode: 'direct' as const,
  teamId: 'team-1',
};
const directTeamOptions: SpawnSessionOptions = {
  directory: '/repo',
  spawnNonce: 'nonce-1',
  connectedServices: {
    v: 2,
    bindingsByServiceId: {
      'happier.agent.codex/openai-codex': {
        source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'direct', disclosedMember,
      },
    },
  },
  teamCredentialBindings: [teamSlotBinding],
  primaryTeamId: 'team-1',
  manager: { sessionId: 'lead-1' },
  capabilitySelection: {
    mcp: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['docs'], forceExcludeServerIds: [] },
    skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: ['native-review'] },
  },
} as SpawnSessionOptions;

function plainSessionRow(id: string, metadata: Record<string, unknown>) {
  return {
    id,
    seq: 0,
    encryptionMode: 'plain',
    metadata: JSON.stringify(metadata),
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 0,
    dataEncryptionKey: null,
  };
}

describe('commitDaemonLaunchSession', () => {
  it('requires the canonical Session before a managed Connected Account endpoint acquires its consumer', () => {
    const options = { directory: '/repo' };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(false);
    expect(daemonLaunchRequiresCommittedSession(options, { requiresSessionConsumer: true })).toBe(true);
  });
  it('offers committed progress after authenticated attach and before physical launch completion', async () => {
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
      resolveAccountId: async () => 'account', generateOperationId: () => 'commit-operation' });
    const input = { creationKey: 'commit-once', observeSessionCommit: true, executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path' as const, path: '/repo' }, agentTarget: { kind: 'agent' as const,
        identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    let releaseAttach!: () => void;
    const attaching = new Promise<void>(resolve => { releaseAttach = resolve; });
    let releaseNative!: () => void;
    const native = new Promise<void>(resolve => { releaseNative = resolve; });
    const getOrCreateSession = vi.fn(async (request: { metadata: Record<string, unknown> }) => ({
      id: 'session-committed', metadata: request.metadata,
      sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () => {
      await attaching;
      return plainSessionRow('session-committed', getOrCreateSession.mock.calls[0]![0].metadata);
    });
    let offered: unknown;
    let admissions = 0;
    const observed = operations.observeExecution({ actionId: 'session.spawn_new', input, execute: async operation => {
      // This is the Home create transport; commit, authenticated attach,
      // acceptance and retained operation observation all use their real owners.
      const result = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials,
        directory: '/repo', accountSettings: {}, options: { directory: '/repo', projectSetupOperation: operation } });
      if (!result.ok) throw new Error('Fixture commit refused');
      await native;
      admissions += 1;
      return { ok: true, result: { type: 'success', disposition: 'created', sessionId: result.session.sessionId,
        executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'accepted', localId: 'original-input' } } };
    } }).then(value => { offered = value; return value; });
    try {
      await vi.waitFor(() => expect(getOrCreateSession).toHaveBeenCalledTimes(1));
      expect(offered).toBeUndefined();
      releaseAttach();
      await vi.waitFor(() => expect(offered).toMatchObject({ ok: true, result: { type: 'pending', outcome: 'accepted',
        sessionId: 'session-committed' } }));
      expect(admissions).toBe(0);
      const { observeSessionCommit: _observer, ...terminalInput } = input;
      const terminal = operations.observeExecution({ actionId: 'session.spawn_new', input: terminalInput,
        execute: async () => { throw new Error('The held startup must not execute twice'); } });
      releaseNative();
      await expect(terminal).resolves.toMatchObject({ ok: true, result: { type: 'success',
        initialInput: { status: 'accepted', localId: 'original-input' } } });
      expect(admissions).toBe(1);
    } finally { releaseAttach(); releaseNative(); await observed; }
  });
  it('commits a brokered Provider-model slot and carries only the Home witness through attach', async () => {
    const binding = { v: 1 as const, slot: { kind: 'provider_model' as const }, resourceId: 'accepted-resource',
      expectedResourceRevision: 3, deliveryMode: 'brokered' as const, teamId: 'team-1' };
    const options = { directory: '/repo', teamCredentialBindings: [binding] };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(true);
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-brokered', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'rejoined' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () => ({
      ...plainSessionRow('session-brokered', getOrCreateSession.mock.calls[0]![0].metadata),
      acceptedTeamCredentialBinding: { ...binding, resourceId: 'original-resource' },
    }));
    const result = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials,
      directory: '/repo', options, accountSettings: {} });
    expect(result).toMatchObject({ ok: true, session: { created: false, attachPayload: { snapshot: {
      acceptedTeamCredentialBinding: { ...binding, resourceId: 'original-resource' },
    } } } });
    if (result.ok) expect(withoutFreshSessionCreationFields(result.session.options)).not.toHaveProperty('teamCredentialBindings');
  });
  it('refuses a Team model launch when the Home supplies no accepted inference witness', async () => {
    const operations = createHostActionOperationRuntime({ serverId: 'home', machineId: 'machine',
      resolveAccountId: async () => 'account' });
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-no-witness', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'rejoined' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () => plainSessionRow('session-no-witness', getOrCreateSession.mock.calls[0]![0].metadata));
    const result = await operations.observeExecution({ actionId: 'session.spawn_new', input: {
      creationKey: 'unaccepted-team-model', observeSessionCommit: true, executionTarget: { serverId: 'home', machineId: 'machine' },
      directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    }, execute: async operation => {
      const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials, directory: '/repo', accountSettings: {},
        options: { directory: '/repo', projectSetupOperation: operation, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: 'unaccepted',
          expectedResourceRevision: 1, deliveryMode: 'brokered', teamId: 'team-1' }] } });
      if (committed.ok) throw new Error('Unaccepted Team model must refuse before progress');
      return { ok: false, errorCode: committed.result.errorCode ?? 'spawn_failed', error: committed.result.errorMessage };
    } });
    expect(result).toMatchObject({ ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED });
  });
  it('requires server birth admission for Discussion participants before a native runner is started', () => {
    const discussionParticipant = { discussionId: 'discussion', participantSlotId: 'slot' };
    const discussionParticipantLaunch = { executionTarget: { serverId: 'home', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo', originKind: 'discussion',
      discussionParticipant, discussionParticipantLaunch })).toBe(true);
    const sessionCreationTag = deriveSessionCreationTagV1({ callerCreationNamespace: 'discussion', creationKey: 'slot' });
    const sessionCreationCorrespondence = SessionCreationCorrespondenceV1Schema.parse({ v: 1, sessionCreationTag,
      recipe: { execution: { machineId: 'machine-1', directory: { kind: 'path', path: '/repo' } },
        organization: { folderId: null, tagIds: [] },
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
        discussionParticipant: { discussionId: 'discussion', participantSlotId: 'slot' }, modelSelection: null, profileId: null,
        requestedPermissionMode: null, agentModeId: null, configuration: null, connectedServices: null,
        capabilitySelection: null, transcriptStorage: null, terminal: null, agentSessionStartupInstructionsMarkerV1: null, checkout: null },
    });
    const correspondenceOnly = { directory: '/repo', sessionCreationTag, sessionCreationCorrespondence };
    expect(() => daemonLaunchRequiresCommittedSession(correspondenceOnly)).toThrow();
    expect(daemonLaunchRequiresCommittedSession({ ...correspondenceOnly, originKind: 'discussion',
      discussionParticipant, discussionParticipantLaunch })).toBe(true);
    expect(daemonLaunchRequiresCommittedSession({ ...correspondenceOnly, existingSessionId: 'session-existing' })).toBe(false);
  });
  it('commits an authored workspace ceiling before native admission and retains it on attach', async () => {
    const options = { directory: '/repo', workspaceWrites: 'deny' as const };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(true);
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-workspace-policy', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () =>
      plainSessionRow('session-workspace-policy', getOrCreateSession.mock.calls[0]![0].metadata));
    const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials, options, directory: '/repo' });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(readSessionWorkspaceWritesV1(getOrCreateSession.mock.calls[0]![0].metadata)).toBe('deny');
    expect(committed.session.attachPayload).toMatchObject({ snapshot: { metadata: { workspaceWrites: 'deny' } } });
  });
  it('commits selection-bearing launches before child startup so selections travel through metadata', () => {
    const capabilitySelection = {
      skills: { v: 1 as const, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    };
    expect(daemonLaunchRequiresCommittedSession({ directory: '/workspace', capabilitySelection })).toBe(true);
  });
  beforeEach(async () => {
    network.fetchSessionByIdCompat.mockReset();
    network.fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    const settingsResponse = AccountSettingsV2GetResponseSchema.parse({
      content: { t: 'plain', v: {} }, version: 1,
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v2/account/settings') return { status: 200, data: settingsResponse };
      throw new Error(`Unexpected launch fixture Home read: ${path}`);
    });
    resetActiveAccountSettingsSnapshotForTests();
    // Await the real Account settings producer before committing a launch.
    // Fast bootstrap must not leave an unowned HTTP refresh after the test.
    await bootstrapAccountSettingsContext({ credentials, mode: 'blocking', refresh: 'force' });
  });
  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    vi.restoreAllMocks();
  });

  it('commits launches needing host creation proof or directly delivered Team material', () => {
    expect(daemonLaunchRequiresCommittedSession(directTeamOptions)).toBe(true);
    expect(daemonLaunchRequiresCommittedSession({
      ...directTeamOptions,
      capabilitySelection: undefined,
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' },
        },
      },
    } as SpawnSessionOptions)).toBe(false);
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo' })).toBe(false);
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo', creationAuthorization: { token: 'signed-proof' } })).toBe(true);
  });

  it('commits a complete role snapshot before launch instead of transporting role text in the process environment', () => {
    const initialSessionRolesV1 = snapshotSessionRolesAtSpawnV1({
      leadSessionId: 'lead-1',
      roles: { builder: { roleId: 'builder', name: 'Builder', instructions: 'Build carefully',
        engine: { agentTargetKey: 'agent:codex' }, runsAs: { kind: 'session' },
        workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } },
    });
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo', initialSessionRolesV1 })).toBe(true);
  });

  it('commits qualified selected Instructions before the runner and consumes the fresh-only context', async () => {
    const promptStack = [{ id: 'session.instructions',
      ref: { kind: 'doc', serverId: 'guide-home', artifactId: 'guide-doc' },
      enabled: true, required: true, placement: 'system_append' }] as const;
    const options = { directory: '/repo', promptStack };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(true);
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo', promptStack: [] })).toBe(false);
    // This API port is the Home create transport; metadata and attach preparation stay real.
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-instructions', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () =>
      plainSessionRow('session-instructions', getOrCreateSession.mock.calls[0]![0].metadata));
    const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials, options, directory: '/repo' });
    expect(committed.ok).toBe(true);
    expect(getOrCreateSession.mock.calls[0]![0].metadata).toMatchObject({ work: { promptStack } });
    if (!committed.ok) return;
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('promptStack');
    expect(committed.session.attachPayload).not.toHaveProperty('promptStack');
  });

  it.each([true, false])('commits the profile before the runner attaches (with triggers: %s)', async withTriggers => {
    const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
      automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge',
      assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } },
      triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
        events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    })];
    const identity = { bot: { kind: 'bot' as const }, createdAsBot: true as const };
    const options = { directory: '/repo', ...(withTriggers ? { initialTriggers, identity, memoryEnabled: false } : {}), approvalProfileId: 'builtin:read-propose' };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(true);
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-initial-trigger', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () =>
      plainSessionRow('session-initial-trigger', getOrCreateSession.mock.calls[0]![0].metadata));
    const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials, options, directory: '/repo' });
    expect(committed.ok).toBe(true);
    if (withTriggers) expect(getOrCreateSession.mock.calls[0]![0]).toMatchObject({ initialTriggers });
    expect(getOrCreateSession.mock.calls[0]![0].metadata).not.toHaveProperty('summary');
    expect(getOrCreateSession.mock.calls[0]![0].metadata).toMatchObject({
      ...(withTriggers ? { ...identity, work: { memoryEnabled: false } } : {}), approvalProfileId: 'builtin:read-propose' });
    if (!committed.ok) return;
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('initialTriggers');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('identity');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('memoryEnabled');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('approvalProfileId');
    expect(committed.session.attachPayload).not.toHaveProperty('initialTriggers');
  });

  it('creates the Session with its Team slot binding before launch, then continues as an attach to it', async () => {
    const initialSessionRolesV1 = { ...snapshotSessionRolesAtSpawnV1({
      leadSessionId: 'lead-1', notes: 'Keep notes',
      roles: { builder: { roleId: 'builder', name: 'Builder', instructions: 'Resolved instructions',
        engine: { agentTargetKey: 'agent:codex', modelId: 'builder-model' }, runsAs: { kind: 'session' },
        workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } },
    }), roleId: 'builder' };
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-committed',
      metadata: input.metadata,
      sessionCreationOutcome: {
        disposition: 'created' as const,
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () =>
      plainSessionRow('session-committed', getOrCreateSession.mock.calls[0]![0].metadata));

    const committed = await commitDaemonLaunchSession({
      api: { getOrCreateSession } as never,
      credentials,
      options: { ...directTeamOptions, creationAuthorization: { token: 'signed-proof' }, initialSessionRolesV1, initialTitle: '3 · Implement' },
      directory: '/repo',
      agentModeId: 'plan',
      agentModeUpdatedAt: 5,
    });

    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    const createInput = getOrCreateSession.mock.calls[0]![0] as Record<string, unknown> & {
      metadata: Record<string, unknown>;
    };
    // The Home admits the Team binding in the create transaction.
    expect(createInput).toMatchObject({
      creationAuthorization: { token: 'signed-proof' },
      teamCredentialBindings: [teamSlotBinding],
      primaryTeamId: 'team-1',
      manager: { sessionId: 'lead-1' },
    });
    // Intents an attaching runner never takes from its own process are
    // seeded by the creator.
    expect(createInput.metadata).toMatchObject({
      path: '/repo',
      mcpSelectionV1: { v: 1, forceIncludeServerIds: ['docs'] },
      skillSelectionV1: { v: 1, forceIncludeSkillIds: ['lint'], excludeNativeSkillNames: ['native-review'] },
      connectedServiceMaterializationIdentityV1: committed.session.options.connectedServiceMaterializationIdentityV1,
      work: { sessionRolesV1: initialSessionRolesV1 },
      summary: { text: '3 · Implement', updatedAt: expect.any(Number) },
    });
    expect(JSON.stringify(createInput.metadata)).toContain('"plan"');
    expect(committed.session).toMatchObject({
      sessionId: 'session-committed',
      created: true,
      sessionCreationOutcome: { disposition: 'created' },
      attachPayload: { v: 2, encryptionMode: 'plain' },
      options: { existingSessionId: 'session-committed', attachMetadataIdentityPolicy: 'replace_with_runtime_identity' },
    });
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('teamCredentialBindings');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('creationAuthorization');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('primaryTeamId');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('manager');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('initialSessionRolesV1');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('initialTitle');
  });

  it('keeps the identity a rejoined Session already persisted', async () => {
    const persistedIdentity = { v: 1, id: 'csm_persisted_identity_0001', createdAt: 1, source: 'first_spawn' };
    const getOrCreateSession = vi.fn(async () => ({
      id: 'session-rejoined',
      metadata: { path: '/repo', host: 'h', connectedServiceMaterializationIdentityV1: persistedIdentity },
      sessionCreationOutcome: {
        disposition: 'rejoined' as const,
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    }));
    network.fetchSessionByIdCompat.mockResolvedValue(plainSessionRow('session-rejoined', { path: '/repo', host: 'h' }));

    const committed = await commitDaemonLaunchSession({
      api: { getOrCreateSession } as never,
      credentials,
      options: directTeamOptions,
      directory: '/repo',
    });

    expect(committed).toMatchObject({
      ok: true,
      session: {
        created: false,
        options: { existingSessionId: 'session-rejoined', connectedServiceMaterializationIdentityV1: persistedIdentity },
      },
    });
  });

  it('returns the exact creation refusal and creates nothing', async () => {
    const getOrCreateSession = vi.fn(async () => {
      throw new SessionInitialAccessServerError('session_access_forbidden', 403);
    });

    await expect(commitDaemonLaunchSession({
      api: { getOrCreateSession } as never,
      credentials,
      options: directTeamOptions,
      directory: '/repo',
    })).resolves.toMatchObject({
      ok: false,
      result: {
        type: 'error',
        errorCode: 'SPAWN_VALIDATION_FAILED',
        errorDetail: { kind: 'session_creation_access_refused' },
      },
    });
    expect(network.fetchSessionByIdCompat).not.toHaveBeenCalled();
  });

});
