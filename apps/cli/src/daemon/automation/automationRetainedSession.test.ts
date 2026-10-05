import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveAccountMachineKeyFromRecoverySecret, deriveBoxPublicKeyFromSeed,
  encodeBase64, sealEncryptedDataKeyEnvelopeV1, resolveValidatedAutomationAccountEncryptionV1 } from '@happier-dev/protocol';
import { AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { parseAutomationTemplateExecution } from './automationTemplateExecution';
import { resolveAutomationTemplateRetainedSession } from './automationRetainedSession';
import { executeClaimedRun, type ClaimableRunPayload } from './automationRunExecutor';
import type { sendSessionMessage } from '@/session/services/sendSessionMessage';
import { openSessionStoredContent } from '@/session/transport/encryption/sessionEncryptionContext';

const network = vi.hoisted(() => ({ fetchSession: vi.fn(), lookupSessions: vi.fn(), fetchCurrentness: vi.fn() }));
// Authenticated Session HTTP is the boundary; the Session envelope and template codecs remain real.
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: network.fetchSession, lookupSessionsByTags: network.lookupSessions }));
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: network.fetchCurrentness }));

describe('retained Automation Session custody', () => {
  beforeEach(() => { network.fetchSession.mockReset(); network.lookupSessions.mockReset(); network.fetchCurrentness.mockReset(); });
  it.each(['legacy', 'dataKey'] as const)('opens the Session envelope before exposing historical %s material to the retained template branch', async (credentialType) => {
    const secret = new Uint8Array(32).fill(7);
    const seed = deriveAccountMachineKeyFromRecoverySecret(secret);
    const encryption = credentialType === 'legacy' ? { type: 'legacy' as const, secret }
      : { type: 'dataKey' as const, machineKey: seed, publicKey: deriveBoxPublicKeyFromSeed(seed) };
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(3),
      recipientPublicKey: deriveBoxPublicKeyFromSeed(seed), randomBytes: (length) => new Uint8Array(length).fill(1) }), 'base64');
    network.fetchSession.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey, effectiveAccess: { role: 'owner' } });
    const retainedSession = await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old',
      credentials: { token: 'token', encryption } });
    expect(parseAutomationTemplateExecution({ targetType: 'existing_session', templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED },
      undefined, 'plain', retainedSession ?? undefined)).toMatchObject({ ok: true, value: { existingSessionId: 'session-old' } });
    const keyless = await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old', credentials: { token: 'token', encryption: null } });
    expect(keyless?.material).toBeUndefined();
    expect(parseAutomationTemplateExecution({ targetType: 'existing_session', templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED },
      undefined, 'plain', keyless ?? undefined)).toMatchObject({ ok: false, code: 'session_key_required' });
    network.fetchSession.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey: 'corrupt', effectiveAccess: { role: 'owner' } });
    expect((await resolveAutomationTemplateRetainedSession({ sessionId: 'session-old',
      credentials: { token: 'token', encryption } }))?.material).toBeUndefined();
  });
  it.each(['legacy', 'dataKey', null] as const)('dispatches only the key-holding retained Session branch under plain Account currentness (custody: %s)', async (credentialType) => {
    const secret = new Uint8Array(32).fill(7);
    const seed = deriveAccountMachineKeyFromRecoverySecret(secret);
    const encryption = credentialType === null ? null : credentialType === 'legacy' ? { type: 'legacy' as const, secret }
      : { type: 'dataKey' as const, machineKey: seed, publicKey: deriveBoxPublicKeyFromSeed(seed) };
    const dataEncryptionKey = encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: new Uint8Array(32).fill(3),
      recipientPublicKey: deriveBoxPublicKeyFromSeed(seed), randomBytes: (length) => new Uint8Array(length).fill(1) }), 'base64');
    const rawSession = { id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey, active: true, machineId: 'machine', metadata: null };
    network.fetchSession.mockResolvedValue(rawSession);
    network.lookupSessions.mockResolvedValue({ state: 'available', sessions: [rawSession] });
    const witness = { mode: 'plain' as const, version: 1, contentKeyFingerprint: null };
    network.fetchCurrentness.mockResolvedValue({ ...witness, signingKeyFingerprint: null, updatedAt: 1 });
    const claimed: ClaimableRunPayload = { protocol: 'v3', accountCurrentness: witness,
      automation: { id: 'automation-old', name: 'Old', enabled: true }, run: {
        id: 'run-old', automationId: 'automation-old', attempt: 1, revision: 0, recipeKind: 'legacy', triggerId: null,
        cause: { kind: 'manual', invokedAt: 1 }, resultDelivery: { kind: 'none' }, executionInputEnvelope: JSON.stringify({
          kind: 'happier_automation_run_execution_input_v1', targetType: 'existing_session', templateVersion: 1,
          templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, origin: { kind: 'manual', invokedAt: 1 },
        }),
      } };
    // Claim persistence and Session process spawning are genuine system boundaries.
    const failRun = vi.fn();
    const succeedRun = vi.fn();
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-old' }));
    const machineAdmissionTransport = vi.fn<NonNullable<Parameters<typeof sendSessionMessage>[0]['machineAdmissionTransport']>>(async (request) => {
      expect(request.content.t).toBe('encrypted');
      expect(openSessionStoredContent({ mode: 'e2ee', ctx: { encryptionKey: new Uint8Array(32).fill(3), encryptionVariant: 'dataKey' },
        content: request.content })).toMatchObject({ role: 'user', content: { type: 'text', text: 'Review the release' } });
      return { status: 'accepted', localId: request.localId };
    });
    await executeClaimedRun({ token: 'token', credentials: { token: 'token', encryption },
      machineId: 'machine', heartbeatMs: 60_000, leaseDurationMs: 120_000, claimed, spawnSession, machineAdmissionTransport,
      claimClient: { startRun: async () => witness, heartbeatRun: async () => {}, succeedRun, failRun },
      resolveAutomationAccountEncryption: (signal) => resolveValidatedAutomationAccountEncryptionV1({ signal,
        resolveAccountEncryptionCurrentness: async () => ({ ...witness, signingKeyFingerprint: null, updatedAt: 1 }),
        resolveAccountEncryptionMaterial: async () => null }),
    });
    if (encryption) {
      expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({ existingSessionId: 'session-old', directory: '/repo' }));
      expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-old', targetMachineId: 'machine' }), expect.anything());
      expect(succeedRun).toHaveBeenCalledWith(expect.objectContaining({ protocol: 'v3', runId: 'run-old', producedSessionId: 'session-old' }));
      expect(failRun).not.toHaveBeenCalled();
    } else {
      expect(spawnSession).not.toHaveBeenCalled();
      expect(machineAdmissionTransport).not.toHaveBeenCalled();
      expect(succeedRun).not.toHaveBeenCalled();
      expect(failRun).toHaveBeenCalledWith(expect.objectContaining({ errorCode: 'session_key_required' }));
    }
  });
});
