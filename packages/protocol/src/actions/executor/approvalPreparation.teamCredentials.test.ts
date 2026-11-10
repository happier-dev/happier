import { describe, expect, it } from 'vitest';
import { prepareApprovalRequest } from './approvalPreparation.js';
import { prepareTeamCredentialSources } from '../specs/teamCredentialApproval.js';
import type { ActionExecutorDeps } from './types.js';
import { TeamSummaryV1Schema, resolveTeamAdmissionProjectionV1 } from '../../teams/projections.js';
import { NO_TEAM_CAPABILITIES_V1 } from '../../teams/capabilities.js';
import { TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceEntitledPageV1Schema } from '../../teams/credentials/resourceV1.js';
import { SessionSpawnNewInputV2Schema } from '../../sessions/creation/sessionSpawnNewInputV2.js';
import { ManagedAcquireInputV1Schema } from '../../machines/managed/actionsV1.js';

const team = TeamSummaryV1Schema.parse({ id: 'team-build', name: 'Build Team', description: null,
  logo: null, archivedAt: null, recovery: null, viewerRole: 'member', counts: null,
  policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
    defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null },
  capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true }, admission: resolveTeamAdmissionProjectionV1() });
const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: 'resource-work', teamId: team.id,
  displayName: 'Work account', resourceRevision: 4, readiness: { kind: 'available' },
  recoveryAction: null, mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered',
  sessionUsePolicy: null, providerModels: [], sourcePresentation: { kind: 'connected_service',
    service: { pluginId: 'example.accounts', localId: 'work' } } });
const input = SessionSpawnNewInputV2Schema.parse({
  executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'managed' },
  agentTarget: { kind: 'agent', identity: { pluginId: 'example.agent', localId: 'agent' } },
  teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, teamId: team.id,
    resourceId: resource.id, expectedResourceRevision: 4, deliveryMode: 'brokered' }],
});
const context = { surface: 'mcp', authority: 'account_automation', serverId: 'home' } as const;

