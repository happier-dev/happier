import { describe, expect, it } from 'vitest';

import { TeamResourceConnectedServiceSelectionV2Schema } from '../../connect/connectedServiceBindings.js';

import {
  TeamCredentialDeliveryModeV1Schema,
  TeamCredentialDisclosureCeilingV1Schema,
  TeamCredentialSessionUsePolicyV1Schema,
  TeamCredentialSourceBindingV1Schema,
  TeamCredentialResourceActivityEventV1Schema,
  TeamCredentialResourceActivityReadInputV1Schema,
  TeamCredentialResourceActivityPageV1Schema,
  TeamCredentialResourcePageV1Schema,
  TeamCredentialResourceListInputV1Schema,
  decodeTeamCredentialResourcesCursorV1,
  encodeTeamCredentialResourcesCursorV1,
  teamCredentialResourcesQueryKeyV1,
  TeamCredentialResourceCatalogEntryV1Schema,
  TeamCredentialProviderModelCatalogEntryV1Schema,
  TeamCredentialProviderModelSelectionV1Schema,
  TeamCredentialRequestPolicyV1Schema,
  TeamCredentialRequestPolicySupportInputV1Schema,
  TeamCredentialRequestPolicySupportOutputV1Schema,
  TeamCredentialResourceEntitledPageV1Schema,
  TeamCredentialResourceReadInputV1Schema,
  TeamCredentialResourceDiscoverInputV1Schema,
  TeamCredentialResourceDiscoveryPageV1Schema,
  TeamCredentialResourceGetInputV1Schema,
  TeamCredentialBrokerPlacementV1Schema,
  TeamCredentialResourceUpdateInputV1Schema,
  TeamCredentialResourceCreateInputV1Schema,
  TeamCredentialErrorCodeV1Schema,
  TeamCredentialResourceErrorV1Schema,
  teamCredentialErrorHttpStatusV1,
} from './index.js';

const service = {
  pluginId: 'happier.connected-account.test',
  localId: 'subscription',
} as const;

describe('TeamResourceConnectedServiceSelectionV2Schema', () => {
  it('accepts only the Session-owned resource selection facts for brokered and direct use', () => {
    expect(TeamResourceConnectedServiceSelectionV2Schema.parse({
      source: 'team_resource',
      resourceId: 'resource-1',
      deliveryMode: 'brokered',
    })).toEqual({
      source: 'team_resource',
      resourceId: 'resource-1',
      deliveryMode: 'brokered',
    });
    expect(TeamResourceConnectedServiceSelectionV2Schema.parse({
      source: 'team_resource',
      resourceId: 'resource-1',
      deliveryMode: 'direct',
      disclosedMember: {
        service,
        accountId: 'disclosed-account',
      },
    })).toEqual({
      source: 'team_resource',
      resourceId: 'resource-1',
      deliveryMode: 'direct',
      disclosedMember: {
        service,
        accountId: 'disclosed-account',
      },
    });
    expect(TeamResourceConnectedServiceSelectionV2Schema.safeParse({
      source: 'team_resource',
      resourceId: 'resource-1',
      teamId: 'team-1',
      expectedResourceRevision: 7,
      sourceMemberKey: 'private-source-member',
      sourceVersion: 'private-source-version',
    }).success).toBe(false);
  });
});

const validSources = [
  {
    v: 1,
    kind: 'connected_account',
    target: {
      kind: 'account',
      account: { service, accountId: 'work' },
    },
    credentialIncarnation: 'cm123',
  },
  {
    v: 1,
    kind: 'connected_pool',
    target: {
      kind: 'group',
      service,
      groupId: 'fallbacks',
    },
    poolIncarnation: 'pool-life-1',
  },
  {
    v: 1,
    kind: 'provider_connection',
    connectionId: 'connection-1',
    connectionSecurityFingerprint: 'connection-security:v1:test',
    credentialSlotId: 'api-key',
  },
] as const;

