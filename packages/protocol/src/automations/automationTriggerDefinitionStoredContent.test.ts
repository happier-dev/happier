import { describe, expect, it } from 'vitest';

import {
  readAccountScopedCiphertextKindByte,
  sealAccountScopedBlobCiphertext,
  type AccountScopedCryptoMaterial,
} from '../crypto/accountScopedCipher.js';
import {
  createAutomationPluginEventTriggerDefinitionV1,
  AutomationTriggerDefinitionBindingV1Schema,
  isAutomationTriggerDefinitionCiphertextV1,
  openAutomationTriggerDefinitionStoredEnvelopeV1,
  sealAutomationPluginEventTriggerInputV1,
  sealAutomationTriggerDefinitionStoredEnvelopeV1,
} from './automationTriggerDefinitionStoredContent.js';
import { AutomationPluginEventDefinitionTriggerSchema } from './automationTriggerDefinition.js';
import { AutomationEventTriggerDefinitionStoredPayloadV1Schema } from './automationEventV1.js';
import { automationSubjectKeyV1 } from './automationSubjectV1.js';

const material: AccountScopedCryptoMaterial = {
  type: 'dataKey',
  machineKey: new Uint8Array(32).fill(7),
};

const binding = {
  v: 1,
  automationId: 'automation-trigger-definition-1',
  triggerId: 'trigger-1',
  triggerRevision: 3,
  triggerKind: 'pluginEvent',
  eventRef: { pluginId: 'com.acme.github', localId: 'pull-request-opened' },
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
  it.each(['plain', 'e2ee'] as const)('retains the authored Event subject in the %s definition envelope', mode => {
    const subject = { kind: 'machine', serverId: 'home-1', machineId: 'machine-1' } as const;
    const authored = AutomationPluginEventDefinitionTriggerSchema.parse({
      kind: 'pluginEvent', eventRef: binding.eventRef, sourceInstanceId: definition.sourceInstanceId,
      sourceContractVersion: 1, sourceConfig: definition.sourceConfig, displayLabel: definition.displayLabel,
      observationTransport: { kind: 'checkpointedPull', watcherMaterializationRef: {
        machineId: 'observer-1', pluginId: binding.eventRef.pluginId, materializationId: 'observer-materialization',
      } }, filter: null, maximumObservationAgeMs: null, subject,
    });
    const stored = createAutomationPluginEventTriggerDefinitionV1(authored);
    let envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ binding, definition: stored,
      mode, material, randomBytes: length => new Uint8Array(length).fill(8) });
    if (mode === 'e2ee') {
      const sealed = sealAutomationPluginEventTriggerInputV1({ binding, trigger: { ...authored, enabled: true },
        seal: input => {
          const sealedEnvelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({ ...input, mode, material,
            randomBytes: length => new Uint8Array(length).fill(8) });
          if (sealedEnvelope.t !== 'encrypted') throw new Error('Expected encrypted Event definition');
          return sealedEnvelope;
        } });
      expect(sealed).toMatchObject({ subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject) });
      expect(JSON.stringify(sealed)).not.toContain('"machineId":"machine-1"');
      envelope = sealed.triggerDefinitionEnvelope;
    }
    const opened = openAutomationTriggerDefinitionStoredEnvelopeV1({ mode, binding, envelope, material });
    expect(opened.kind).toBe('available');
    if (opened.kind !== 'available') throw new Error(opened.kind);
    expect(AutomationEventTriggerDefinitionStoredPayloadV1Schema.parse(opened.definition).subject).toEqual(subject);
  });
  it('opens unknown stored binding fields without giving them routing authority', () => {
    const envelope = { t: 'plain', extra: true, v: { v: 1, extra: true,
      binding: { ...binding, extra: true, eventRef: { ...binding.eventRef, extra: true } }, definition } };
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding, envelope }))
      .toEqual({ kind: 'available', definition });
    expect(openAutomationTriggerDefinitionStoredEnvelopeV1({ mode: 'plain', binding: { ...binding, triggerRevision: 4 }, envelope }))
      .toEqual({ kind: 'bindingMismatch' });
  });
  it.each(['prComment', 'ciFailed'] as const)('binds private %s selections in plain and E2EE Accounts', (triggerKind) => {
    const prBinding = AutomationTriggerDefinitionBindingV1Schema.parse({
      v: 1, automationId: binding.automationId, triggerId: binding.triggerId,
      triggerRevision: 3, triggerKind,
    });
    const selection = { kind: triggerKind, pullRequest: { repository: 'owner/repo', number: 42 } };
    for (const mode of ['plain', 'e2ee'] as const) {
      const envelope = sealAutomationTriggerDefinitionStoredEnvelopeV1({
        binding: prBinding, definition: selection, mode, material,
        randomBytes: (length) => new Uint8Array(length).fill(8),
      });
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        binding: prBinding, envelope, mode, material,
      })).toEqual({ kind: 'available', definition: selection });
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        binding: { ...prBinding, triggerRevision: 4 }, envelope, mode, material,
      })).toEqual({ kind: 'bindingMismatch' });
      expect(openAutomationTriggerDefinitionStoredEnvelopeV1({
        binding: { ...prBinding, triggerKind: triggerKind === 'prComment' ? 'ciFailed' : 'prComment' },
        envelope, mode, material,
      })).toEqual({ kind: 'bindingMismatch' });
    }
  });
  it('rejects the retired Conversation definition binding arm', () => {
    const conversationBinding = {
      v: 1,
      automationId: 'automation-trigger-definition-2',
      triggerId: 'trigger-2',
      triggerRevision: 1,
      triggerKind: 'conversation',
      eventRef: null,
      sourceSelectorId: null,
    } as const;
    expect(AutomationTriggerDefinitionBindingV1Schema.safeParse(conversationBinding).success)
      .toBe(false);
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
      binding: { ...binding, triggerRevision: 4 },
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
      binding: { ...binding, triggerRevision: 4 },
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
