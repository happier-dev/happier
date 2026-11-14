import { describe, expect, it, vi } from 'vitest';

import { createActionExecutor, type ActionExecutorDeps } from '../actions/actionExecutor.js';
import { resolveMachineAgentTeamCredentialDemandV1 } from '../teams/credentials/teamCredentialModelCatalogV1.js';
import { NO_TEAM_CAPABILITIES_V1 } from '../teams/capabilities.js';

const TEAM = { id: 'team-1', name: 'Team', description: null, logo: null,
  archivedAt: null, recovery: null, viewerRole: 'member', capabilities: NO_TEAM_CAPABILITIES_V1,
  counts: null, admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
  policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
    defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null } };

const CODEX = 'agent:happier.agent.codex/codex';
const BROKER = { pluginId: 'happier.provider.cliproxyapi', localId: 'cliproxyapi' };
const APPLICATION = { agentTargetKey: CODEX, implementationIdentity: BROKER, endpointTemplateId: 'responses', protocol: 'openai-responses' };

const projection = {
  agentsById: {
    codex: { id: 'codex', identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
      providerRequirements: { acceptsProtocols: ['openai-responses'] },
      connectedAccounts: [{ service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' } }] },
  },
  familiesById: { providers: { entriesById: {
    'happier.provider.cliproxyapi/cliproxyapi': { id: 'happier.provider.cliproxyapi/cliproxyapi', provenance: 'first_party',
      definition: { endpointTemplates: [{ id: 'responses', protocol: 'openai-responses' }, { id: 'chat', protocol: 'openai-chat' }],
        managedRuntime: { endpointTemplateIds: ['responses', 'chat'] } } },
  } } },
};

const resource = (id: string, service: { pluginId: string; localId: string }, availability = 'available') => ({
  id, teamId: 'team-1', displayName: encryptedName(id), resourceRevision: 1, sourceOwnerDisplayName: 'Ada',
  readiness: { kind: 'available' }, recoveryAction: null, mayBroker: true, mayReceiveDirect: false,
  directMaterialState: 'never_delivered', sessionUsePolicy: 'personal_allowed', connectedServiceSelections: [],
  sourcePresentation: { kind: 'connected_service', service },
  providerModels: [{ selection: { kind: 'team_credential_provider_model', teamId: 'team-1', resourceId: id,
    expectedResourceRevision: 1, deliveryMode: 'brokered', agentTargetKey: CODEX, modelId: `${id}-model` },
  descriptor: { id: `${id}-model`, name: `${id} model` }, application: APPLICATION, sourceRevision: 'source-1', availability }],
});

import { prepareTeamCredentialSources } from '../actions/specs/teamCredentialApproval.js';
import { projectPrivateLabelForRecipientV1, sealPrivateLabelV1 } from '../crypto/privateLabelV1.js';
import type { PrivateLabelReadV1 } from '../crypto/privateLabelV1.js';
import { resolveTeamCredentialModelOptionsV1 } from './teamCredentialModelOptions.js';

import tweetnacl from 'tweetnacl';
import { encodeBase64 } from '../crypto/base64.js';
import { sealEncryptedDataKeyEnvelopeV1 } from '../crypto/encryptedDataKeyEnvelopeV1.js';
const dataKey = new Uint8Array(32).fill(7);
function encryptedName(id: string): PrivateLabelReadV1 {
  return projectPrivateLabelForRecipientV1({ stored: sealPrivateLabelV1({ mode: 'e2ee',
    binding: { entity: 'team_credential_resource', field: 'displayName', id }, value: `${id} account`,
    dataKey, recipients: [{ accountId: 'viewer', envelope: { encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)).publicKey, randomBytes: length => new Uint8Array(length).fill(5) })), recipientContentPublicKeyFingerprint: `content-public-key-sha256:${'a'.repeat(64)}` } }], randomBytes: length => new Uint8Array(length).fill(3) }), recipientAccountId: 'viewer' });
}
// A keyholding host delegates to the actual cipher owner; HTTP and daemon RPC are the only faked boundaries.
import { createCliPrivateLabelActionOpener } from '../../../../apps/cli/src/api/privateLabels.js';
const privateLabelOpen = createCliPrivateLabelActionOpener({ type: 'dataKey', machineKey: new Uint8Array(32).fill(9),
  publicKey: tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9)).publicKey });
const ctx = { surface: 'ui', authority: 'present_user', serverId: 'home' } as const;
const codex = resource('codex', { pluginId: 'happier.agent.codex', localId: 'openai-codex' });
function dependencies(): ActionExecutorDeps {
  return { privateLabelOpen, machinePluginProjectionRead: async () => projection,
    homeDomainAction: async ({ actionId, input }) => actionId === 'teams.list' ? { items: [TEAM], nextCursor: null }
      : actionId === 'teams.get' ? TEAM : { resources: [codex], nextCursor: null, ...('teamIds' in (input as Record<string, unknown>) ? { failures: [] } : {}) },
    providerActionExecute: async () => ({ ok: true, result: { status: 'success', agentTargetKey: CODEX,
      groups: [], teamCredentialResources: [codex] } }),
  };
}
describe('Team credential sealed names in semantic Action consumers', () => {
  it('preserves captured keyholder retirement instead of presenting stale names as unavailable', async () => {
    const retired = Object.assign(new Error('retired'), { code: 'action_account_scope_changed' });
    const deps = { ...dependencies(), privateLabelOpen: async () => { throw retired; } };
    await expect(prepareTeamCredentialSources({ deps, context: ctx,
      selection: { resources: [{ teamId: TEAM.id, resourceId: codex.id }] } })).rejects.toBe(retired);
  });
  it('opens the encrypted recipient name for model descriptions rather than interpolating ciphertext objects', async () => {
    const result = await resolveTeamCredentialModelOptionsV1({ deps: dependencies(), ctx,
      actionId: null, machineId: 'm1', agentTargetKey: CODEX, readFailure: () => null });
    expect(result).toMatchObject({ ok: true, result: [{ description: 'codex account', label: 'codex model' }] });
  });
  it('opens the exact selected credential name before capturing approval display context', async () => {
    const sources = await prepareTeamCredentialSources({ deps: dependencies(), context: ctx,
      selection: { resources: [{ teamId: TEAM.id, resourceId: codex.id }] } });
    expect(sources).toEqual([{ teamId: TEAM.id, resourceId: 'codex', teamName: TEAM.name, accountName: 'codex account' }]);
  });
  it('omits unavailable approval names and ciphertext from model descriptions when no keyholder exists', async () => {
    const deps = { ...dependencies(), privateLabelOpen: undefined };
    const sources = await prepareTeamCredentialSources({ deps, context: ctx,
      selection: { resources: [{ teamId: TEAM.id, resourceId: codex.id }] } });
    expect(sources).toEqual([]);
    const result = await resolveTeamCredentialModelOptionsV1({ deps, ctx, actionId: null,
      machineId: 'm1', agentTargetKey: CODEX, readFailure: () => null });
    expect(result).toMatchObject({ ok: true, result: [{ label: 'codex model' }] });
    expect(JSON.stringify(result)).not.toContain('[object Object]');
    expect(JSON.stringify(result)).not.toContain(JSON.stringify(codex.displayName));
  });
});
