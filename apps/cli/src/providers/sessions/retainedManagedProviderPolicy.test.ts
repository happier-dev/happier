import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderConnectionIdSchema,
  ProviderRuntimeBindingBasisV1Schema,
  ProviderSettingsV1Schema,
  createProviderMachineGrantFingerprintV1,
  type ProviderSettingsV1,
} from '@happier-dev/protocol';

import { isRetainedManagedProviderSettingsGrantCurrent } from './retainedManagedProviderPolicy';

const connectionId = ProviderConnectionIdSchema.parse('pc_retained');
const machineId = 'machine-1';
const contributionKey = 'acme.gateway/provider';
const connectionSecurityFingerprint = 'connection-security:v1:retained-p';
const machineGrant = Object.freeze({
  v: 1 as const,
  machineId,
  connectionId,
  endpointSetFingerprint: 'endpoint-set:v1:retained-p',
  connectionSecurityFingerprint,
  confirmedAt: 1,
});
const runtimeBindingBasis = ProviderRuntimeBindingBasisV1Schema.parse({
  v: 1,
  agentTargetKey: 'agent:fixture',
  connectionId,
  contributionKey,
  runtimeCredentialTransport: null,
  prepared: { v: 1, materialization: 'spawnEnv' },
  adapterVersion: 1,
  agentSupport: {
    acceptsProtocols: ['openai-responses'],
    required: { streaming: true },
    credentialSupport: { supportsNoAuth: true, apiKeyTransports: [] },
    materialization: 'spawnEnv',
    supportsFreeformModelIds: true,
    authIsolation: { ownedEnvKeys: [], suppressConnectedServiceIds: [] },
    applyPolicy: 'restart_session',
  },
  deployment: {
    kind: 'managedLocal',
    implementationIdentity: {
      pluginId: 'acme.wrapper',
      localId: 'managed-runtime',
    },
    managedRuntime: {
      kind: 'managed',
      dependencies: [],
      endpointTemplateIds: ['responses'],
      connectedAccounts: [],
      requestAuthUses: [],
    },
    purposeBindings: { v: 1, bindings: [] },
  },
  endpoint: {
    endpointTemplateId: 'responses',
    protocol: 'openai-responses',
    publicHeaders: {},
  },
  credentialAuthorization: {
    connectionSecurityFingerprint,
    grantFingerprint: createProviderMachineGrantFingerprintV1(machineGrant),
  },
});

function settings(
  overrides: Partial<ProviderSettingsV1> = {},
): ProviderSettingsV1 {
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [{
      v: 1,
      id: connectionId,
      source: { kind: 'contribution', contributionKey },
      role: 'default',
      displayName: 'Retained Provider',
      displayNameMode: 'automatic',
      deployment: { kind: 'managedLocal' },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }],
    machineGrants: [machineGrant],
    ...overrides,
  });
}

describe('retained managed Provider settings/grant policy', () => {
  it('keeps exact adopted P authorized when current Q removes or changes its declaration', () => {
    expect(isRetainedManagedProviderSettingsGrantCurrent({
      machineId,
      providerSettings: settings(),
      runtimeBindingBasis,
    })).toBe(true);
  });

  it.each([
    {
      label: 'connection removal',
      providerSettings: settings({ connections: [], machineGrants: [] }),
    },
    {
      label: 'connection source replacement',
      providerSettings: settings({
        connections: [{
          ...settings().connections[0]!,
          source: {
            kind: 'contribution' as const,
            contributionKey: 'acme.successor/provider',
          },
        }],
      }),
    },
    {
      label: 'managed deployment removal',
      providerSettings: settings({
        connections: [{
          ...settings().connections[0]!,
          deployment: { kind: 'external' as const },
        }],
      }),
    },
    {
      label: 'grant removal',
      providerSettings: settings({ machineGrants: [] }),
    },
    {
      label: 'grant security drift',
      providerSettings: settings({
        machineGrants: [{
          ...machineGrant,
          connectionSecurityFingerprint:
            'connection-security:v1:changed',
        }],
      }),
    },
  ])('fails closed for $label without consulting current Q', ({ providerSettings }) => {
    expect(isRetainedManagedProviderSettingsGrantCurrent({
      machineId,
      providerSettings,
      runtimeBindingBasis,
    })).toBe(false);
  });
});
