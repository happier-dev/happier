import { describe, expect, it } from 'vitest';

import { ProviderSettingsV1Schema, DEFAULT_PROVIDER_SETTINGS_V1 } from './v1.js';
import { validateProviderSettingsExternalReferencesV1 } from './externalReferencesV1.js';

describe('validateProviderSettingsExternalReferencesV1', () => {
  it('validates machine and contribution-template references at the context-owning boundary', () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin/p' },
        role: 'default', displayName: 'P', displayNameMode: 'automatic',
        endpointOverrides: [{ endpointTemplateId: 'missing-template', baseUrl: 'https://example.test/v1' }],
        endpointOverridesByMachineId: {
          missing_machine: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/' }],
        },
        revision: 0, createdAt: 1, updatedAt: 1,
      }],
      machineGrants: [{
        v: 1, machineId: 'missing_machine', connectionId: 'pc_a',
        endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1,
      }],
      secretBindingsByConnectionId: {
        pc_a: { byMachineId: { missing_machine: { apiKey: 'secret-a' } } },
      },
    });
    expect(validateProviderSettingsExternalReferencesV1(settings, {
      knownMachineIds: ['machine_a'],
      endpointTemplateIdsByContributionKey: { 'plugin/p': ['chat'] },
    })).toEqual([
      { path: 'connections[0].endpointOverrides[0].endpointTemplateId', reason: 'unknown_endpoint_template' },
      { path: 'connections[0].endpointOverridesByMachineId.missing_machine', reason: 'unknown_machine' },
      { path: 'machineGrants[0].machineId', reason: 'unknown_machine' },
      { path: 'secretBindingsByConnectionId.pc_a.byMachineId.missing_machine', reason: 'unknown_machine' },
    ]);
  });

  it('derives custom-template ids without requiring a contribution registry entry', () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: 'pc_custom', source: {
          kind: 'custom', template: {
            v: 1, name: 'Custom',
            endpointTemplates: [{
              id: 'chat', protocol: 'openai-chat', baseUrl: 'https://example.test/v1',
              capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
            }],
            catalog: { source: 'manual', manualModelPolicy: 'allowed' },
          },
        },
        role: 'named', displayName: 'Custom', displayNameMode: 'custom',
        endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://override.example/v1' }],
        revision: 0, createdAt: 1, updatedAt: 1,
      }],
    });
    expect(validateProviderSettingsExternalReferencesV1(settings, {
      knownMachineIds: [], endpointTemplateIdsByContributionKey: {},
    })).toEqual([]);
  });

  it('does not treat inherited prototype members as contribution registry entries', () => {
    const settings = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections: [{
        v: 1, id: 'pc_prototype_member', source: { kind: 'contribution', contributionKey: 'toString' },
        role: 'default', displayName: 'Prototype member', displayNameMode: 'automatic',
        endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1' }],
        revision: 0, createdAt: 1, updatedAt: 1,
      }],
    });
    expect(() => validateProviderSettingsExternalReferencesV1(settings, {
      knownMachineIds: [], endpointTemplateIdsByContributionKey: {},
    })).not.toThrow();
    expect(validateProviderSettingsExternalReferencesV1(settings, {
      knownMachineIds: [], endpointTemplateIdsByContributionKey: {},
    })).toEqual([]);
  });
});
