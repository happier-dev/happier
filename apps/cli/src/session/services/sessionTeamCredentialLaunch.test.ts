import { describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createAccountServerActionDeps } from '@/api/accountServerActionDeps';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceReadInputV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { normalizeSessionTeamCredentialLaunch, readSessionTeamCredentialResourceCatalog, SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunch';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { ManagedCredentialDeliveryResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { projectTeamCredentialLaunchFailure } from './sessionTeamCredentialLaunchError';

const target = buildBackendTargetKeyV2({ kind: 'backend', backendId: 'codex', sourceKind: 'built_in' });
const selection = { source: 'team_resource', resourceId: 'resource-a', deliveryMode: 'brokered' } as const;
const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({
  id: 'resource-a', teamId: 'team-a', displayName: 'Shared Pool', resourceRevision: 7,
  readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
  directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed',
  connectedServiceSelections: [selection],
  sourcePresentation: { kind: 'connected_service', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } },
  providerModels: [{
    selection: { kind: 'team_credential_provider_model', resourceId: 'resource-a', teamId: 'team-a',
      expectedResourceRevision: 7, deliveryMode: 'brokered', agentTargetKey: target, modelId: 'gpt-6-luna' },
    descriptor: { id: 'gpt-6-luna', name: 'GPT-6 Luna' }, sourceRevision: 'source-7', availability: 'available',
    application: { agentTargetKey: target, implementationIdentity: { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' },
      endpointTemplateId: 'cliproxyapi-openai-responses', protocol: 'openai-responses' },
  }],
});
const options: SpawnSessionOptions = {
  directory: '/tmp/team-launch',
  modelSelection: { v: 1, ref: { agentTargetKey: target, providerConnectionId: null, modelId: 'gpt-6-luna' }, updatedAt: 1 },
  connectedServices: { v: 2, bindingsByServiceId: { 'happier.agent.codex/openai-codex': selection } },
};
const applications = resource.providerModels.map(entry => entry.application);

describe('Session Team launch composition', () => {
  it.each([
    { kind: 'unknown', code: 'action_outcome_unknown' },
    { kind: 'refused', code: 'credential_unavailable' },
  ])('preserves an unknown native delivery outcome or definite refusal $code through runtime and strict spawn failures', ({ kind, code }) => {
    const outcome = ManagedCredentialDeliveryResultV1Schema.parse({ kind, code });
    const error = projectTeamCredentialLaunchFailure(outcome, 'binding', 'team_credential_provider_selection_not_current');
    expect(error.code).toBe(code);
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error }))
      .toMatchObject({ code });
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: error.code,
    }))).toMatchObject({ launchError: { code } });
  });
  it('keeps a storage-backed Home 500 retryable through the real HTTP catalog and public spawn projection', async () => {
    // HTTP is the boundary. The Home adapter, catalog parsing, launch owner
    // and public result projection stay real; no database is opened.
    const http = vi.spyOn(axios, 'request').mockResolvedValue({ status: 500,
      data: { statusCode: 500, error: 'Internal Server Error', message: 'Internal Server Error' } });
    try {
      const home = createAccountServerActionDeps({ token: 'synthetic-recipient-token',
        serverId: 'home', serverHttpBaseUrl: 'https://home.test' }).homeDomainAction;
      if (!home) throw new Error('Expected Home action transport');
      const error: unknown = await normalizeSessionTeamCredentialLaunch({ options,
        agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
        readCatalog: () => readSessionTeamCredentialResourceCatalog({ applications, teamIds: [resource.teamId], homeDomainAction: home }),
      }).catch(failure => failure);
      expect(error).toMatchObject({ code: 'provider_catalog_unavailable', phase: 'resource_catalog' });
      if (!(error instanceof SessionTeamCredentialLaunchUnavailableError)) throw new Error('Expected Home catalog failure');
      expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: error.code,
      }))).toMatchObject({ retryable: true, launchError: { code: 'provider_catalog_unavailable' } });
      expect(http).toHaveBeenCalledTimes(1);
    } finally { http.mockRestore(); }
  });

  it('chooses the custodian ordered usable Provider delivery for a fresh implicit model source', async () => {
    const brokered = resource.providerModels[0]!;
    const direct = { ...brokered, selection: { ...brokered.selection, deliveryMode: 'direct' as const },
      direct: { sourceMemberKey: 'source-member', sourceVersion: brokered.sourceRevision } };
    const allowedRoutes: Array<'direct' | 'brokered'> = ['direct', 'brokered'];
    const ordered = Object.assign({}, resource, { mayReceiveDirect: true,
      deliveryPolicy: { preferredAllowedModes: allowedRoutes }, allowedRoutes, providerModels: [brokered, direct] });
    const result = await normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      executionMachineId: 'worker', contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [ordered] });
    expect(result.teamModelRow?.selection.deliveryMode).toBe('direct');
    expect(result.options.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model'))
      .toMatchObject({ resourceId: resource.id, deliveryMode: 'direct', providerModelSelection: {
        agentTargetKey: target, modelId: direct.selection.modelId, application: direct.application, executionMachineId: 'worker',
      } });
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      executionMachineId: 'worker', contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource, providerModels: [direct] }],
    })).rejects.toMatchObject({ code: 'provider_model_not_found' });
  });

  it('preserves the exact Machine native unavailability when Home cannot admit any model row', async () => {
    const unavailable = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
      deliveryPolicy: { preferredAllowedModes: ['vendor-native'] }, allowedRoutes: ['vendor-native'],
      providerModels: [], readiness: { kind: 'source_unavailable' }, deliveryUnavailableReason: 'provider_credential_transport_unavailable',
    });
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      executionMachineId: 'worker', contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [unavailable],
    })).rejects.toMatchObject({ code: 'provider_credential_transport_unavailable' });
  });

  it('retains the exact canonical native row rather than reselecting an unusable row of the same mode', async () => {
    const native = { ...resource.providerModels[0]!,
      selection: { ...resource.providerModels[0]!.selection, deliveryMode: 'vendor-native' as const },
      nativeSource: { providerTicket: 't'.repeat(43) },
      compatibility: { confirmed: true, compatibilityFingerprint: `compatibility:v1:${'a'.repeat(64)}`,
        result: { status: 'verified' as const, selectedProtocol: 'openai-responses' as const,
          evidence: { sourceUrls: ['https://example.test'], verifiedAt: '2026-10-20' } } } };
    const { nativeSource: _missingTicket, ...unusable } = native;
    const ordered = { ...resource, deliveryPolicy: { preferredAllowedModes: ['vendor-native' as const, 'brokered' as const] },
      allowedRoutes: ['vendor-native' as const, 'brokered' as const], providerModels: [unusable, native, ...resource.providerModels] };
    const result = await normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      executionMachineId: 'worker', contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [ordered] });
    expect(result.teamModelRow).toEqual(native);
    expect(result.options.teamCredentialBindings?.find(binding => binding.slot.kind === 'provider_model'))
      .toMatchObject({ deliveryMode: 'vendor-native', providerModelSelection: { application: native.application,
        executionMachineId: 'worker', nativeSource: { sourceRevision: native.sourceRevision, providerTicket: native.nativeSource.providerTicket } } });
  });

  it('retains update-required readiness through an explicit launch and its strict Action outcome', async () => {
    const unavailable = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
      readiness: { kind: 'update_required' }, providerModels: [], connectedServiceSelections: [],
    });
    let reads = 0;
    const error = await normalizeSessionTeamCredentialLaunch({ options: { ...options, connectedServices: undefined,
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: resource.teamId, expectedResourceRevision: resource.resourceRevision, deliveryMode: 'brokered' }],
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: () => readSessionTeamCredentialResourceCatalog({ applications, teamIds: [resource.teamId],
        homeDomainAction: async () => { reads++; return { resources: [unavailable], nextCursor: null }; },
      }),
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'update_required', phase: 'readiness' });
    expect(reads).toBe(1);
    if (!(error instanceof SessionTeamCredentialLaunchUnavailableError)) throw new Error('Expected readiness refusal');
    expect(SessionSpawnNewResultV1Schema.parse(projectSessionSpawnFailure({
      errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED, errorMessage: error.code,
    }))).toMatchObject({ launchError: { code: 'update_required' } });
  });
  it('asks for a Team model instead of reporting an unavailable provider when no model was selected', async () => {
    let reads = 0;
    const error = await normalizeSessionTeamCredentialLaunch({
      options: { ...options, modelSelection: undefined }, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => { reads++; return [resource]; },
    }).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 'team_credential_model_selection_required', phase: 'model_selection' });
    expect(reads).toBe(1);
    if (!(error instanceof SessionTeamCredentialLaunchUnavailableError)) throw new Error('Expected Team launch refusal');
    expect(projectSessionSpawnFailure({ errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: error.code,
    })).toMatchObject({ retryable: false, launchError: { code: 'team_credential_model_selection_required' } });
    const selected = await normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource] });
    expect(selected.teamModelRow?.selection.modelId).toBe(options.modelSelection?.ref.modelId);
  });

  it.each(['resource_forbidden', 'provider_catalog_unavailable', 'connected_service_credential_reconnect_required'])(
    'preserves the Home %s refusal through catalog and strict spawn projection', async code => {
      let reads = 0;
      const error = await normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
        contributions: readCurrentContributionRegistry(), applications,
        readCatalog: () => readSessionTeamCredentialResourceCatalog({ applications, teamIds: [resource.teamId],
          homeDomainAction: async () => { reads++; return { ok: false, error: { code } }; },
        }),
      }).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code, phase: 'resource_catalog' });
      expect(reads).toBe(1);
      if (!(error instanceof SessionTeamCredentialLaunchUnavailableError)) throw new Error('Expected Team launch refusal');
      expect(projectSessionSpawnFailure({ errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
        errorMessage: error.code,
      })).toMatchObject({ launchError: { code } });
    },
  );

  it('distinguishes an invalid catalog page from a resource revision changing between applications', async () => {
    await expect(readSessionTeamCredentialResourceCatalog({ applications, teamIds: [resource.teamId],
      homeDomainAction: async () => ({ resources: 'invalid' }),
    })).rejects.toMatchObject({ code: 'provider_rpc_response_invalid', phase: 'resource_catalog' });
    let reads = 0;
    await expect(readSessionTeamCredentialResourceCatalog({ applications: [...applications, ...applications], teamIds: [resource.teamId],
      homeDomainAction: async () => ({ resources: [{ ...resource, resourceRevision: ++reads }], nextCursor: null }),
    })).rejects.toMatchObject({ code: 'resource_changed', phase: 'catalog_revision' });
  });

  it('refuses malformed supplied Connected Account bindings through the typed launch refusal', async () => {
    await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options, connectedServices: { v: 99 } },
      agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => { throw new Error('Unexpected Team catalog read'); },
    })).rejects.toBeInstanceOf(SessionTeamCredentialLaunchUnavailableError);
  });

  it('sends the exact application through the shared strict catalog transport and refuses failed reads', async () => {
    const application = resource.providerModels[0]!.application;
    const resources = await readSessionTeamCredentialResourceCatalog({ applications: [application], teamIds: ['team-a'],
      homeDomainAction: async request => {
        const consumed = TeamCredentialResourceReadInputV1Schema.parse(request.input);
        expect(consumed).toMatchObject({ teamId: 'team-a', application });
        return { resources: [resource], nextCursor: null };
      } });
    expect(resources.flatMap(entry => entry.providerModels)).toEqual(resource.providerModels);
    await expect(readSessionTeamCredentialResourceCatalog({ applications: [application], teamIds: ['team-a'],
      homeDomainAction: async () => ({ error: 'resource_forbidden' }),
    })).rejects.toMatchObject({ code: 'resource_forbidden', phase: 'resource_catalog' });
  });

  it('normalizes service-only Team intent and the effective model before strict binding admission', async () => {
    const result = await normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource] });
    const bindings = SessionTeamCredentialBindingIntentsV1Schema.parse(result.options.teamCredentialBindings);
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ slot: { kind: 'provider_model' }, resourceId: 'resource-a', teamId: 'team-a',
        expectedResourceRevision: 7, deliveryMode: 'brokered' }),
      expect.objectContaining({ slot: expect.objectContaining({ kind: 'connected_service_purpose' }),
        resourceId: 'resource-a', expectedResourceRevision: 7 }),
    ]));
    expect(result.options.modelSelection).toEqual(options.modelSelection);
    expect(result.teamModelRow).toEqual(resource.providerModels[0]);
  });

  it('refuses an unavailable model instead of using native or personal authentication', async () => {
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource, providerModels: [] }] })).rejects.toMatchObject({ code: 'provider_model_not_found' });
  });

  it('distinguishes a present refused row without a reason from a genuinely absent model', async () => {
    const refused = { ...resource.providerModels[0]!, availability: 'policy_denied' as const };
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource, providerModels: [refused] }],
    })).rejects.toMatchObject({ code: 'team_credential_provider_selection_not_current', phase: 'model_catalog' });
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource, providerModels: [{ ...refused,
        deliveryUnavailableReason: 'provider_compatibility_unverified',
        selection: { ...refused.selection, modelId: 'another-model' },
        descriptor: { id: 'another-model', name: 'Another model' },
      }] }],
    })).rejects.toMatchObject({ code: 'provider_model_not_found', phase: 'model_catalog' });
  });

  it.each([false, true])('names an exhausted allowance for an exact Team selection (explicit=%s)', async explicit => {
    const exhausted = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
      readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-26T00:00:00.000Z' },
      usageLimit: { metric: 'inference_requests', remaining: '0', resetsAtUtc: '2026-10-26T00:00:00.000Z' },
      recoveryAction: 'retry', providerModels: [],
    });
    let reads = 0;
    await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options,
      ...(explicit ? { connectedServices: undefined, teamCredentialBindings: [{ v: 1 as const,
        slot: { kind: 'provider_model' as const }, resourceId: resource.id, teamId: resource.teamId,
        expectedResourceRevision: resource.resourceRevision, deliveryMode: 'brokered' as const }] } : {}),
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => { reads++; return [exhausted]; },
    })).rejects.toMatchObject({ code: 'team_credential_usage_limit', details: { v: 1, source: 'team_credential' } });
    expect(reads).toBe(1);
  });

  it.each([false, true])('preserves an unavailable source through catalog transport and launch (explicit=%s)', async explicit => {
    const unavailable = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
      readiness: { kind: 'broker_unavailable', reason: 'projection_unavailable' },
      recoveryAction: 'retry', providerModels: [], connectedServiceSelections: [],
    });
    let reads = 0;
    const error = await normalizeSessionTeamCredentialLaunch({ options: { ...options,
      ...(explicit ? { connectedServices: undefined, teamCredentialBindings: [{ v: 1 as const,
        slot: { kind: 'provider_model' as const }, resourceId: resource.id, teamId: resource.teamId,
        expectedResourceRevision: resource.resourceRevision, deliveryMode: 'brokered' as const }] } : {}),
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: () => readSessionTeamCredentialResourceCatalog({ applications, teamIds: [resource.teamId],
        homeDomainAction: async () => { reads++; return { resources: [unavailable], nextCursor: null }; },
      }),
    }).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'broker_unavailable', details: { v: 1, source: 'team_credential' } });
    expect(classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error }))
      .toMatchObject({ source: 'team_credential', code: 'broker_unavailable' });
    if (!(error instanceof SessionTeamCredentialLaunchUnavailableError)) throw new Error('Missing launch refusal');
    expect(projectSessionSpawnFailure({ errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_VALIDATION_FAILED,
      errorMessage: error.code,
    })).toMatchObject({ type: 'error', retryable: true, launchError: { message: 'broker_unavailable' } });
    expect(reads).toBe(1);
  });

  it('keeps a stale explicit revision distinct from an unavailable source projection', async () => {
    await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options, connectedServices: undefined,
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: resource.teamId, expectedResourceRevision: 6, deliveryMode: 'brokered' }],
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource, providerModels: [],
        readiness: { kind: 'broker_unavailable', reason: 'projection_unavailable' }, recoveryAction: 'retry',
      }],
    })).rejects.toMatchObject({ code: 'resource_changed', phase: 'resource_selection' });
  });

  it('keeps a stale explicit revision distinct from a current exhausted allowance', async () => {
    await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options, connectedServices: undefined,
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: resource.teamId, expectedResourceRevision: 6, deliveryMode: 'brokered' }],
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [{ ...resource,
        readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-26T00:00:00.000Z' },
      }],
    })).rejects.toMatchObject({ code: 'resource_changed', phase: 'resource_selection' });
  });

  it('does not apply a brokered allowance to an offered direct model route', async () => {
    const directResource = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
      mayReceiveDirect: true, directMaterialState: 'current',
      readiness: { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-10-26T00:00:00.000Z' },
      providerModels: resource.providerModels.map(row => ({ ...row,
        selection: { ...row.selection, deliveryMode: 'direct' as const },
      })),
    });
    const result = await normalizeSessionTeamCredentialLaunch({ options: { ...options, connectedServices: undefined,
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: resource.teamId, expectedResourceRevision: resource.resourceRevision, deliveryMode: 'direct' }],
    }, agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => [directResource],
    });
    expect(result.teamModelRow?.selection.deliveryMode).toBe('direct');
  });

  it.each([true, false])('preserves an explicit Provider-model route and carries its admitted Team (Team supplied: %s)', async includesTeam => {
    const explicit = { ...options, teamCredentialBindings: [{ v: 1 as const, slot: { kind: 'provider_model' as const },
      resourceId: 'explicit-resource', ...(includesTeam ? { teamId: 'team-b' } : {}), expectedResourceRevision: 2, deliveryMode: 'brokered' as const }] };
    const explicitResource = { ...resource, id: 'explicit-resource', teamId: 'team-b', resourceRevision: 2,
      providerModels: resource.providerModels.map(row => ({ ...row, selection: { ...row.selection,
        resourceId: 'explicit-resource', teamId: 'team-b', expectedResourceRevision: 2 } })) };
    const result = await normalizeSessionTeamCredentialLaunch({ options: explicit, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource, explicitResource] });
    expect(result.options.teamCredentialBindings?.find(entry => entry.slot.kind === 'provider_model'))
      .toEqual({ ...explicit.teamCredentialBindings[0], teamId: 'team-b', providerModelSelection: {
        agentTargetKey: target, modelId: explicitResource.providerModels[0]!.selection.modelId,
      } });
    expect(result.teamModelRow?.selection.resourceId).toBe('explicit-resource');
  });

  it.each([{ teamId: 'team-other', expectedResourceRevision: 7 }, { teamId: 'team-a', expectedResourceRevision: 6 }])(
    'refuses a fresh explicit model binding whose Team or revision was not offered', async witness => {
      await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options, teamCredentialBindings: [{ v: 1,
        slot: { kind: 'provider_model' }, resourceId: resource.id, deliveryMode: 'brokered', ...witness }] },
        agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
        readCatalog: async () => [resource] })).rejects.toMatchObject({ code: 'resource_changed', phase: 'resource_selection' });
    },
  );

  it('uses current offered model facts on resume without treating an old binding revision as a new intent', async () => {
    const result = await normalizeSessionTeamCredentialLaunch({ options: { ...options, existingSessionId: 'session-a',
      teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: resource.id,
        teamId: resource.teamId, expectedResourceRevision: 6, deliveryMode: 'brokered' }] }, agentId: 'codex',
      agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource] });
    expect(result.teamModelRow).toEqual(resource.providerModels[0]);
  });

  it('refuses another Agent target before reading a Team source', async () => {
    await expect(normalizeSessionTeamCredentialLaunch({ options, agentId: 'codex',
      agentTargetKey: buildBackendTargetKeyV2({ kind: 'backend', backendId: 'acme.worker/assistant', sourceKind: 'built_in' }),
      contributions: readCurrentContributionRegistry(), applications,
      readCatalog: async () => { throw new Error('unexpected Team source read'); },
    })).rejects.toMatchObject({ code: 'provider_incompatible_with_agent', phase: 'agent_target' });
  });

  it('uses qualified external-Agent declarations and ignores an unrelated tool service for model routing', async () => {
    const agentId = 'acme.worker/assistant';
    const externalTarget = buildBackendTargetKeyV2({ kind: 'backend', backendId: agentId, sourceKind: 'built_in' });
    const contributions = { providersByContributionKey: readCurrentContributionRegistry().providersByContributionKey,
      agentDefinitionsById: new Map([[agentId, { identity: { pluginId: 'acme.worker', localId: 'assistant' },
        richDefinition: { definition: { connectedAccounts: [
          { purpose: 'inference', service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' }, materializationKinds: ['files'] },
          { purpose: 'repository', service: { pluginId: 'acme.integration', localId: 'github' }, materializationKinds: ['httpHeaders'] },
        ] } } }]]) };
    const externalResource = { ...resource, providerModels: resource.providerModels.map(row => ({ ...row,
      selection: { ...row.selection, agentTargetKey: externalTarget },
      application: { ...row.application, agentTargetKey: externalTarget } })) };
    const externalOptions = { ...options, modelSelection: { ...options.modelSelection!,
      ref: { ...options.modelSelection!.ref, agentTargetKey: externalTarget } } };
    const result = await normalizeSessionTeamCredentialLaunch({ agentId, agentTargetKey: externalTarget, options: externalOptions, contributions,
      applications: externalResource.providerModels.map(row => row.application), readCatalog: async () => [externalResource] });
    expect(result.teamModelRow?.selection.agentTargetKey).toBe(externalTarget);
    expect(result.options.teamCredentialBindings).toContainEqual(expect.objectContaining({
      slot: { kind: 'connected_service_purpose', purpose: { consumer: { pluginId: 'acme.worker', localId: 'assistant' }, purpose: 'inference' } },
    }));

    const toolSelection = { ...selection, resourceId: 'github-resource' };
    const toolResource = { ...resource, id: 'github-resource', providerModels: [], connectedServiceSelections: [toolSelection],
      sourcePresentation: { kind: 'connected_service' as const, service: { pluginId: 'acme.integration', localId: 'github' } } };
    const tool = await normalizeSessionTeamCredentialLaunch({ agentId, agentTargetKey: externalTarget, contributions,
      options: { ...externalOptions, connectedServices: { v: 2, bindingsByServiceId: { 'acme.integration/github': toolSelection } } },
      applications: externalResource.providerModels.map(row => row.application), readCatalog: async () => [toolResource] });
    expect(tool.teamModelRow).toBeNull();
    expect(tool.options.teamCredentialBindings?.some(binding => binding.slot.kind === 'provider_model')).toBe(false);
    expect(tool.options.teamCredentialBindings).toContainEqual(expect.objectContaining({
      resourceId: 'github-resource', slot: expect.objectContaining({ kind: 'connected_service_purpose' }),
    }));
  });

  it.each(['native', 'personal', 'personal_with_stale_team_binding'] as const)('preserves an explicit %s model source over a service-derived route', async source => {
    const explicit: SpawnSessionOptions = { ...options,
      ...(source === 'native' ? { teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }] }
        : { modelSelection: { ...options.modelSelection!, ref: { ...options.modelSelection!.ref, providerConnectionId: ProviderConnectionIdSchema.parse('pc_personal') } } }),
      ...(source === 'personal_with_stale_team_binding' ? { teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' },
        resourceId: 'previous-resource', teamId: 'previous-team', expectedResourceRevision: 1, deliveryMode: 'brokered' }] } : {}),
    };
    const result = await normalizeSessionTeamCredentialLaunch({ options: explicit, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource] });
    expect(result.teamModelRow).toBeNull();
    expect(result.options.teamCredentialBindings?.find(entry => entry.slot.kind === 'provider_model'))
      .toEqual(source === 'personal' ? undefined : explicit.teamCredentialBindings?.[0]);
    expect(result.options.modelSelection).toEqual(explicit.modelSelection);
  });
});
