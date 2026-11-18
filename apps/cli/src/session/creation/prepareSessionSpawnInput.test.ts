import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, projectExternalActionProjectSessionDefaultsAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';
import { TeamSummaryV1Schema, resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { ExternalActionRequesterInvocationV1Schema } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createPrepareSessionSpawnInput } from './prepareSessionSpawnInput';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { readSessionCreationAccountSettingsContext } from './cliManagedSessionDefaultsContext';

// HTTP is the boundary. Preparation, context loading, custody and precedence stay real.
afterEach(() => vi.restoreAllMocks());

it('keeps the captured Account snapshot outside requester wire defaults and signed input', async () => {
  const credentials = { token: 'requester-token', encryption: null, credentialProvenance: 'stored_session' as const };
  const operation = createInvocationSavedSecretOperationContextV1({ credentials, serverHttpBaseUrl: 'https://home.test',
    isCurrent: async () => true, snapshot: { settings: accountSettingsParse({}), settingsVersion: 987654321,
      loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network',
      scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) } });
  vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { homeDefaults: null } });
  const prepare = createPrepareSessionSpawnInput({ credentials, token: credentials.token, mode: 'plain',
    sessionId: '', ctx: null, serverId: 'home', serverHttpBaseUrl: 'https://home.test', savedSecretOperationContext: operation,
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no connected-services intent'); },
  });
  const prepared = await prepare({ executionTarget: { serverId: 'home', machineId: 'machine' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    directory: { kind: 'path', path: '/repo' } }, { surface: 'cli', authority: 'present_user' });
  expect(readSessionCreationAccountSettingsContext(prepared.defaults)?.settingsVersion).toBe(987654321);
  const wire = ExternalActionRequesterInvocationV1Schema.shape.sessionCreationDefaults.parse(prepared.defaults);
  expect(readSessionCreationAccountSettingsContext(wire)).toBeUndefined();
  expect(JSON.stringify({ input: prepared.input, defaults: prepared.defaults })).not.toContain('987654321');
});

