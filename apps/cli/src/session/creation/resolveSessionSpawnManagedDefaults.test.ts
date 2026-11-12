import axios, { AxiosHeaders } from 'axios';
import nacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { rebindRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, SessionSpawnNewInputV2Schema } from '@happier-dev/protocol';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { configuration } from '@/configuration';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { resolveSessionSpawnManagedDefaults } from './resolveSessionSpawnManagedDefaults';

const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
const targetKey = 'agent:happier.agent.codex/codex';
const purpose = resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn({ agentId: 'codex', contributions: readCurrentContributionRegistry() })?.authorizedPurposes[0];
if (!purpose?.serviceRefs[0]) throw new Error('Expected real Codex purpose');
const service = purpose.serviceRefs[0];
const serviceId = buildQualifiedPluginContributionKey(service);
const model = (modelId: string) => ({ v: 1 as const, updatedAt: 1, ref: { agentTargetKey: targetKey, providerConnectionId: null, modelId } });
const values = (permissionMode: 'read-only' | 'safe-yolo' | 'yolo', modelId: string) => ({
  permissionModeByAgentTargetKey: { [targetKey]: permissionMode }, modelByAgentTargetKey: { [targetKey]: model(modelId) },
  connectedServicesByAgentTargetKey: { [targetKey]: [{ purpose: purpose.purpose, service, target: { kind: 'account', account: { service, accountId: modelId.replace('-model', '-account') } }, teamResource: null }] },
});
const team = () => TeamSummaryV1Schema.parse({ id: 'team', name: 'Team', description: null, logo: null, archivedAt: null, recovery: null,
  policy: { v: 1, sessionCreationPolicy: 'private_default', externalSharingPolicy: 'allowed', defaultSessionHistoryAccess: 'from_membership',
    admissionMode: 'invite_only', authenticationPolicy: null, managedDefaults: { team: values('safe-yolo', 'team-model'),
      groups: { group: values('yolo', 'group-model') } }, homeDefaults: values('read-only', 'home-model') },
  managedDefaultsGroupIds: [], viewerRole: 'member', capabilities: { ...NO_TEAM_CAPABILITIES_V1, viewTeam: true },
  admission: resolveTeamAdmissionProjectionV1(), counts: null });

