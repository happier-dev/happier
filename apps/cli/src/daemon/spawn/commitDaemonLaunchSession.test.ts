import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionInitialAccessServerError } from '@/api/session/sessionCreationInitialAccess';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { SessionInitialTriggerAdmissionV1Schema, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol';

// Network boundary only: the Session row read, the Account currentness read and
// the archive mutation are HTTP calls. Attach-context building stays real.
const network = vi.hoisted(() => ({
  fetchSessionByIdCompat: vi.fn(),
  fetchAccountEncryptionCurrentness: vi.fn(),
  setSessionArchivedStateById: vi.fn(),
}));
vi.mock('@/session/transport/http/sessionsHttp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>()),
  fetchSessionByIdCompat: network.fetchSessionByIdCompat,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>()),
  fetchAccountEncryptionCurrentness: network.fetchAccountEncryptionCurrentness,
}));
vi.mock('@/session/services/sessionArchivedStateById', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/session/services/sessionArchivedStateById')>()),
  setSessionArchivedStateById: network.setSessionArchivedStateById,
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
  reportsTo: { sessionId: 'lead-1' },
  mcpSelection: { v: 1, managedServersEnabled: true, forceIncludeServerIds: ['docs'], forceExcludeServerIds: [] },
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
  beforeEach(() => {
    network.fetchSessionByIdCompat.mockReset();
    network.fetchAccountEncryptionCurrentness.mockReset().mockResolvedValue({
      mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
    });
    network.setSessionArchivedStateById.mockReset().mockResolvedValue({ archivedAt: 1 });
  });

  it('commits launches needing host creation proof or directly delivered Team material', () => {
    expect(daemonLaunchRequiresCommittedSession(directTeamOptions)).toBe(true);
    expect(daemonLaunchRequiresCommittedSession({
      ...directTeamOptions,
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
      leadSessionId: 'lead-1', sameAccount: false,
      roles: { builder: { roleId: 'builder', name: 'Builder', instructions: 'Build carefully',
        engine: { agentTargetKey: 'agent:codex' }, runsAs: { kind: 'session' },
        workspaceWrites: 'allow', secondOpinion: 'off', enabled: true } },
    });
    expect(daemonLaunchRequiresCommittedSession({ directory: '/repo', initialSessionRolesV1 })).toBe(true);
  });

  it('commits initial triggers at birth and consumes them before the runner attaches', async () => {
    const initialTriggers = [SessionInitialTriggerAdmissionV1Schema.parse({
      automationId: 'automation-initial', name: 'Prepare workspace', enabled: true,
      workflowDefinitionId: 'builtin:review-and-converge',
      assignments: [{ machineId: 'machine-1', enabled: true }],
      executionRecipe: { v: 2, templateVersion: 0, triggerEvidence: null,
        workflow: { t: 'plain', v: { workspace: { directory: '/repo' }, executionTarget: { kind: 'session' } } } },
      triggers: [{ triggerId: 'trigger-initial', trigger: { kind: 'sessionLifecycle', enabled: true,
        events: ['sessionStarted'], policy: { kind: 'firstMatch' } } }],
    })];
    const options = { directory: '/repo', initialTriggers };
    expect(daemonLaunchRequiresCommittedSession(options)).toBe(true);
    const getOrCreateSession = vi.fn(async (input: { metadata: Record<string, unknown> }) => ({
      id: 'session-initial-trigger', metadata: input.metadata,
      sessionCreationOutcome: { disposition: 'created' as const, organizationPlacement: { folderId: null, tagIds: [] } },
    }));
    network.fetchSessionByIdCompat.mockImplementation(async () =>
      plainSessionRow('session-initial-trigger', getOrCreateSession.mock.calls[0]![0].metadata));
    const committed = await commitDaemonLaunchSession({ api: { getOrCreateSession } as never, credentials, options, directory: '/repo' });
    expect(committed.ok).toBe(true);
    expect(getOrCreateSession.mock.calls[0]![0]).toMatchObject({ initialTriggers });
    expect(getOrCreateSession.mock.calls[0]![0].metadata).not.toHaveProperty('summary');
    if (!committed.ok) return;
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('initialTriggers');
    expect(committed.session.attachPayload).not.toHaveProperty('initialTriggers');
  });

  it('creates the Session with its Team slot binding before launch, then continues as an attach to it', async () => {
    const initialSessionRolesV1 = { ...snapshotSessionRolesAtSpawnV1({
      leadSessionId: 'lead-1', sameAccount: true, notes: 'Keep notes', memoryDocRef: { kind: 'doc', artifactId: 'memory' },
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
      creationAuthorizationToken: 'signed-proof',
      teamCredentialBindings: [teamSlotBinding],
      primaryTeamId: 'team-1',
      reportsTo: { sessionId: 'lead-1' },
    });
    // Intents an attaching runner never takes from its own process are
    // seeded by the creator.
    expect(createInput.metadata).toMatchObject({
      path: '/repo',
      mcpSelectionV1: { v: 1, forceIncludeServerIds: ['docs'] },
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
      options: { attachMetadataIdentityPolicy: 'replace_with_runtime_identity' },
    });
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('teamCredentialBindings');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('creationAuthorization');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('primaryTeamId');
    expect(withoutFreshSessionCreationFields(committed.session.options)).not.toHaveProperty('reportsTo');
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
        options: { connectedServiceMaterializationIdentityV1: persistedIdentity },
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

  it('archives a Session it created when the launch cannot attach to it', async () => {
    const getOrCreateSession = vi.fn(async () => ({
      id: 'session-unattachable',
      metadata: { path: '/repo', host: 'h' },
      sessionCreationOutcome: {
        disposition: 'created' as const,
        organizationPlacement: { folderId: null, tagIds: [] },
      },
    }));
    network.fetchSessionByIdCompat.mockResolvedValue(null);

    await expect(commitDaemonLaunchSession({
      api: { getOrCreateSession } as never,
      credentials,
      options: directTeamOptions,
      directory: '/repo',
    })).resolves.toMatchObject({ ok: false, result: { type: 'error' } });
    expect(network.setSessionArchivedStateById).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-unattachable',
      archived: true,
    }));
  });
});