it.each(['machine', 'preset', 'unavailable-team', 'automatic', 'authored-model'] as const)('prepares public no-box defaults while preserving private preset custody (%s)', async placement => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
  const keys = nacl.sign.keyPair();
  const projectContext = { projectRef: { serverId: 'home', projectKey: 'private' }, sourceRef: { serverId: 'home', sourceId: 'selected' } };
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
    accountEncryptionMode: 'e2ee', custodianAccountId: 'custodian', serverIdentityId: 'home',
    machineId: 'machine', installationId: 'installed', actionId: 'session.spawn_new', requestId: 'birth',
    target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
    projectSessionDefaultsAdmission: projectExternalActionProjectSessionDefaultsAdmissionV1('session.spawn_new', { projectContext }),
  } });
  const reads: string[] = [];
  vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('private Account GET is unavailable without requester custody'); });
  vi.spyOn(axios, 'post').mockImplementation(async () => { throw new Error('private Account POST is unavailable without requester custody'); });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const url = new URL(String(config.url));
    const path = url.pathname + url.search;
    reads.push(url.pathname);
    const headers = config.headers;
    expect(Object.keys(headers ?? {}).map(name => name.toLowerCase())).not.toContain('authorization');
    const effectActionId = url.pathname === '/v1/teams/get' ? 'teams.get'
      : url.pathname === '/v1/home/governance/get' ? 'home.governance.get' : 'projects.sources.read';
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId,
      target: authorization.binding.target, installationId: 'installed', requestId: 'birth',
      method: String(config.method).toUpperCase(), path, ...(config.data === undefined ? {} : { body: config.data }),
      publicKey: keys.publicKey, signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    if (url.pathname === '/v1/projects/sources/selected') return { status: 200, data: { ok: true,
      source: { id: 'selected', name: 'Shared', revision: 1, owner: { kind: 'team', teamId: 'team' },
        audience: [], createdByAccountId: 'owner' }, canManage: false,
      sessionDefaults: { revision: 1, defaults: { approvalProfileId: 'project-profile',
        ...(placement === 'preset' ? { placement: { kind: 'preset', homeId: 'home', presetId: 'shared-preset' } } : {}),
        defaultAgentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } } } };
    if (placement === 'unavailable-team' && url.pathname === '/v1/teams/get') {
      return { status: 404, data: { error: 'team_not_found' } };
    }
    if (url.pathname === '/v1/home/governance/get') throw new Error('optional Home is unreachable');
    if (url.pathname === '/v1/teams/get') return { status: 200, data: TeamSummaryV1Schema.parse({
      id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
      policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed',
        defaultSessionHistoryAccess: 'from_membership', admissionMode: 'invite_only', authenticationPolicy: null,
        managedDefaults: { team: { approvalProfileId: 'team-profile', modelByAgentTargetKey: {
          'agent:happier.agent.codex/codex': { v: 2, updatedAt: 7, ref: { source: 'team_resource',
            teamId: 'team', resourceId: 'model-resource', expectedResourceRevision: 3, deliveryMode: 'brokered',
            agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'muse-spark-1.3-contributor' },
        } } }, groups: {} }, homeDefaults: null },
      managedDefaultsGroupIds: [], viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
      admission: resolveTeamAdmissionProjectionV1(), counts: null }) };
    throw new Error(`Unexpected HTTP read ${path}`);
  });
  const prepare = createPrepareSessionSpawnInput({ credentials: { token, encryption: null }, token, mode: 'plain',
    sessionId: '', ctx: null, rawSession: {}, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
    externalActionMachineInstallationId: 'installed', externalActionMachineRequestPrivateKey: keys.secretKey,
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no connected-services intent'); },
  });
  const preparation = prepare({ ...(placement !== 'preset' ? { executionTarget: { serverId: 'home', machineId: 'machine' } } : {}),
    directory: { kind: 'path', path: '/repo' }, projectContext,
    ...(placement === 'automatic' || placement === 'authored-model' ? { configuration: {
      mode: { value: null, updatedAtMs: 1 }, permissionIntent: { value: null, updatedAtMs: 1 }, options: {},
      model: { value: placement === 'automatic' ? null : 'my-model', updatedAtMs: 7, selectionSource: 'explicit' },
    } } : {}) }, { surface: 'rpc', authority: 'account_automation', externalActionExecutionAuthorization: authorization,
    externalActionTarget: authorization.binding.target });
  if (placement === 'preset') {
    await expect(preparation).rejects.toMatchObject({ errorCode: 'client_required' });
    expect(reads).toEqual(['/v1/projects/sources/selected', '/v1/teams/get']);
    return;
  }
  const prepared = await preparation;
  expect(prepared.input.agentTarget).toMatchObject({ identity: { localId: 'codex' } });
  if (placement === 'automatic' || placement === 'authored-model') {
    expect(prepared.input.modelSelection).toBeUndefined();
    expect(prepared.input.configuration).toMatchObject({ model: {
      value: placement === 'automatic' ? null : 'my-model', selectionSource: 'explicit',
    } });
  } else if (placement !== 'unavailable-team') expect(prepared.input.modelSelection).toEqual({ v: 2, updatedAt: 7, ref: { source: 'team_resource',
      teamId: 'team', resourceId: 'model-resource', expectedResourceRevision: 3, deliveryMode: 'brokered',
      agentTargetKey: 'agent:happier.agent.codex/codex', modelId: 'muse-spark-1.3-contributor' } });
  expect(prepared.defaults.context.personalProjectDefaults).toBeNull();
  expect(resolveManagedSessionDefaults({ ...prepared.defaults.context, agentTargetKey: '' }).approvalProfileId)
    .toMatchObject({ value: 'project-profile', source: 'project', teamOrGroupDerived: true });
  expect(reads).toEqual(['/v1/projects/sources/selected', '/v1/teams/get',
    ...(placement === 'unavailable-team' ? ['/v1/home/governance/get'] : [])]);
  if (placement === 'unavailable-team') {
    expect(prepared.defaults.unavailableDefaults).toMatchObject([
      { errorCode: 'team_not_found' }, { errorCode: 'defaults_unavailable', effectAttempted: false },
    ]);
    const invocation = ExternalActionRequesterInvocationV1Schema.parse({ caller: { kind: 'host' }, surface: 'rpc',
      authority: 'account_automation', sessionCreationDefaults: prepared.defaults });
    expect(invocation.sessionCreationDefaults?.unavailableDefaults).toEqual(prepared.defaults.unavailableDefaults);
  }
});