describe('Team credential source at existing Action admission', () => {
  it('keeps each selected Team identity when aggregated references name the same resource', async () => {
    const source = { teamId: team.id, resourceId: resource.id, teamName: team.name, accountName: resource.displayName };
    const sources = await prepareTeamCredentialSources({ deps: {}, selection: { serverId: 'home', resources: [
      { teamId: 'another-team', resourceId: resource.id }, { teamId: team.id, resourceId: resource.id },
    ] }, context: { ...context, teamCredentialPresentation: { serverId: 'home', sources: [source] } } });
    expect(sources).toEqual([source]);
  });

  it('retains child source names captured by the existing parent review preparation', async () => {
    const source = { teamId: team.id, resourceId: resource.id, teamName: team.name, accountName: resource.displayName };
    const prepared = await prepareApprovalRequest({ deps: {}, actionId: 'workflow.run.start',
      input: {}, actionArgs: {}, context, hostReviewedContent: { teamCredentialSources: [source] } });
    expect(prepared).toMatchObject({ preview: { teamCredentialSources: [source],
      summary: expect.stringContaining('Build Team’s shared Work account') } });
  });

  it('captures the exact public Team and shared account for headless spawn before any credential effect', async () => {
    const reads: Parameters<NonNullable<ActionExecutorDeps['homeDomainAction']>>[0][] = [];
    const deps: ActionExecutorDeps = { homeDomainAction: async request => {
      reads.push(request);
      if (request.actionId === 'teams.get') return team;
      if (request.actionId === 'teams.credentials.entitled.list') return TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [resource] });
      throw new Error(`Unexpected effect: ${request.actionId}`);
    } };
    const prepared = await prepareApprovalRequest({ deps, actionId: 'session.spawn_new', input, actionArgs: input, context });
    expect(prepared).toMatchObject({ preview: { teamCredentialSources: [{ teamId: team.id,
      resourceId: resource.id, teamName: team.name, accountName: resource.displayName }],
      summary: expect.stringContaining('Build Team’s shared Work account') } });
    expect(reads.map(read => ({ actionId: read.actionId, input: read.input }))).toEqual([
      { actionId: 'teams.get', input: { teamId: team.id } },
      { actionId: 'teams.credentials.entitled.list', input: { teamId: team.id, resourceId: resource.id } },
    ]);
    expect(prepared).toMatchObject({ actionArgs: input });
  });

  it('does no Team discovery for ordinary spawn or an explicit native clear', async () => {
    const { teamCredentialBindings: _bindings, ...ordinary } = input;
    let reads = 0;
    const deps: ActionExecutorDeps = { homeDomainAction: async () => { reads++; return {}; } };
    for (const spawn of [ordinary, { ...ordinary, teamCredentialBindings: [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }] }]) {
      const prepared = await prepareApprovalRequest({ deps, actionId: 'session.spawn_new', input: spawn, actionArgs: spawn, context });
      expect(prepared).not.toHaveProperty('preview.teamCredentialSources');
    }
    expect(reads).toBe(0);
  });

  it('reuses exact Home and resource facts already projected for a mounted caller', async () => {
    let reads = 0;
    const deps: ActionExecutorDeps = { homeDomainAction: async () => { reads++; return {}; } };
    const source = { teamId: team.id, resourceId: resource.id, teamName: team.name, accountName: resource.displayName };
    const prepared = await prepareApprovalRequest({ deps, actionId: 'session.spawn_new', input, actionArgs: input,
      context: { ...context, teamCredentialPresentation: { serverId: 'home', sources: [
        { ...source, teamId: 'unrelated-team', teamName: 'Unrelated Team' }, source,
      ] } } });
    expect(prepared).toMatchObject({ preview: { teamCredentialSources: [source],
      summary: expect.stringContaining('Build Team’s shared Work account') } });
    expect(reads).toBe(0);
  });

  it('does not disclose a blanket Team account overridden by the selected fanout target', async () => {
    let reads = 0;
    const deps: ActionExecutorDeps = { homeDomainAction: async request => {
      reads++;
      return request.actionId === 'teams.get' ? team
        : TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [resource] });
    } };
    const target = 'agent:example.agent/agent';
    const start = { backendTargetKeys: [target], instructions: 'Plan the work', connectedServices: {
      v: 2, bindingsByServiceId: { 'example.accounts/work': { source: 'team_resource', resourceId: resource.id, deliveryMode: 'brokered' } },
    }, connectedServicesByBackendTargetKey: { [target]: 'native' } };
    const prepared = await prepareApprovalRequest({ deps, actionId: 'subagents.plan.start', input: start, actionArgs: start, context });
    expect(prepared).not.toHaveProperty('preview.teamCredentialSources');
    expect(reads).toBe(0);
  });

  it('discloses managed acquisition agentStart on its selected Home without acquiring credentials', async () => {
    const { executionTarget: _target, ...agentStart } = input;
    const acquire = ManagedAcquireInputV1Schema.parse({
      enrollmentIdentity: { kind: 'existingUser', role: 'adopted' },
      selection: { kind: 'preset', homeId: 'home', id: 'preset', revision: 1 },
      controller: { machineId: 'controller', installationId: 'installation' },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false, agentStart,
      reviewedFacts: { launch: { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1,
        name: 'Work VM', choices: {} }, controller: { machineId: 'controller', installationId: 'installation' },
        optionStatus: 'current', billing: { location: 'unknown', stoppedBilling: 'unknown' }, prerequisites: [],
        retentionCapabilities: { supportedIntents: ['start', 'delete'] }, retention: { kind: 'until-delete' },
        wakeOnAcceptedMessage: false, preset: { id: 'preset', revision: 1 }, setup: {} },
    });
    const homes: (string | null | undefined)[] = [];
    const deps: ActionExecutorDeps = { homeDomainAction: async request => {
      homes.push(request.context.serverId);
      if (request.actionId === 'teams.get') return team;
      if (request.actionId === 'teams.credentials.entitled.list') return TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [resource] });
      throw new Error(`Unexpected effect: ${request.actionId}`);
    } };
    const prepared = await prepareApprovalRequest({ deps, actionId: 'machines.managed.acquire', input: acquire, actionArgs: acquire,
      context: { ...context, serverId: 'another-home', teamCredentialPresentation: { serverId: 'another-home', sources: [{
        teamId: team.id, resourceId: resource.id, teamName: 'Wrong Home Team', accountName: 'Wrong Home account',
      }] } } });
    expect(prepared).toMatchObject({ preview: { summary: expect.stringContaining('Build Team’s shared Work account') } });
    expect(homes).toEqual(['home', 'home']);
  });

  it('does not attach another resource’s names when the recipient read cannot resolve the selected account', async () => {
    const deps: ActionExecutorDeps = { homeDomainAction: async request => request.actionId === 'teams.get' ? team
      : TeamCredentialResourceEntitledPageV1Schema.parse({ resources: [{ ...resource, id: 'unrelated-resource' }] }) };
    const prepared = await prepareApprovalRequest({ deps, actionId: 'session.spawn_new', input, actionArgs: input, context });
    expect(prepared).not.toHaveProperty('preview.teamCredentialSources');
    expect(prepared).toMatchObject({ actionArgs: input });
  });
});
