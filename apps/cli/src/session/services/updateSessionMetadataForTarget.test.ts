import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { applySessionMemoryCeilingOverrideToMetadata } from '@happier-dev/protocol/machines/guard/sessionGuardStateV1';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol';
import { updateSessionMetadataForTarget } from './updateSessionMetadataForTarget';
import { createCliSessionStateMetadataUpdatePort } from '@/agent/runtime/state/metadataUpdatePort';

// HTTP adapters are the network boundary; resolution, encryption and CAS remain real.
const http = vi.hoisted(() => ({ fetch: vi.fn(), lookup: vi.fn(), patch: vi.fn(), currentness: vi.fn() }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: http.fetch, fetchSessionByIdCompat: http.fetch,
  lookupSessionsByTags: http.lookup, patchSessionMetadataEnvelopeTuple: http.patch,
}));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: http.currentness }));
afterEach(() => vi.resetAllMocks());

describe('exact inactive Session metadata mutation', () => {
  it('passes the observed CAS revision to runtime state updates through the metadata port', async () => {
    const credentials = { token: 'token', encryption: null };
    http.currentness.mockResolvedValue({ mode: 'plain', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null });
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { path: '/repo', host: 'host', machineId: 'machine-1' }, agentState: null });
    http.fetch.mockResolvedValue({ id: 'requested-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    http.patch.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 2 }, agentState: { version: 1 } });
    const port = createCliSessionStateMetadataUpdatePort({ credentials });
    let observedRevision: unknown;
    await expect(port.update('requested-session', (metadata, revision) => {
      observedRevision = revision;
      return { ...metadata, summary: { text: 'Updated', updatedAt: 1 } };
    }, { reason: 'reconciliation' })).resolves.toEqual({ ok: true, version: 2 });
    expect(observedRevision).toBe(1);
  });

  it('refuses a prefix-resolved different Session before any metadata mutation', async () => {
    const credentials = { token: 'token', encryption: null };
    http.currentness.mockResolvedValue({ mode: 'plain', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null });
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { path: '/repo', host: 'host', machineId: 'machine-1' }, agentState: null });
    const raw = { id: 'requested-session-other', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } };
    http.fetch.mockResolvedValue(null);
    http.lookup.mockResolvedValue({ state: 'available', sessions: [raw] });
    http.patch.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 2 }, agentState: { version: 1 } });
    const input = { credentials, idOrPrefix: 'requested-session', expectedSessionId: 'requested-session',
      updater: (metadata: Record<string, unknown>) => ({ ...metadata, summary: { text: 'Updated', updatedAt: 1 } }) };
    await expect(updateSessionMetadataForTarget(input)).resolves.toEqual({ ok: false, code: 'session_not_found' });
    expect(http.patch).not.toHaveBeenCalled();
  });

  it('persists an inactive Session ceiling in the actual shared metadata tuple', async () => {
    const credentials = { token: 'token', encryption: null };
    http.currentness.mockResolvedValue({ mode: 'plain', version: 1, updatedAt: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null });
    const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
      storedContentMode: 'plain', metadata: { path: '/repo', host: 'host', machineId: 'machine-1' }, agentState: null });
    http.fetch.mockResolvedValue({ id: 'requested-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
      metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
      metadataVersion: 1, agentState: null, agentStateVersion: 0, dataEncryptionKey: null,
      effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }],
        capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) } });
    http.patch.mockResolvedValue({ success: true, metadataLayoutVersion: 1,
      sharedMetadata: { version: 2 }, agentState: { version: 1 } });
    const result = await updateSessionMetadataForTarget({ credentials, idOrPrefix: 'requested-session',
      updater: metadata => applySessionMemoryCeilingOverrideToMetadata(metadata, 4096) });
    expect(result).toMatchObject({ ok: true, metadata: { sessionGuardStateV1: { v: 1, kind: 'configured', ceilingBytes: 4096 } } });
    const patch: unknown = http.patch.mock.calls[0]?.[0].patch;
    if (!patch || typeof patch !== 'object' || !('sharedMetadata' in patch)
      || !patch.sharedMetadata || typeof patch.sharedMetadata !== 'object'
      || !('ciphertext' in patch.sharedMetadata) || typeof patch.sharedMetadata.ciphertext !== 'string') {
      throw new Error('Expected a shared metadata tuple at the HTTP boundary');
    }
    expect(JSON.parse(patch.sharedMetadata.ciphertext)).toHaveProperty('sessionGuardStateV1.ceilingBytes', 4096);
  });
});