it.each(['pat', 'daemon'] as const)('prepares no-Project creation without requester-private reads (%s)', async kind => {
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant: API_TOKEN_FULL_GRANT_V1,
    accountEncryptionMode: 'plain', custodianAccountId: 'custodian', serverIdentityId: 'home',
    machineId: 'machine', installationId: 'installed', actionId: 'session.spawn_new', requestId: 'birth',
    target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  vi.spyOn(axios, 'get').mockRejectedValue(new Error('private read forbidden'));
  vi.spyOn(axios, 'post').mockRejectedValue(new Error('private write forbidden'));
  vi.spyOn(axios, 'request').mockRejectedValue(new Error('Home admin read forbidden'));
  const prepare = createPrepareSessionSpawnInput({ credentials: { token, encryption: null }, token, mode: 'plain',
    sessionId: '', ctx: null, rawSession: {}, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no auth intent'); },
  });
  const prepared = await prepare({ executionTarget: { serverId: 'home', machineId: 'machine' },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    directory: { kind: 'path', path: '/repo' }, primaryTeamId: 'unavailable-team' }, { surface: 'rpc', authority: 'account_automation',
    ...(kind === 'pat' ? { externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target } : {}) });
  expect(prepared.input.executionTarget).toEqual({ serverId: 'home', machineId: 'machine' });
  expect(prepared.defaults.context.homeDefaults).toBeNull();
  expect(prepared.defaults.context.primaryTeamId).toBe('unavailable-team');
  expect(prepared.defaults.context.teamDefaults).toBeNull();
  expect(axios.request).not.toHaveBeenCalled();
  expect(axios.get).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

it('inherits signed Account Home defaults without a Project selection or requester box', async () => {
  const keys = nacl.sign.keyPair();
  const token = 'machine-custodian-token';
  const target = { kind: 'machine', machineId: 'machine' } as const;
  const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root-proof', binding: {
    accountId: 'requester', authentication: { kind: 'account', tokenEpoch: 0 },
    accountEncryptionMode: 'e2ee', custodianAccountId: 'custodian', serverIdentityId: 'home',
    machineId: target.machineId, installationId: 'installed', actionId: 'session.spawn_new', requestId: 'birth',
    target, requestEnvelopeDigest: 'a'.repeat(43),
  } });
  vi.spyOn(axios, 'request').mockImplementation(async config => {
    const path = new URL(String(config.url)).pathname;
    expect(path).toBe('/v1/home/governance/get');
    expect(config.data).toEqual({ projection: 'session_defaults' });
    expect(Object.keys(config.headers ?? {}).map(name => name.toLowerCase())).not.toContain('authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'home.governance.get',
      target, installationId: 'installed', requestId: 'birth', method: String(config.method).toUpperCase(),
      path, body: config.data, publicKey: keys.publicKey,
      signature: String(config.headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
    return { status: 200, data: { homeDefaults: { approvalProfileId: 'home-profile' } } };
  });
  const prepare = createPrepareSessionSpawnInput({ credentials: { token, encryption: null }, token, mode: 'plain',
    sessionId: '', ctx: null, rawSession: {}, serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
    externalActionMachineInstallationId: 'installed', externalActionMachineRequestPrivateKey: keys.secretKey,
  }, { serverId: 'home', serverHttpBaseUrl: 'https://home.test' }, {
    spawnConnectedServicesList: async () => { throw new Error('no connected-services intent'); },
  });
  const prepared = await prepare({ executionTarget: { serverId: 'home', machineId: target.machineId },
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
    directory: { kind: 'path', path: '/repo' } }, { surface: 'rpc', authority: 'account_automation',
    externalActionExecutionAuthorization: authorization, externalActionTarget: target });
  expect(prepared.defaults.unavailableDefaults ?? []).toEqual([]);
  expect(resolveManagedSessionDefaults({ ...prepared.defaults.context, agentTargetKey: '' }).approvalProfileId)
    .toMatchObject({ value: 'home-profile', source: 'home' });
});