describe('TeamCredentialResourceCreateInputV1Schema', () => {
  it('requires the complete one-save draft and accepts audience, placement, policy, and limits together', () => {
    const narrow = { teamId: 'team-1', resourceId: 'resource-1', displayName: 'Shared', source: validSources[0], disclosureCeiling: 'brokered_only' };
    expect(TeamCredentialResourceCreateInputV1Schema.safeParse(narrow).success).toBe(false);
    expect(TeamCredentialResourceCreateInputV1Schema.parse({
      ...narrow,
      sessionUsePolicy: 'team_context_required',
      brokerPlacement: { kind: 'machine', machineId: 'machine-1' },
      requestPolicy: { allowedProtocolKinds: ['openai_responses'], allowedModelIds: ['gpt-5'], reasoningEffort: null },
      allMembersDeliveryMode: 'brokered',
      groupGrants: [{ teamGroupId: 'group-1', deliveryMode: 'brokered' }],
      memberGrants: [{ teamMembershipId: 'membership-1', deliveryMode: 'brokered' }],
      usageLimits: [{ subjectKind: 'resource', subjectId: '', period: 'month', metric: 'inference_requests', maximum: '100', enabled: true }],
    })).toMatchObject({ sessionUsePolicy: 'team_context_required', allMembersDeliveryMode: 'brokered' });
  });
});

describe('TeamCredentialRequestPolicyV1Schema', () => {
  it('carries no caller-authored output or thinking token bound', () => {
    const policy = {
      allowedProtocolKinds: ['openai_responses'] as const,
      allowedModelIds: ['gpt-5'],
      reasoningEffort: null,
    };
    expect(TeamCredentialRequestPolicyV1Schema.parse(policy)).toEqual(policy);
    expect(TeamCredentialRequestPolicyV1Schema.safeParse({ ...policy, maxOutputTokens: 4096 }).success).toBe(false);
    expect(TeamCredentialRequestPolicyV1Schema.safeParse({ ...policy, maxThinkingBudgetTokens: 4096 }).success).toBe(false);
  });
});

describe('Team credential request-policy support projection', () => {
  const application = {
    agentTargetKey: 'agent:happier.agent.codex/codex',
    implementationIdentity: { pluginId: 'happier.provider.openai', localId: 'openai' },
    endpointTemplateId: 'responses',
    protocol: 'openai-responses',
  } as const;

  it('accepts one exact source draft or one existing resource and keeps the request closed', () => {
    expect(TeamCredentialRequestPolicySupportInputV1Schema.parse({
      scope: 'source_draft',
      teamId: 'team-1',
      source: validSources[0],
      brokerPlacement: { kind: 'machine', machineId: 'machine-1' },
    })).toMatchObject({ scope: 'source_draft', teamId: 'team-1' });
    expect(TeamCredentialRequestPolicySupportInputV1Schema.parse({
      scope: 'resource', resourceId: 'resource-1',
    })).toMatchObject({ scope: 'resource', resourceId: 'resource-1' });
    expect(TeamCredentialRequestPolicySupportInputV1Schema.safeParse({
      scope: 'resource', resourceId: 'resource-1', source: validSources[0],
    }).success).toBe(false);
    expect(TeamCredentialRequestPolicySupportInputV1Schema.safeParse({
      scope: 'resource', resourceId: 'resource-1', application,
    }).success).toBe(false);
  });

  it('returns only value-free model capability facts and rejects private topology or material', () => {
    const output = TeamCredentialRequestPolicySupportOutputV1Schema.parse({
      status: 'available',
      models: [{
        descriptor: {
          id: 'gpt-5', name: 'GPT-5',
          capabilities: { reasoningControls: 'supported' },
          modelOptions: [{
            id: 'reasoning_effort', name: 'Effort', type: 'select', currentValue: 'medium',
            options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }],
          }],
        },
        application,
        sourceRevision: 'source-revision-1',
        allowedProtocolKinds: ['openai_responses'],
        reasoningEffort: { allowedValues: ['low', 'medium'], defaultValue: 'medium' },
      }],
    });
    expect(output.status).toBe('available');
    expect(TeamCredentialRequestPolicySupportOutputV1Schema.safeParse({
      ...output,
      models: [{ ...output.models[0], maxOutputTokens: { maximum: 4096 } }],
    }).success).toBe(false);
    expect(TeamCredentialRequestPolicySupportOutputV1Schema.safeParse({
      ...output,
      models: [{ ...output.models[0], maxThinkingBudgetTokens: { minimum: 1024, maximum: 4096 } }],
    }).success).toBe(false);
    expect(TeamCredentialRequestPolicySupportOutputV1Schema.safeParse({
      ...output,
      models: [{ ...output.models[0], machineId: 'private-machine' }],
    }).success).toBe(false);
    expect(TeamCredentialRequestPolicySupportOutputV1Schema.safeParse({
      ...output,
      models: [{ ...output.models[0], credential: 'secret' }],
    }).success).toBe(false);
    expect(TeamCredentialRequestPolicySupportOutputV1Schema.parse({
      status: 'unavailable', reason: 'source_unavailable',
    })).toEqual({ status: 'unavailable', reason: 'source_unavailable' });
  });
});

