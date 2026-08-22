import { describe, expect, it } from 'vitest';

import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  SessionOwnerMetadataV1Schema,
} from '@happier-dev/protocol';
import type { Credentials } from '@/persistence';
import type { ResolvedContributionRegistry } from '@/plugins/projection/registry/types';
import { buildCliSessionRowModel as buildCliSessionRowModelOwner } from './buildCliSessionRowModel';

const credentials: Credentials = {
  token: 'token',
  encryption: {
    type: 'legacy',
    secret: new Uint8Array([1, 2, 3]),
  },
};

function buildCliSessionRowModel(
  params: Omit<
    Parameters<typeof buildCliSessionRowModelOwner>[0],
    'accountEncryptionMode'
  > & Partial<Pick<
    Parameters<typeof buildCliSessionRowModelOwner>[0],
    'accountEncryptionMode'
  >>,
) {
  return buildCliSessionRowModelOwner({
    ...params,
    accountEncryptionMode: params.accountEncryptionMode ?? 'plain',
  });
}

function createContributionRegistry(): Pick<ResolvedContributionRegistry, 'agentDefinitionsById'> {
    return {
      agentDefinitionsById: new Map([
      ['pluginProvider', {
        id: 'pluginProvider',
        identity: {
          pluginId: 'acme.plugin-provider',
          localId: 'plugin-provider',
        },
        provenance: 'external',
        source: { kind: 'path' },
        definition: {},
        // The real projection: a contributed Agent's native-resume support is a
        // catalog-entry fact. `PluginAgentContributionV2` is strict and has no
        // `session` block, so a definition-local resume declaration is a shape
        // no manifest can produce.
        catalogEntry: { vendorResumeSupport: 'supported' },
        richDefinition: {
          provenance: 'external',
          definition: {
            capabilities: { surfaces: ['terminal', 'externalSessions'] },
            surfaces: {
              externalSession: {
                sources: [{ sourceKind: 'pluginTranscript' }],
              },
            },
          },
        },
      }],
    ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
      };
}

function createAntigravityContributionRegistry(): Pick<ResolvedContributionRegistry, 'agentDefinitionsById'> {
  return {
    agentDefinitionsById: new Map([
      ['antigravity', {
        id: 'antigravity',
        identity: {
          pluginId: 'happier.agent.antigravity',
          localId: 'antigravity',
        },
        provenance: 'first_party',
        source: { kind: 'bundled' },
        definition: {},
        richDefinition: {
          provenance: 'first_party',
          definition: {
            capabilities: { surfaces: ['terminal', 'externalSessions'] },
            surfaces: {
              externalSession: {
                sources: [{
                  sourceKind: 'antigravityCliPrint',
                }],
              },
            },
          },
        },
      }],
    ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
  };
}

describe('buildCliSessionRowModel', () => {
  it('keeps shared presentation fields while withholding owner-only fields from a layout-v1 recipient', () => {
    const rowModel = buildCliSessionRowModel({
      credentials: {
        token: 'recipient-token',
        encryption: null,
      },
      rawSession: {
        id: 'sess_layout_v1_recipient',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadataLayoutVersion: 1,
        metadata: JSON.stringify({
          v: 1,
          summary: { text: 'Recipient-safe title', updatedAt: 2 },
          agentPresentation: { agentId: 'acme.presentation-agent' },
        }),
        ownerMetadata: null,
        share: {
          accessLevel: 'admin',
          canApprovePermissions: true,
        },
      } as any,
      contributionRegistry: createContributionRegistry(),
    });

    expect(rowModel).toMatchObject({
      agentId: 'acme.presentation-agent',
      title: 'Recipient-safe title',
      path: null,
      isSystem: false,
      systemPurpose: null,
      vendorResume: { eligible: false },
    });
  });

  it('reads private path and native resume identity from a layout-v1 owner envelope', () => {
    const ownerCredentials = {
      token: 'owner-token',
      encryption: {
        type: 'legacy',
        secret: new Uint8Array(32).fill(17),
      },
    } satisfies Credentials;
    const ownerMetadata = SessionOwnerMetadataV1Schema.parse({
      v: 1,
      workspace: {
        path: '/private/layout-v1-worktree',
        host: 'private-host',
        flavor: 'pluginProvider',
      },
      nativeSession: {
        runtimeDescriptorV1: {
          v: 1,
          agentId: 'pluginProvider',
          providerSessionId: 'private-plugin-session',
        },
      },
    });

    const rawSession = {
      id: 'sess_layout_v1_owner',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadataLayoutVersion: 1,
      metadata: JSON.stringify({
        v: 1,
        summary: { text: 'Recipient-safe title', updatedAt: 2 },
      }),
      ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(ownerMetadata),
    } as any;
    const rowModel = buildCliSessionRowModel({
      credentials: ownerCredentials,
      rawSession,
      contributionRegistry: createContributionRegistry(),
    });

    expect(rowModel).toMatchObject({
      path: '/private/layout-v1-worktree',
      title: 'Recipient-safe title',
      vendorResume: {
        eligible: true,
        vendorResumeId: 'private-plugin-session',
      },
    });

    const unreadableRowModel = buildCliSessionRowModel({
      credentials: ownerCredentials,
      rawSession: {
        ...rawSession,
        ownerMetadata: {
          t: 'encrypted',
          c: 'not-owner-ciphertext',
        },
      },
      contributionRegistry: createContributionRegistry(),
    });
    expect(unreadableRowModel).toMatchObject({
      title: 'Recipient-safe title',
      path: null,
      vendorResume: { eligible: false },
    });
  });

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
            agentId: 'pluginProvider',
            provider: {
              backendMode: 'server',
              providerSessionId: 'canonical-plugin-session',
            },
          },
          agentRuntimeDescriptorV1: {
            v: 1,
            agentId: 'legacyPluginProvider',
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

  /**
   * A contributed Agent has no generated `<vendor>SessionId` slot and
   * `PluginAgentContributionV2` is strict — it declares no definition-local
   * resume block — so its native conversation id can only live in the
   * agent-agnostic runtime-descriptor slot. The listing must resolve it from
   * there through the shared owner, or it reports a Session as resumable that
   * the daemon will respawn fresh.
   */
  it('resolves a contributed Agent resume id from the runtime descriptor slot', () => {
    const buildRow = (agentPayload: Record<string, unknown>) => buildCliSessionRowModel({
      credentials,
      rawSession: {
        id: 'sess_configured_plugin_1',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.resume.backend',
            agent: agentPayload,
          },
        }),
      } as any,
      contributionRegistry: {
        agentDefinitionsById: new Map([
          ['acme.resume.backend', {
            id: 'acme.resume.backend',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {},
            catalogEntry: { vendorResumeSupport: 'supported' },
          }],
        ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
      },
    });

    expect(buildRow({ backendMode: 'acp', providerSessionId: 'plugin-vendor-session-1' }).vendorResume)
      .toEqual({ eligible: true, vendorResumeId: 'plugin-vendor-session-1' });
    // Nothing else in metadata may stand in for the recorded conversation.
    expect(buildRow({ backendMode: 'acp' }).vendorResume)
      .toEqual({ eligible: false, reasonCode: 'vendor_resume_id_missing' });
  });

  it('refuses a contributed Agent whose catalog declares no native resume support', () => {
    const rowModel = buildCliSessionRowModel({
      credentials,
      rawSession: {
        id: 'sess_configured_plugin_2',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'acme.resume.backend',
            agent: { backendMode: 'acp', providerSessionId: 'plugin-vendor-session-1' },
          },
        }),
      } as any,
      contributionRegistry: {
        agentDefinitionsById: new Map([
          ['acme.resume.backend', {
            id: 'acme.resume.backend',
            provenance: 'external',
            source: { kind: 'path' },
            definition: {},
            catalogEntry: { vendorResumeSupport: 'unsupported' },
          }],
        ]) as unknown as ResolvedContributionRegistry['agentDefinitionsById'],
      },
    });

    expect(rowModel.vendorResume).toEqual({ eligible: false, reasonCode: 'agent_unsupported' });
  });

  it('fails closed before CLI dispatch when linked resume identity is stale', () => {
    const rowModel = buildCliSessionRowModel({
      credentials,
      rawSession: {
        id: 'sess_linked_antigravity_1',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'antigravity',
          antigravitySessionId: 'stale-conversation',
          externalSessionV1: {
            v: 1,
            agentId: 'antigravity',
            machineId: 'machine-1',
            remoteSessionId: 'conversation-1',
            source: {
              kind: 'antigravityCliPrint',
              brainDir: '/tmp/antigravity-brain',
            },
            qualifiedIdentity: {
              v: 1,
              agent: {
                pluginId: 'happier.agent.antigravity',
                localId: 'antigravity',
              },
              source: {
                kind: 'antigravityCliPrint',
                contractVersion: 1,
              },
            },
          },
        }),
      } as any,
      contributionRegistry: createAntigravityContributionRegistry(),
    });

    expect(rowModel.vendorResume).toEqual({
      eligible: false,
      reasonCode: 'linked_session_identity_unverified',
    });
  });

  it('allows CLI linked resume when the persisted link matches the current contribution', () => {
    const rowModel = buildCliSessionRowModel({
      credentials,
      rawSession: {
        id: 'sess_linked_antigravity_2',
        createdAt: 1,
        updatedAt: 2,
        active: false,
        activeAt: 0,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({
          flavor: 'antigravity',
          antigravitySessionId: 'conversation-1',
          externalSessionV1: {
            v: 1,
            agentId: 'antigravity',
            machineId: 'machine-1',
            remoteSessionId: 'conversation-1',
            source: {
              kind: 'antigravityCliPrint',
              brainDir: '/tmp/antigravity-brain',
            },
            qualifiedIdentity: {
              v: 1,
              agent: {
                pluginId: 'happier.agent.antigravity',
                localId: 'antigravity',
              },
              source: {
                kind: 'antigravityCliPrint',
                contractVersion: 1,
              },
            },
          },
        }),
      } as any,
      contributionRegistry: createAntigravityContributionRegistry(),
    });

    expect(rowModel.vendorResume).toEqual({
      eligible: true,
      vendorResumeId: 'conversation-1',
    });
  });

  it('applies the linked identity fence to configured plugin vendor resume', () => {
    const metadata = {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'pluginProvider',
        provider: {
          providerSessionId: 'plugin-session-1',
        },
      },
      pluginSessionId: 'plugin-session-1',
      externalSessionV1: {
        v: 1,
        agentId: 'pluginProvider',
        machineId: 'machine-1',
        remoteSessionId: 'plugin-session-1',
        source: {
          kind: 'pluginTranscript',
        },
        qualifiedIdentity: {
          v: 1,
            agent: {
              pluginId: 'replacement.plugin-provider',
              localId: 'plugin-provider',
          },
          source: {
            kind: 'pluginTranscript',
            contractVersion: 1,
          },
        },
      },
    };
    const rawSession = {
      id: 'sess_linked_plugin_1',
      createdAt: 1,
      updatedAt: 2,
      active: false,
      activeAt: 0,
      archivedAt: null,
      encryptionMode: 'plain',
      metadata: JSON.stringify(metadata),
    } as any;

    expect(buildCliSessionRowModel({
      credentials,
      rawSession,
      contributionRegistry: createContributionRegistry(),
    }).vendorResume).toEqual({
      eligible: false,
      reasonCode: 'linked_session_identity_unverified',
    });

    expect(buildCliSessionRowModel({
      credentials,
      rawSession: {
        ...rawSession,
        metadata: JSON.stringify({
          ...metadata,
          externalSessionV1: {
            ...metadata.externalSessionV1,
            qualifiedIdentity: {
              ...metadata.externalSessionV1.qualifiedIdentity,
              agent: {
                pluginId: 'acme.plugin-provider',
                localId: 'plugin-provider',
              },
            },
          },
        }),
      },
      contributionRegistry: createContributionRegistry(),
    }).vendorResume).toEqual({
      eligible: true,
      vendorResumeId: 'plugin-session-1',
    });
  });
});
