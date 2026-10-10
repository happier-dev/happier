import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret, deriveBoxPublicKeyFromSeed,
  encodeBase64, sealEncryptedDataKeyEnvelopeV1, openAutomationTemplateStoredV1 } from '@happier-dev/protocol';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { resolveAutomationTemplateRetainedSession } from './automationRetainedSession';

const network = vi.hoisted(() => ({ fetchSession: vi.fn(), lookupSessions: vi.fn(), fetchCurrentness: vi.fn() }));
// Authenticated Session HTTP is the boundary; the Session envelope and template codecs remain real.
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: network.fetchSession, lookupSessionsByTags: network.lookupSessions }));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: network.fetchCurrentness }));

describe('retained Automation Session custody', () => {
  beforeEach(() => { network.fetchSession.mockReset(); network.lookupSessions.mockReset(); network.fetchCurrentness.mockReset(); });
  it.each(['legacy', 'dataKey'] as const)('opens the Session envelope before exposing historical %s material to explicit template review', async (credentialType) => {
    const secret = new Uint8Array(32).fill(7);
    const seed = deriveAccountMachineKeyFromRecoverySecret(secret);
    const encryption = credentialType === 'legacy' ? { type: 'legacy' as const, secret }
      : { type: 'dataKey' as const, machineKey: seed, publicKey: deriveBoxPublicKeyFromSeed(seed) };
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(3),
      recipientPublicKey: deriveBoxPublicKeyFromSeed(seed), randomBytes: (length) => new Uint8Array(length).fill(1) }), 'base64');
    network.fetchSession.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey, effectiveAccess: { role: 'owner' } });
    const retainedSession = await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old',
      credentials: { token: 'token', encryption } });
    expect(openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      accountMode: 'plain', retainedSession: retainedSession ?? undefined })).toMatchObject({ ok: true, template: { existingSessionId: 'session-old' } });
    const keyless = await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old', credentials: { token: 'token', encryption: null } });
    expect(keyless?.material).toBeUndefined();
    expect(openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      accountMode: 'plain', retainedSession: keyless ?? undefined })).toMatchObject({ ok: false, code: 'session_key_required' });
    network.fetchSession.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey: 'corrupt', effectiveAccess: { role: 'owner' } });
    expect((await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old',
      credentials: { token: 'token', encryption } }))?.material).toBeUndefined();
  });
});
