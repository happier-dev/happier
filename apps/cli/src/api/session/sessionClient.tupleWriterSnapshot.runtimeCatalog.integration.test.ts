import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { SessionTeamCredentialBindingMetadataPatchV1Schema } from '@happier-dev/protocol/teams';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, createSessionTranscriptHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import type { StoredCredentials } from '@/persistence';
import { ApiSessionClient } from './sessionClient';
import { createSessionScopedSocketConnection } from './sockets';

// Only the Home HTTP/Socket.IO boundaries are substituted. The tuple writer,
// its CAS conflict refresh and the client's applied versions stay real.
vi.mock('axios');
const { mockIo } = vi.hoisted(() => ({ mockIo: vi.fn() }));
vi.mock('socket.io-client', () => ({ io: mockIo }));

const serverUrl = 'https://tuple-writer.example.test';
const currentFeatures = FeaturesResponseSchema.parse({
  features: { sharing: { pendingQueueV2: { enabled: true } } },
  capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 }, publisherAuthority: { protocolVersion: 1 } } },
});

function createOwnerSession(id: string, accountMode: 'plain' | 'e2ee' = 'plain') {
  const credentials: StoredCredentials = accountMode === 'plain'
    ? { token: 'tok', encryption: null }
    : { token: 'tok', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } };
  const currentness = createAccountEncryptionCurrentnessFixture(accountMode === 'plain' ? {} : {
    mode: 'e2ee',
    contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) } }).contentPublicKeyFingerprint),
  });
  const session = createPlainSessionFixture({ id });
  const tuple = buildSessionMetadataEnvelopeFields({
    credentials, accountEncryptionMode: accountMode,
    metadata: session.metadata, agentState: session.agentState, storedContentMode: 'plain',
  });
  const row = createSessionRecordFixture({
    id, metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext,
    metadataVersion: session.metadataVersion, ownerMetadata: tuple.ownerMetadata,
    agentState: tuple.agentState, agentStateVersion: session.agentStateVersion, encryptionMode: 'plain', share: null,
  });
  return { credentials, currentness, session: { ...session, metadataLayoutVersion: 1 as const,
    ownerMetadata: tuple.ownerMetadataValue, ownerMetadataEnvelope: tuple.ownerMetadata }, row };
}

