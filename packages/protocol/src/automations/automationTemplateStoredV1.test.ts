import { describe, expect, it } from 'vitest';
import { openAutomationTemplateStoredV1, openAutomationTemplateStoredForMigrationV1 } from './automationTemplateStoredV1.js';
import { deriveAccountMachineKeyFromRecoverySecret } from '../crypto/accountScopedCipher.js';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_ENCRYPTED,
  AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
  AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED } from './automationTemplateV02.testFixtures.js';

const material = { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) };
describe('the Protocol-owned 0.2 stored template codec', () => {
  it.each([AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED])('opens exact historical recovery input through the transition-only entry', (templateCiphertext) => {
    expect(openAutomationTemplateStoredForMigrationV1({ templateCiphertext, material }))
      .toMatchObject({ ok: true, template: { prompt: 'Review the release' } });
  });
  it.each([AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED])('opens a retained E2EE Session on a plain Account only with its explicit historical custody', (templateCiphertext) => {
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain',
      retainedSession: { sessionId: 'session-old', encryptionMode: 'e2ee', material } }))
      .toMatchObject({ ok: true, template: { existingSessionId: 'session-old', prompt: 'Review the release' } });
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain', material,
      retainedSession: { sessionId: 'session-old', encryptionMode: 'e2ee' } }))
      .toEqual({ ok: false, code: 'session_key_required' });
  });
  it('does not admit unrelated ciphertext through retained Session custody', () => {
    for (const [templateCiphertext, retainedSession] of [
      [AUTOMATION_TEMPLATE_V02_ENCRYPTED, { sessionId: 'session-old', encryptionMode: 'e2ee', material }],
      [AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, { sessionId: 'another-session', encryptionMode: 'e2ee', material }],
      [AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED, { sessionId: 'session-old', encryptionMode: 'plain', material }],
    ] as const) {
      expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain', retainedSession }))
        .toEqual({ ok: false, code: 'encryption_mode_mismatch' });
    }
  });
  it('uses real retained data-key custody and keeps a failed decryption locked', () => {
    const templateCiphertext = AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED;
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain', retainedSession: {
      sessionId: 'session-old', encryptionMode: 'e2ee', material: {
        type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(material.secret),
      },
    } })).toMatchObject({ ok: true, template: { existingSessionId: 'session-old' } });
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain', retainedSession: {
      sessionId: 'session-old', encryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
    } })).toEqual({ ok: false, code: 'invalid_template' });
  });
  it.each([AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN])('reads the exact plain predecessor writer', (templateCiphertext) => {
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'plain' }))
      .toMatchObject({ ok: true, template: { directory: '/repo', agent: 'claude', prompt: 'Review the release' } });
  });
  it.each([AUTOMATION_TEMPLATE_V02_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_RAW_ENCRYPTED, AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED])('reads the exact scoped and raw encrypted predecessor writers', (templateCiphertext) => {
    expect(openAutomationTemplateStoredV1({ templateCiphertext, accountMode: 'e2ee', material }))
      .toMatchObject({ ok: true, template: { directory: '/repo', prompt: 'Review the release' } });
  });
  it('does not reinterpret unavailable or wrong E2EE material as plain', () => {
    expect(openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, accountMode: 'e2ee' }))
      .toEqual({ ok: false, code: 'encryption_material_unavailable' });
    expect(openAutomationTemplateStoredV1({ templateCiphertext: AUTOMATION_TEMPLATE_V02_ENCRYPTED, accountMode: 'e2ee',
      material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } })).toEqual({ ok: false, code: 'invalid_template' });
  });
  it.each([AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
    AUTOMATION_TEMPLATE_V02_EXISTING_RAW_ENCRYPTED])('rejects a substituted predecessor outer Session id', (bytes) => {
    const envelope = JSON.parse(bytes);
    envelope.existingSessionId = 'another-session';
    expect(openAutomationTemplateStoredV1({ templateCiphertext: JSON.stringify(envelope),
      accountMode: bytes === AUTOMATION_TEMPLATE_V02_EXISTING_PLAIN ? 'plain' : 'e2ee', material }))
      .toEqual({ ok: false, code: 'invalid_template' });
  });
});
