import { expect, it, vi } from 'vitest';
import { createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';

const { fetchSessionById, patchSessionMetadataEnvelopeTuple, fetchAccountEncryptionCurrentness } = vi.hoisted(() => ({
  fetchSessionById: vi.fn(), patchSessionMetadataEnvelopeTuple: vi.fn(), fetchAccountEncryptionCurrentness: vi.fn(),
}));
// Substitute only HTTP and socket transports; selection, encryption and CAS remain real.
vi.mock('@/session/transport/http/sessionsHttp', async importOriginal => ({
  ...await importOriginal<typeof import('@/session/transport/http/sessionsHttp')>(),
  fetchSessionById, fetchSessionByIdCompat: fetchSessionById, patchSessionMetadataEnvelopeTuple,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', async importOriginal => ({
  ...await importOriginal<typeof import('@/api/client/connectedServiceCredentialApi')>(), fetchAccountEncryptionCurrentness,
}));
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Unexpected ordinary model RPC'); } }));
import { setSessionModel } from './setSessionModel';

it.each([
  { active: true, applyTiming: 'next_prompt' as const, explicit: false, deliveryMode: 'brokered' as const, expectedStatus: 'intent_updated' },
  { active: false, applyTiming: 'next_prompt' as const, explicit: false, deliveryMode: 'brokered' as const, expectedStatus: 'intent_updated' },
  { active: true, applyTiming: 'immediate' as const, explicit: false, deliveryMode: 'brokered' as const, expectedStatus: 'restart_required' },
  { active: true, applyTiming: 'next_prompt' as const, explicit: true, deliveryMode: 'brokered' as const, expectedStatus: 'restart_required' },
  { active: true, applyTiming: 'next_prompt' as const, explicit: false, deliveryMode: 'vendor-native' as const, expectedStatus: 'restart_required' },
])('retains Team intent and reports $expectedStatus (active=$active, timing=$applyTiming, explicit=$explicit, delivery=$deliveryMode)', async ({ active, applyTiming, explicit, deliveryMode, expectedStatus }) => {
  const ref = { source: 'team_resource' as const, resourceId: 'team-muse', teamId: 'team-1',
    expectedResourceRevision: 0, deliveryMode,
    agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'muse-spark-1.2' };
  const converted = createSessionOwnerMetadataV1({ metadata: { flavor: 'claude',
    modelSelectionIntentV2: { v: 2, updatedAt: 10, ref } } });
  if (!converted.ok) throw new Error('Invalid owner fixture');
  const owner = converted.ownerMetadata;
  const raw = { id: 'cmwdryqwk00inmcwxg5822z0k', active, activeAt: 1,
    metadataLayoutVersion: 1, encryptionMode: 'plain', metadata: JSON.stringify({ v: 1 }), metadataVersion: 1,
    ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner), ownerMetadataVersion: 1,
    agentState: null, agentStateVersion: 0 };
  fetchSessionById.mockResolvedValue(raw);
  fetchAccountEncryptionCurrentness.mockResolvedValue({ mode: 'plain', version: 1,
    signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
  patchSessionMetadataEnvelopeTuple.mockReset();
  patchSessionMetadataEnvelopeTuple.mockResolvedValue({ success: true,
    sharedMetadata: { version: 2 }, ownerMetadata: { version: 2 }, agentState: { version: 1 } });
  const { source: _source, ...teamRef } = ref;
  const result = await setSessionModel({ credentials: { token: 'fixture', encryption: null },
    idOrPrefix: raw.id, modelId: 'muse-spark-1.3', applyTiming,
    ...(explicit ? { teamCredentialModel: { kind: 'team_credential_provider_model' as const,
      ...teamRef, modelId: 'muse-spark-1.3' } } : {}),
  });
  expect(result).toMatchObject({ status: expectedStatus });
  const patch = patchSessionMetadataEnvelopeTuple.mock.calls[0]?.[0]?.patch;
  expect(patch).toMatchObject({ mode: 'owner_team_credential_binding', teamCredentialBindings: [{
    resourceId: ref.resourceId, teamId: ref.teamId, deliveryMode: ref.deliveryMode,
  }] });
  expect(readSessionModelSelectionV2FromMetadata(projectSessionOwnerCompatibilityViewV1({
    sharedMetadata: { v: 1 }, ownerMetadata: patch.ownerMetadata.v,
  }))?.ref)
    .toEqual({ ...ref, modelId: 'muse-spark-1.3' });
});
