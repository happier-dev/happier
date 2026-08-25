import {
  createProviderManagedProbeRequestFingerprintV1,
  ProviderConnectionIdSchema,
  resolveProviderManagedRuntimeDeclarationV1,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

import { isExactManagedCatalogLaunch } from './managedRuntime';

describe('managed Provider catalog launch identity', () => {
  it('accepts canonically equal purpose bindings regardless of array order', () => {
    const implementationIdentity = {
      pluginId: 'happier.provider.example',
      localId: 'example',
    } as const;
    const connectionId = ProviderConnectionIdSchema.parse('pc_example');
    const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
      implementationIdentity,
      managedRuntime: {
        kind: 'managed',
        dependencies: ['example-runtime'],
        endpointTemplateIds: ['responses'],
        connectedAccounts: [],
        requestAuthUses: [],
      },
    });
    const bindings = {
      v: 1 as const,
      bindings: [
        {
          purpose: { consumer: implementationIdentity, purpose: 'first' },
          target: {
            kind: 'account' as const,
            account: {
              service: { pluginId: 'happier.connected-account.example', localId: 'example' },
              accountId: 'account-a',
            },
          },
        },
        {
          purpose: { consumer: implementationIdentity, purpose: 'second' },
          target: {
            kind: 'account' as const,
            account: {
              service: { pluginId: 'happier.connected-account.example', localId: 'example' },
              accountId: 'account-b',
            },
          },
        },
      ],
    };
    const source = {
      implementationIdentity,
      managedRuntime,
      purposeBindings: bindings,
      endpointTemplateId: 'responses',
      protocol: 'openai-responses' as const,
      publicHeaders: {},
    };
    const fingerprint = createProviderManagedProbeRequestFingerprintV1({
      ...source,
      method: 'GET',
      path: '/models',
      parser: 'openai-models',
    });
    const reorderedBindings = {
      ...bindings,
      bindings: [...bindings.bindings].reverse(),
    };

    const launch = {
      source,
      request: {
        deployment: 'managedLocal',
        connectionId,
        machineId: 'machine-a',
        implementationIdentity,
        managedRuntime,
        purposeBindings: reorderedBindings,
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        path: '/models',
        parser: 'openai-models',
        probeRequestFingerprint: fingerprint,
      },
      ticket: {
        deployment: 'managedLocal',
        connectionId,
        connectionRevision: 1,
        machineId: 'machine-a',
        connectionSecurityFingerprint: 'connection:v1:example',
        endpointSetFingerprint: 'endpoints:v1:example',
        grantFingerprint: 'grant:v1:example',
        connectionScope: 'machine',
        contributionKey: 'happier.provider.example/example',
        implementationIdentity,
        managedRuntime,
        purposeBindings: bindings,
        endpointTemplateId: 'responses',
        protocol: 'openai-responses',
        path: '/models',
        parser: 'openai-models',
        probeRequestFingerprint: fingerprint,
      },
    } as const;

    expect(isExactManagedCatalogLaunch(launch)).toBe(true);
    expect(isExactManagedCatalogLaunch({
      ...launch,
      ticket: { ...launch.ticket, path: '/other-models' },
    })).toBe(false);
  });
});
