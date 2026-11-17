import { expect, it } from 'vitest';
import { projectSessionAccessCapabilitiesV1 } from '../access/sessionEffectiveAccessV1.js';
import { composeSessionReadinessV1, readSessionOperationCredentialReadinessV1, SessionReadinessV1Schema, type SessionReadinessFactsV1 } from './sessionReadinessV1.js';
import { TeamCredentialResourceCatalogEntryV1Schema } from '../../teams/credentials/resourceV1.js';
import { PluginProjectionV2Schema } from '../../daemon/contributionRegistryProjection.js';

const facts: SessionReadinessFactsV1 = {
  configured: true, operation: 'conversation', machine: { status: 'ready', machineId: 'machine-1' },
  agent: { agentId: 'acme-agent', current: true, observedAtMs: 10, state: 'ready', repair: null },
  invocation: { v: 1, level: 'owner', sources: [], capabilities: projectSessionAccessCapabilitiesV1({ owner: true, grants: [] }) },
  credential: { kind: 'not_required' },
};

it('keeps optional integration failure independent of conversation, preserving the credential owner detail', () => {
  const credential = { kind: 'team' as const, teamId: 'team', resourceId: 'resource',
    readiness: { kind: 'limit_reached' as const, metric: 'inference_requests' as const, resetsAtUtc: '2026-10-19T00:00:00Z' },
    recoveryAction: 'source_owner_action' as const };
  const conversation = composeSessionReadinessV1({ ...facts, credential });
  expect(conversation.status).toBe('ready');
  const write = composeSessionReadinessV1({ ...facts, operation: 'credential', credential });
  expect(write).toMatchObject({ status: 'unavailable', cause: 'credential', credential });
  expect(SessionReadinessV1Schema.parse(write)).toEqual(write);
});

it('never certifies stale or missing sign-in and never reclassifies unsupported as offline', () => {
  expect(composeSessionReadinessV1({ ...facts, agent: null })).toMatchObject({ status: 'unknown', cause: 'agent' });
  expect(composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, current: false } })).toMatchObject({ status: 'unknown', cause: 'agent' });
  expect(composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, state: 'unsupported' } })).toMatchObject({ status: 'unavailable', cause: 'agent', machine: { status: 'ready' } });
  expect(composeSessionReadinessV1({ ...facts, operation: 'credential' })).toMatchObject({ status: 'unknown', cause: 'credential' });
});

it('keeps a missing required Team route on the credential owner instead of native Agent sign-in', () => {
  const credential = { kind: 'team' as const, teamId: 'team', resourceId: 'resource', readiness: null, recoveryAction: null };
  expect(composeSessionReadinessV1({ ...facts,
    agent: { ...facts.agent!, state: 'needsSignIn' }, credential }, { credentialRequiredForConversation: true }))
    .toMatchObject({ status: 'unknown', cause: 'credential', credential });
});

it('preserves an exact entitled sign-in repair without executing it', () => {
  const repair = { actionId: 'machines.agents.signIn.start' as const, input: { machineId: 'machine-1', agentId: 'acme-agent', method: 'native' as const } };
  const result = composeSessionReadinessV1({ ...facts, agent: { ...facts.agent!, state: 'needsSignIn', repair } });
  expect(result).toMatchObject({ status: 'unavailable', cause: 'agent', agent: { repair } });
  expect(SessionReadinessV1Schema.parse(result)).toEqual(result);
  expect(SessionReadinessV1Schema.safeParse({ ...result, agent: { ...result.agent, token: 'secret' } }).success).toBe(false);
});

it('keeps the purpose resource owner detail only for the current exact Team selection', () => {
  const service = { pluginId: 'acme.external', localId: 'account' };
  const purpose = { consumer: { pluginId: service.pluginId, localId: 'helper' }, purpose: 'outside-write' };
  const selection = { source: 'team_resource' as const, resourceId: 'resource', deliveryMode: 'direct' as const,
    disclosedMember: { service, accountId: 'work' } };
  const resource = TeamCredentialResourceCatalogEntryV1Schema.parse({ id: selection.resourceId, teamId: 'team', displayName: { content: { t: 'plain', v: 'Acme' }, recipientEnvelope: null },
    resourceRevision: 1, readiness: { kind: 'limit_reached', metric: 'inference_requests', resetsAtUtc: '2026-10-20T00:00:00Z' },
    recoveryAction: 'source_owner_action', mayBroker: false, mayReceiveDirect: true, directMaterialState: 'current',
    sessionUsePolicy: 'personal_allowed', providerModels: [], connectedServiceSelections: [selection], sourcePresentation: { kind: 'connected_service', service } });
  const projection = PluginProjectionV2Schema.parse({ v: 2, generation: 1,
    installedPackagesById: { [service.pluginId]: { id: service.pluginId, enabled: true, displayName: 'Acme',
      source: { kind: 'builtin', locator: service.pluginId } } },
    resourcesById: { helper: { id: purpose.consumer.localId, pluginId: service.pluginId, resourceKind: 'config', path: 'helper.json',
      connectedAccountPurposes: [{ purpose: purpose.purpose, serviceRefs: [service] }] } },
  });
  const input: Parameters<typeof readSessionOperationCredentialReadinessV1>[0] = {
    purpose, projection, machineProvisionersById: projection.familiesById.machineProvisioners?.entriesById ?? {},
    bindings: { v: 1, bindings: [] }, teamSelection: { purpose, teamId: 'team', selection },
    accounts: [], groups: [], now: 30, machineId: 'machine-1', executionAccountId: 'alice', machineAccess: null,
    repairAccess: 'custodian_only', teamResource: resource,
  };
  const credential = readSessionOperationCredentialReadinessV1(input);
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamSelection: undefined })).toEqual({ kind: 'unknown' });
  expect(credential).toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource',
    readiness: { kind: 'available' }, recoveryAction: resource.recoveryAction });
  expect(SessionReadinessV1Schema.parse(composeSessionReadinessV1({ ...facts, operation: 'credential', credential })))
    .toMatchObject({ status: 'ready', cause: null, credential });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamResource: { ...resource,
    connectedServiceSelections: [{ ...selection, disclosedMember: { service, accountId: 'replacement' } }] } }))
    .toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource', readiness: null, recoveryAction: null });
  const changedService = { pluginId: 'other.external', localId: 'account' };
  const incompatible = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource, readiness: { kind: 'available' },
    sourcePresentation: { kind: 'connected_service', service: changedService },
  });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamResource: incompatible }))
    .toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource', readiness: null, recoveryAction: null });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamResource: { ...incompatible, readiness: resource.readiness } }))
    .toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource', readiness: null, recoveryAction: null });
  const unavailable = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...resource,
    readiness: { kind: 'source_unavailable' }, connectedServiceSelections: [] });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamResource: unavailable }))
    .toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource', readiness: unavailable.readiness,
      recoveryAction: unavailable.recoveryAction });
  const corrupt = TeamCredentialResourceCatalogEntryV1Schema.parse({ ...unavailable,
    readiness: { kind: 'resource_corrupt' }, sourcePresentation: null });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamResource: corrupt }))
    .toEqual({ kind: 'team', teamId: 'team', resourceId: 'resource', readiness: corrupt.readiness,
      recoveryAction: corrupt.recoveryAction });
  expect(readSessionOperationCredentialReadinessV1({ ...input, teamSelection: { ...input.teamSelection!,
    purpose: { ...purpose, purpose: 'different-operation' } } })).toEqual({ kind: 'unknown' });
});