describe('ApiSessionClient owner tuple writer snapshot', () => {
  const clients: ApiSessionClient[] = [];
  let sessionReads = 0;
  let currentnessReads = 0;
  let publisherChecks = 0;
  let row: ReturnType<typeof createOwnerSession>['row'];

  function serve(currentness = createAccountEncryptionCurrentnessFixture()) {
    vi.mocked(axios.get).mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      if (path === '/v1/auth/ping') return { status: 200, data: {} };
      if (path === '/v1/account/encryption/currentness') {
        currentnessReads += 1;
        return { status: 200, data: currentness };
      }
      if (path === `/v2/sessions/${row.id}`) {
        sessionReads += 1;
        return { status: 200, data: { session: { ...row } } };
      }
      return { status: 404, data: {} };
    });
    // Home CAS: a patch whose expected versions are stale is a conflict.
    vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
      const teamPatch = SessionTeamCredentialBindingMetadataPatchV1Schema.safeParse(body);
      const patch = teamPatch.success ? teamPatch.data : SessionMetadataTuplePatchV1Schema.parse(body);
      if (patch.mode !== 'owner' && patch.mode !== 'owner_team_credential_binding') throw new Error('Expected layout-1 owner tuple patch');
      if (patch.sharedMetadata.expectedVersion !== row.metadataVersion
        || patch.agentState.expectedVersion !== row.agentStateVersion) {
        return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
          sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
      }
      row.metadata = patch.sharedMetadata.ciphertext;
      row.ownerMetadata = patch.ownerMetadata;
      row.metadataVersion += 1;
      row.agentState = patch.agentState.ciphertext;
      row.agentStateVersion = (row.agentStateVersion ?? 0) + 1;
      if (patch.mode === 'owner_team_credential_binding') row.acceptedTeamCredentialBinding =
        patch.teamCredentialBindings.find(binding => binding.slot.kind === 'provider_model') ?? row.acceptedTeamCredentialBinding;
      return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({
        success: true, metadataLayoutVersion: 1, sharedMetadata: { version: row.metadataVersion },
        agentState: { version: row.agentStateVersion },
      }) };
    });
  }

  function createClient(session: ReturnType<typeof createOwnerSession>['session'],
    credentials: StoredCredentials = { token: 'tok', encryption: null }) {
    mockIo.mockImplementation(() => {
      const activity = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1', committedFenceMs: 1_000 });
      const transcript = createSessionTranscriptHomeStub();
      return createApiSessionSocketStub({ emitWithAck: (event, payload) => {
        if (event === 'session-publisher-authority-check') publisherChecks += 1;
        return activity.answer(event, payload) ?? transcript.answer(event, payload) ?? { result: 'success' };
      } });
    });
    const client = new ApiSessionClient('tok', session, {
      localMachineId: 'machine-1',
      metadataAuthority: { kind: 'owner', credentials },
      initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
        sessionId: session.id, agentRuntimeApplicability: 'supported',
      })],
      transport: { serverId: 'tuple-writer-home', serverUrl,
        createSessionSocketTransport: ({ sessionId, machineId }) =>
          createSessionScopedSocketConnection({ token: 'tok', serverUrl, sessionId, machineId }) },
    });
    clients.push(client);
    return client;
  }

  beforeEach(() => {
    sessionReads = 0;
    currentnessReads = 0;
    publisherChecks = 0;
    vi.mocked(axios.get).mockReset();
    vi.mocked(axios.patch).mockReset();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(currentFeatures), { status: 200,
      headers: { 'content-type': 'application/json' } })));
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(client => client.close()));
    vi.unstubAllGlobals();
  });

  it.each(['plain', 'e2ee', 'team'] as const)('writes from its admitted %s Account tuple with one HTTP per change and none for a no-op', async accountMode => {
    const owner = createOwnerSession('tuple-writer-own-commit', accountMode === 'e2ee' ? 'e2ee' : 'plain');
    row = owner.row;
    if (accountMode === 'team') row.acceptedTeamCredentialBinding = {
      v: 1, slot: { kind: 'provider_model' }, resourceId: 'resource-1', expectedResourceRevision: 7, deliveryMode: 'brokered',
    };
    serve(owner.currentness);
    const client = createClient(owner.session, owner.credentials);
    // An approval answer: two sequential Agent-state writes, then a metadata write.
    await client.updateAgentState(state => ({ ...state, controlledByUser: true }));
    const readsAfterFirst = sessionReads;
    await client.updateAgentState(state => ({ ...state, controlledByUser: false }));
    await client.updateMetadata(metadata => ({ ...metadata, path: '/after' }));

    expect({ followUpSessionReads: sessionReads - readsAfterFirst, currentnessReads }).toEqual({
      followUpSessionReads: 0,
      currentnessReads: 1,
    });
    expect(axios.patch).toHaveBeenCalledTimes(3);
    const readsBeforeNoOp = { sessionReads, currentnessReads };
    await client.updateMetadata(metadata => ({ ...metadata }));
    await client.updateAgentState(state => ({ ...state }));
    expect({ sessionReads, currentnessReads }).toEqual(readsBeforeNoOp);
    expect(axios.patch).toHaveBeenCalledTimes(3);
    expect(client.getAgentStateSnapshot()?.controlledByUser).toBe(false);
    expect(client.getMetadataSnapshot()?.path).toBe('/after');
  });

  it('retains the accepted Team binding from its own model-selection commit without re-reading', async () => {
    const owner = createOwnerSession('tuple-writer-team-commit');
    row = owner.row;
    row.acceptedTeamCredentialBinding = { v: 1, slot: { kind: 'provider_model' },
      resourceId: 'resource-1', expectedResourceRevision: 7, deliveryMode: 'brokered' };
    serve();
    const client = createClient(owner.session);
    await client.updateAgentState(state => ({ ...state, controlledByUser: true }));
    const readsAfterAdmission = { sessionReads, currentnessReads };
    await client.updateMetadata(metadata => ({ ...metadata, modelSelectionIntentV1: { v: 1, updatedAt: 10,
      selection: { agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'native-model' } } }));
    let acceptedResourceId: string | null | undefined = 'not-observed';
    await client.updateMetadata((metadata, context) => {
      acceptedResourceId = context?.acceptedTeamCredentialBinding?.resourceId;
      return metadata;
    });
    expect(acceptedResourceId).toBeNull();
    expect({ sessionReads, currentnessReads }).toEqual(readsAfterAdmission);
    expect(axios.patch).toHaveBeenCalledTimes(2);
  });

  it('converges through the Home CAS when another writer committed unobserved', async () => {
    const owner = createOwnerSession('tuple-writer-foreign-commit');
    row = owner.row;
    serve();
    const client = createClient(owner.session);
    await client.updateAgentState(state => ({ ...state, controlledByUser: true }));
    // A foreign writer moves the Home tuple; its socket update has not arrived.
    const foreign = buildSessionMetadataEnvelopeFields({
      credentials: { token: 'tok', encryption: null }, accountEncryptionMode: 'plain',
      metadata: { ...client.getMetadataSnapshot()!, path: '/foreign' },
      agentState: client.getAgentStateSnapshot()!, storedContentMode: 'plain',
    });
    row.metadata = foreign.sharedMetadata.ciphertext;
    row.ownerMetadata = foreign.ownerMetadata;
    row.metadataVersion += 1;

    const beforeConflict = { sessionReads, currentnessReads, patches: vi.mocked(axios.patch).mock.calls.length };
    await client.updateAgentState(state => ({ ...state, controlledByUser: false }));

    expect({ sessionReads: sessionReads - beforeConflict.sessionReads,
      currentnessReads: currentnessReads - beforeConflict.currentnessReads,
      patches: vi.mocked(axios.patch).mock.calls.length - beforeConflict.patches }).toEqual({
      sessionReads: 1, currentnessReads: 1, patches: 2,
    });
    expect(client.getMetadataSnapshot()?.path).toBe('/foreign');
    expect(client.getAgentStateSnapshot()?.controlledByUser).toBe(false);
    const afterConflict = { sessionReads, currentnessReads };
    await client.updateMetadata(metadata => ({ ...metadata, path: '/after-conflict' }));
    await client.updateMetadata(metadata => ({ ...metadata }));
    expect({ sessionReads, currentnessReads }).toEqual(afterConflict);
    expect(client.getMetadataSnapshot()?.path).toBe('/after-conflict');
  });

  it('keeps a changed Account encryption admission closed at the write boundary', async () => {
    const owner = createOwnerSession('tuple-writer-account-changed');
    row = owner.row;
    serve();
    const client = createClient(owner.session);
    await client.updateAgentState(state => ({ ...state, controlledByUser: true }));
    const reads = { sessionReads, currentnessReads };
    vi.mocked(axios.patch).mockResolvedValueOnce({ status: 409, data: { code: 'metadata_privacy_upgrade_required' } });
    await expect(client.updateMetadata(metadata => ({ ...metadata, path: '/refused' })))
      .rejects.toMatchObject({ code: 'metadata_privacy_upgrade_required' });
    expect(client.getMetadataSnapshot()?.path).not.toBe('/refused');
    expect({ sessionReads, currentnessReads }).toEqual(reads);
  });

  it('reuses the admitted publisher precondition and leaves rejection to the commit', async () => {
    const owner = createOwnerSession('tuple-writer-publisher');
    row = owner.row;
    serve();
    const client = createClient(owner.session);
    await client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, path: '/first' }));
    const admittedReads = { sessionReads, currentnessReads, publisherChecks };
    await client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, path: '/second' }));
    await client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata }));
    expect({ sessionReads, currentnessReads, publisherChecks }).toEqual(admittedReads);
    expect(axios.patch).toHaveBeenCalledTimes(2);
    expect(SessionMetadataTuplePatchV1Schema.parse(vi.mocked(axios.patch).mock.calls[1][1]))
      .toMatchObject({ publisherPrecondition: { machineId: 'machine-1', committedFenceMs: 1_000, publisherGeneration: '1' } });
    vi.mocked(axios.patch).mockResolvedValueOnce({ status: 409, data: { code: 'session_publisher_authority_lost' } });
    await expect(client.updateMetadataAsCurrentPublisher(metadata => ({ ...metadata, path: '/refused' })))
      .rejects.toMatchObject({ code: 'session_publisher_authority_lost' });
    expect(client.getMetadataSnapshot()?.path).toBe('/second');
  });
});
