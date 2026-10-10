import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import fastify from 'fastify';
import tweetnacl from 'tweetnacl';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  API_TOKEN_FULL_GRANT_V1,
  createActionExecutor,
  deriveBoxPublicKeyFromSeed,
  decodeBase64,
  encodeBase64,
  EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER,
  EXTERNAL_ACTION_RESOLVED_TARGET_HEADER,
  encodeExternalActionResolvedTargetV1,
  openEncryptedDataKeyEnvelopeV1,
  openAccountScopedBlobCiphertext,
  sealAccountScopedBlobCiphertext,
  openPublicShareDataKeyV1,
  type ArtifactPublicLinkIssuedV1,
  PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
  sealEncryptedDataKeyEnvelopeV1,
  SetSessionAccessGrantRequestV1Schema,
  signAccountContentKeyBindingV1,
  verifyExternalActionMachineRequestV1,
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import { NO_TEAM_CAPABILITIES_V1 } from '@happier-dev/protocol/teams';

import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import {
  createCurrentSessionProjectionRecordFixture,
  createSessionRecordFixture,
} from '@/testkit/backends/sessionFixtures';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import * as machineRpcTransport from '@/session/transport/rpc/machineRpc';
import { computeWorkspaceSyncPolicyDigest } from '@happier-dev/protocol/sessions/control/handoff/workspaceSyncSchemas';
import { discoverLocalServiceRunTargets } from '@/daemon/local/services/launch/runTargets';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { isApprovalRequiredByActionsSettings } from '@happier-dev/protocol/actions/actionApprovalPolicy';
import { createCliActionDeps } from '@/session/actions/createCliActionDeps';
import { resolveSessionEncryptionContextFromCredentials } from '@/session/transport/encryption/sessionEncryptionContext';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';

function createAccountProjectWorkerActionDeps(input: Parameters<typeof createAccountServerActionDeps>[0]) {
  const ctx = input.credentials ? resolveSessionEncryptionContextFromCredentials(input.credentials) : null;
  // This global fixture binds no Session. Account encryption is still read by its real HTTP owner.
  const cryptoContext = ctx ? { mode: 'e2ee' as const, ctx } : { mode: 'plain' as const, ctx: null };
  return createCliActionDeps({
    ...input,
    ...cryptoContext,
    sessionId: 'cli-global',
    projectWorkerAccountAction: createAccountServerActionDeps(input).projectWorkerAction,
  });
}

function createWorkerPreferenceCustodyExecutor(input: Parameters<typeof createAccountServerActionDeps>[0]) {
  // This Account user explicitly waived confirmation for this Action on CLI.
  // Keep the actual shared approval policy; a confirmation hint is not a waiver.
  const settings = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
    approvalWaivedSurfaces: { 'projects.worker.preferences.set': ['cli'] } });
  return createActionExecutor({
    ...createAccountProjectWorkerActionDeps(input),
    isActionApprovalRequired: (actionId, context, actionInput) =>
      isApprovalRequiredByActionsSettings(actionId, settings, context, undefined, undefined, actionInput),
  });
}

function ownerSessionAccessGrants(grants: readonly unknown[] = []) {
  return {
    visibility: 'complete' as const,
    owner: {
      kind: 'account' as const,
      accountId: 'owner-account',
      firstName: 'Owner',
      lastName: null,
      username: 'owner',
      avatarUrl: null,
    },
    effectiveAccess: {
      v: 1 as const,
      level: 'owner' as const,
      capabilities: {
        readTranscript: true,
        submitAgentInput: true,
        editSessionRecords: true,
        approveRuntimePermissions: true,
        manageAccess: true,
        managePermissionDelegation: true,
        managePublicLink: true,
        archiveSession: true,
        renameSession: true,
        assignResponsibility: true,
        stopSession: true,
        deleteSession: true,
      },
      sources: [{ kind: 'owner' as const }],
    },
    primaryTeamId: null,
    grants,
  };
}

const archivedTeamSummary = {
  id: 'team-1',
  name: 'Platform',
  description: null,
  logo: null,
  archivedAt: 1,
  recovery: null,
  policy: {
    v: 1,
    sessionCreationPolicy: 'private_default',
    externalSharingPolicy: 'allowed',
    defaultSessionHistoryAccess: 'from_membership',
    admissionMode: 'invite_only',
    authenticationPolicy: null,
  },
  viewerRole: 'owner',
  capabilities: NO_TEAM_CAPABILITIES_V1,
  admission: { historyChoice: { admin: 'choice', member: 'choice', guest: 'hidden' } },
  counts: null,
} as const;

function managedIdentityProviderFixture() {
  return {
    v: 1 as const,
    owner: { kind: 'home' as const },
    id: 'provider-1',
    kind: 'oidc' as const,
    displayName: 'Corporate OIDC',
    enabled: false,
    firstEnabledAt: null,
    securityRevision: 2,
    revision: 3,
    config: {
      v: 1 as const,
      kind: 'oidc' as const,
      issuer: 'https://id.example.test',
      clientId: 'happier',
      clientAuthenticationMethod: 'client_secret_post' as const,
      scopes: 'openid profile email',
      httpTimeoutSeconds: 15,
      claims: { login: 'preferred_username', email: 'email', groups: 'groups' },
      allow: { usersAllowlist: [], emailDomains: [], groupsAny: [], groupsAll: [] },
      fetchUserInfo: true,
      storeRefreshToken: false,
      ui: { buttonColor: null, iconHint: null },
    },
    secret: { configured: true, health: 'configured' as const },
    lastSuccessfulTest: null,
    createdByAccountId: 'account-1',
    createdAt: 1,
    updatedAt: 2,
    teamConsumers: [],
  };
}