const initialPolicy = configuration.organizationPolicy;
afterEach(() => { Object.defineProperty(configuration, 'organizationPolicy', { value: initialPolicy, configurable: true }); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Session spawn defaults at admission', () => {
  it.each(['home', 'team'] as const)('retains an admitted %s governance refusal and public diagnostic', async scope => {
    const details = { requiredFact: 'governance_access', remedy: 'request_access' };
    const failureCause = projectActionFailureCauseV1({ name: 'Error', code: 'permission_denied', status: 403 },
      scope === 'home' ? 'home.governance.get' : 'teams.get');
    // These adapters are the Home/Team HTTP read boundaries; defaults resolution
    // and its thrown failure projection remain real.
    const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'permission_denied',
      error: 'Governance access refused', details, failureCause, effectAttempted: false });
    const refuse = async () => failure;
    let thrown: unknown;
    try {
      await resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' }, agentTarget: target,
        ...(scope === 'team' ? { primaryTeamId: 'team' } : {}) }, {
        agentId: 'codex', accountSettings: accountSettingsParse({}), organizationPolicy: initialPolicy,
        readTeam: refuse, readHome: refuse,
      });
    } catch (error) { thrown = error; }
    expect(normalizeActionExecutorThrownError(thrown)).toMatchObject({ errorCode: 'permission_denied', details, failureCause, effectAttempted: false });
  });

  it.each([
    { name: 'cross-Account signed spawn uses only acting Account settings and credentials', surface: 'mcp' as const, layer: 'requester', permission: 'read-only', modelId: 'member-model' },
    { name: 'unadmitted cross-Account request refuses', surface: 'mcp' as const, layer: 'unadmitted', permission: 'read-only', modelId: 'member-model' },
    { name: 'retired requester snapshot refuses', surface: 'mcp' as const, layer: 'retired', permission: 'read-only', modelId: 'member-model' },
    { name: 'MCP Team defaults', surface: 'mcp' as const, layer: 'team', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'saved member defaults', surface: 'mcp' as const, layer: 'member', permission: 'read-only', modelId: 'member-model' },
    { name: 'explicit Automatic', surface: 'mcp' as const, layer: 'automatic', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'V2 native Team model', surface: 'mcp' as const, layer: 'v2', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'V2 Team resource model', surface: 'mcp' as const, layer: 'team-resource', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'Group defaults', surface: 'mcp' as const, layer: 'group', permission: 'yolo', modelId: 'group-model' },
    { name: 'locked file policy', surface: 'mcp' as const, layer: 'policy', permission: 'yolo', modelId: 'policy-model' },
    { name: 'conflicting locked placement', surface: 'mcp' as const, layer: 'placement', permission: 'yolo', modelId: 'policy-model' },
    { name: 'Home without Team', surface: 'mcp' as const, layer: 'home', permission: 'read-only', modelId: 'home-model' },
  ])('$name', async testCase => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const crossAccount = ['requester', 'unadmitted', 'retired'].includes(testCase.layer);
    const custodianToken = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    const reads: string[] = [];
    const launched: SpawnDaemonSessionRequest[] = [];
    const settings = accountSettingsParse({ memoryUpkeepInNewBots: false,
      ...(testCase.layer === 'member' || testCase.layer === 'policy' || crossAccount ? {
        sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'read-only' },
        providerDefaultModelSelectionsByAgentTargetKeyV1: { [targetKey]: model('member-model') },
        connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', profileId: 'member-account' } } } } },
      } : {}),
    });
    Object.defineProperty(configuration, 'organizationPolicy', { configurable: true, value: testCase.layer === 'policy' || testCase.layer === 'placement' ? {
      status: 'loaded', policy: { schemaVersion: 2, organization: 'Example', sessionDefaults: { values: { ...values('yolo', 'policy-model'),
        placement: { kind: 'machine', target: { serverId: 'home', machineId: testCase.layer === 'placement' ? 'different-machine' : 'machine' } } }, locked: true } },
    } : { status: 'absent' } });
    // HTTP and the native launch are real system boundaries; all Action,
    // precedence, correspondence, Team parsing and launch preparation stay real.
    vi.spyOn(axios, 'request').mockImplementation(async config => {
      const path = new URL(String(config.url)).pathname;
      reads.push(path);
      if (crossAccount) expect(AxiosHeaders.from(config.headers).get('Authorization')).toBe(`Bearer ${token}`);
      if (path === '/v1/teams/get') {
        const projection = team();
        if (testCase.layer === 'group') projection.managedDefaultsGroupIds = ['group'];
        if (testCase.layer === 'v2' || testCase.layer === 'team-resource') projection.policy.managedDefaults!.team.modelByAgentTargetKey = {
          [targetKey]: testCase.layer === 'v2' ? { v: 2, updatedAt: 1, ref: { source: 'native', agentTargetKey: targetKey, modelId: 'team-model' } }
            : { v: 2, updatedAt: 1, ref: { source: 'team_resource', resourceId: 'model-resource', teamId: 'team', expectedResourceRevision: 3,
              deliveryMode: 'brokered', agentTargetKey: targetKey, modelId: 'team-model' } },
        };
        return { status: 200, data: projection };
      }
      if (path === '/v1/home/governance/get') return { status: 200, data: { homeDefaults: values('read-only', 'home-model') } };
      throw new Error(`Unexpected Home Action read: ${path}`);
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      if (String(url).endsWith('/v2/sessions/lookup-by-tags')) return { status: 200, data: { sessions: [] } };
      throw new Error(`Unexpected Home write: ${url}`);
    });
    const invokeNative = async (method: string): Promise<unknown> => {
        if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT || method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE) return { ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null };
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return { protocolVersion: 1, projection: { v: 2, generation: 1,
          familiesById: {}, agentsById: { codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } } } } };
        if (method === RPC_METHODS.CAPABILITIES_DETECT) return { protocolVersion: 1, results: { 'cli.codex': { ok: true, checkedAt: 1, data: {
          installed: true, version: '1.0', latestVersion: null, update: { supported: false, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'managed', sizeBytes: null, guideUrl: null }, dependencies: [] } } } };
        throw new Error(`Unexpected native read: ${method}`);
    };
    vi.spyOn(machineRpc, 'callExactMachineRpc').mockImplementation(async request => invokeNative(request.method));
    vi.spyOn(machineRpc, 'callMachineRpc').mockImplementation(async request => invokeNative(request.method));
    const params = { credentials: { token, encryption: null }, token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
      savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
        serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        snapshot: { settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network',
          scopeKey: resolveAccountSettingsScopeKeyForToken(token), whenRefreshed: null,
          connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes',
            value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: testCase.layer === 'member' || testCase.layer === 'policy' || crossAccount
              ? [{ purpose: purpose.purpose, target: { kind: 'account', account: { service, accountId: 'member-account' } } }] : [] }) } } } }),
      sessionSpawnDirectTargetTransport: { machineId: 'machine', prepare: async () => ({ ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
        spawnedSession: { spawn: async request => { launched.push(request); return { type: 'success', sessionId: 'created',
          sessionCreationOutcome: { disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } }; },
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) } },
      machineActionDirectTargetTransport: { machineId: 'machine', invoke: invokeNative },
    } satisfies Parameters<typeof createCliActionDeps>[0];
    let externalAuthorization;
    if (crossAccount) {
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-root-proof', binding: {
        accountId: 'requester', custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
        admittedMachineRole: 'manage', actionId: 'session.spawn_new', requestId: `defaults-${testCase.layer}`,
        target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
      } });
      const projected = await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'home', bootstrap: {
        credentials: { token, encryption: null }, serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        attribution: { serverId: 'home', accountId: 'requester', machineId: 'machine', installationId: 'installation' },
      } });
      if (!projected) throw new Error('Expected requester projection');
      const snapshot = params.savedSecretOperationContext.readSnapshot();
      if (!snapshot) throw new Error('Expected captured settings');
      const requesterOperation = createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null },
        snapshot, serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        ...(testCase.layer === 'retired' ? { readSourceSnapshot: () => null } : {}),
      });
      // Model the already-admitted host-local custody boundary. The production
      // projection and custody selector remain real; no wire input can set it.
      externalAuthorization = testCase.layer === 'unadmitted' ? projected : rebindRequesterAccountActionContext(projected, projected, {
        credentials: { token, encryption: null }, savedSecretOperationContext: requesterOperation,
        accountSettingsContext: { ...snapshot, whenRefreshed: null }, accountEncryptionCurrentness: { mode: 'plain', version: 1,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
        authorization: projected, serverHttpBaseUrl: 'https://home.test', resolveEncryption: async () => null,
        isCurrent: async () => true, refreshAccountSettings: async () => true,
        subscribeEnvironmentAccess: () => () => undefined, retain: () => async () => undefined, dispose: async () => undefined,
      });
      params.credentials = { token: custodianToken, encryption: null };
      params.token = custodianToken;
      params.actionsSettingsProvider = createActionSettingsProvider({ accountSettings: accountSettingsParse({
        sessionDefaultPermissionModeByTargetKey: { [targetKey]: 'yolo' },
        providerDefaultModelSelectionsByAgentTargetKeyV1: { [targetKey]: model('custodian-model') },
      }) });
      // A distinct daemon snapshot makes accidental fallback observable.
      params.savedSecretOperationContext = createInvocationSavedSecretOperationContextV1({ credentials: params.credentials,
        snapshot: { ...snapshot, scopeKey: resolveAccountSettingsScopeKeyForToken(custodianToken),
          settings: params.actionsSettingsProvider.getAccountSettings()! }, serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true });
    }
    const deps = createCliActionDeps({ ...params, externalActionMachineInstallationId: 'installation',
      externalActionMachineRequestPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).secretKey });
    const executor = createCliActionExecutor(params);
    const input = SessionSpawnNewInputV2Schema.parse({ creationKey: `defaults-${testCase.layer}`,
      executionTarget: { serverId: 'home', machineId: 'machine' }, directory: { kind: 'path', path: '/tmp' }, agentTarget: target,
      ...(testCase.layer === 'home' ? {} : { primaryTeamId: 'team' }),
      ...(testCase.layer === 'automatic' ? { configuration: { mode: { value: null, updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1, selectionSource: 'explicit' },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } } : {}),
      ...(testCase.layer === 'policy' ? { permissionMode: 'safe-yolo', modelSelection: model('explicit-model') } : {}),
      connectedServices: { v: 2, bindingsByServiceId: testCase.layer === 'policy' ? { [serviceId]: { source: 'connected', profileId: 'explicit-account' } } : {} }, memoryEnabled: false });
    const spawn = deps.sessionSpawnNew!({ ...input,
      invokeAgentReadinessAction: (actionId, request) => executor.execute(actionId, request, { surface: 'cli',
        authority: 'present_user', serverId: 'home', bypassApprovals: true }), actionCaller: { kind: 'host' }, callerSurface: testCase.surface,
      sessionCreationTag: deriveSessionCreationTagV1({ callerCreationNamespace: 'user', creationKey: input.creationKey! }),
      context: { surface: testCase.surface, authority: 'present_user', actionCaller: { kind: 'host' },
        serverId: 'home', actionRequestId: `defaults-${testCase.layer}`, bypassApprovals: true,
        ...(externalAuthorization ? { externalActionExecutionAuthorization: externalAuthorization } : {}),
        ...(externalAuthorization && testCase.layer !== 'unadmitted'
          ? { externalActionTarget: { kind: 'machine' as const, machineId: 'machine' } } : {}) } });
    if (testCase.layer === 'unadmitted') {
      await expect(spawn).rejects.toMatchObject({ details: { authorizationRefusalReason: 'target_missing' } });
      expect(launched).toEqual([]);
      expect(reads).toEqual([]);
      return;
    }
    const result = await spawn;
    if (testCase.layer === 'placement' || testCase.layer === 'retired') {
      expect(result).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(launched).toHaveLength(0);
      if (crossAccount) expect(reads).toEqual([]);
      return;
    }
    expect(launched, JSON.stringify(result)).toHaveLength(1);
    expect(launched[0]).toMatchObject({ permissionMode: testCase.permission,
      ...(testCase.layer === 'team-resource' || testCase.layer === 'automatic' ? {} : { modelSelection: model(testCase.modelId) }),
      connectedServices: { v: 2, bindingsByServiceId: { [serviceId]: { source: 'connected', profileId: testCase.modelId.replace('-model', '-account') } } } });
    if (testCase.layer === 'automatic') expect(launched[0]?.modelSelection).toBeUndefined();
    if (testCase.layer === 'team-resource') {
      expect(launched[0]?.modelSelection).toBeUndefined();
      expect(launched[0]?.teamCredentialBindings).toEqual([expect.objectContaining({ slot: { kind: 'provider_model' },
        resourceId: 'model-resource', expectedResourceRevision: 3, providerModelSelection: { agentTargetKey: targetKey, modelId: 'team-model' } })]);
    }
    expect(reads).toEqual([testCase.layer === 'home' ? '/v1/home/governance/get' : '/v1/teams/get']);
  });
});