describe('TeamCredentialSourceBindingV1Schema', () => {
  it.each(validSources)('accepts the closed $kind source arm', (source) => {
    expect(TeamCredentialSourceBindingV1Schema.parse(source)).toEqual(source);
  });

  it('rejects source kinds paired with the wrong qualified target arm', () => {
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[0],
      target: validSources[1].target,
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[1],
      target: validSources[0].target,
    }).success).toBe(false);
  });

  it.each([
    { ...validSources[0], credentialRevision: 4 },
    { ...validSources[0], custodianAccountId: 'account-1' },
    { ...validSources[1], generation: 7 },
    { ...validSources[1], activeConnectedAccountId: 'work' },
    { ...validSources[2], connectionRevision: 3 },
    { ...validSources[2], requestPolicy: { allowedModelIds: ['model-1'] } },
  ])('rejects extra source authority fields', (source) => {
    expect(TeamCredentialSourceBindingV1Schema.safeParse(source).success).toBe(false);
  });

  it('uses the existing source identity bounds', () => {
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[0],
      credentialIncarnation: '',
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[0],
      target: {
        ...validSources[0].target,
        account: {
          ...validSources[0].target.account,
          accountId: 'x'.repeat(257),
        },
      },
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[1],
      poolIncarnation: 'x'.repeat(129),
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[2],
      connectionSecurityFingerprint: 'x'.repeat(257),
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[2],
      connectionId: 'x'.repeat(257),
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[2],
      connectionSecurityFingerprint: 'binding-security:v1:test',
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[2],
      credentialSlotId: 'api key',
    }).success).toBe(false);
    expect(TeamCredentialSourceBindingV1Schema.safeParse({
      ...validSources[2],
      credentialSlotId: 'x'.repeat(129),
    }).success).toBe(false);
  });
});

describe('team credential resource modes', () => {
  it('accepts only the plan-owned disclosure, session-use, and delivery values', () => {
    expect(TeamCredentialDisclosureCeilingV1Schema.options).toEqual([
      'brokered_only',
      'direct_allowed',
    ]);
    expect(TeamCredentialSessionUsePolicyV1Schema.options).toEqual([
      'personal_allowed',
      'team_context_required',
      'team_visibility_required',
    ]);
    expect(TeamCredentialDeliveryModeV1Schema.options).toEqual([
      'brokered',
      'direct',
      'both',
    ]);

    expect(TeamCredentialDisclosureCeilingV1Schema.safeParse('direct').success).toBe(false);
    expect(TeamCredentialSessionUsePolicyV1Schema.safeParse('team').success).toBe(false);
    expect(TeamCredentialDeliveryModeV1Schema.safeParse('none').success).toBe(false);
  });
});

describe('TeamCredentialBrokerPlacementV1Schema', () => {
  it('accepts one exact Machine xor one Machine Pool and keeps routing authority closed', () => {
    expect(TeamCredentialBrokerPlacementV1Schema.parse({
      kind: 'machine', machineId: 'machine-1',
    })).toEqual({ kind: 'machine', machineId: 'machine-1' });
    expect(TeamCredentialBrokerPlacementV1Schema.parse({
      kind: 'machine_pool', poolId: 'pool-1',
    })).toEqual({ kind: 'machine_pool', poolId: 'pool-1' });
    expect(TeamCredentialBrokerPlacementV1Schema.safeParse({
      kind: 'machine', machineId: 'machine-1', poolId: 'pool-1',
    }).success).toBe(false);
    expect(TeamCredentialBrokerPlacementV1Schema.safeParse({
      kind: 'machine_pool', poolId: 'pool-1', machineId: 'machine-1',
    }).success).toBe(false);
    expect(TeamCredentialResourceUpdateInputV1Schema.parse({
      resourceId: 'resource-1', expectedRevision: 2,
      brokerPlacement: { kind: 'machine_pool', poolId: 'pool-1' },
    }).brokerPlacement).toEqual({ kind: 'machine_pool', poolId: 'pool-1' });
  });
});

