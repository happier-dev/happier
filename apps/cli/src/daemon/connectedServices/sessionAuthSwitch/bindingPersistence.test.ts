import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionMetadataTuplePatchV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { openSessionOwnerMetadataEnvelopeV1, projectSessionOwnerCompatibilityViewV1,
  projectSessionAccessCapabilitiesV1, SessionEffectiveAccessV1Schema } from '@happier-dev/protocol';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { persistSessionConnectedServiceBindings } from './bindingPersistence';

// HTTP persistence and Account currentness are genuine network boundaries.
const http = vi.hoisted(() => ({ read: vi.fn(), patch: vi.fn(), currentness: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionByIdCompat: http.read, patchSessionMetadataEnvelopeTuple: http.patch,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: http.currentness }));
const serviceId = 'happier.agent.claude/claude-subscription';
const bindings = { v: 2 as const, bindingsByServiceId: { [serviceId]: {
  source: 'connected' as const, selection: 'group' as const, groupId: 'pool', profileId: 'fallback',
} } };
const credentials = { token: 'account-projection-test', encryption: null };
const plainCurrentness = { mode: 'plain', version: 1, signingKeyFingerprint: null,
  contentKeyFingerprint: null, updatedAt: 1, recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } };
function fixture() {
  const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain', storedContentMode: 'plain',
    metadata: { path: '/repo', host: 'host', connectedServices: bindings }, agentState: null });
  return { id: 'sess_applied_account', encryptionMode: 'plain', metadataLayoutVersion: 1,
    metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, displayProjectionV1: fields.displayProjectionV1,
    metadataVersion: 1, agentState: null, agentStateVersion: 1, dataEncryptionKey: null,
    effectiveAccess: SessionEffectiveAccessV1Schema.parse({ v: 1, level: 'owner', sources: [{ kind: 'owner' }],
      capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) }) };
}
function readPatch(index: number) {
  const patch = SessionMetadataTuplePatchV1Schema.parse(http.patch.mock.calls[index]?.[0]?.patch);
  if (patch.mode !== 'owner') throw new Error('Expected owner metadata mutation');
  const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: 'plain', envelope: patch.ownerMetadata });
  if (!opened.ok) throw new Error('Expected plain Account owner metadata');
  return { patch, metadata: projectSessionOwnerCompatibilityViewV1({
    sharedMetadata: JSON.parse(patch.sharedMetadata.ciphertext), ownerMetadata: opened.ownerMetadata,
  }) };
}
beforeEach(() => {
  vi.clearAllMocks();
  http.currentness.mockResolvedValue(plainCurrentness);
  http.patch.mockResolvedValue({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 1 } });
});
describe('applied account metadata persistence', () => {
  it('publishes actual identity through the owner tuple once and clears it on an explicit selection write', async () => {
    const initial = fixture();
    http.read.mockResolvedValue(initial);
    const input = { token: credentials.token, credentials, sessionId: initial.id,
      providerObservedAccount: { serviceId, groupId: 'pool', profileId: 'observed' }, isCurrent: async () => true };
    await persistSessionConnectedServiceBindings(input);
    const first = readPatch(0);
    expect(first.metadata.connectedServices).toEqual({ ...bindings, bindingsByServiceId: { [serviceId]: {
      ...bindings.bindingsByServiceId[serviceId], appliedProfileId: 'observed',
    } } });
    http.read.mockResolvedValue({ ...initial, metadataVersion: 2, metadata: first.patch.sharedMetadata.ciphertext,
      ownerMetadata: first.patch.ownerMetadata, displayProjectionV1: first.patch.displayProjectionV1 });
    await persistSessionConnectedServiceBindings(input);
    expect(http.patch).toHaveBeenCalledTimes(1);
    await persistSessionConnectedServiceBindings({ token: credentials.token, credentials, sessionId: initial.id, normalizedBindings: bindings });
    expect(readPatch(1).metadata.connectedServices).toEqual(bindings);
  });
  it('refuses an observation retired during Account currentness lookup before committing any owner tuple', async () => {
    const initial = fixture();
    http.read.mockResolvedValue(initial);
    let current = true;
    http.currentness.mockImplementation(async () => { current = false; return plainCurrentness; });
    await expect(persistSessionConnectedServiceBindings({ token: credentials.token, credentials, sessionId: initial.id,
      providerObservedAccount: { serviceId, groupId: 'pool', profileId: 'observed' }, isCurrent: async () => current,
    })).resolves.toBeUndefined();
    expect(http.patch).not.toHaveBeenCalled();
  });
});