describe('Account API token HTTP adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
  });
  afterEach(async () => { restore(); await app.close(); });

  it('dispatches preset Actions to the fixed Home and retains typed revision/refusal outcomes', async () => {
    const bodies: unknown[] = [];
    const preset = { id: 'preset-a', homeId: 'srv_preset', revision: 1, name: 'Guest',
      owner: { kind: 'account', accountId: 'owner' },
      recipe: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'guest', choices: { cores: 2 } },
      controller: { machineId: 'host-a', installationId: 'installation-a' },
    } as const;
    app.post('/v1/machines/presets/list', async (request) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      bodies.push(request.body);
      return { kind: 'listed', presets: [] };
    });
    app.post('/v1/machines/presets/update', async (request, reply) => {
      bodies.push(request.body);
      return reply.code(409).send({ kind: 'conflict', currentRevision: 3 });
    });
    app.post('/v1/machines/presets/get', async (_request, reply) => reply.code(404).send({ kind: 'refused', code: 'preset_not_found' }));
    app.post('/v1/machines/presets/archive', async (request, reply) => {
      bodies.push(request.body);
      return reply.code(403).send({ kind: 'refused', code: 'permission_denied' });
    });
    for (const verb of ['create', 'restore']) {
      app.post(`/v1/machines/presets/${verb}`, async (request) => { bodies.push(request.body); return { kind: 'saved', preset }; });
    }
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'route-preset', serverIdentityId: 'srv_preset', serverHttpBaseUrl: 'http://account.test' });
    const executor = createActionExecutor(deps as Parameters<typeof createActionExecutor>[0]);
    const context = { surface: 'cli', serverId: 'route-preset', authority: 'present_user', bypassApprovals: true } as const;
    expect(await executor.execute('machines.presets.list', { homeId: 'srv_preset' }, context))
      .toEqual({ ok: true, result: { kind: 'listed', presets: [] } });
    expect(await executor.execute('machines.presets.update', { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 2, patch: { name: 'Draft' } }, context))
      .toEqual({ ok: true, result: { kind: 'conflict', currentRevision: 3 } });
    expect(await executor.execute('machines.presets.get', { homeId: 'srv_preset', id: 'preset-a' }, context))
      .toEqual({ ok: true, result: { kind: 'refused', code: 'preset_not_found' } });
    const { revision: _revision, ...create } = preset;
    expect(await executor.execute('machines.presets.create', create, context)).toMatchObject({ ok: true, result: { kind: 'saved', preset } });
    expect(await executor.execute('machines.presets.archive', { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 }, context))
      .toEqual({ ok: true, result: { kind: 'refused', code: 'permission_denied' } });
    expect(await executor.execute('machines.presets.restore', { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 }, context))
      .toMatchObject({ ok: true, result: { kind: 'saved', preset } });
    expect(await executor.execute('machines.presets.list', { homeId: 'route-preset' }, context))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(bodies).toEqual([{ homeId: 'srv_preset' }, { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 2, patch: { name: 'Draft' } },
      create, { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 }, { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 }]);
  });

  it('qualifies presets through the existing authenticated feature snapshot when CLI has no pre-resolved Home identity', async () => {
    let requests = 0;
    app.post('/v1/machines/presets/list', async () => { requests++; return { kind: 'listed', presets: [] }; });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_preset' } } });
    const invocation = { actionId: 'machines.presets.list', input: { homeId: 'srv_preset' }, context: { surface: 'cli', serverId: 'route-preset' } } as const;
    const params = { token: 'interactive', serverId: 'route-preset', serverHttpBaseUrl: 'http://account.test' } as const;
    const authenticated = createAccountServerActionDeps({ ...params, resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'authenticated', features }) });
    await expect(authenticated.machinePresetAction!(invocation)).resolves.toEqual({ kind: 'listed', presets: [] });
    const advisory = createAccountServerActionDeps({ ...params, resolveServerFeaturesSnapshot: async () => ({ status: 'ready', provenance: 'public', features }) });
    await expect(advisory.machinePresetAction!(invocation)).resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    const retired = createAccountServerActionDeps({ ...params, serverIdentityId: 'srv_preset', isCredentialCurrent: () => false });
    await expect(retired.machinePresetAction!(invocation)).resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(requests).toBe(1);
  });

  it('withholds a preset read when its captured Account credential retires before the response', async () => {
    let current = true;
    app.post('/v1/machines/presets/list', async () => { current = false; return { kind: 'listed', presets: [] }; });
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'route-preset', serverIdentityId: 'srv_preset',
      serverHttpBaseUrl: 'http://account.test', isCredentialCurrent: () => current });
    await expect(deps.machinePresetAction!({ actionId: 'machines.presets.list', input: { homeId: 'srv_preset' }, context: { surface: 'cli' } }))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(current).toBe(false);
  });

  it('executes token access updates and terminal policy changes through the declared Home owners', async () => {
    const requests: unknown[] = [];
    const tokenId = '12345678-1234-4234-8234-123456789abc';
    const grant = { ...API_TOKEN_FULL_GRANT_V1, approve: true };
    app.post('/v1/auth/api-tokens/update', async (request) => {
      requests.push(request.body);
      return { apiToken: {
        tokenId, label: 'Edited', displayPrefix: 'hap_v1_12345678', createdAt: '2026-09-30T00:00:00Z',
        lastUsedAt: null, expiresAt: null, hasEncryptionAccess: false, hasUnattendedTeamAccess: false,
        grant, parentTokenId: null, activeChildCount: 0, embedConfig: null,
      } };
    });
    app.post('/v1/account/security/terminal-present-user', async (request) => {
      requests.push(request.body);
      return { policy: 'disallowed' };
    });
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });
    const executor = createActionExecutor(deps as Parameters<typeof createActionExecutor>[0]);
    const automationContext = { surface: 'cli' as const, authority: 'account_automation' as const };
    expect(await executor.execute('account.apiTokens.update', { tokenId, label: 'Edited', grant }, automationContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(await executor.execute('account.security.terminalPresentUser.set', { policy: 'disallowed' }, automationContext))
      .toMatchObject({ ok: false, errorCode: 'present_user_required' });
    expect(requests).toEqual([]);
    const context = { surface: 'cli' as const, authority: 'present_user' as const };
    expect(await executor.execute('account.apiTokens.update', { tokenId, label: 'Edited', grant }, {
      ...context,
      presentUserConfirmation: { actionId: 'account.apiTokens.update' },
    }))
      .toMatchObject({ ok: true, result: { apiToken: { tokenId, label: 'Edited', grant } } });
    expect(await executor.execute('account.security.terminalPresentUser.set', { policy: 'disallowed' }, {
      ...context,
      presentUserConfirmation: { actionId: 'account.security.terminalPresentUser.set' },
    }))
      .toMatchObject({ ok: true, result: { policy: 'disallowed' } });
    expect(requests).toEqual([{ tokenId, label: 'Edited', grant }, { policy: 'disallowed' }]);
  });

  it('rejects a fixed Home endpoint without its matching Home identity', () => {
    const partialFixedHome = { token: 'bound-home-token', serverHttpBaseUrl: 'http://account.test' };
    // @ts-expect-error -- Untyped JavaScript callers can still provide a partial fixed-Home binding.
    expect(() => createAccountServerActionDeps(partialFixedHome)).toThrow('fixed_action_server_target_incomplete');
  });

  it('reads workspace worker preferences through the Action owner for a keyless Account', async () => {
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.post('/v1/projects/execution/config/read', async (request) => {
      expect(request.body).toEqual({ address: { serverId: 'home', refId: 'checkout' } });
      return { status: 'present', revision: 3, content: { t: 'plain', v: {
        enabled: false, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {}, services: {},
      } } };
    });
    const executor = createActionExecutor(createAccountProjectWorkerActionDeps({
      token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test',
    }));
    expect(await executor.execute('projects.worker.preferences.get', { workspace: { serverId: 'home', refId: 'checkout' } }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { status: 'ready', revision: 3, provenance: 'saved', preference: { allowAdHoc: true } } });
  });

  it('does not claim worker effect custody when Account-mode preflight retires before mutation', async () => {
    const controller = new AbortController();
    let effectIssued = false;
    let rowReads = 0;
    let mutations = 0;
    app.get('/v1/account/encryption', async () => {
      controller.abort();
      return { mode: 'plain', updatedAt: 0 };
    });
    app.post('/v1/projects/execution/config/read', async () => {
      rowReads++;
      return { status: 'absent' };
    });
    app.post('/v1/projects/execution/config/mutate', async () => {
      mutations++;
      return { status: 'updated', revision: 1, cursor: 1 };
    });
    const executor = createWorkerPreferenceCustodyExecutor({
      token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test',
      onRequestIssued: () => { effectIssued = true; },
    });
    const outcome = await executor.execute('projects.worker.preferences.set', {
      workspace: { serverId: 'home', refId: 'checkout' }, expectedRevision: 'absent', expected: { kind: 'absent' },
      next: { enabled: false, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {} },
    }, { surface: 'cli', serverId: 'home', signal: controller.signal,
      presentUserConfirmation: { actionId: 'projects.worker.preferences.set' } });
    expect(outcome).toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(controller.signal.aborted).toBe(true);
    expect(effectIssued).toBe(false);
    expect(rowReads).toBe(0);
    expect(mutations).toBe(0);
  });

  it.each(['confirmed', 'malformed'] as const)('retains issued worker preference custody after credential retirement with a %s acknowledgement', async (acknowledgement) => {
    const workspace = { serverId: 'home', refId: 'checkout' };
    const next = { enabled: false as const, unavailable: 'ask' as const, allowAdHoc: true, scriptOverrides: {} };
    let current = true;
    let effectIssued = false;
    let rowReads = 0;
    let mutations = 0;
    app.get('/v1/account/encryption', async () => {
      expect(effectIssued).toBe(false);
      return { mode: 'plain', updatedAt: 0 };
    });
    app.post('/v1/projects/execution/config/read', async (request) => {
      expect(current).toBe(true);
      expect(effectIssued).toBe(false);
      expect(request.body).toEqual({ address: workspace });
      rowReads++;
      return { status: 'absent' };
    });
    app.post('/v1/projects/execution/config/mutate', async (request) => {
      expect(current).toBe(true);
      expect(effectIssued).toBe(true);
      expect(request.body).toEqual({ address: workspace, expectedRevision: 'absent',
        content: { t: 'plain', v: { ...next, services: {} } } });
      mutations++;
      // The HTTP boundary retires this invocation's credential after accepting its exact write.
      current = false;
      return acknowledgement === 'confirmed' ? { status: 'updated', revision: 1, cursor: 1 }
        : { status: 'possibly_updated' };
    });
    const executor = createWorkerPreferenceCustodyExecutor({
      token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test',
      isCredentialCurrent: () => current, onRequestIssued: () => { effectIssued = true; },
    });
    const outcome = await executor.execute('projects.worker.preferences.set', {
      workspace, expectedRevision: 'absent', expected: { kind: 'absent' }, next,
    }, { surface: 'cli', serverId: 'home',
      presentUserConfirmation: { actionId: 'projects.worker.preferences.set' } });
    expect(outcome).toEqual({ ok: true, result: acknowledgement === 'confirmed'
      ? { status: 'applied', preference: next, provenance: 'saved', revision: 1 }
      : { status: 'outcomeUnknown' } });
    expect(effectIssued).toBe(true);
    expect(current).toBe(false);
    expect(rowReads).toBe(1);
    expect(mutations).toBe(1);
  });

  it('saves a service through the real Account Action HTTP path while preserving finite and other service preferences', async () => {
    const workspace = { serverId: 'home', refId: 'checkout' };
    const placement = { runsOn: { kind: 'workers' as const, destination: { kind: 'machine' as const, machineId: 'worker-a' } }, unavailable: 'fail' as const };
    const prior = { enabled: false, unavailable: 'ask', allowAdHoc: true, scriptOverrides: {},
      services: { api: { runsOn: { kind: 'primary' }, unavailable: 'primary' } } };
    let content: unknown = { t: 'plain', v: prior };
    let revision = 3;
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.post('/v1/projects/execution/config/read', async (request) => {
      expect(request.body).toEqual({ address: workspace });
      return { status: 'present', revision, content };
    });
    app.post('/v1/projects/execution/config/mutate', async (request) => {
      const body = request.body as { address: unknown; expectedRevision: number; content: unknown };
      expect(body.address).toEqual(workspace);
      expect(body.expectedRevision).toBe(3);
      content = body.content;
      return { status: 'updated', revision: ++revision, cursor: 1 };
    });
    const executor = createActionExecutor(createAccountProjectWorkerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
    const result = await executor.execute('projects.service.placement.set', { workspace, serviceName: 'web', expectedRevision: 2,
      expected: { kind: 'absent' }, value: placement }, { surface: 'cli', serverId: 'home', authority: 'present_user',
      presentUserConfirmation: { actionId: 'projects.service.placement.set' } });
    expect(result).toMatchObject({ ok: true, result: { status: 'applied', placement, revision: 4 } });
    expect(content).toEqual({ t: 'plain', v: { ...prior, services: { ...prior.services, web: placement } } });
    expect(await executor.execute('projects.service.placement.get', { workspace, serviceName: 'web' }, { surface: 'cli', serverId: 'home' }))
      .toMatchObject({ ok: true, result: { status: 'ready', placement, revision: 4, provenance: 'saved' } });
  });

  it.each(['ordinary', 'bind_child_source', 'bind_child_worker'] as const)('reads actual declared service custody through physical endpoints and logical namespaces (%s)', async kind => {
    const homeId = kind === 'ordinary' ? 'home' : 'srv_service_bind';
    const sourceParent = { id: 'checkout', serverId: homeId, machineId: 'source', rootPath: '/source', createdAtMs: 1 };
    const workerParent = { ...sourceParent, id: 'copy', machineId: 'worker', rootPath: '/worker' };
    const child = { ...sourceParent, id: 'child', machineId: 'child-machine', rootPath: '/work/custom' };
    const source = kind === 'bind_child_source' ? child : sourceParent;
    const worker = kind === 'bind_child_worker' ? child : workerParent;
    const parent = kind === 'bind_child_worker' ? workerParent : sourceParent;
    const unrelated = { ...sourceParent, id: 'unrelated', machineId: 'elsewhere', rootPath: '/unrelated' };
    const observation = { nativeResourceId: 'native-child', user: 'coder', workspaceFolder: child.rootPath,
      storage: { kind: 'bind' as const, hostPath: parent.rootPath, childPath: child.rootPath } };
    const projection = { relation: { managedMachineId: 'managed-child', managedMachineKind: 'devcontainer' as const,
      parentMachineId: parent.machineId }, observation };
    const managedMachine = { id: 'managed-child', homeId, custodianAccountId: 'owner',
      controller: { machineId: parent.machineId, installationId: `${parent.machineId}-installation` },
      launch: { provider: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1, name: 'Child', choices: {} },
      resource: { contributionRef: { pluginId: 'happier.devcontainer', localId: 'devcontainer' }, schemaVersion: 1,
        value: {}, devcontainerObservation: observation }, allocation: 'bound', creationState: 'active', enrolledMachineId: child.machineId,
      desired: 'start', desiredWhen: 'now', intentRevision: 1, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
    } satisfies ManagedMachineV1;
    const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
    const graph = { relationships: [{ v: 1, relationshipId: 'linked', controllerMachineId: 'source',
      alphaWorkspaceRefId: sourceParent.id, betaWorkspaceRefId: workerParent.id, mode: 'keep_synced', enabled: false,
      contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }] };
    let graphRevision = 1;
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
    app.get('/v1/machines/:id', async request => {
      const id = (request.params as { id: string }).id;
      return { machine: { id, active: true, installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
        devcontainerChild: kind !== 'ordinary' && id === child.machineId ? projection : null,
        metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
        metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
          happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier', ...(id === child.machineId ? { devcontainerChild: projection } : {}) }) } };
    });
    if (kind !== 'ordinary') {
      app.post('/v1/machines/managed/actions/get', async () => managedMachine);
      vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ features: {},
        capabilities: { serverIdentity: { serverIdentityId: homeId } } }), { status: 200 }));
    }
    app.post('/v1/projects/execution/config/read', async () => ({ status: 'absent' }));
    app.post('/v1/account/project-rows/list', async () => ({ status: 'listed', coverage: 'complete', rows: [
      ...[sourceParent, workerParent, ...(kind === 'ordinary' ? [] : [child]), unrelated].map(value => { const key = { kind: 'workspace-ref', serverId: homeId, id: value.id };
        return { key, revision: 1, content: { t: 'plain', v: { key, value } } }; }),
      { key: { kind: 'relationship-graph' }, revision: graphRevision, content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: graph } } },
    ] }));
    const target = { id: 'actual', source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'instance' },
      machineId: worker.machineId, workspaceId: worker.id, workspace: { serverId: homeId, workspaceId: worker.id, machineId: worker.machineId, rootPath: worker.rootPath },
      cwd: worker.rootPath, declaration: { workspaceRefId: worker.id, selection: { kind: 'manifest', name: 'web' } },
      serviceState: 'running', readiness: 'not_reported', title: 'web', state: 'available', confidence: 'high', actions: ['manage'] };
    let failWorker = false;
    let sourceAlsoRunning = false;
    let workerRunning = true;
    // This replaces only the remote Machine RPC transport. Account rows, topology, strict
    // binding validation, desired-row codec and the Action front door remain real.
    const remote = vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => {
      if (![sourceParent.machineId, workerParent.machineId, ...(kind === 'ordinary' ? [] : [child.machineId])].includes(request.machineId)) throw new Error('Unrelated Machine census');
      const ref = [sourceParent, workerParent, child].find(value => value.machineId === request.machineId)!;
      expect(request.request).toEqual({ machineId: request.machineId, scope: 'workspace',
        workspaceRoot: ref.rootPath, projection: 'managed_bindings' });
      if (failWorker && request.machineId === worker.machineId) throw new Error('Worker is offline');
      return { protocolVersion: 1, snapshot: { v: 1, machineId: request.machineId, updatedAt: 1,
        targets: request.machineId === worker.machineId ? workerRunning ? [target] : [] : sourceAlsoRunning && request.machineId === source.machineId ? [{ ...target, machineId: source.machineId,
          workspaceId: source.id, workspace: { serverId: homeId, workspaceId: source.id, machineId: source.machineId, rootPath: source.rootPath },
          cwd: source.rootPath, declaration: { workspaceRefId: source.id, selection: { kind: 'manifest', name: 'web' } } }] : [] } };
    });
    const executor = createActionExecutor(createAccountProjectWorkerActionDeps({ token: 'interactive', serverId: homeId, serverHttpBaseUrl: 'https://account.test' }));
    const get = () => executor.execute('projects.service.placement.get', { workspace: { serverId: homeId, refId: source.id }, serviceName: 'web' },
      { surface: 'cli', serverId: homeId });
    try {
      expect(await get()).toMatchObject({ ok: true, result: { status: 'ready', provenance: 'default', placement: { runsOn: { kind: 'primary' } },
        actual: { status: 'present', target } } });
      sourceAlsoRunning = true;
      expect(await get()).toMatchObject({ ok: true, result: { actual: { status: 'ambiguous', targets: expect.arrayContaining([target]) } } });
      failWorker = true;
      expect(await get()).toMatchObject({ ok: true, result: { actual: { status: 'unavailable' } } });
      failWorker = false;
      sourceAlsoRunning = false;
      workerRunning = false;
      expect(await get()).toMatchObject({ ok: true, result: { actual: { status: 'absent' } } });
      graph.relationships[0]!.betaWorkspaceRefId = 'missing-copy';
      graphRevision++;
      expect(await get()).toMatchObject({ ok: true, result: { actual: { status: 'unavailable' } } });
    } finally { remote.mockRestore(); }
  });

  it('reads actual native declaration custody on a linked copy using the original source identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'service-placement-native-'));
    const source = { id: 'native-source', serverId: 'home', machineId: 'source', rootPath: join(root, 'source'), createdAtMs: 1 };
    const worker = { ...source, id: 'native-copy', machineId: 'worker', rootPath: join(root, 'copy') };
    let restoreRemote = () => {};
    try {
      for (const ref of [source, worker]) {
        await mkdir(ref.rootPath);
        await writeFile(join(ref.rootPath, 'package.json'), JSON.stringify({ name: 'native-service', scripts: { dev: 'package-owned server' } }));
      }
      const declarations = await discoverLocalServiceRunTargets({ roots: [], acceptedWorkspaceRefs: [source, worker] });
      const sourceTarget = declarations.find(target => 'declaration' in target && target.workspaceId === source.id);
      const workerTarget = declarations.find(target => 'declaration' in target && target.workspaceId === worker.id);
      if (!sourceTarget || !workerTarget || !('declaration' in sourceTarget) || !('declaration' in workerTarget)) throw new Error('Expected native declarations');
      expect(workerTarget.id).not.toBe(sourceTarget.id);
      const policy = { v: 1 as const, selection: 'all_files' as const, extraIgnorePatterns: [], extraIncludePatterns: [] };
      const relationships = [{ v: 1, relationshipId: 'native-linked', controllerMachineId: source.machineId,
        alphaWorkspaceRefId: source.id, betaWorkspaceRefId: worker.id, mode: 'keep_synced', enabled: false,
        contentPolicy: { ...policy, policyDigest: computeWorkspaceSyncPolicyDigest(policy) }, createdAtMs: 1, updatedAtMs: 1 }];
      app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 0 }));
      app.get('/v1/machines/:id', async request => {
        const id = (request.params as { id: string }).id;
        return { machine: { id, active: true, installationId: `${id}-installation`, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER,
          metadataVersion: 1, daemonStateVersion: 0, daemonState: null,
          metadata: encodePlainMachineStoredContent({ host: id, platform: 'linux', homeDir: '/home/coder', username: 'coder',
            happyCliVersion: 'test', happyHomeDir: '/home/coder/.happier' }) } };
      });
      app.post('/v1/projects/execution/config/read', async () => ({ status: 'absent' }));
      app.post('/v1/account/project-rows/list', async () => ({ status: 'listed', coverage: 'complete', rows: [
        ...[source, worker].map(value => { const key = { kind: 'workspace-ref', serverId: 'home', id: value.id };
          return { key, revision: 1, content: { t: 'plain', v: { key, value } } }; }),
        { key: { kind: 'relationship-graph' }, revision: 1, content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships } } } },
      ] }));
      const target = { id: workerTarget.id, cwd: workerTarget.cwd, title: workerTarget.title,
        workspaceId: workerTarget.workspaceId, workspace: workerTarget.workspace, declaration: workerTarget.declaration,
        source: 'managed_service', sourceClass: { kind: 'managed_service', managedServiceId: 'native-instance' },
        machineId: worker.machineId, serviceState: 'running', readiness: 'not_reported', state: 'available', confidence: 'high', actions: ['manage'] };
      // Only the remote native owner transport is replaced; declaration discovery and identity are real.
      const remote = vi.spyOn(machineRpcTransport, 'callExactMachineRpc').mockImplementation(async request => ({ protocolVersion: 1,
        snapshot: { v: 1, machineId: request.machineId, updatedAt: 1, targets: request.machineId === worker.machineId ? [target] : [] } }));
      restoreRemote = () => remote.mockRestore();
      const executor = createActionExecutor(createAccountProjectWorkerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
      expect(await executor.execute('projects.service.placement.get', { workspace: { serverId: 'home', refId: source.id }, serviceName: sourceTarget.id },
        { surface: 'cli', serverId: 'home' })).toMatchObject({ ok: true, result: { actual: { status: 'present', target: { id: workerTarget.id } } } });
    } finally { restoreRemote(); await rm(root, { recursive: true, force: true }); }
  });

  it('uses the one current list route with an empty body and no projection query', async () => {
    const requests: unknown[] = [];
    app.post('/v1/auth/api-tokens/list', async (request) => {
      requests.push({ query: request.query, body: request.body });
      return { tokens: [] };
    });
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });
    await expect(deps.accountApiTokensListAction!({ input: {}, context: { surface: 'cli' } }))
      .resolves.toEqual({ tokens: [] });
    expect(requests).toEqual([{ query: {}, body: {} }]);
  });

  it('does not retry listing after an authority denial and does not admit error-body extras', async () => {
    let requests = 0;
    app.post('/v1/auth/api-tokens/list', async (_request, reply) => {
      requests++; return reply.code(403).send({ error: 'present_user_required', secret: 'DO_NOT_DISCLOSE' });
    });
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });
    const result = await deps.accountApiTokensListAction!({ input: {}, context: { surface: 'cli' } });
    expect(result).toEqual({ ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_DISCLOSE');
    expect(requests).toBe(1);
  });

  it('preserves strict server codes and removes untrusted error bodies', async () => {
    app.post('/v1/auth/api-tokens/revoke', async (_request, reply) => reply.code(403).send({ error: 'present_user_required' }));
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });
    await expect(deps.accountApiTokensRevokeAction!({ input: { tokenId: '12345678-1234-4234-8234-123456789abc' }, context: { surface: 'cli' } }))
      .resolves.toEqual({ ok: false, errorCode: 'present_user_required', error: 'present_user_required' });
  });

  it('refuses account management addressed to a different selected Home before sending credentials', async () => {
    let requests = 0;
    app.post('/v1/auth/api-tokens/list', async () => {
      requests += 1;
      return { tokens: [] };
    });
    app.post('/v1/auth/api-tokens/update', async () => { requests += 1; return {}; });
    app.post('/v1/account/security/terminal-present-user', async () => { requests += 1; return {}; });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });

    await expect(deps.accountApiTokensListAction!({
      input: {},
      context: { surface: 'cli', serverId: 'home-b' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    await expect(deps.accountApiTokensUpdateAction!({
      input: { tokenId: '12345678-1234-4234-8234-123456789abc', label: 'Edited' },
      context: { surface: 'cli', serverId: 'home-b' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    await expect(deps.accountSecurityTerminalPresentUserSetAction!({
      input: { policy: 'disallowed' },
      context: { surface: 'cli', serverId: 'home-b' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toBe(0);
  });

  it('settles a mutation cancelled before transport issuance without fabricating uncertainty', async () => {
    let requests = 0;
    app.post('/v1/auth/api-tokens/create', async () => {
      requests += 1;
      return { unexpected: true };
    });
    const controller = new AbortController();
    controller.abort();
    const deps = createAccountServerActionDeps({
      token: 'interactive',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });

    await expect(deps.accountApiTokensCreateAction!({
      input: { tokenId: '12345678-1234-4234-8234-123456789abc', label: 'cancelled' },
      context: { surface: 'cli', serverId: 'home-a' },
      signal: controller.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
    });
    expect(requests).toBe(0);
  });

  it('settles malformed API-token acknowledgements from each ActionSpec side-effect class', async () => {
    app.post('/v1/auth/api-tokens/create', async () => ({}));
    app.post('/v1/auth/api-tokens/update', async () => ({}));
    app.post('/v1/auth/api-tokens/list', async () => ({}));
    app.post('/v1/auth/api-tokens/revoke', async () => ({}));
    app.post('/v1/auth/api-tokens/revoke-all', async () => ({}));
    const deps = createAccountServerActionDeps({
      token: 'interactive',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });
    const context = { surface: 'cli' as const, serverId: 'home-a' };

    await expect(deps.accountApiTokensCreateAction!({
      input: { tokenId: '12345678-1234-4234-8234-123456789abc', label: 'malformed' },
      context,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.accountApiTokensUpdateAction!({
      input: { tokenId: '12345678-1234-4234-8234-123456789abc', label: 'malformed' },
      context,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.accountApiTokensRevokeAction!({
      input: { tokenId: '12345678-1234-4234-8234-123456789abc' },
      context,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.accountApiTokensRevokeAllAction!({
      input: {},
      context,
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.accountApiTokensListAction!({
      input: {},
      context,
    })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('retains outcome uncertainty when a dispatched API-token mutation loses its response through a nested socket reset', async () => {
    const originalAdapter = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async () => {
      requests += 1;
      throw Object.assign(new Error('API-token response was lost'), {
        cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      });
    };
    const deps = createAccountServerActionDeps({
      token: 'interactive',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });

    try {
      await expect(deps.accountApiTokensCreateAction!({
        input: { tokenId: '12345678-1234-4234-8234-123456789abc', label: 'lost response' },
        context: { surface: 'cli', serverId: 'home-a' },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'outcome_unknown',
        error: 'outcome_unknown',
      });

      axios.defaults.adapter = async () => {
        requests += 1;
        throw Object.assign(new Error('API-token request was refused'), {
          cause: Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' }),
        });
      };
      await expect(deps.accountApiTokensCreateAction!({
        input: { tokenId: '22345678-1234-4234-8234-123456789abc', label: 'refused request' },
        context: { surface: 'cli', serverId: 'home-a' },
      })).resolves.toEqual({
        ok: false,
        errorCode: 'server_unreachable',
        error: 'server_unreachable',
      });
      expect(requests).toBe(2);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  });

  it('surfaces ambiguous sign-out response loss without widening the signed-out result contract', async () => {
    const originalAdapter = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async () => {
      requests += 1;
      throw Object.assign(new Error('sign-out response was lost'), { code: 'ECONNRESET' });
    };
    const deps = createAccountServerActionDeps({
      token: 'interactive',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });

    try {
      await expect(deps.accountSessionsSignOutEverywhereAction!({
        input: {},
        context: { surface: 'cli', serverId: 'home-a' },
      })).rejects.toMatchObject({ code: 'outcome_unknown' });
      expect(requests).toBe(1);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  });

  it('carries all six Machine Pool intents through the bound Home with natural typed results', async () => {
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const pool = {
      pool: {
        id: poolId,
        name: 'Fast pool',
        description: 'Home-readable administration',
        revision: 4,
        createdAt: 1,
        updatedAt: 2,
        members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true, state: 'connected' }],
      },
      availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
    } as const;
    const observed: Array<{ path: string; body: unknown }> = [];
    for (const verb of ['list', 'get', 'create', 'update', 'delete', 'resolve'] as const) {
      app.post(`/v1/machines/pools/${verb}`, async (request) => {
        expect(request.headers.authorization).toBe('Bearer interactive');
        observed.push({ path: request.url, body: request.body });
        if (verb === 'list') return { pools: [pool] };
        if (verb === 'delete') return { poolId, deleted: true };
        if (verb === 'resolve') return { kind: 'resolved', poolId, machineId: 'machine-1', priorityTier: 0 };
        return pool;
      });
    }
    const inputs = {
      'machines.pools.list': {},
      'machines.pools.get': { poolId },
      'machines.pools.create': {
        poolId,
        name: 'Fast pool',
        description: 'Home-readable administration',
        members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true }],
      },
      'machines.pools.update': {
        poolId,
        expectedRevision: 4,
        name: 'Fast pool',
        description: 'Home-readable administration',
        members: [{ machineId: 'machine-1', priorityTier: 0, enabled: true }],
      },
      'machines.pools.delete': { poolId, expectedRevision: 4 },
      'machines.pools.resolve': { poolId, requestKey: 'deliberate-selection-1' },
    } as const;
    const deps = createAccountServerActionDeps({
      token: 'interactive',
      serverId: 'home-a',
      serverHttpBaseUrl: 'http://account.test',
    });

    for (const [actionId, actionInput] of Object.entries(inputs)) {
      await expect(deps.machinePoolAction!({
        actionId: actionId as keyof typeof inputs,
        input: actionInput,
        context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
      })).resolves.not.toMatchObject({ ok: false });
    }
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.create',
      input: inputs['machines.pools.create'],
      context: { surface: 'cli', authority: 'present_user', serverId: 'home-a' },
    })).resolves.not.toMatchObject({ ok: false });
    expect(observed.map(({ path }) => path)).toEqual([
      '/v1/machines/pools/list',
      '/v1/machines/pools/get',
      '/v1/machines/pools/create',
      '/v1/machines/pools/update',
      '/v1/machines/pools/delete',
      '/v1/machines/pools/resolve',
      '/v1/machines/pools/create',
    ]);
    expect(JSON.stringify(observed)).toContain('Home-readable administration');
    expect(observed[5]?.body).toEqual({ poolId, requestKey: 'deliberate-selection-1' });
    expect(observed[2]?.body).toEqual(observed[6]?.body);
  });

  it('preserves Pool CAS/current data, non-disclosing not-found, and old-Home unsupported errors', async () => {
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    app.post('/v1/machines/pools/update', async (request, reply) => {
      expect(request.headers.authorization).toBe('Bearer interactive');
      expect(request.body).toMatchObject({ poolId, expectedRevision: 1 });
      return reply.code(409).send({
        code: 'pool_changed',
        current: {
          pool: { id: poolId, name: 'Current', description: null, revision: 2, createdAt: 1, updatedAt: 2, members: [] },
          availability: { state: 'known', connectedCount: 0, enabledCount: 0 },
        },
      });
    });
    app.post('/v1/machines/pools/get', async (_request, reply) => reply.code(404).send({ code: 'pool_not_found' }));
    app.post('/v1/machines/pools/list', async (_request, reply) => reply.code(404).send({ error: 'route_not_found' }));
    const deps = createAccountServerActionDeps({ token: 'interactive', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.update',
      input: { poolId, expectedRevision: 1, name: 'Pool', members: [] },
      context: { surface: 'cli' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'pool_changed',
      error: 'pool_changed',
      details: expect.objectContaining({ code: 'pool_changed', current: expect.objectContaining({ pool: expect.objectContaining({ revision: 2 }) }) }),
    });
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.get', input: { poolId }, context: { surface: 'cli' },
    })).resolves.toEqual({
      ok: false, errorCode: 'pool_not_found', error: 'pool_not_found', details: { code: 'pool_not_found' },
    });
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.list', input: {}, context: { surface: 'cli' },
    })).resolves.toEqual({
      ok: false, errorCode: 'unsupported_action', error: 'unsupported_action:machines.pools.list',
    });
  });

  it('refuses a Machine Pool Action addressed to another Home before sending the bound credential', async () => {
    let requests = 0;
    app.post('/v1/machines/pools/list', async () => {
      requests += 1;
      return { pools: [] };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });

    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.list',
      input: {},
      context: { surface: 'cli', serverId: 'other-home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    expect(requests).toBe(0);
  });

  it('settles Machine Pool transport loss according to the canonical Action side-effect class', async () => {
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });
    const originalAdapter = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async () => {
      requests += 1;
      throw Object.assign(new Error('connection reset after Home commit'), { code: 'ECONNRESET' });
    };

    try {
      for (const action of [
        {
          actionId: 'machines.pools.create' as const,
          input: { poolId, name: 'Development', members: [] },
        },
        {
          actionId: 'machines.pools.delete' as const,
          input: { poolId, expectedRevision: 1 },
        },
      ]) {
        await expect(deps.machinePoolAction!({
          ...action,
          context: { surface: 'cli', serverId: 'home' },
        })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
      }

      await expect(deps.machinePoolAction!({
        actionId: 'machines.pools.list',
        input: {},
        context: { surface: 'cli', serverId: 'home' },
      })).resolves.toEqual({ ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' });

      expect(requests).toBe(3);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  });

  it('does not issue a Machine Pool request when cancellation is already observable', async () => {
    const controller = new AbortController();
    controller.abort();
    const originalAdapter = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async () => {
      requests += 1;
      throw new Error('pre-cancelled request must not reach the Axios adapter');
    };
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });

    try {
      await expect(deps.machinePoolAction!({
        actionId: 'machines.pools.delete',
        input: { poolId: '99d55938-f860-4af8-8023-01fecec86f35', expectedRevision: 1 },
        context: { surface: 'cli', serverId: 'home' },
        signal: controller.signal,
      })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
      expect(requests).toBe(0);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  });

  it('settles cancellation after a Machine Pool mutation was issued as an unknown outcome', async () => {
    const controller = new AbortController();
    const originalAdapter = axios.defaults.adapter;
    let requests = 0;
    axios.defaults.adapter = async () => {
      requests += 1;
      controller.abort();
      throw new axios.CanceledError('cancelled after dispatch');
    };
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });

    try {
      await expect(deps.machinePoolAction!({
        actionId: 'machines.pools.delete',
        input: { poolId: '99d55938-f860-4af8-8023-01fecec86f35', expectedRevision: 1 },
        context: { surface: 'cli', serverId: 'home' },
        signal: controller.signal,
      })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
      expect(requests).toBe(1);
    } finally {
      axios.defaults.adapter = originalAdapter;
    }
  });

  it('treats malformed mutation acknowledgements as ambiguous while malformed reads remain protocol failures', async () => {
    const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
    app.post('/v1/machines/pools/create', async () => ({ malformed: true }));
    app.post('/v1/machines/pools/delete', async () => ({ malformed: true }));
    app.post('/v1/machines/pools/list', async () => ({ malformed: true }));
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });

    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.create',
      input: { poolId, name: 'Development', members: [] },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.delete',
      input: { poolId, expectedRevision: 1 },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({ ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' });
    await expect(deps.machinePoolAction!({
      actionId: 'machines.pools.list',
      input: {},
      context: { surface: 'cli', serverId: 'home' },
    })).rejects.toThrow();
  });

  it('materializes folder and tag resource displays for the exact E2EE Home and opens listed labels', async () => {
    const machineKey = new Uint8Array(32).fill(37);
    const token = 'selected-home-token';
    const material = { type: 'dataKey' as const, machineKey };
    const credentials = { token, encryption: { type: 'dataKey' as const, machineKey,
      publicKey: tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey } };
    const display = { t: 'plain' as const, v: { name: 'Research' } };
    const tagDisplay = { t: 'plain' as const, v: { label: 'Research' } };
    const encrypted = { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({
      kind: 'session_organization_display', material, payload: display.v, randomBytes: tweetnacl.randomBytes,
    }) };
    const folder = { folderId: 'folder-1', folderKey: 'folder-key', parentFolderId: null,
      parentFolderKey: null, sortKey: null, display: encrypted, archivedAt: null, createdAt: 1, updatedAt: 1 };
    const tag = { tagId: 'tag-1', tagKey: 'tag-key', sortKey: null, display: {
      t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'session_organization_display',
        material, payload: tagDisplay.v, randomBytes: tweetnacl.randomBytes }),
    },
      archivedAt: null, createdAt: 1, updatedAt: 1 };
    const stored: unknown[] = [];
    app.get('/v1/account/encryption', async () => ({ mode: 'e2ee', updatedAt: 1 }));
    app.post('/v2/session-organization/folders', async (request, reply) => {
      const parsed = (await import('@happier-dev/protocol')).CreateOrUpdateSessionOrganizationFolderRequestSchema.parse(request.body);
      stored.push(parsed.display);
      if (parsed.display?.t !== 'encrypted') return reply.code(409).send({ error: 'session_organization_display_mode_mismatch' });
      return { folder: { ...folder, display: parsed.display } };
    });
    app.post('/v2/session-organization/tags', async (request, reply) => {
      const parsed = (await import('@happier-dev/protocol')).CreateOrUpdateSessionOrganizationTagRequestSchema.parse(request.body);
      stored.push(parsed.display);
      if (parsed.display?.t !== 'encrypted') return reply.code(409).send({ error: 'session_organization_display_mode_mismatch' });
      return { tag: { ...tag, display: parsed.display } };
    });
    app.get('/v2/session-organization', async () => ({ snapshot: {
      schemaVersion: 1, version: 1, pins: [], folders: [folder], tags: [tag],
      folderAssignments: [], tagAssignments: [], orderEntries: [], labels: [],
    } }));
    const executor = createActionExecutor(createAccountServerActionDeps({ token, credentials,
      serverId: 'home', serverHttpBaseUrl: 'http://account.test' }) as Parameters<typeof createActionExecutor>[0]);
    const context = { surface: 'mcp' as const, authority: 'account_automation' as const, serverId: 'home' };
    const created = await executor.execute('session.folders.create', { folderKey: folder.folderKey,
      parentFolderId: null, parentFolderKey: null, sortKey: null, display }, context);
    expect(created.ok ? undefined : created.errorCode).toBeUndefined();
    expect(created).toMatchObject({ ok: true });
    expect(await executor.execute('session.tags.rename', { tagId: tag.tagId, tagKey: tag.tagKey,
      sortKey: null, display: tagDisplay }, context)).toMatchObject({ ok: true });
    expect(stored.map(envelope => envelope && typeof envelope === 'object' && 'c' in envelope
      ? openAccountScopedBlobCiphertext({ kind: 'session_organization_display', material, ciphertext: String(envelope.c) })?.value
      : null)).toEqual([display.v, tagDisplay.v]);
    expect(await executor.execute('session.folders.list', {}, context)).toMatchObject({
      ok: true, result: { snapshot: { folders: [{ display }], tags: [{ display: tagDisplay }] } },
    });
    const withoutKey = createActionExecutor(createAccountServerActionDeps({ token,
      serverId: 'home', serverHttpBaseUrl: 'http://account.test' }) as Parameters<typeof createActionExecutor>[0]);
    expect(await withoutKey.execute('session.tags.create', { tagKey: 'new-key', sortKey: null, display }, context))
      .toMatchObject({ ok: false, errorCode: 'account_key_unavailable' });
    expect(stored).toHaveLength(2);
  });

  it('carries the complete managed provider lifecycle through exact Home routes with redacted typed output', async () => {
    const provider = managedIdentityProviderFixture();
    const lifecycleInput = {
      owner: { kind: 'home' as const },
      id: provider.id,
      expectedRevision: provider.revision,
      expectedSecurityRevision: provider.securityRevision,
    };
    const cases = [
      ['identity.providers.list', '/v1/identity/providers/list', { owner: { kind: 'home' } }, { items: [provider], unreadableCount: 0 }],
      ['identity.providers.create', '/v1/identity/providers/create', { owner: { kind: 'home' }, displayName: provider.displayName, config: provider.config, clientSecret: 'create-secret' }, provider],
      ['identity.providers.update', '/v1/identity/providers/update', { owner: { kind: 'home' }, id: provider.id, expectedRevision: provider.revision, displayName: 'Renamed' }, provider],
      ['identity.providers.secret.replace', '/v1/identity/providers/secret/replace', { owner: { kind: 'home' }, id: provider.id, expectedRevision: provider.revision, clientSecret: 'replacement-secret' }, provider],
      ['identity.providers.validate', '/v1/identity/providers/validate', lifecycleInput, provider],
      ['identity.providers.test.start', '/v1/identity/providers/test/start', lifecycleInput, { authorizeUrl: 'https://id.example.test/authorize', attemptId: 'attempt-1' }],
      ['identity.providers.test.consume', '/v1/identity/providers/test/consume', { owner: { kind: 'home' }, id: provider.id, resultHandle: 'result-1' }, { provider, testedAt: 3, subjectPresent: true }],
      ['identity.providers.enable', '/v1/identity/providers/enable', lifecycleInput, provider],
      ['identity.providers.disable', '/v1/identity/providers/disable', lifecycleInput, provider],
      ['identity.providers.remove.preview', '/v1/identity/providers/remove/preflight', { owner: { kind: 'home' }, id: provider.id, expectedRevision: provider.revision }, { provider, canRemove: true, blockers: { identityCount: 0, connectionCount: 0, affectedAccountIds: [] } }],
      ['identity.providers.remove', '/v1/identity/providers/remove', { owner: { kind: 'home' }, id: provider.id, expectedRevision: provider.revision }, { outcome: 'removed' }],
    ] as const;
    const observed: Array<{ path: string; authorization: string | undefined; body: unknown }> = [];
    for (const [, path, , output] of cases) {
      app.post(path, async (request) => {
        observed.push({ path: request.url, authorization: request.headers.authorization, body: request.body });
        return output;
      });
    }
    const deps = createAccountServerActionDeps({
      token: 'selected-home-token',
      serverId: 'selected-home-profile-id',
      serverIdentityId: 'selected-home-server-identity',
      serverHttpBaseUrl: 'http://account.test',
    });

    const results: unknown[] = [];
    for (const [actionId, , input] of cases) {
      results.push(await deps.homeDomainAction!({
        actionId,
        input,
        context: { surface: 'cli', authority: 'present_user', serverId: 'selected-home-profile-id' },
      }));
    }

    expect(observed.map(({ path }) => path)).toEqual(cases.map(([, path]) => path));
    expect(observed.every(({ authorization }) => authorization === 'Bearer selected-home-token')).toBe(true);
    expect(observed.map(({ body }) => body)).toEqual(cases.map(([, , input]) => input));
    expect(JSON.stringify(results)).not.toContain('create-secret');
    expect(JSON.stringify(results)).not.toContain('replacement-secret');
    expect(results.at(-1)).toEqual({ outcome: 'removed' });
  });

  it('preserves managed-provider domain failures without reflecting untrusted secret fields', async () => {
    const provider = managedIdentityProviderFixture();
    app.post('/v1/identity/providers/update', async (_request, reply) => reply.code(409).send({
      error: 'identity_provider_revision_conflict',
      current: provider,
    }));
    const deps = createAccountServerActionDeps({ token: 'selected-home-token', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });

    const result = await deps.homeDomainAction!({
      actionId: 'identity.providers.update',
      input: { owner: { kind: 'home' }, id: provider.id, expectedRevision: 1, displayName: 'Stale' },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'identity_provider_revision_conflict',
      error: 'identity_provider_revision_conflict',
      details: { error: 'identity_provider_revision_conflict', current: provider },
    });
    expect(JSON.stringify(result)).not.toContain('clientSecret');
  });

  it.each([405, 501])('fails an old Home provider route closed as unsupported at HTTP %s', async (status) => {
    app.post('/v1/identity/providers/list', async (_request, reply) => reply.code(status).send({ secret: 'do-not-reflect' }));
    const deps = createAccountServerActionDeps({ token: 'selected-home-token', serverId: 'home', serverHttpBaseUrl: 'http://account.test' });

    const result = await deps.homeDomainAction!({
      actionId: 'identity.providers.list',
      input: { owner: { kind: 'home' } },
      context: { surface: 'cli', authority: 'present_user', serverId: 'home' },
    });

    expect(result).toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:identity.providers.list',
    });
    expect(JSON.stringify(result)).not.toContain('do-not-reflect');
  });

  it('uses the Home execution authorization plus a fresh Machine signature instead of the daemon bearer', async () => {
    const installationIdentity = tweetnacl.sign.keyPair();
    const authorization = {
      v: 1 as const,
      token: 'home-minted-exact-invocation',
      binding: {
        serverIdentityId: 'home',
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        grant: API_TOKEN_FULL_GRANT_V1,
        machineId: 'machine-1',
        actionId: 'teams.archive',
        requestId: 'request-1',
        requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine' as const, machineId: 'machine-1' },
      },
    };
    let requests = 0;
    app.post('/v1/teams/archive', async (request) => {
      requests += 1;
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('teams.archive');
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]).toBe(
        encodeExternalActionResolvedTargetV1(authorization.binding.target),
      );
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      expect(typeof signature).toBe('string');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token,
        effectActionId: 'teams.archive',
        target: authorization.binding.target,
        installationId: 'installation-1',
        requestId: authorization.binding.requestId,
        method: 'POST',
        path: '/v1/teams/archive',
        body: { v: 1, teamId: 'team-1' },
        publicKey: installationIdentity.publicKey,
        signature: signature as string,
      })).toBe(true);
      return archivedTeamSummary;
    });
    const deps = createAccountServerActionDeps({
      token: 'daemon-bearer-must-not-cross',
      serverId: 'home',
      serverIdentityId: 'home',
      serverHttpBaseUrl: 'http://account.test',
      externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });

    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: {
        surface: 'api',
        authority: 'account_automation',
        externalActionTarget: authorization.binding.target,
        externalActionExecutionAuthorization: authorization,
      },
    })).resolves.toEqual(archivedTeamSummary);
    expect(requests).toBe(1);
  });

  it('binds preset mutations to their exact signed effect rather than sending the daemon bearer', async () => {
    const installationIdentity = tweetnacl.sign.keyPair();
    const body = { homeId: 'srv_preset', id: 'preset-a', expectedRevision: 1 };
    const authorization = {
      v: 1 as const,
      token: 'home-minted-preset-invocation',
      binding: {
        serverIdentityId: 'srv_preset', accountId: 'account-1', principalId: 'principal-1',
        credentialId: 'credential-1', grant: API_TOKEN_FULL_GRANT_V1, machineId: 'machine-1',
        actionId: 'machines.presets.archive', requestId: 'request-preset', requestEnvelopeDigest: 'A'.repeat(43),
        target: { kind: 'machine' as const, machineId: 'machine-1' },
      },
    };
    app.post('/v1/machines/presets/archive', async (request, reply) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers[EXTERNAL_ACTION_EFFECT_ACTION_HEADER]).toBe('machines.presets.archive');
      expect(request.headers[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(authorization.token);
      expect(request.headers[EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]).toBe(encodeExternalActionResolvedTargetV1(authorization.binding.target));
      const signature = request.headers[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER];
      expect(typeof signature).toBe('string');
      expect(verifyExternalActionMachineRequestV1({
        authorizationToken: authorization.token, effectActionId: 'machines.presets.archive',
        target: authorization.binding.target, installationId: 'installation-1', requestId: authorization.binding.requestId,
        method: 'POST', path: '/v1/machines/presets/archive', body,
        publicKey: installationIdentity.publicKey, signature: signature as string,
      })).toBe(true);
      return reply.code(403).send({ kind: 'refused', code: 'permission_denied' });
    });
    const deps = createAccountServerActionDeps({
      token: 'daemon-bearer-must-not-cross', serverId: 'route-preset', serverIdentityId: 'srv_preset',
      serverHttpBaseUrl: 'http://account.test', externalActionMachineRequestPrivateKey: installationIdentity.secretKey,
      externalActionMachineInstallationId: 'installation-1',
    });
    await expect(deps.machinePresetAction!({
      actionId: 'machines.presets.archive', input: body,
      context: { surface: 'api', authority: 'account_automation', externalActionTarget: authorization.binding.target,
        externalActionExecutionAuthorization: authorization },
    })).resolves.toEqual({ kind: 'refused', code: 'permission_denied' });
  });

  it('does not send an externally authorized request when the Machine signing key is unavailable', async () => {
    let requests = 0;
    app.post('/v1/teams/archive', async () => {
      requests += 1;
      return archivedTeamSummary;
    });
    const deps = createAccountServerActionDeps({
      token: 'daemon-bearer-must-not-cross',
      serverId: 'home',
      serverIdentityId: 'home',
      serverHttpBaseUrl: 'http://account.test',
    });

    await expect(deps.homeDomainAction!({
      actionId: 'teams.archive',
      input: { v: 1, teamId: 'team-1' },
      context: {
        surface: 'api',
        authority: 'account_automation',
        externalActionTarget: { kind: 'machine', machineId: 'machine-1' },
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'proof-alone-is-insufficient',
          binding: {
            serverIdentityId: 'home',
            accountId: 'account-1',
            principalId: 'principal-1',
            credentialId: 'credential-1',
            grant: API_TOKEN_FULL_GRANT_V1,
            machineId: 'machine-1',
            actionId: 'teams.archive',
            requestId: 'request-1',
            requestEnvelopeDigest: 'A'.repeat(43),
            target: { kind: 'machine', machineId: 'machine-1' },
          },
        },
      },
    })).resolves.toMatchObject({ ok: false });
    expect(requests).toBe(0);
  });
});

