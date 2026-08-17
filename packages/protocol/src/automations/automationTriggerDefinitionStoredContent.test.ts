import { describe, expect, it } from 'vitest';

import {
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  AutomationConversationTriggerDefinitionStoredPayloadV1Schema,
  isAutomationTriggerDefinitionCiphertextV1,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from './automationTriggerDefinitionStoredContent.js';

const material: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};

const binding = {
  v: 1,
  automationId: 'automation-trigger-definition-1',
  templateVersion: 3,
  triggerKind: 'pluginEvent',
  eventRef: { pluginId: 'com.acme.github', localId: 'repository-event' },
  sourceSelectorId: '9d5af559-2c82-4c22-b6a0-ecabce38a631',
} as const;

const definition = {
  v: 1,
  sourceInstanceId: 'repository-1',
  sourceConfig: { repositoryId: 42 },
  displayLabel: 'Repository 42',
  filter: null,
  maximumObservationAgeMs: null,
} as const;

describe('Automation trigger-definition stored content', () => {
  it('keeps a Conversation definition bound to one exact binding id', () => {
    expect(AutomationConversationTriggerDefinitionStoredPayloadV1Schema.safeParse({
      v: 1,
      bindingId: 'binding-1',
    }).success).toBe(true);
    expect(AutomationConversationTriggerDefinitionStoredPayloadV1Schema.safeParse({
      v: 1,
    }).success).toBe(false);
    expect(AutomationConversationTriggerDefinitionStoredPayloadV1Schema.safeParse({
      v: 1,
      bindingId: 'binding-1',
      unexpected: true,
    }).success).toBe(false);
  });

  it('uses the dedicated byte-20 domain and binds an Event definition to its record identity and version', () => {
    const encrypted = sealAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      definition,
      mode: 'e2ee',
      material,
      randomBytes: (length) => Uint8Array.from({ length }, (_, index) => index + 1),
    });

    expect(encrypted.t).toBe('encrypted');
    if (encrypted.t !== 'encrypted') throw new Error('expected encrypted definition');
    expect(readAccountScopedCiphertextKindByte(encrypted.c)).toBe(20);
    expect(isAutomationTriggerDefinitionCiphertextV1(encrypted.c)).toBe(true);
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      envelope: encrypted,
      mode: 'e2ee',
      material,
    })).toEqual({ kind: 'available', definition });

    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding: { ...binding, templateVersion: 4 },
      envelope: encrypted,
      mode: 'e2ee',
      material,
    })).toEqual({ kind: 'bindingMismatch' });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding: { ...binding, automationId: 'automation-trigger-definition-2' },
      envelope: encrypted,
      mode: 'e2ee',
      material,
    })).toEqual({ kind: 'bindingMismatch' });

    const plain = sealAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      definition,
      mode: 'plain',
    });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding: { ...binding, templateVersion: 4 },
      envelope: plain,
      mode: 'plain',
    })).toEqual({ kind: 'bindingMismatch' });
  });

  it('rejects bytes 2 and 19 as definition ciphertexts and enforces Account-mode legality', () => {
    const payload = {
      v: 1,
      binding,
      definition,
    };
    for (const kind of [
      'automation_template_payload',
      'automation_trigger_evidence',
    ] as const) {
      const wrongDomain = sealAccountScopedBlobCiphertext({
        kind,
        material,
        payload,
        randomBytes: (length) => new Uint8Array(length).fill(5),
      });
      expect(isAutomationTriggerDefinitionCiphertextV1(wrongDomain)).toBe(false);
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        binding,
        envelope: { t: 'encrypted', c: wrongDomain },
        mode: 'e2ee',
        material,
      })).toEqual({ kind: 'contentInvalid' });
    }

    const plain = sealAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      definition,
      mode: 'plain',
    });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      envelope: plain,
      mode: 'e2ee',
      material,
    })).toEqual({ kind: 'modeMismatch' });

    const encrypted = sealAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      definition,
      mode: 'e2ee',
      material,
      randomBytes: (length) => new Uint8Array(length).fill(9),
    });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      envelope: encrypted,
      mode: 'plain',
    })).toEqual({ kind: 'modeMismatch' });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
      binding,
      envelope: encrypted,
      mode: 'e2ee',
    })).toEqual({ kind: 'materialUnavailable' });
  });
});
