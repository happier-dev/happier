import { describe, expect, it } from 'vitest';

import { ProviderConnectionV1Schema } from './v1.js';

describe('ProviderConnectionV1Schema endpoint overrides', () => {
  it('normalizes safe endpoint overrides and rejects credential-bearing or unsafe URLs', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin:providers:p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    expect(ProviderConnectionV1Schema.parse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://EXAMPLE.test:443/v1' }] }).endpointOverrides)
      .toEqual([{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1' }]);
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1?token=secret' }] }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'http://169.254.169.254/' }] }).success).toBe(false);
  });

  it('rejects non-canonical machine map keys instead of collapsing them', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin:providers:p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    expect(ProviderConnectionV1Schema.safeParse({
      ...base,
      endpointOverridesByMachineId: {
        machine_a: [{ endpointTemplateId: 'chat', baseUrl: 'https://a.example/v1' }],
        ' machine_a ': [{ endpointTemplateId: 'chat', baseUrl: 'https://wrong.example/v1' }],
      },
    }).success).toBe(false);
  });

  it('bounds per-machine endpoint override branches at the shared settings limit', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin:providers:p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    const atLimit = Object.fromEntries(Array.from({ length: 2_048 }, (_, index) => [`machine-${index}`, []]));
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverridesByMachineId: atLimit }).success).toBe(true);
    expect(ProviderConnectionV1Schema.safeParse({
      ...base, endpointOverridesByMachineId: { ...atLimit, 'machine-over': [] },
    }).success).toBe(false);
  });

  it('enforces embedded custom-template override references for account and machine scopes', () => {
    const custom = {
      v: 1, id: 'pc_custom',
      source: {
        kind: 'custom',
        template: {
          v: 1, name: 'Custom',
          endpointTemplates: [{
            id: 'chat', protocol: 'openai-chat', baseUrl: 'https://example.test/v1',
            capabilities: { streaming: 'unknown', toolRoundTrips: 'unknown', statefulResponses: 'unknown', reasoningControls: 'unknown' },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
      },
      role: 'named', displayName: 'Custom', displayNameMode: 'custom', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    expect(ProviderConnectionV1Schema.safeParse({
      ...custom,
      endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://override.example/v1' }],
      endpointOverridesByMachineId: {
        machine_a: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/' }],
      },
    }).success).toBe(true);
    expect(ProviderConnectionV1Schema.safeParse({
      ...custom,
      endpointOverrides: [{ endpointTemplateId: 'missing', baseUrl: 'https://override.example/v1' }],
    }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({
      ...custom,
      endpointOverridesByMachineId: {
        machine_a: [{ endpointTemplateId: 'missing', baseUrl: 'http://127.0.0.1:1234/' }],
      },
    }).success).toBe(false);
  });
});