describe('TeamCredentialResourceUpdateInputV1Schema', () => {
  const replacement = {
    enabled: true,
    displayName: 'Shared provider',
    sessionUsePolicy: 'team_context_required' as const,
    requestPolicy: null,
    allMembersDeliveryMode: 'brokered' as const,
    groupGrants: [{ teamGroupId: 'group-1', deliveryMode: 'brokered' as const }],
    memberGrants: [{ teamMembershipId: 'membership-1', deliveryMode: 'brokered' as const }],
    usageLimitDelta: {
      upserts: [{
        id: 'limit-1', subjectKind: 'resource' as const, subjectId: '', period: 'month' as const,
        metric: 'inference_requests' as const, maximum: '100', enabled: true,
      }],
      deleteIds: ['limit-2'],
    },
    custodian: {
      source: {
        v: 1 as const,
        kind: 'provider_connection' as const,
        connectionId: 'connection-1',
        connectionSecurityFingerprint: 'connection-security:v1:test',
        credentialSlotId: 'apiKey',
      },
      disclosureCeiling: 'brokered_only' as const,
      brokerPlacement: { kind: 'machine' as const, machineId: 'machine-1' },
    },
  };

  it('accepts one strict complete replacement while retaining legacy patches', () => {
    expect(TeamCredentialResourceUpdateInputV1Schema.parse({
      resourceId: 'resource-1', expectedRevision: 2, replacement,
    }).replacement).toEqual(replacement);
    expect(TeamCredentialResourceUpdateInputV1Schema.safeParse({
      resourceId: 'resource-1', expectedRevision: 2,
      replacement: { ...replacement, custodian: undefined },
    }).success).toBe(true);
    expect(TeamCredentialResourceUpdateInputV1Schema.parse({
      resourceId: 'resource-1', expectedRevision: 2, displayName: 'Legacy patch',
    }).displayName).toBe('Legacy patch');
  });

  it('rejects partial replacements, unknown fields, duplicate deletes, and mixed mutation modes', () => {
    expect(TeamCredentialResourceUpdateInputV1Schema.safeParse({
      resourceId: 'resource-1', expectedRevision: 2,
      replacement: { ...replacement, custodian: { ...replacement.custodian, source: undefined } },
    }).success).toBe(false);
    expect(TeamCredentialResourceUpdateInputV1Schema.safeParse({
      resourceId: 'resource-1', expectedRevision: 2,
      replacement: { ...replacement, unexpected: true },
    }).success).toBe(false);
    expect(TeamCredentialResourceUpdateInputV1Schema.safeParse({
      resourceId: 'resource-1', expectedRevision: 2,
      replacement: { ...replacement, usageLimitDelta: { upserts: [], deleteIds: ['limit-1', 'limit-1'] } },
    }).success).toBe(false);
    expect(TeamCredentialResourceUpdateInputV1Schema.safeParse({
      resourceId: 'resource-1', expectedRevision: 2, displayName: 'Mixed', replacement,
    }).success).toBe(false);
  });
});