describe('Session access HTTP adapter', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://access.test' });
  });
  afterEach(async () => { restore(); await app.close(); });

  it('uses the exact Home feature snapshot for direct-grant Session hydration', async () => {
    const sessionQueries: unknown[] = [];
    app.get('/v2/sessions/session-plain', async (request, reply) => {
      sessionQueries.push(request.query);
      if ((request.query as { accessProjectionVersion?: string }).accessProjectionVersion !== '1') {
        return reply.code(404).send({ error: 'session_access_session_not_found' });
      }
      return {
        // A Home answering accessProjectionVersion=1 must return the complete
        // current projection: SessionCurrentProjectionRecordV1Schema requires the
        // responsibility pair alongside effectiveAccess so an omission cannot be
        // read as an authoritative unassigned value.
        session: createCurrentSessionProjectionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
          effectiveAccess: ownerSessionAccessGrants().effectiveAccess,
        }),
      };
    });
    app.post('/v2/sessions/access-grants/set', async () => ({
      changed: true,
      grant: {
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
    }));
    const serverFeaturesSnapshot = {
      status: 'ready' as const,
      features: FeaturesResponseSchema.parse({
        features: {
          sessions: { enabled: true },
          sharing: { session: { enabled: true } },
        },
        capabilities: {},
      }),
    };
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      resolveServerFeaturesSnapshot: async () => serverFeaturesSnapshot,
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: {
        sessionId: 'session-plain',
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(sessionQueries).toEqual([{ accessProjectionVersion: '1' }]);
  });

  it('keeps supported older Homes on the released bare detail projection during grant preparation', async () => {
    const sessionQueries: unknown[] = [];
    app.get('/v2/sessions/session-plain', async (request) => {
      sessionQueries.push(request.query);
      return {
        session: createSessionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
        }),
      };
    });
    app.post('/v2/sessions/access-grants/set', async () => ({
      changed: true,
      grant: {
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
    }));
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      resolveServerFeaturesSnapshot: async () => ({
        status: 'unsupported',
        reason: 'endpoint_missing',
      }),
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: {
        sessionId: 'session-plain',
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(sessionQueries).toEqual([{}]);
  });

  it('uses the captured Home credential and descriptor transport for responsibility', async () => {
    app.post('/v2/sessions/responsibility/set', async (request) => {
      expect(request.headers.authorization).toBe('Bearer bound-home-token');
      expect(request.body).toEqual({ sessionId: 'session', responsibleAccountId: null });
      return { changed: true, responsibleAccountId: null, responsibleAccount: null, autoFollowed: false };
    });
    const deps = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' });
    await expect(deps.sessionAccessAction!({ actionId: 'session.responsibility.set', input: { sessionId: 'session', responsibleAccountId: null }, context: { surface: 'cli', serverId: 'home' } }))
      .resolves.toMatchObject({ changed: true, responsibleAccountId: null });
  });

  it.each([
    [409, 'session_responsibility_assignee_unavailable'],
    [403, 'session_access_forbidden'],
    [404, 'session_access_session_not_found'],
    [400, 'invalid_cursor'],
  ] as const)('preserves the typed Session responsibility failure from HTTP status %s', async (status, errorCode) => {
    app.post('/v2/sessions/responsibility/set', async (_request, reply) => reply.code(status).send({ error: errorCode }));
    const deps = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.responsibility.set',
      input: { sessionId: 'session', responsibleAccountId: null },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({ ok: false, errorCode, error: errorCode });
  });

  it('materializes a key-free direct E2EE grant through the bound credential before the physical mutation', async () => {
    const callerMachineKey = new Uint8Array(32).fill(7);
    const callerPublicKey = deriveBoxPublicKeyFromSeed(callerMachineKey);
    const sessionDataKey = new Uint8Array(32).fill(9);
    const recipientContentKey = tweetnacl.box.keyPair();
    const recipientSigningKey = tweetnacl.sign.keyPair();
    const recipientContentKeySignature = signAccountContentKeyBindingV1({
      accountSigningSecretKey: recipientSigningKey.secretKey,
      contentPublicKey: recipientContentKey.publicKey,
    });
    const publishedCallerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: callerPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const physicalBodies: unknown[] = [];

    // An existing direct grant is not proof that its canonical recipient tuple
    // exists. The trusted host must still prepare current material; only the
    // physical transaction may decide that an existing tuple can be reused.
    app.post('/v2/sessions/access-grants/list', async () => ownerSessionAccessGrants([{
      grant: {
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
      principal: {
        kind: 'account', accountId: 'recipient-account', firstName: 'Recipient',
        lastName: null, username: 'recipient', avatarUrl: null,
      },
      allowedTransitions: {
        accessLevels: ['view', 'edit', 'admin'], canChangePermissionDelegation: true, canRemove: true,
      },
    }]));
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: publishedCallerEnvelope,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account',
        firstName: 'Recipient',
        lastName: null,
        avatar: null,
        username: 'recipient',
        bio: null,
        badges: [],
        status: 'none',
        recipientEnvelopeReadiness: { status: 'available' },
        publicKey: Buffer.from(recipientSigningKey.publicKey).toString('hex'),
        contentPublicKey: encodeBase64(recipientContentKey.publicKey),
        contentPublicKeySig: encodeBase64(recipientContentKeySignature),
      },
    }));
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
      };
    });

    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: {
        token: 'bound-home-token',
        encryption: { type: 'dataKey', publicKey: callerPublicKey, machineKey: callerMachineKey },
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    const publicInput = {
      sessionId: 'session-e2ee',
      subject: { kind: 'account' as const, accountId: 'recipient-account' },
      accessLevel: 'view' as const,
      canApprovePermissions: false,
    };

    const actionExecutor = createActionExecutor(deps as Parameters<typeof createActionExecutor>[0]);
    await expect(actionExecutor.execute(
      'session.access.grant.set',
      publicInput,
      { surface: 'cli', serverId: 'home', bypassApprovals: true },
    )).resolves.toMatchObject({ ok: true, result: { changed: true } });

    expect(publicInput).not.toHaveProperty('accountEnvelopeInput');
    expect(physicalBodies).toHaveLength(1);
    const physical = physicalBodies[0] as typeof publicInput & {
      accountEnvelopeInput: { v: 1; encryptedDataKey: string };
    };
    expect(SetSessionAccessGrantRequestV1Schema.safeParse(physical).success).toBe(true);
    expect(physical).toMatchObject(publicInput);
    expect(physical.accountEnvelopeInput.v).toBe(1);
    expect(openEncryptedDataKeyEnvelopeV1({
      envelope: Buffer.from(physical.accountEnvelopeInput.encryptedDataKey, 'base64'),
      recipientSecretKeyOrSeed: recipientContentKey.secretKey,
    })).toEqual(sessionDataKey);
  });

  it('lets the canonical route reuse a retained recipient envelope when this host cannot reopen the Session DEK', async () => {
    const recipientContentKey = tweetnacl.box.keyPair();
    const recipientSigningKey = tweetnacl.sign.keyPair();
    const recipientContentKeySignature = signAccountContentKeyBindingV1({
      accountSigningSecretKey: recipientSigningKey.secretKey,
      contentPublicKey: recipientContentKey.publicKey,
    });
    const publicInput = {
      sessionId: 'session-e2ee',
      subject: { kind: 'account' as const, accountId: 'recipient-account' },
      accessLevel: 'view' as const,
      canApprovePermissions: false,
    };
    const physicalBodies: unknown[] = [];
    const authorizationHeaders: string[] = [];
    let retainedTupleState: 'valid' | 'missing' | 'invalid' | 'other_error' = 'valid';
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: null,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account', firstName: 'Recipient', lastName: null, avatar: null,
        username: 'recipient', bio: null, badges: [], status: 'none',
        recipientEnvelopeReadiness: { status: 'available' },
        publicKey: Buffer.from(recipientSigningKey.publicKey).toString('hex'),
        contentPublicKey: encodeBase64(recipientContentKey.publicKey),
        contentPublicKeySig: encodeBase64(recipientContentKeySignature),
      },
    }));
    app.post('/v2/sessions/access-grants/set', async (request, reply) => {
      physicalBodies.push(request.body);
      authorizationHeaders.push(request.headers.authorization ?? '');
      if (retainedTupleState !== 'valid') {
        return reply.code(400).send({
          error: retainedTupleState === 'other_error'
            ? 'recipient_key_unavailable'
            : 'recipient_envelope_required',
        });
      }
      return {
        changed: true,
        grant: {
          subject: publicInput.subject,
          accessLevel: publicInput.accessLevel,
          canApprovePermissions: publicInput.canApprovePermissions,
        },
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'other-home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'server_target_mismatch',
      error: 'server_target_mismatch',
    });
    expect(physicalBodies).toEqual([]);
    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(physicalBodies).toEqual([publicInput]);
    retainedTupleState = 'missing';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_data_key_unavailable',
      error: 'session_data_key_unavailable',
    });
    retainedTupleState = 'invalid';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_data_key_unavailable',
      error: 'session_data_key_unavailable',
    });
    retainedTupleState = 'other_error';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'recipient_key_unavailable',
      error: 'recipient_key_unavailable',
    });
    expect(physicalBodies).toEqual([publicInput, publicInput, publicInput, publicInput]);
    expect(authorizationHeaders).toEqual([
      'Bearer bound-home-token',
      'Bearer bound-home-token',
      'Bearer bound-home-token',
      'Bearer bound-home-token',
    ]);
  });

  it('keeps a direct Plain grant key-free without requiring local encryption credentials', async () => {
    const physicalBodies: unknown[] = [];
    app.get('/v2/sessions/session-plain', async () => ({
      session: createSessionRecordFixture({
        id: 'session-plain',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
      };
    });

    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    const publicInput = {
      sessionId: 'session-plain',
      subject: { kind: 'account' as const, accountId: 'recipient-account' },
      accessLevel: 'view' as const,
      canApprovePermissions: false,
    };

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(physicalBodies).toEqual([publicInput]);
  });

  it('does not submit a sealed direct-recipient envelope after the credential is replaced', async () => {
    const managerKey = tweetnacl.box.keyPair();
    const recipientContentKey = tweetnacl.box.keyPair();
    const recipientSigningKey = tweetnacl.sign.keyPair();
    const sessionDataKey = new Uint8Array(32).fill(19);
    const ownerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: managerKey.publicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const credentials = {
      token: 'bound-home-token',
      encryption: {
        type: 'dataKey' as const,
        publicKey: managerKey.publicKey,
        machineKey: managerKey.secretKey,
      },
    };
    let currentnessReads = 0;
    let mutationCalls = 0;
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: ownerEnvelope,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account', firstName: 'Recipient', lastName: null, avatar: null,
        username: 'recipient', bio: null, badges: [], status: 'none',
        recipientEnvelopeReadiness: { status: 'available' },
        publicKey: Buffer.from(recipientSigningKey.publicKey).toString('hex'),
        contentPublicKey: encodeBase64(recipientContentKey.publicKey),
        contentPublicKeySig: encodeBase64(signAccountContentKeyBindingV1({
          accountSigningSecretKey: recipientSigningKey.secretKey,
          contentPublicKey: recipientContentKey.publicKey,
        })),
      },
    }));
    app.post('/v2/sessions/access-grants/set', async () => {
      mutationCalls += 1;
      return { changed: true };
    });
    const deps = createAccountServerActionDeps({
      token: credentials.token,
      credentials,
      isCredentialCurrent: async () => {
        currentnessReads += 1;
        return currentnessReads < 6;
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: {
        sessionId: 'session-e2ee',
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_access_stale_scope',
      error: 'session_access_stale_scope',
    });
    expect(currentnessReads).toBeGreaterThanOrEqual(3);
    expect(mutationCalls).toBe(0);
  });

  it('keeps Team grants on the key-free physical path without probing Session crypto', async () => {
    const physicalBodies: unknown[] = [];
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'team', teamId: 'team-1' },
          accessLevel: 'edit',
          canApprovePermissions: false,
          requiredByTeamPolicy: false,
        },
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    const publicInput = {
      sessionId: 'session-e2ee',
      subject: { kind: 'team' as const, teamId: 'team-1' },
      accessLevel: 'edit' as const,
      canApprovePermissions: false,
    };

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(physicalBodies).toEqual([publicInput]);
  });

  it('lets the server commit an E2EE grant pending recipient setup without fabricating an envelope', async () => {
    const physicalBodies: unknown[] = [];
    app.post('/v2/sessions/access-grants/list', async () => ownerSessionAccessGrants());
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'published-owner-envelope',
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account',
        firstName: 'Recipient',
        lastName: null,
        avatar: null,
        username: 'recipient',
        bio: null,
        badges: [],
        status: 'none',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
        publicKey: null,
        contentPublicKey: null,
        contentPublicKeySig: null,
      },
    }));
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    const publicInput = {
      sessionId: 'session-e2ee',
      subject: { kind: 'account' as const, accountId: 'recipient-account' },
      accessLevel: 'view' as const,
      canApprovePermissions: false,
    };

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(physicalBodies).toEqual([publicInput]);
  });

  it('leaves recipient repair key-free for the canonical physical grant admission', async () => {
    const physicalBodies: unknown[] = [];
    const callerMachineKey = new Uint8Array(32).fill(19);
    const callerPublicKey = deriveBoxPublicKeyFromSeed(callerMachineKey);
    const callerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: new Uint8Array(32).fill(23),
      recipientPublicKey: callerPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(7),
    }));
    let readiness: unknown = { status: 'unavailable', reason: 'encryption_inconsistent' };
    app.post('/v2/sessions/access-grants/list', async () => ownerSessionAccessGrants());
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: callerEnvelope,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account',
        firstName: 'Recipient',
        lastName: null,
        avatar: null,
        username: 'recipient',
        bio: null,
        badges: [],
        status: 'none',
        recipientEnvelopeReadiness: readiness,
        publicKey: '00'.repeat(32),
        contentPublicKey: null,
        contentPublicKeySig: null,
      },
    }));
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: {
        token: 'bound-home-token',
        encryption: { type: 'dataKey', publicKey: callerPublicKey, machineKey: callerMachineKey },
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: {
        sessionId: 'session-e2ee',
        subject: { kind: 'account', accountId: 'recipient-account' },
        accessLevel: 'view',
        canApprovePermissions: false,
      },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    // With a usable Session key, unavailable readiness must remain distinct from
    // malformed projections and advertised-ready Accounts missing their binding.
    for (const [nextReadiness, errorCode] of [
      [undefined, 'unsupported_action'],
      [{ status: 'available' }, 'recipient_key_unavailable'],
    ] as const) {
      readiness = nextReadiness;
      await expect(deps.sessionAccessAction!({
        actionId: 'session.access.grant.set',
        input: {
          sessionId: 'session-e2ee',
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
        context: { surface: 'cli', serverId: 'home' },
      })).resolves.toMatchObject({ ok: false, errorCode });
    }
    expect(physicalBodies).toEqual([{
      sessionId: 'session-e2ee',
      subject: { kind: 'account', accountId: 'recipient-account' },
      accessLevel: 'view',
      canApprovePermissions: false,
    }]);
  });

  it('keeps an E2EE Session grant key-free for a Plain recipient with retained binding columns', async () => {
    const physicalBodies: unknown[] = [];
    app.post('/v2/sessions/access-grants/list', async () => ownerSessionAccessGrants());
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'published-owner-envelope',
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.get('/v1/user/recipient-account', async () => ({
      user: {
        id: 'recipient-account',
        firstName: 'Recipient',
        lastName: null,
        avatar: null,
        username: 'recipient',
        bio: null,
        badges: [],
        status: 'none',
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        // Retained legacy binding columns are deliberately present. The Account
        // mode/readiness owner, not key presence, decides this path is Plain.
        publicKey: '00'.repeat(32),
        contentPublicKey: encodeBase64(new Uint8Array(32).fill(5)),
        contentPublicKeySig: encodeBase64(new Uint8Array(64).fill(6)),
      },
    }));
    app.post('/v2/sessions/access-grants/set', async (request) => {
      physicalBodies.push(request.body);
      return {
        changed: true,
        grant: {
          subject: { kind: 'account', accountId: 'recipient-account' },
          accessLevel: 'view',
          canApprovePermissions: false,
        },
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    const publicInput = {
      sessionId: 'session-e2ee',
      subject: { kind: 'account' as const, accountId: 'recipient-account' },
      accessLevel: 'view' as const,
      canApprovePermissions: false,
    };

    await expect(deps.sessionAccessAction!({
      actionId: 'session.access.grant.set',
      input: publicInput,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true });
    expect(physicalBodies).toEqual([publicInput]);
  });

  it('does not disclose an untrusted domain error body', async () => {
    app.post('/v2/sessions/responsibility/set', async (_request, reply) => reply.code(403).send({ error: 'Forbidden', token: 'PRIVATE_BEARER' }));
    const deps = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' });
    const result = await deps.sessionAccessAction!({ actionId: 'session.responsibility.set', input: { sessionId: 'session', responsibleAccountId: null }, context: { surface: 'cli', serverId: 'home' } }).catch((error: unknown) => error);
    expect(result).toMatchObject({ code: 'not_authenticated', response: { status: 403 } });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_BEARER');
  });

  it('refuses another Home before sending the bound credential', async () => {
    let requests = 0;
    app.post('/v2/sessions/responsibility/set', async () => { requests++; return {}; });
    const deps = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' });
    await expect(deps.sessionAccessAction!({ actionId: 'session.responsibility.set', input: { sessionId: 'session', responsibleAccountId: null }, context: { surface: 'cli', serverId: 'other-home' } }))
      .resolves.toEqual({ ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' });
    expect(requests).toBe(0);
  });

  it('routes Session-access Actions through the declared Home transport and pins the bound Home', async () => {
    const requests: unknown[] = [];
    app.post('/v2/sessions/responsibility/set', async (request) => {
      requests.push({
        body: request.body,
        authorization: request.headers.authorization,
      });
      return { changed: true, responsibleAccountId: null, responsibleAccount: null, autoFollowed: false };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.responsibility.set',
      input: { sessionId: 'session', responsibleAccountId: null },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ changed: true, responsibleAccountId: null });
    expect(requests).toEqual([{
      body: { sessionId: 'session', responsibleAccountId: null },
      authorization: 'Bearer bound-home-token',
    }]);

    await expect(deps.sessionAccessAction!({
      actionId: 'session.responsibility.set',
      input: { sessionId: 'session', responsibleAccountId: null },
      context: { surface: 'cli', serverId: 'other-home' },
    })).resolves.toEqual({ ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' });
    expect(requests).toHaveLength(1);
  });

  it.each([
    {
      actionId: 'session.access.grant.set' as const,
      method: 'post' as const,
      path: '/v2/sessions/access-grants/set',
      input: {
        sessionId: 'session',
        subject: { kind: 'team' as const, teamId: 'team' },
        accessLevel: 'edit' as const,
        canApprovePermissions: false,
      },
    },
    {
      actionId: 'session.access.grant.remove' as const,
      method: 'post' as const,
      path: '/v2/sessions/access-grants/remove',
      input: { sessionId: 'session', subject: { kind: 'team' as const, teamId: 'team' } },
    },
    {
      actionId: 'session.access.context.set' as const,
      method: 'post' as const,
      path: '/v2/sessions/access-context/set',
      input: { sessionId: 'session', primaryTeamId: 'team' },
    },
    {
      actionId: 'session.responsibility.set' as const,
      method: 'post' as const,
      path: '/v2/sessions/responsibility/set',
      input: { sessionId: 'session', responsibleAccountId: null },
    },
    {
      actionId: 'session.public_link.create' as const,
      method: 'post' as const,
      path: '/v1/public-shares',
      input: { sessionId: 'session' },
    },
    {
      actionId: 'session.public_link.remove' as const,
      method: 'delete' as const,
      path: '/v1/sessions/session/public-share',
      input: { sessionId: 'session' },
    },
  ])('returns outcome_unknown when $actionId receives a malformed successful acknowledgement', async ({
    actionId,
    method,
    path,
    input,
  }) => {
    app.get('/v2/sessions/session', async () => ({
      session: createSessionRecordFixture({
        id: 'session',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.route({ method: method.toUpperCase() as 'POST' | 'DELETE', url: path, handler: async () => ({}) });
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      onPublicLinkIssued: link => { issued.push(link); },
    });

    await expect(deps.sessionAccessAction!({
      actionId,
      input,
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      error: 'outcome_unknown',
    });
  });

  it.each([
    {
      actionId: 'session.access.grants.list' as const,
      method: 'post' as const,
      path: '/v2/sessions/access-grants/list',
      input: { sessionId: 'session' },
    },
    {
      actionId: 'session.public_link.get' as const,
      method: 'get' as const,
      path: '/v1/sessions/session/public-share',
      input: { sessionId: 'session' },
    },
  ])('keeps malformed successful $actionId reads as invalid responses', async ({ actionId, method, path, input }) => {
    app.route({ method: method.toUpperCase() as 'GET' | 'POST', url: path, handler: async () => ({}) });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId,
      input,
      context: { surface: 'cli', serverId: 'home' },
    })).rejects.toThrow();
  });

  it('returns a complete Plain fragment public link with or without a mounted consumer', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const physicalBodies: unknown[] = [];
    let sessionReads = 0;
    app.get('/v2/sessions/session-plain', async () => {
      sessionReads += 1;
      return {
        session: createSessionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
        }),
      };
    });
    app.post('/v1/public-shares', async (request) => {
      physicalBodies.push({ url: request.url, body: request.body });
      return {
        publicShare: {
          id: 'share-plain',
          token: 'PHYSICAL_TOKEN_MUST_NOT_LEAK',
          expiresAt: null,
          maxUses: null,
          useCount: 0,
          isConsentRequired: false,
          createdAt: 1,
          updatedAt: 1,
          keyDerivation: 'fragment_v1',
        },
        isolatedOrigin: 'https://public.example.test',
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      onPublicLinkIssued: link => { issued.push(link); },
    });
    const logicalInput = { sessionId: 'session-plain', isConsentRequired: false };
    const snapshot = JSON.parse(JSON.stringify(logicalInput));

    const result = await deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: logicalInput,
      context: { surface: 'cli', serverId: 'home' },
    });
    expect(result).toMatchObject({ id: 'share-plain', updatedAt: 1, expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: false });
    expect(logicalInput).toEqual(snapshot);
    expect(sessionReads).toBe(1);
    expect(physicalBodies).toHaveLength(1);
    const physical = (physicalBodies[0] as { body: Record<string, unknown> }).body;
    expect(physical.lookupId).toBe(issued[0]?.lookupId);
    expect(physical).toHaveProperty('keyDerivation', 'fragment_v1');
    expect(physical).not.toHaveProperty('token');
    expect(issued[0]?.url).toBe(`https://public.example.test/s/${issued[0]?.lookupId}#k=${issued[0]?.secret}`);
    expect(result).toMatchObject({ url: issued[0]?.url });
    expect(JSON.stringify(physical)).not.toContain(issued[0]?.secret);
    expect(physical).not.toHaveProperty('encryptedDataKey');
    expect(physical).toMatchObject({ isConsentRequired: false });
    expect(physical.subject).toEqual({ kind: 'session', id: 'session-plain' });
    const noCustody = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home', serverHttpBaseUrl: 'http://access.test' });
    await expect(noCustody.sessionAccessAction!({ actionId: 'session.public_link.create', input: logicalInput,
      context: { surface: 'cli', serverId: 'home' } })).resolves.toMatchObject({ url: expect.stringMatching(/^https:\/\/public.example.test\/s\/[^#]+#k=.+$/) });
    expect(physicalBodies).toHaveLength(2);
  });

  it('does not rotate an older Home publication through a Session route that strips new fields', async () => {
    let legacyPublication = 'retained-legacy-publication';
    let aliasMutations = 0;
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    app.get('/v2/sessions/session-plain', async () => ({ session: createSessionRecordFixture({
      id: 'session-plain', encryptionMode: 'plain', dataEncryptionKey: null, metadataVersion: 0, agentStateVersion: 0,
    }) }));
    // The predecessor owner route ignores unknown lookup/derivation fields and mutates its legacy publication.
    app.post('/v1/sessions/:sessionId/public-share', async () => {
      aliasMutations += 1;
      legacyPublication = 'silently-rotated';
      return { publicShare: { id: 'share-old', expiresAt: null, maxUses: null, useCount: 0,
        isConsentRequired: false, createdAt: 1, updatedAt: 2 } };
    });
    const host = createAccountServerActionDeps({ token: 'bound-home-token', serverId: 'home',
      serverHttpBaseUrl: 'http://access.test', onPublicLinkIssued: link => { issued.push(link); } });
    const result = await host.sessionAccessAction!({ actionId: 'session.public_link.create', input: { sessionId: 'session-plain' },
      context: { surface: 'cli', serverId: 'home' } });
    expect(aliasMutations).toBe(0);
    expect(legacyPublication).toBe('retained-legacy-publication');
    expect(result).toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(issued).toEqual([]);
  });
  it('replays one lost public-link create with the identical physical body', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const physicalBodies: string[] = [];
    let sessionReads = 0;
    app.get('/v2/sessions/session-plain', async () => {
      sessionReads += 1;
      return {
        session: createSessionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
        }),
      };
    });
    app.post('/v1/public-shares', async (request) => {
      physicalBodies.push(JSON.stringify(request.body));
      return {
        publicShare: {
          id: 'share-plain', expiresAt: null, maxUses: null, useCount: 0,
          isConsentRequired: false, createdAt: 1, updatedAt: 1, keyDerivation: 'fragment_v1',
        },
        isolatedOrigin: 'https://public.example.test',
      };
    });
    const installedAdapter = axios.getAdapter(axios.defaults.adapter);
    let publicationAttempts = 0;
    axios.defaults.adapter = async (config) => {
      if (config.method === 'post' && config.url?.endsWith('/v1/public-shares')) {
        publicationAttempts += 1;
        const response = await installedAdapter(config);
        if (publicationAttempts === 1) {
          throw Object.assign(new Error('response lost after Home commit'), { code: 'ECONNRESET' });
        }
        return response;
      }
      return await installedAdapter(config);
    };
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      onPublicLinkIssued: link => { issued.push(link); },
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-plain', isConsentRequired: false },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toMatchObject({ id: 'share-plain' });

    expect(sessionReads).toBe(1);
    expect(physicalBodies).toHaveLength(2);
    expect(physicalBodies[1]).toBe(physicalBodies[0]);
    expect(issued).toHaveLength(1);
  });

  it('creates an E2EE public link by wrapping the exact-Home current Session DEK without leaking secrets', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    const callerMachineKey = new Uint8Array(32).fill(11);
    const callerPublicKey = deriveBoxPublicKeyFromSeed(callerMachineKey);
    const sessionDataKey = new Uint8Array(32).fill(29);
    const publishedCallerEnvelope = encodeBase64(sealEncryptedDataKeyEnvelopeV1({
      dataKey: sessionDataKey,
      recipientPublicKey: callerPublicKey,
      randomBytes: (length) => new Uint8Array(length).fill(3),
    }));
    const physicalBodies: Array<{ body: Record<string, unknown> }> = [];
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: publishedCallerEnvelope,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.post('/v1/public-shares', async (request) => {
      physicalBodies.push({ body: request.body as Record<string, unknown> });
      return {
        publicShare: {
          id: 'share-e2ee',
          token: 'PHYSICAL_TOKEN_MUST_NOT_LEAK',
          expiresAt: null,
          maxUses: null,
          useCount: 0,
          isConsentRequired: true,
          createdAt: 1,
          updatedAt: 1,
          keyDerivation: 'fragment_v1',
        },
        isolatedOrigin: 'https://public.example.test',
      };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: {
        token: 'bound-home-token',
        encryption: { type: 'dataKey', publicKey: callerPublicKey, machineKey: callerMachineKey },
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      onPublicLinkIssued: link => { issued.push(link); },
    });
    const logicalInput = { sessionId: 'session-e2ee', isConsentRequired: true };
    const snapshot = JSON.parse(JSON.stringify(logicalInput));

    const result = await deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: logicalInput,
      context: { surface: 'cli', serverId: 'home' },
    });
    expect(result).toMatchObject({ id: 'share-e2ee', updatedAt: 1, expiresAt: null, maxUses: null, useCount: 0, isConsentRequired: true });
    expect(logicalInput).toEqual(snapshot);
    expect(physicalBodies).toHaveLength(1);
    const physical = physicalBodies[0]!.body;
    const secret = issued[0]!.secret;
    expect(physical.lookupId).toBe(issued[0]?.lookupId);
    expect(physical.subject).toEqual({ kind: 'session', id: 'session-e2ee' });
    expect(physical).not.toHaveProperty('token');
    expect(typeof physical.encryptedDataKey).toBe('string');
    expect(decodeBase64(physical.encryptedDataKey as string)).toHaveLength(
      PUBLIC_SHARE_ENCRYPTED_DATA_KEY_CURRENT_V0_BYTES,
    );
    expect(openPublicShareDataKeyV1({ encryptedDataKey: physical.encryptedDataKey as string, secret })).toEqual(sessionDataKey);
    expect(openPublicShareDataKeyV1({ encryptedDataKey: physical.encryptedDataKey as string, secret: physical.lookupId as string })).toBeNull();
    expect(result).not.toHaveProperty('token');
    expect(result).not.toHaveProperty('encryptedDataKey');
    expect(result).toMatchObject({ url: issued[0]!.url });
    expect(JSON.stringify(result)).not.toContain(physical.encryptedDataKey as string);
    expect(JSON.stringify(physical)).not.toContain(secret);
  });

  it('rejects a caller-authored public-link envelope before any effect', async () => {
    let sessionReads = 0;
    let mutations = 0;
    app.get('/v2/sessions/session-e2ee', async () => {
      sessionReads += 1;
      return { session: createSessionRecordFixture({ id: 'session-e2ee' }) };
    });
    app.post('/v1/public-shares', async () => {
      mutations += 1;
      return { publicShare: null };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-e2ee', token: 'caller-token', encryptedDataKey: 'caller-envelope' },
      context: { surface: 'cli', serverId: 'home' },
    })).rejects.toThrow();
    expect(sessionReads).toBe(0);
    expect(mutations).toBe(0);
  });

  it('fails closed on malformed current E2EE Session key material before publication', async () => {
    let mutations = 0;
    app.get('/v2/sessions/session-e2ee', async () => ({
      session: createSessionRecordFixture({
        id: 'session-e2ee',
        encryptionMode: 'e2ee',
        dataEncryptionKey: 'not-an-envelope',
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    app.post('/v1/public-shares', async () => {
      mutations += 1;
      return { publicShare: null };
    });
    const callerMachineKey = new Uint8Array(32).fill(11);
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: {
        token: 'bound-home-token',
        encryption: {
          type: 'dataKey',
          publicKey: deriveBoxPublicKeyFromSeed(callerMachineKey),
          machineKey: callerMachineKey,
        },
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-e2ee' },
      context: { surface: 'agent', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_data_key_unavailable',
      error: 'session_data_key_unavailable',
    });
    expect(mutations).toBe(0);
  });

  it('rechecks credential currentness after Session hydration and before publication', async () => {
    let currentnessChecks = 0;
    let sessionReads = 0;
    let mutations = 0;
    app.get('/v2/sessions/session-plain', async () => {
      sessionReads += 1;
      return {
        session: createSessionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
        }),
      };
    });
    app.post('/v1/public-shares', async () => {
      mutations += 1;
      return { publicShare: null };
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      isCredentialCurrent: async () => {
        currentnessChecks += 1;
        return currentnessChecks < 3;
      },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-plain' },
      context: { surface: 'mcp', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_access_stale_scope',
      error: 'session_access_stale_scope',
    });
    expect(sessionReads).toBe(1);
    expect(mutations).toBe(0);
  });

  it('sends nothing when public-link creation is cancelled or the scope goes stale', async () => {
    let sessionReads = 0;
    let mutations = 0;
    app.get('/v2/sessions/session-plain', async () => {
      sessionReads += 1;
      return {
        session: createSessionRecordFixture({
          id: 'session-plain',
          encryptionMode: 'plain',
          dataEncryptionKey: null,
          metadataVersion: 0,
          agentStateVersion: 0,
        }),
      };
    });
    app.post('/v1/public-shares', async () => {
      mutations += 1;
      return { publicShare: null };
    });
    const staleDeps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      isCredentialCurrent: async () => false,
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    await expect(staleDeps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-plain' },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'session_access_stale_scope',
      error: 'session_access_stale_scope',
    });
    const cancelled = new AbortController();
    cancelled.abort();
    const freshDeps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });
    await expect(freshDeps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-plain' },
      context: { surface: 'cli', serverId: 'home' },
      signal: cancelled.signal,
    })).resolves.toEqual({ ok: false, errorCode: 'cancelled', error: 'cancelled' });
    expect(sessionReads).toBe(0);
    expect(mutations).toBe(0);
  });

  it('translates a committed public-link delete without ambiguous post-commit decoding', async () => {
    let mode: 'ok' | 'absent' | 'route_missing' = 'ok';
    app.delete('/v1/sessions/:sessionId/public-share', async (_request, reply) => {
      if (mode === 'ok') return { success: true };
      if (mode === 'absent') return reply.code(404).send({ error: 'Share not found' });
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Route DELETE:/v1/sessions/session-1/public-share not found' });
    });
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    mode = 'ok';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.remove',
      input: { sessionId: 'session-1' },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({ changed: true });
    mode = 'absent';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.remove',
      input: { sessionId: 'session-1' },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({ changed: false });
    mode = 'route_missing';
    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.remove',
      input: { sessionId: 'session-1' },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_action',
      error: 'unsupported_action:session.public_link.remove',
    });
  });

  it('reports cancellation after public-link mutation dispatch as an unknown outcome', async () => {
    const issued: ArtifactPublicLinkIssuedV1[] = [];
    app.get('/v2/sessions/session-plain', async () => ({
      session: createSessionRecordFixture({
        id: 'session-plain',
        encryptionMode: 'plain',
        dataEncryptionKey: null,
        metadataVersion: 0,
        agentStateVersion: 0,
      }),
    }));
    const installedAdapter = axios.getAdapter(axios.defaults.adapter);
    axios.defaults.adapter = async (config) => {
      if (config.method === 'post' && config.url?.endsWith('/v1/public-shares')) {
        throw new axios.CanceledError('cancelled after dispatch', undefined, config);
      }
      return await installedAdapter(config);
    };
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      credentials: { token: 'bound-home-token', encryption: null },
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
      onPublicLinkIssued: link => { issued.push(link); },
    });

    await expect(deps.sessionAccessAction!({
      actionId: 'session.public_link.create',
      input: { sessionId: 'session-plain' },
      context: { surface: 'cli', serverId: 'home' },
    })).resolves.toEqual({
      ok: false,
      errorCode: 'outcome_unknown',
      error: 'outcome_unknown',
    });
  });

  it.each([
    {
      actionId: 'session.access.grant.set' as const,
      input: {
        sessionId: 'session-1',
        subject: { kind: 'team' as const, teamId: 'team-1' },
        accessLevel: 'edit' as const,
        canApprovePermissions: false,
      },
    },
    {
      actionId: 'session.access.grant.remove' as const,
      input: {
        sessionId: 'session-1',
        subject: { kind: 'team' as const, teamId: 'team-1' },
      },
    },
  ])('does not dispatch an already-cancelled $actionId mutation', async ({ actionId, input }) => {
    let mutations = 0;
    app.post('/v2/sessions/access-grants/set', async () => {
      mutations += 1;
      return { changed: true };
    });
    app.post('/v2/sessions/access-grants/remove', async () => {
      mutations += 1;
      return { changed: true };
    });
    const cancelled = new AbortController();
    cancelled.abort();
    const deps = createAccountServerActionDeps({
      token: 'bound-home-token',
      serverId: 'home',
      serverHttpBaseUrl: 'http://access.test',
    });

    await expect(deps.sessionAccessAction!({
      actionId,
      input,
      context: { surface: 'mcp', serverId: 'home' },
      signal: cancelled.signal,
    })).resolves.toEqual({
      ok: false,
      errorCode: 'cancelled',
      error: 'cancelled',
    });
    expect(mutations).toBe(0);
  });
});
