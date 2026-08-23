import { describe, expect, it } from 'vitest';

import { PROVIDER_WIRE_PROTOCOL_LIMITS_V1 } from '../capabilities/v1.js';
import { ProviderConnectionV1Schema } from './v1.js';

describe('ProviderConnectionV1Schema endpoint overrides', () => {
  it('defaults legacy connections to external deployment and bounds managed deployment to contribution-backed connections without endpoint overrides', () => {
    const contribution = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    expect(ProviderConnectionV1Schema.parse(contribution).deployment).toEqual({ kind: 'external' });
    expect(ProviderConnectionV1Schema.parse({
      ...contribution,
      deployment: { kind: 'managedLocal' },
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    }).deployment).toEqual({ kind: 'managedLocal' });
    expect(ProviderConnectionV1Schema.safeParse({
      ...contribution,
      deployment: { kind: 'managedLocal' },
    }).success).toBe(true);
    expect(ProviderConnectionV1Schema.safeParse({
      ...contribution,
      purposeBindingDefaults: {
        upstream: {
          kind: 'account',
          account: {
            service: {
              pluginId: 'happier.connected-account.example',
              localId: 'example',
            },
            accountId: 'account-a',
          },
        },
      },
    }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({
      ...contribution,
      deployment: { kind: 'managedLocal' },
      endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1' }],
    }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({
      ...contribution,
      deployment: { kind: 'managedLocal' },
      endpointOverridesByMachineId: {
        machine_a: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/' }],
      },
    }).success).toBe(false);

    const custom = {
      ...contribution,
      id: 'pc_custom',
      source: {
        kind: 'custom',
        template: {
          v: 1,
          name: 'Custom',
          endpointTemplates: [{
            id: 'chat',
            protocol: 'openai-chat',
            baseUrl: 'https://example.test/v1',
            capabilities: {
              streaming: 'unknown',
              toolRoundTrips: 'unknown',
              statefulResponses: 'unknown',
              reasoningControls: 'unknown',
            },
          }],
          catalog: { source: 'manual', manualModelPolicy: 'allowed' },
        },
      },
      role: 'named',
      displayNameMode: 'custom',
      deployment: { kind: 'managedLocal' },
    } as const;
    expect(ProviderConnectionV1Schema.safeParse(custom).success).toBe(false);
  });

  it('normalizes safe endpoint overrides and rejects credential-bearing or unsafe URLs', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    expect(ProviderConnectionV1Schema.parse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://EXAMPLE.test:443/v1' }] }).endpointOverrides)
      .toEqual([{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1' }]);
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'https://example.test/v1?token=secret' }] }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: [{ endpointTemplateId: 'chat', baseUrl: 'http://169.254.169.254/' }] }).success).toBe(false);
  });

  it('rejects non-canonical machine map keys instead of collapsing them', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin/p' },
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

  it('accepts per-machine endpoint override branches beyond the retired global count', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    const atLimit = Object.fromEntries(Array.from({ length: 2_048 }, (_, index) => [`machine-${index}`, []]));
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverridesByMachineId: atLimit }).success).toBe(true);
    expect(ProviderConnectionV1Schema.safeParse({
      ...base, endpointOverridesByMachineId: { ...atLimit, 'machine-over': [] },
    }).success).toBe(true);
  });

  it('admits one endpoint override per endpoint a contribution-backed Provider may declare', () => {
    const base = {
      v: 1, id: 'pc_1', source: { kind: 'contribution', contributionKey: 'plugin/p' },
      role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    } as const;
    // A contribution declares up to `maxProtocolsPerDeclaration` endpoint templates, one per
    // wire protocol. The persisted override contract must reach every one of them, otherwise a
    // Provider the platform admits cannot have all of its endpoints overridden.
    const overrides = Array.from(
      { length: PROVIDER_WIRE_PROTOCOL_LIMITS_V1.maxProtocolsPerDeclaration },
      (_, index) => ({ endpointTemplateId: `endpoint-${index}`, baseUrl: `https://example.test/v${index}` }),
    );
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: overrides }).success).toBe(true);
    expect(ProviderConnectionV1Schema.safeParse({
      ...base, endpointOverridesByMachineId: { machine_a: overrides },
    }).success).toBe(true);

    const over = [...overrides, { endpointTemplateId: 'endpoint-over', baseUrl: 'https://example.test/over' }];
    expect(ProviderConnectionV1Schema.safeParse({ ...base, endpointOverrides: over }).success).toBe(false);
    expect(ProviderConnectionV1Schema.safeParse({
      ...base, endpointOverridesByMachineId: { machine_a: over },
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