describe('TeamCredentialResourcePageV1Schema', () => {
  it('carries the viewer decision beside the rows so no client derives it', () => {
    const page = TeamCredentialResourcePageV1Schema.parse({
      resources: [],
      viewer: { manageCredentials: false, offerOwnCredential: true },
      nextCursor: null,
    });
    expect(page.viewer).toEqual({ manageCredentials: false, offerOwnCredential: true });
  });

  it('refuses a page whose viewer decision is absent or partial', () => {
    expect(TeamCredentialResourcePageV1Schema.safeParse({ resources: [] }).success).toBe(false);
    expect(TeamCredentialResourcePageV1Schema.safeParse({
      resources: [], viewer: { manageCredentials: true },
      nextCursor: null,
    }).success).toBe(false);
    // A role, or any other fact a client might use to reconstruct authority,
    // has no place in this projection.
    expect(TeamCredentialResourcePageV1Schema.safeParse({
      resources: [],
      viewer: { manageCredentials: true, offerOwnCredential: true, viewerRole: 'admin' },
      nextCursor: null,
    }).success).toBe(false);
  });

  it('binds an opaque stable-name cursor to the exact list query', () => {
    const input = TeamCredentialResourceListInputV1Schema.parse({
      teamId: 'team-1', search: 'Build', filter: 'needs_attention', limit: 2,
    });
    const queryKey = teamCredentialResourcesQueryKeyV1(input);
    const cursor = encodeTeamCredentialResourcesCursorV1({
      queryKey, displayName: 'Equal name', id: 'resource-2',
    });
    expect(decodeTeamCredentialResourcesCursorV1(cursor, queryKey)).toEqual({
      status: 'ok', cursor: { displayName: 'Equal name', id: 'resource-2' },
    });
    expect(decodeTeamCredentialResourcesCursorV1(
      cursor,
      teamCredentialResourcesQueryKeyV1({ ...input, search: 'Other' }),
    )).toEqual({ status: 'invalid' });
  });

  it('keeps recipient catalog rows least-privilege while carrying the safe CAS and provider identity', () => {
    const entry = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource-1', teamId: 'team-1', displayName: 'Build provider',
      resourceRevision: 7,
      readiness: { kind: 'source_unavailable' },
      recoveryAction: 'source_owner_action',
      mayBroker: true,
      mayReceiveDirect: false, directMaterialState: 'never_delivered',
      sessionUsePolicy: 'personal_allowed',
      providerModels: [],
      sourcePresentation: {
        kind: 'provider',
        provider: {
          identity: { pluginId: 'happier.provider.test', localId: 'test' },
          definitionRevision: 1,
        },
      },
    });
    expect(entry).not.toHaveProperty('custodianAccountId');
    expect(entry).not.toHaveProperty('source');
    expect(entry).not.toHaveProperty('brokerMachineId');
    expect(entry.resourceRevision).toBe(7);
    expect(entry.connectedServiceSelections).toEqual([]);
    expect(entry).not.toHaveProperty('groupGrants');
    expect(entry.sourcePresentation).toEqual({
      kind: 'provider',
      provider: {
        identity: { pluginId: 'happier.provider.test', localId: 'test' },
        definitionRevision: 1,
      },
    });
  });

  it('publishes only exact content-free Connected Service selection witnesses', () => {
    const entry = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource-1', teamId: 'team-1', displayName: 'Shared account',
      resourceRevision: 7,
      readiness: { kind: 'available' }, recoveryAction: null,
      mayBroker: false, mayReceiveDirect: true,
      directMaterialState: 'current', sessionUsePolicy: 'personal_allowed',
      providerModels: [],
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'service.plugin', localId: 'mail' },
      },
      connectedServiceSelections: [{
        source: 'team_resource', resourceId: 'resource-1',
        deliveryMode: 'direct',
        disclosedMember: {
          service: { pluginId: 'service.plugin', localId: 'mail' },
          accountId: 'disclosed-account',
        },
      }],
    });
    expect(entry.connectedServiceSelections).toHaveLength(1);
    expect(entry).not.toHaveProperty('custodianAccountId');
    expect(TeamCredentialResourceCatalogEntryV1Schema.safeParse({
      ...entry,
      connectedServiceSelections: [{
        ...entry.connectedServiceSelections[0],
        brokerMachineId: 'private-machine',
      }],
    }).success).toBe(false);
  });

  it('rejects private source authority in recipient rows and binds selections to the catalog revision', () => {
    const entry = {
      id: 'resource-1', teamId: 'team-1', displayName: 'Build provider',
      resourceRevision: 7,
      readiness: { kind: 'source_unavailable' }, recoveryAction: 'source_owner_action',
      mayBroker: false, mayReceiveDirect: false, sessionUsePolicy: 'personal_allowed',
      directMaterialState: 'never_delivered', providerModels: [],
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'service.plugin', localId: 'mail' },
      },
    };
    expect(TeamCredentialResourceCatalogEntryV1Schema.safeParse({
      ...entry, custodianAccountId: 'secret-owner', brokerMachineId: 'secret-machine',
    }).success).toBe(false);
    expect(TeamCredentialResourceCatalogEntryV1Schema.safeParse({
      ...entry,
      sourcePresentation: {
        kind: 'connected_service',
        service: { pluginId: 'service.plugin', localId: 'mail' },
        accountId: 'secret-source',
      },
    }).success).toBe(false);
    const selection = TeamCredentialProviderModelSelectionV1Schema.parse({
      kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
      expectedResourceRevision: 7,
      deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
    });
    expect(selection.expectedResourceRevision).toBe(entry.resourceRevision);
    expect(TeamCredentialProviderModelSelectionV1Schema.safeParse({
      ...selection, expectedResourceRevision: undefined,
    }).success).toBe(false);
  });

  it('keeps the direct selection witness opaque and rejects administration internals', () => {
    const model = {
      selection: {
        kind: 'team_credential_provider_model', resourceId: 'resource-1', teamId: 'team-1',
        expectedResourceRevision: 7,
        deliveryMode: 'direct',
        agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'model-1',
      },
      descriptor: { id: 'model-1', name: 'Model 1' },
      application: {
        agentTargetKey: 'agent:happier.agent.codex/codex',
        implementationIdentity: { pluginId: 'happier.provider.test', localId: 'test' },
        endpointTemplateId: 'responses', protocol: 'openai-responses',
      },
      sourceRevision: 'opaque-source-revision',
      direct: {
        sourceMemberKey: 'opaque-member-digest', sourceVersion: 'opaque-version-digest',
      },
      availability: 'available',
    } as const;
    expect(TeamCredentialProviderModelCatalogEntryV1Schema.parse(model).direct).toMatchObject({
      sourceMemberKey: model.direct.sourceMemberKey,
      sourceVersion: model.direct.sourceVersion,
    });
    const catalog = { ...model, confidence: 'account_unverified',
      sources: { manual: false, static: true, probe: false } };
    expect(TeamCredentialProviderModelCatalogEntryV1Schema.parse(catalog)).toMatchObject(catalog);
    for (const privateField of [
      'custodianAccountId', 'source', 'brokerMachineId', 'audience', 'revision',
      'quota', 'encryptedMaterial', 'endpoint', 'normalizedUrl', 'publicHeaders',
      'credentialTransport',
    ]) {
      expect(TeamCredentialProviderModelCatalogEntryV1Schema.safeParse({
        ...model,
        direct: { ...model.direct, [privateField]: 'private' },
      }).success).toBe(false);
    }
  });

  it('keeps single-resource administration and entitled selection as distinct strict intents', () => {
    expect(TeamCredentialResourceGetInputV1Schema.parse({ resourceId: 'resource-1' }))
      .toEqual({ resourceId: 'resource-1' });
    expect(TeamCredentialResourceGetInputV1Schema.safeParse({ resourceId: 'resource-1', teamId: 'team-1' }).success)
      .toBe(false);
    expect(TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [] })).toEqual({ resources: [], nextCursor: null });
    expect(TeamCredentialResourceReadInputV1Schema.parse({ teamId: 'team-1' })).toMatchObject({ limit: 50 });
    expect(TeamCredentialResourceReadInputV1Schema.safeParse({ teamId: 'team-1', limit: 101 }).success).toBe(false);
    expect(TeamCredentialResourceDiscoverInputV1Schema.parse({ teamIds: ['team-1', 'team-2'] }))
      .toEqual({ teamIds: ['team-1', 'team-2'], limit: 50 });
    expect(TeamCredentialResourceReadInputV1Schema.safeParse({ teamIds: ['team-1'] }).success).toBe(false);
    expect(TeamCredentialResourceDiscoverInputV1Schema.safeParse({ teamIds: ['team-1'], teamId: 'team-1' }).success).toBe(false);
    expect(TeamCredentialResourceDiscoveryPageV1Schema.parse({ resources: [], nextCursor: null,
      failures: [{ teamId: 'team-2', error: 'team_authentication_required' }] }).failures)
      .toEqual([{ teamId: 'team-2', error: 'team_authentication_required' }]);
    expect(TeamCredentialResourceDiscoveryPageV1Schema.safeParse({ resources: [], nextCursor: null,
      failures: [{ teamId: 'team-2', error: 'forbidden', authority: 'owner' }] }).success).toBe(false);
  });

  it('keeps a corrupt recipient row visible when no source identity can be parsed safely', () => {
    const row = TeamCredentialResourceCatalogEntryV1Schema.parse({
      id: 'resource-corrupt', teamId: 'team-1', displayName: 'Unavailable source',
      resourceRevision: 8,
      readiness: { kind: 'resource_corrupt' },
      recoveryAction: 'source_owner_action',
      mayBroker: false, mayReceiveDirect: false,
      directMaterialState: 'never_delivered', sessionUsePolicy: null,
      providerModels: [], sourcePresentation: null,
    });
    expect(row.sourcePresentation).toBeNull();
    expect(TeamCredentialResourceCatalogEntryV1Schema.safeParse({
      ...row, readiness: { kind: 'source_unavailable' }, sourcePresentation: null,
    }).success).toBe(true);
  });
});

