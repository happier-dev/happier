import { describe, expect, it } from 'vitest';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  getAccountScopedBlobCiphertextBase64LengthV1,
  sealAccountScopedBlobCiphertext,
} from '../crypto/accountScopedCipher.js';
import {
  AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1,
  AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1,
  AutomationSessionStartRequestEnvelopeV1Schema,
  isAutomationSessionStartRequestCiphertextV1,
  openAutomationSessionStartRequestEnvelopeV1,
  sealAutomationSessionStartRequestEnvelopeV1,
  validateAutomationSessionStartRequestEnvelopeOuterForModeV1,
} from './automationSessionStartRequestEnvelopeV1.js';

const input = {
  creationKey: 'automation-run:run-1',
  executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
  directory: '/workspace/project',
  organizationPlacement: { folderId: null, tagIds: [] },
  agentTarget: {
    kind: 'agent' as const,
    identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
  },
  initialInput: { text: 'Start the Automation Session.' },
};

const material = createAccountScopedCryptoMaterialSnapshotV1({
  accountEncryptionMode: 'e2ee',
  material: { type: 'legacy', secret: new Uint8Array(32).fill(11) },
});

function opaquePayloadWithSerializedUtf8Bytes(bytes: number) {
  const empty = JSON.stringify({ payload: '' });
  const emptyBytes = new TextEncoder().encode(empty).byteLength;
  return { payload: 'x'.repeat(bytes - emptyBytes) };
}

describe('Automation Session-start request envelope V1', () => {
  it('seals and opens the strict V2 input in both Account modes', () => {
    const plain = sealAutomationSessionStartRequestEnvelopeV1({ mode: 'plain', input });
    expect(plain).toEqual({ t: 'plain', v: input });
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'plain',
      envelope: plain,
    })).toEqual({ kind: 'available', input });

    const encrypted = sealAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      input,
      material: material.material,
      randomBytes: (length) => new Uint8Array(length).fill(12),
    });
    expect(encrypted.t).toBe('encrypted');
    if (encrypted.t !== 'encrypted') throw new Error('expected encrypted request envelope');
    expect(isAutomationSessionStartRequestCiphertextV1(encrypted.c)).toBe(true);
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      envelope: encrypted,
      material: material.material,
    })).toEqual({ kind: 'available', input });
  });

  it('keeps outer-only server readers opaque while the target rejects malformed inner V2 data', () => {
    const envelope = {
      t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({
        kind: 'automation_session_start_request',
        material: material.material,
        payload: { opaqueToServer: true },
        randomBytes: (length) => new Uint8Array(length).fill(13),
      }),
    };

    expect(validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
      mode: 'e2ee',
      envelope,
    })).toMatchObject({ kind: 'available' });
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      envelope,
      material: material.material,
    })).toEqual({ kind: 'contentInvalid' });
  });

  it.each([
    'automation_trigger_evidence',
    'automation_trigger_definition',
  ] as const)('refuses purpose-byte substitution from %s', (kind) => {
    const envelope = {
      t: 'encrypted' as const,
      c: sealAccountScopedBlobCiphertext({
        kind,
        material: material.material,
        payload: input,
        randomBytes: (length) => new Uint8Array(length).fill(14),
      }),
    };

    expect(isAutomationSessionStartRequestCiphertextV1(envelope.c)).toBe(false);
    expect(validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
      mode: 'e2ee',
      envelope,
    })).toEqual({ kind: 'contentInvalid' });
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      envelope,
      material: material.material,
    })).toEqual({ kind: 'contentInvalid' });
  });

  it('fails closed for Account mode mismatch or missing E2EE material', () => {
    const plain = { t: 'plain' as const, v: input };
    expect(validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
      mode: 'e2ee',
      envelope: plain,
    })).toEqual({ kind: 'modeMismatch' });

    const encrypted = sealAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      input,
      material: material.material,
      randomBytes: (length) => new Uint8Array(length).fill(15),
    });
    expect(validateAutomationSessionStartRequestEnvelopeOuterForModeV1({
      mode: 'plain',
      envelope: encrypted,
    })).toEqual({ kind: 'modeMismatch' });
    expect(openAutomationSessionStartRequestEnvelopeV1({
      mode: 'e2ee',
      envelope: encrypted,
    })).toEqual({ kind: 'materialUnavailable' });
  });

  it('derives raw and ciphertext max/+1 admission from the canonical cipher length', () => {
    const maximumPlainPayload = opaquePayloadWithSerializedUtf8Bytes(
      AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1,
    );
    const oversizedPlainPayload = opaquePayloadWithSerializedUtf8Bytes(
      AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1 + 1,
    );
    expect(new TextEncoder().encode(JSON.stringify(maximumPlainPayload)).byteLength).toBe(
      AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1,
    );
    expect(AutomationSessionStartRequestEnvelopeV1Schema.safeParse({
      t: 'plain',
      v: maximumPlainPayload,
    }).success).toBe(true);
    expect(AutomationSessionStartRequestEnvelopeV1Schema.safeParse({
      t: 'plain',
      v: oversizedPlainPayload,
    }).success).toBe(false);

    expect(AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1).toBe(
      getAccountScopedBlobCiphertextBase64LengthV1(
        AUTOMATION_SESSION_START_REQUEST_MAX_RAW_UTF8_BYTES_V1,
      ),
    );
    expect(AutomationSessionStartRequestEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'A'.repeat(AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1),
    }).success).toBe(true);
    expect(AutomationSessionStartRequestEnvelopeV1Schema.safeParse({
      t: 'encrypted',
      c: 'A'.repeat(AUTOMATION_SESSION_START_REQUEST_MAX_ENCRYPTED_CIPHERTEXT_UTF8_BYTES_V1 + 1),
    }).success).toBe(false);
  });
});
