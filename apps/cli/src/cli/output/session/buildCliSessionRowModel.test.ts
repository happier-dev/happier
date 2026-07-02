import { describe, expect, it } from 'vitest';

import type { Credentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { buildCliSessionRowModel } from './buildCliSessionRowModel';

const credentials: Credentials = {
  token: 'token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3]),
  },
};

function createContributionRegistry(): Pick<ResolvedContributionRegistry, 'providerDefinitionsById' | 'backendDefinitionsById'> {
    return {
      providerDefinitionsById: new Map([
      ['pluginProvider', {
        id: 'pluginProvider',
        provenance: 'external',
        source: { kind: 'path' },
        definition: {},
        richDefinition: {
          provenance: 'external',
          definition: {
            session: {
              resume: {
                supportLevel: 'supported',
              },
            },
          },
        },
      }],
    ]) as unknown as ResolvedContributionRegistry['providerDefinitionsById'],
    backendDefinitionsById: new Map(),
  };
}

describe('buildCliSessionRowModel', () => {
  it('prefers canonical runtimeDescriptorV1 over legacy agentRuntimeDescriptorV1 for plugin vendor resume eligibility', () => {
    const rowModel = buildCliSessionRowModel({
      credentials,
      rawSession: {
        id: 'sess_1',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          runtimeDescriptorV1: {
            v: 1,
            providerId: 'pluginProvider',
            provider: {
              backendMode: 'server',
              providerSessionId: 'canonical-plugin-session',
            },
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            providerId: 'legacyPluginProvider',
            provider: {
              backendMode: 'server',
              providerSessionId: 'legacy-plugin-session',
            },
          },
        }),
      } as any,
      contributionRegistry: createContributionRegistry(),
    });

    expect(rowModel.vendorResume).toEqual({
      eligible: true,
      vendorResumeId: 'canonical-plugin-session',
    });
  });
});