describe('team credential resource errors', () => {
  it('exports one strict error vocabulary with its canonical HTTP status mapping', () => {
    const expectedStatuses = {
      invalid_resource_input: 400,
      not_found_or_not_visible: 404,
      forbidden: 403,
      resource_changed: 409,
      team_authentication_required: 403,
      team_authentication_policy_unavailable: 503,
      feature_disabled: 503,
      source_owner_required: 400,
      source_replaced_or_missing: 400,
      invalid_audience: 400,
      disclosure_not_allowed: 400,
      broker_unavailable: 400,
      update_required: 400,
      resource_corrupt: 400,
      resource_not_found: 404,
      resource_forbidden: 403,
      member_not_eligible: 403,
      session_policy_incompatible: 409,
      invalid_limit: 400,
      limit_identity_immutable: 400,
      subject_not_in_team: 400,
      token_limit_unavailable: 400,
      cost_limit_unavailable: 400,
      team_credential_usage_limit: 400,
    } as const;

    expect(TeamCredentialErrorCodeV1Schema.options).toEqual(Object.keys(expectedStatuses));
    for (const [error, status] of Object.entries(expectedStatuses)) {
      const parsed = TeamCredentialResourceErrorV1Schema.parse({ error });
      expect(teamCredentialErrorHttpStatusV1(parsed.error)).toBe(status);
    }
    expect(TeamCredentialResourceErrorV1Schema.safeParse({ error: 'forbidden', details: {} }).success).toBe(false);
  });
});

