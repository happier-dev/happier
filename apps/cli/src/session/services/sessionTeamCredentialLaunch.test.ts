import { projectTeamCredentialLaunchFailure } from './sessionTeamCredentialLaunchError';
import { ManagedCredentialDeliveryResultV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { SessionSpawnNewResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SPAWN_SESSION_ERROR_CODES } from '@happier-dev/protocol/spawnSession';
import { projectSessionSpawnFailure } from '@/session/creation/projectSessionSpawnFailure';
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue';
import { describe, expect, it } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol/providers/ids';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceReadInputV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import type { SpawnSessionOptions } from '@/session/shared/spawnSessionContract';
import { normalizeSessionTeamCredentialLaunch, readSessionTeamCredentialResourceCatalog, SessionTeamCredentialLaunchUnavailableError } from './sessionTeamCredentialLaunch';

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
    })).rejects.toThrow('team_credential_provider_selection_not_current');
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
      readCatalog: async () => [{ ...resource, providerModels: [] }] })).rejects.toThrow('team_credential_provider_selection_not_current');
  });

  it('preserves an explicit Provider-model route without deriving a second route', async () => {
    const explicit = { ...options, teamCredentialBindings: [{ v: 1 as const, slot: { kind: 'provider_model' as const },
      resourceId: 'explicit-resource', teamId: 'team-b', expectedResourceRevision: 2, deliveryMode: 'brokered' as const }] };
    const explicitResource = { ...resource, id: 'explicit-resource', teamId: 'team-b', resourceRevision: 2,
      providerModels: resource.providerModels.map(row => ({ ...row, selection: { ...row.selection,
        resourceId: 'explicit-resource', teamId: 'team-b', expectedResourceRevision: 2 } })) };
    const result = await normalizeSessionTeamCredentialLaunch({ options: explicit, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource, explicitResource] });
    expect(result.options.teamCredentialBindings?.find(entry => entry.slot.kind === 'provider_model')).toEqual(explicit.teamCredentialBindings[0]);
    expect(result.teamModelRow?.selection.resourceId).toBe('explicit-resource');
  });

  it.each([{ teamId: 'team-other', expectedResourceRevision: 7 }, { teamId: 'team-a', expectedResourceRevision: 6 }])(
    'refuses a fresh explicit model binding whose Team or revision was not offered', async witness => {
      await expect(normalizeSessionTeamCredentialLaunch({ options: { ...options, teamCredentialBindings: [{ v: 1,
        slot: { kind: 'provider_model' }, resourceId: resource.id, deliveryMode: 'brokered', ...witness }] },
        agentId: 'codex', agentTargetKey: target, contributions: readCurrentContributionRegistry(), applications,
        readCatalog: async () => [resource] })).rejects.toThrow('team_credential_provider_selection_not_current');
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
    })).rejects.toThrow('team_credential_provider_selection_not_current');
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

  it.each(['native', 'personal'] as const)('preserves an explicit %s model source over a service-derived route', async source => {
    const explicit: SpawnSessionOptions = { ...options,
      ...(source === 'native' ? { teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }] }
        : { modelSelection: { ...options.modelSelection!, ref: { ...options.modelSelection!.ref, providerConnectionId: ProviderConnectionIdSchema.parse('pc_personal') } } }),
    };
    const result = await normalizeSessionTeamCredentialLaunch({ options: explicit, agentId: 'codex', agentTargetKey: target,
      contributions: readCurrentContributionRegistry(), applications, readCatalog: async () => [resource] });
    expect(result.teamModelRow).toBeNull();
    expect(result.options.teamCredentialBindings?.find(entry => entry.slot.kind === 'provider_model'))
      .toEqual(source === 'native' ? explicit.teamCredentialBindings?.[0] : undefined);
    expect(result.options.modelSelection).toEqual(explicit.modelSelection);
  });
});
