import { describe, expect, it } from 'vitest';

import {
  createAccountScopedCryptoMaterialSnapshotV1,
  sealAccountScopedBlobCiphertext,
} from '../crypto/accountScopedCipher.js';
import {
  readAutomationDefinitionDisplayV1,
} from './automationDefinitionDisplayReaderV1.js';
import {
  sealAutomationStoredActionDefinitionTemplateV1,
} from './automationRunExecutionRecipeV1.js';

const workflow = {
  workspace: { directory: '/workspace/project' },
  executionTarget: { kind: 'session' as const },
  display: { name: 'Nightly release review', description: 'Review the release branch every night' },
};

describe('Automation definition display reader V1', () => {
  it.each(['plain', 'e2ee'] as const)(
    'opens the private V2 Workflow display for a %s Account and does not use the row marker',
    mode => {
      const material = createAccountScopedCryptoMaterialSnapshotV1({
        accountEncryptionMode: 'e2ee',
        material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
      });
      const envelope = mode === 'plain'
        ? { t: 'plain' as const, v: workflow }
        : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
          kind: 'automation_template_payload', material: material.material, payload: workflow,
          randomBytes: length => new Uint8Array(length).fill(5),
        }) };

      expect(readAutomationDefinitionDisplayV1({
        definition: {
          id: 'automation-1', name: 'Automation', description: null,
          triggers: [], executionRecipe: { v: 2, templateVersion: 1, workflow: envelope,
            triggerEvidence: null },
        },
        encryption: mode === 'plain'
          ? { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } }
          : { kind: 'available', witness: { mode: 'e2ee', version: 1,
            contentKeyFingerprint: 'current' }, material },
      })).toEqual({
        kind: 'available', source: 'workflowDefinition', display: workflow.display,
      });
    },
  );

  it('retains a released raw row label only when the V2 display field is absent', () => {
    expect(readAutomationDefinitionDisplayV1({
      definition: {
        id: 'automation-legacy', name: 'Legacy review', description: 'Kept readable', triggers: [],
        executionRecipe: { v: 2, templateVersion: 1, workflow: { t: 'plain', v: {
          workspace: { directory: '/workspace/project' }, executionTarget: { kind: 'session' },
        } }, triggerEvidence: null },
      },
      encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
    })).toEqual({
      kind: 'available', source: 'legacy', display: { name: 'Legacy review', description: 'Kept readable' },
    });
  });

  it.each(['plain', 'e2ee'] as const)('seals and opens a %s Action definition display in its existing template carrier', mode => {
    const display = { name: 'Refresh incident index', description: 'Run the incident action' };
    const material = createAccountScopedCryptoMaterialSnapshotV1({
      accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(7) },
    });
    const encryption = mode === 'plain'
      ? { kind: 'available' as const, witness: { mode: 'plain' as const, version: 1, contentKeyFingerprint: null } }
      : { kind: 'available' as const, witness: { mode: 'e2ee' as const, version: 1, contentKeyFingerprint: 'current' }, material };
    const template = sealAutomationStoredActionDefinitionTemplateV1({
      template: { v: 1, prompt: '', actionInput: { kind: 'literal', value: { incident: 'INC-42' } }, display },
      encryption,
      randomBytes: length => new Uint8Array(length).fill(5),
    });
    expect(template.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    expect(readAutomationDefinitionDisplayV1({
      definition: {
        id: 'automation-action', name: 'Automation', description: null, triggers: [],
        executionRecipe: {
          v: 1,
          templateVersion: 1,
          template,
          triggerEvidence: null,
          target: { kind: 'contributedAction', action: { pluginId: 'com.example.incidents', localId: 'refresh' } },
        },
      },
      encryption,
    })).toEqual({
      kind: 'available', source: 'actionDefinition', display,
    });
  });

  it('retains a released Action row label when its template predates private display storage', () => {
    expect(readAutomationDefinitionDisplayV1({
      definition: {
        id: 'automation-action-legacy', name: 'Legacy incident action', description: null, triggers: [],
        executionRecipe: {
          v: 1,
          templateVersion: 1,
          template: { t: 'plain', v: {
            v: 1,
            prompt: '',
            actionInput: { kind: 'literal', value: { incident: 'INC-42' } },
          } },
          triggerEvidence: null,
          target: { kind: 'contributedAction', action: { pluginId: 'com.example.incidents', localId: 'refresh' } },
        },
      },
      encryption: { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } },
    })).toEqual({
      kind: 'available', source: 'legacy', display: { name: 'Legacy incident action', description: null },
    });
  });
});
