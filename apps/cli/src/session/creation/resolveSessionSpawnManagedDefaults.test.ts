import axios from 'axios';
import nacl from 'tweetnacl';
import { EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { projectRequesterAccountActionAuthorization } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { rebindRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountSettingsParse, SessionSpawnNewInputV2Schema, SessionSpawnNewResultV1Schema } from '@happier-dev/protocol';
import type { SessionSpawnNewActionAuthoringInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions';
import { TeamSummaryV1Schema } from '@happier-dev/protocol/teams/projections';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams/capabilities';
import { resolveTeamAdmissionProjectionV1 } from '@happier-dev/protocol/teams/projections';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { configuration } from '@/configuration';
import type { StoredCredentials } from '@/persistence';
import { ConnectedServiceBindingsV2IngressSchema } from '@happier-dev/protocol/connect/connectedServiceBindings';
import { createInvocationSavedSecretOperationContextV1 } from '@/settings/secrets/savedSecretOperationContext';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { ConnectedPurposeCatalogV1Schema } from '@happier-dev/protocol/connect/connectedAccountConfigurationRowsV1';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveQualifiedPurposeDeclarationSnapshotForAgentSpawn } from '@/daemon/connectedServices/requestAuth/prepareConnectedAccountRequestAuthForSpawn';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { ActionExecuteFailureSchema, projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
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
  it('uses explicit Session placement without switching to Workflow policy', async () => {
    const configured = { provisioner: { pluginId: 'example.sandbox', localId: 'sandbox' }, presetId: 'development-preset' };
    const input = { executionTarget: { serverId: 'home', machineId: 'machine' }, agentTarget: target,
      sessionPlacement: { kind: 'machine' as const, target: { serverId: 'home', machineId: 'machine' },
        configuredSandbox: { kind: 'sandbox' as const, configuredSandboxId: 'development', lifecycle: 'shared-kept' as const, ...configured } } };
    const resolved = await resolveSessionSpawnManagedDefaults(input, {
      agentId: 'codex', accountSettings: {}, organizationPolicy: { status: 'absent' },
      openedMachineMetadata: { isolationPolicyV1: { configuredSandboxes: { development: configured },
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } } },
      readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
    });
    expect(resolved.resolveIsolation()).toMatchObject({ workKind: 'sessions',
      choice: { kind: 'sandbox', configuredSandboxId: 'development', lifecycle: 'shared-kept' } });
  });

  it.each(['configured', 'missing', 'preset-mismatch', 'machine'] as const)(
    'honors an admitted Workflow selection through Machine policy (%s)', async scenario => {
    const configured = { provisioner: { pluginId: 'example.sandbox', localId: 'sandbox' }, presetId: 'development-preset' };
    const resolved = await resolveSessionSpawnManagedDefaults({
      executionTarget: { serverId: 'home', machineId: 'machine' }, agentTarget: target,
    }, {
      agentId: 'codex', accountSettings: {}, organizationPolicy: { status: 'absent' },
      openedMachineMetadata: { isolationPolicyV1: {
        configuredSandboxes: scenario === 'missing' ? {} : { development: configured },
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' },
          automationsWorkflows: scenario === 'machine'
            ? { kind: 'sandbox', configuredSandboxId: 'development', lifecycle: 'fresh' } : { kind: 'directly' } },
      } },
      startContext: { authority: 'account_automation', actionCaller: { kind: 'workflowRun', runId: 'run',
        authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } },
      admittedWorkflowPlacement: { kind: 'machine', target: { serverId: 'home', machineId: 'machine' },
        ...(scenario !== 'machine' ? { configuredSandbox: { kind: 'sandbox' as const, configuredSandboxId: 'development',
          lifecycle: 'shared-kept' as const, ...configured, presetId: scenario === 'preset-mismatch' ? 'other-preset' : configured.presetId } } : {}) },
      readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
    });
    if (scenario === 'missing' || scenario === 'preset-mismatch') {
      expect(resolved.resolveIsolation).toThrowError(expect.objectContaining({ errorCode: 'target_unavailable' }));
    } else expect(resolved.resolveIsolation()).toMatchObject({ workKind: 'automationsWorkflows',
      choice: { kind: 'sandbox', configuredSandboxId: 'development', lifecycle: scenario === 'machine' ? 'fresh' : 'shared-kept' },
      configuredSandbox: configured });
  });
  it('preserves explicit native authentication instead of reapplying a saved connected account', async () => {
    const resolved = await resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' },
      agentTarget: target, connectedServices: null }, {
      agentId: 'codex', organizationPolicy: { status: 'absent' }, accountSettings: accountSettingsParse({
        connectedServicesDefaultAuthByAgentIdV1: { v: 1, bindingsByAgentId: { codex: { v: 2, bindingsByServiceId: {
          [serviceId]: { source: 'connected', profileId: 'saved-account' },
        } } } },
      }), readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
    });
    expect(resolved.connectedServices.bindingsByServiceId).not.toHaveProperty(serviceId);
  });
  it.each([
    { caller: { kind: 'host' } as const, workKind: 'sessions', id: 'session' },
    { caller: { kind: 'workflowRun', runId: 'run', authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' } } as const, workKind: 'automationsWorkflows', id: 'workflow' },
    { caller: { kind: 'plugin', pluginId: 'example.channels' } as const, workKind: 'botsChannels', id: 'bot', attestedContext: { externalPrincipalId: 'sender', sourceMessageId: 'message' } },
  ])('enforces the $workKind placement from admitted origin before caller-selected placement', async ({ caller, workKind, id, attestedContext }) => {
    const resolved = await resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' },
      agentTarget: target, ...(attestedContext ? { attestedContext } : {}) }, {
      agentId: 'codex', accountSettings: accountSettingsParse({}), organizationPolicy: { status: 'absent' },
      openedMachineMetadata: { isolationPolicyV1: {
        configuredSandboxes: Object.fromEntries(['session', 'bot', 'workflow'].map(key => [key, {
          provisioner: { pluginId: 'example.sandbox', localId: 'sandbox' }, presetId: `preset-${key}`,
        }])), workKinds: {
          sessions: { kind: 'sandbox', configuredSandboxId: 'session', lifecycle: 'fresh' },
          botsChannels: { kind: 'sandbox', configuredSandboxId: 'bot', lifecycle: 'shared-kept' },
          automationsWorkflows: { kind: 'sandbox', configuredSandboxId: 'workflow', lifecycle: 'fresh' },
        },
      } }, startContext: { actionCaller: caller, authority: 'account_automation' },
      readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
    });
    expect(resolved.resolveIsolation()).toMatchObject({ workKind, choice: { kind: 'sandbox', configuredSandboxId: id },
      configuredSandbox: { presetId: `preset-${id}` } });
  });
  it.each(['malformed', 'unattested-bot', 'noninteractive-override', 'use-override', 'interactive-manage-override'] as const)(
    'admits only a verified interactive Manage override ($0)', async scenario => {
      const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'admitted-proof', binding: {
        accountId: 'requester', custodianAccountId: 'custodian', authentication: { kind: 'account', tokenEpoch: 0 },
        accountEncryptionMode: 'plain', serverIdentityId: 'home', machineId: 'machine', installationId: 'installation',
        admittedMachineRole: scenario === 'use-override' ? 'use' : 'manage', actionId: 'session.spawn_new', requestId: 'policy-start',
        target: { kind: 'machine', machineId: 'machine' }, requestEnvelopeDigest: 'a'.repeat(43),
      } });
      const promise = resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' }, agentTarget: target,
        ...(scenario === 'unattested-bot' ? { identity: { bot: { kind: 'bot' as const } } } : {}),
        ...(scenario.endsWith('override') ? { isolationOverride: 'directly' as const } : {}) }, {
        agentId: 'codex', accountSettings: {}, organizationPolicy: { status: 'absent' },
        openedMachineMetadata: { isolationPolicyV1: scenario === 'malformed' ? { agentNativeSandboxEnabled: 'yes' } : {
          configuredSandboxes: { sandbox: { provisioner: { pluginId: 'example.sandbox', localId: 'sandbox' }, presetId: 'preset' } },
          workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'sandbox', lifecycle: 'fresh' }, botsChannels: { kind: 'directly' },
            automationsWorkflows: { kind: 'directly' } },
        } }, startContext: { surface: 'ui', authority: scenario === 'noninteractive-override' ? 'account_automation' : 'present_user',
          actionCaller: { kind: 'host' }, externalActionExecutionAuthorization: authorization,
          presentUserApproval: { actionId: 'session.spawn_new', requestId: 'policy-start', inputDigest: 'a'.repeat(43), decidedAtMs: 1 } },
        readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
      });
      if (scenario === 'interactive-manage-override') {
        expect((await promise).resolveIsolation()?.choice).toEqual({ kind: 'directly' });
      } else await expect(promise.then(value => value.resolveIsolation())).rejects.toMatchObject({ errorCode: scenario.endsWith('override') ? 'permission_denied' : 'target_unavailable' });
    });
  it.each([
    { explicit: undefined, available: true, resume: false, expected: 'off' },
    { explicit: 'on' as const, available: true, resume: false, expected: 'on' },
    { explicit: undefined, available: false, resume: false, expected: undefined },
    { explicit: undefined, available: true, resume: true, expected: undefined },
    { explicit: 'on' as const, available: true, resume: true, expected: 'on' },
  ])('keeps sandbox intent separate from permission defaults (available=$available, resume=$resume, explicit=$explicit)', async ({ explicit, available, resume, expected }) => {
    const resolved = await resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' },
      agentTarget: target, permissionMode: 'read-only', ...(explicit || resume ? { configuration: {
        ...(explicit ? { nativeSandbox: explicit } : {}),
        ...(resume ? { providerSessionResume: { kind: 'provider_session.v1' as const, providerSessionId: 'retained-native-session' } } : {}),
        mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1 },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {},
      } } : {}) }, {
      agentId: 'codex', accountSettings: accountSettingsParse({}), organizationPolicy: { status: 'absent' },
      machineIsolation: { environment: 'managed-guest', provisionerId: 'example.machine/guest' },
      sandboxTypeSupportsNativeSandbox: true,
      nativeSandboxAvailable: available, readTeam: async () => team(), readHome: async () => ({ homeDefaults: null }),
    });
    expect(resolved.nativeSandbox).toBe(expected);
    expect(resolved.permissionMode).toBe('read-only');
  });
  it.each(['home', 'team'] as const)('retains authored choices and notes unreadable optional %s defaults', async scope => {
    const details = { requiredFact: 'governance_access', remedy: 'request_access' };
    const failureCause = projectActionFailureCauseV1({ name: 'Error', code: 'permission_denied', status: 403 },
      scope === 'home' ? 'home.governance.get' : 'teams.get');
    const failure = ActionExecuteFailureSchema.parse({ ok: false, errorCode: 'permission_denied',
      error: 'Governance access refused', details, failureCause, effectAttempted: false });
    const refuse = async () => failure;
    const resolved = await resolveSessionSpawnManagedDefaults({ executionTarget: { serverId: 'home', machineId: 'machine' },
      agentTarget: target, approvalProfileId: 'explicit-profile', permissionMode: 'read-only',
      modelSelection: model('explicit-model'), ...(scope === 'team' ? { primaryTeamId: 'team' } : {}) }, {
      agentId: 'codex', accountSettings: accountSettingsParse({}), organizationPolicy: initialPolicy,
      readTeam: refuse, readHome: refuse,
    });
    expect(resolved).toMatchObject({ permissionMode: 'read-only', modelSelection: model('explicit-model'),
      approvalProfileId: 'explicit-profile', unavailableDefaults: [failure, ...(scope === 'team' ? [failure] : [])] });
  });

  it.each([
    { name: 'cross-Account signed spawn uses only acting Account settings and credentials', surface: 'mcp' as const, layer: 'requester', permission: 'read-only', modelId: 'member-model' },
    { name: 'admitted requester retains private For me above public defaults', surface: 'mcp' as const, layer: 'requester-project', permission: 'safe-yolo', modelId: 'personal-project-model' },
    { name: 'unadmitted cross-Account request refuses', surface: 'mcp' as const, layer: 'unadmitted', permission: 'read-only', modelId: 'member-model' },
    { name: 'retired requester snapshot refuses', surface: 'mcp' as const, layer: 'retired', permission: 'read-only', modelId: 'member-model' },
    { name: 'MCP Team defaults', surface: 'mcp' as const, layer: 'team', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'native recovery preserves authored facets when optional Account defaults are unavailable', surface: 'mcp' as const, layer: 'recovery', permission: 'read-only', modelId: 'retained-model' },
    { name: 'saved member defaults', surface: 'mcp' as const, layer: 'member', permission: 'read-only', modelId: 'member-model' },
    { name: 'Machine approval profile is captured at Session birth', surface: 'cli' as const, layer: 'approval-machine', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'explicit null clears the Machine approval profile at Session birth', surface: 'cli' as const, layer: 'approval-null', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'Team approval profile is captured with derived provenance at Session birth', surface: 'cli' as const, layer: 'approval-team', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'Voice spawn binding reaches saved member model and service defaults', surface: 'voice' as const, layer: 'member', permission: 'read-only', modelId: 'member-model' },
    { name: 'explicit Muse source excludes the saved Codex pool', surface: 'mcp' as const, layer: 'muse', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'no explicit source retains the saved Codex pool', surface: 'mcp' as const, layer: 'pool-default', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'explicit Automatic', surface: 'mcp' as const, layer: 'automatic', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'V2 native Team model', surface: 'mcp' as const, layer: 'v2', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'V2 Team resource model', surface: 'mcp' as const, layer: 'team-resource', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'Group defaults', surface: 'mcp' as const, layer: 'group', permission: 'yolo', modelId: 'group-model' },
    { name: 'locked file policy', surface: 'mcp' as const, layer: 'policy', permission: 'yolo', modelId: 'policy-model' },
    { name: 'conflicting locked placement', surface: 'mcp' as const, layer: 'placement', permission: 'yolo', modelId: 'policy-model' },
    { name: 'Home without Team', surface: 'mcp' as const, layer: 'home', permission: 'read-only', modelId: 'home-model' },
    { name: 'isolated Machine sandbox default preserves Team approvals', surface: 'mcp' as const, layer: 'isolated', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'isolated Machine refuses unavailable explicit native sandbox', surface: 'mcp' as const, layer: 'isolated-explicit', permission: 'safe-yolo', modelId: 'team-model' },
    { name: 'isolated Machine refuses malformed native sandbox policy', surface: 'mcp' as const, layer: 'isolated-invalid-policy', permission: 'safe-yolo', modelId: 'team-model' },
  ])('$name', async testCase => {
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url')}.signature`;
    const crossAccount = ['requester', 'requester-project', 'unadmitted', 'retired'].includes(testCase.layer);
    const custodianToken = `e30.${Buffer.from(JSON.stringify({ sub: 'custodian' })).toString('base64url')}.signature`;
    const reads: string[] = [];
    const launched: SpawnDaemonSessionRequest[] = [];
    const settings = accountSettingsParse({ memoryUpkeepInNewBots: false,
      ...(testCase.layer === 'approval-machine' || testCase.layer === 'approval-null'
        ? { actionsSettingsV1: { v: 1, actions: {}, machineApprovalProfiles: { machine: 'custom:machine-profile' } } } : {}),
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
      if (crossAccount) {
        const headers = config.headers;
        expect(Object.keys(headers ?? {}).map(name => name.toLowerCase())).not.toContain('authorization');
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: 'admitted-root-proof',
          effectActionId: path === '/v1/teams/get' ? 'teams.get' : 'home.governance.get',
          target: { kind: 'machine', machineId: 'machine' }, installationId: 'installation',
          requestId: `defaults-${testCase.layer}`, method: String(config.method).toUpperCase(), path, body: config.data,
          publicKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(7)).publicKey,
          signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]) })).toBe(true);
      }
      if (path === '/v1/teams/get') {
        const projection = { ...team(), viewerJoinedAt: 1700000000000, hasSetup: true };
        if (testCase.layer === 'approval-team') projection.policy.managedDefaults!.team.approvalProfileId = 'custom:team-profile';
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
    vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      if (testCase.layer === 'requester-project' && String(url).endsWith('/v1/account/encryption')) {
        expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      }
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected Home read: ${url}`);
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, config) => {
      if (testCase.layer === 'requester-project' && String(url).endsWith('/v1/account/project-rows/read')) {
        const key = { kind: 'project-session-defaults' as const, serverId: 'home', projectKey: 'personal-project' };
        expect(body).toEqual({ key });
        expect(config?.headers?.Authorization).toBe(`Bearer ${token}`);
        const cipher = createProjectAccountRowCipherV1({ mode: 'plain', material: null, randomBytes: n => new Uint8Array(n) });
        return { status: 200, data: { status: 'present', row: { key, revision: 1, content: cipher.seal({ key, value: {
          permissionModeByAgentTargetKey: { [targetKey]: 'safe-yolo' }, modelByAgentTargetKey: { [targetKey]: model('personal-project-model') },
        } }) } } };
      }
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
    const credentials: StoredCredentials = { token, encryption: null, credentialProvenance: 'stored_session' };
    const params = { credentials, token, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverIdentityId: 'home', serverHttpBaseUrl: 'https://home.test',
      actionsSettingsProvider: createActionSettingsProvider({ accountSettings: settings }),
      savedSecretOperationContext: createInvocationSavedSecretOperationContextV1({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
        ...(testCase.layer === 'recovery' ? { readSourceSnapshot: () => null } : {}),
        serverHttpBaseUrl: 'https://home.test', isCurrent: async () => true,
        snapshot: { settings, settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], source: 'network',
          scopeKey: resolveAccountSettingsScopeKeyForToken(token),
          connectedPurposeCatalog: { status: 'ready', revision: 1, record: { key: 'purposes',
            value: ConnectedPurposeCatalogV1Schema.parse({ v: 1, bindings: testCase.layer === 'muse' || testCase.layer === 'pool-default'
              ? [{ purpose: purpose.purpose, target: { kind: 'group', service, groupId: 'saved-codex-pool' } }]
              : testCase.layer === 'member' || testCase.layer === 'policy' || crossAccount
              ? [{ purpose: purpose.purpose, target: { kind: 'account', account: { service, accountId: 'member-account' } } }] : [] }) } } } }),
      sessionSpawnDirectTargetTransport: { machineId: 'machine', readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1,
        metadata: testCase.layer.startsWith('isolated') ? { isolationV1: { environment: 'managed-guest', provisionerId: 'example.machine/guest' },
          ...(testCase.layer === 'isolated-invalid-policy' ? { isolationPolicyV1: { agentNativeSandboxEnabled: 'yes' } } : {}) } : {} }),
        prepare: async () => ({ ok: true, directory: '/tmp', directoryKind: 'path', directoryCreationRequired: false, checkout: null }),
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
      ...(testCase.layer === 'approval-null' ? { approvalProfileId: null } : {}),
      ...(testCase.layer === 'requester-project' ? { projectContext: { projectRef: { serverId: 'home', projectKey: 'personal-project' } } } : {}),
      ...(testCase.layer === 'home' ? {} : { primaryTeamId: 'team' }),
      ...(testCase.layer === 'recovery' ? { permissionMode: 'read-only', modelSelection: model('retained-model'),
        configuration: { providerSessionResume: { kind: 'provider_session.v1', providerSessionId: 'existing-provider-session' },
          mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
          permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } } : {}),
      ...(testCase.layer === 'automatic' ? { configuration: { mode: { value: null, updatedAtMs: 1 },
        model: { value: null, updatedAtMs: 1, selectionSource: 'explicit' },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } } : {}),
      ...(testCase.layer === 'isolated-explicit' ? { configuration: { nativeSandbox: 'on',
        mode: { value: null, updatedAtMs: 1 }, model: { value: null, updatedAtMs: 1, selectionSource: 'inherited' },
        permissionIntent: { value: null, updatedAtMs: 1 }, options: {} } } : {}),
      ...(testCase.layer === 'policy' ? { permissionMode: 'safe-yolo', modelSelection: model('explicit-model') } : {}),
      connectedServices: { v: 2, bindingsByServiceId: testCase.layer === 'muse'
        ? { 'happier.agent.muse/muse-account': { source: 'connected', selection: 'profile', profileId: 'own-muse' } }
        : testCase.layer === 'policy' ? { [serviceId]: { source: 'connected', profileId: 'explicit-account' } } : {} }, memoryEnabled: false });
    // Voice preserves the authoring input for ordinary creation preparation.
    // Leave model/services unset: supplying them here would hide a defaults bypass.
    // Keep the UI module in its owning compiler program, as other cross-app
    // compositions do; Vitest still loads its real implementation.
    const voiceBinderSource = '../../../../ui/sources/voice/tools/actionImpl/bindSessionSpawnInput';
    const voiceBinder = testCase.surface === 'voice' ? await vi.importActual<{
      bindVoiceSessionSpawnInput(input: unknown):
        { ok: true; input: SessionSpawnNewActionAuthoringInputV2 } | ActionExecuteFailure;
    }>(voiceBinderSource) : null;
    const voiceInput = voiceBinder
      ? voiceBinder.bindVoiceSessionSpawnInput(input)
      : null;
    if (voiceInput && !voiceInput.ok) throw new Error(voiceInput.errorCode);
    const spawn = testCase.layer.startsWith('approval-')
      ? executor.execute('session.spawn_new', input, { surface: testCase.surface, authority: 'present_user',
        serverId: 'home', actionRequestId: `defaults-${testCase.layer}`, bypassApprovals: true })
      : testCase.surface === 'voice' && voiceInput?.ok
      ? executor.execute('session.spawn_new', voiceInput.input, { surface: 'voice', authority: 'present_user',
        serverId: 'home', actionRequestId: 'voice-member-defaults', bypassApprovals: true })
      : deps.sessionSpawnNew!({ ...input, creationKey: input.creationKey,
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
    if (testCase.layer === 'isolated-invalid-policy') {
      await expect(spawn).rejects.toMatchObject({ errorCode: 'target_unavailable',
        details: { reason: 'machine_isolation_policy_unreadable' } });
      expect(launched).toEqual([]);
      return;
    }
    const result = await spawn;
    if (testCase.layer === 'isolated-explicit') {
      expect(SessionSpawnNewResultV1Schema.parse(result)).toMatchObject({ type: 'error', code: 'target_unavailable', retryable: false,
        failureCause: { nativeErrorReason: 'not_available_in_sandbox_type' } });
      expect(launched).toEqual([]);
      return;
    }
    if (testCase.layer === 'placement' || testCase.layer === 'retired') {
      expect(result).toMatchObject({ type: 'error', code: 'permission_denied' });
      expect(launched).toHaveLength(0);
      if (crossAccount) expect(reads).toEqual([]);
      return;
    }
    expect(launched, JSON.stringify(result)).toHaveLength(1);
    expect(launched[0]).toMatchObject({ permissionMode: testCase.permission,
      ...(testCase.layer === 'team-resource' || testCase.layer === 'automatic' || testCase.layer === 'v2' ? {} : { modelSelection: model(testCase.modelId) }),
    });
    if (testCase.layer === 'recovery') { expect(reads).toEqual([]); return; }
    if (testCase.layer.startsWith('approval-')) {
      const approvalProfileId = testCase.layer === 'approval-null' ? null
        : testCase.layer === 'approval-team' ? 'custom:team-profile' : 'custom:machine-profile';
      const approvalProfileTeamOrGroupDerived = testCase.layer === 'approval-team';
      expect(launched[0]).toMatchObject({ approvalProfileId, approvalProfileTeamOrGroupDerived,
        sessionCreationCorrespondence: { recipe: { approvalProfileId, approvalProfileTeamOrGroupDerived } } });
    }
    if (testCase.layer.startsWith('isolated')) {
      const nativeSandbox = testCase.layer === 'isolated' ? 'off' : 'on';
      expect(launched[0]).toMatchObject({ nativeSandbox, sessionCreationCorrespondence: { recipe: { configuration: { nativeSandbox } } } });
    }
    const expectedBindings = testCase.layer === 'muse'
      ? { 'happier.agent.muse/muse-account': { source: 'connected', selection: 'profile', profileId: 'own-muse' } }
      : testCase.layer === 'pool-default'
        ? { [serviceId]: { source: 'connected', selection: 'group', groupId: 'saved-codex-pool' } }
        : { [serviceId]: { source: 'connected', profileId: testCase.layer === 'requester-project'
          ? 'member-account' : testCase.modelId.replace('-model', '-account') } };
    if (testCase.layer === 'muse' || testCase.layer === 'pool-default') {
      const services = ConnectedServiceBindingsV2IngressSchema.parse(launched[0]?.connectedServices);
      const connectedBindings = Object.fromEntries(Object.entries(services.bindingsByServiceId)
        .filter(([, binding]) => binding.source !== 'native'));
      expect(connectedBindings).toEqual(expectedBindings);
    } else {
      expect(launched[0]?.connectedServices).toMatchObject({ v: 2, bindingsByServiceId: expectedBindings });
    }
    if (testCase.layer === 'automatic') expect(launched[0]?.modelSelection).toBeUndefined();
    if (testCase.layer === 'v2') expect(launched[0]?.modelSelection).toEqual({ v: 2, updatedAt: 1,
      ref: { source: 'native', agentTargetKey: targetKey, modelId: 'team-model' } });
    if (testCase.layer === 'team-resource') {
      expect(launched[0]?.modelSelection).toEqual({ v: 2, updatedAt: 1, ref: { source: 'team_resource',
        resourceId: 'model-resource', teamId: 'team', expectedResourceRevision: 3, deliveryMode: 'brokered',
        agentTargetKey: targetKey, modelId: 'team-model' } });
      expect(launched[0]?.teamCredentialBindings).toEqual([expect.objectContaining({ slot: { kind: 'provider_model' },
        resourceId: 'model-resource', expectedResourceRevision: 3, providerModelSelection: { agentTargetKey: targetKey, modelId: 'team-model' } })]);
    }
    const governanceReads = reads.filter(path => path === '/v1/teams/get' || path === '/v1/home/governance/get');
    expect(governanceReads).toEqual([testCase.layer === 'home' ? '/v1/home/governance/get' : '/v1/teams/get']);
  });
});