describe('TeamCredentialResourceActivity schemas', () => {
  it('accepts bounded pagination and metadata-only events', () => {
    const input = TeamCredentialResourceActivityReadInputV1Schema.parse({
      resourceId: 'resource', limit: 25,
    });
    expect(input).toEqual({ resourceId: 'resource', limit: 25 });
    const event = TeamCredentialResourceActivityEventV1Schema.parse({
      kind: 'audience_changed', actorDisplayName: 'Maya',
      subjectDisplayName: 'Developers', createdAt: new Date(0).toISOString(),
    });
    expect(event).not.toHaveProperty('resourceId');
    expect(TeamCredentialResourceActivityPageV1Schema.parse({
      items: [event], nextCursor: 'event-2',
    })).toMatchObject({ items: [event], nextCursor: 'event-2' });
  });

  it('rejects hidden identifiers, unsupported event kinds, and oversized pages', () => {
    expect(TeamCredentialResourceActivityEventV1Schema.safeParse({
      kind: 'audience_changed', actorDisplayName: 'Maya',
      subjectDisplayName: 'Developers', createdAt: new Date(0).toISOString(), resourceId: 'secret',
    }).success).toBe(false);
    expect(TeamCredentialResourceActivityEventV1Schema.safeParse({
      kind: 'request_log', actorDisplayName: 'Maya',
      subjectDisplayName: 'Developers', createdAt: new Date(0).toISOString(),
    }).success).toBe(false);
    expect(TeamCredentialResourceActivityReadInputV1Schema.safeParse({ resourceId: 'r', limit: 101 }).success).toBe(false);
  });
});
