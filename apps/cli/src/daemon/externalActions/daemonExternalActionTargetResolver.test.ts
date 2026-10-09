import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { buildApprovalExecutionOriginV1, createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { SessionActionRpcOriginV1Schema } from '@happier-dev/protocol/socketRpc';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import nacl from 'tweetnacl';
import type { PromptLibraryStoredArtifact } from '@happier-dev/protocol/prompts/library/promptLibraryActionOperations';
import type { ApprovalRequest } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resolveAvailableAccountSettings } from '@/settings/accountSettings/resolveAvailableAccountSettings';

const mocks = vi.hoisted(() => ({
  fetchSessionById: vi.fn(),
  fetchAccountMachineReplacements: vi.fn(),
}));

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: mocks.fetchSessionById,
}));

vi.mock('@/api/machine/fetchAccountMachineReplacements', () => ({
  fetchAccountMachineReplacements: mocks.fetchAccountMachineReplacements,
}));

import { createDaemonExternalActionTargetResolver, createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { encryptSessionPayload } from '@/session/transport/encryption/sessionEncryptionContext';

const ENCRYPTION_KEY = new Uint8Array(32).fill(7);
const TOKEN_ONLY_CREDENTIALS = {
  token: 'daemon-token',
  encryption: null,
};
const ENCRYPTED_CREDENTIALS = {
  token: 'daemon-token',
  encryption: { type: 'legacy' as const, secret: ENCRYPTION_KEY },
};

function session(machineId: string) {
  return {
    id: 'c111111111111111111111111',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    encryptionMode: 'plain',
    metadata: '{}',
    share: null,
    metadataVersion: 1,
    dataEncryptionKey: null,
    machineId,
  };
}

function encryptedSessionMetadata(params: Readonly<{
  machineId: string;
  host?: string;
  homeDir?: string;
  rawMachineId?: string;
}>) {
  return {
    ...session(params.rawMachineId ?? 'legacy-row-machine-id'),
    encryptionMode: 'e2ee',
    metadata: encryptSessionPayload({
      ctx: { encryptionKey: ENCRYPTION_KEY, encryptionVariant: 'legacy' },
      payload: {
        machineId: params.machineId,
        ...(params.host ? { host: params.host } : {}),
        ...(params.homeDir ? { homeDir: params.homeDir } : {}),
      },
    }),
  };
}

describe('createDaemonExternalActionTargetResolver', () => {
  let accountMode: 'plain' | 'e2ee' = 'plain';
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    accountMode = 'plain';
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {
      get mode() { return accountMode; }, version: 1,
      get signingKeyFingerprint() { return accountMode === 'plain' ? null : 'a'.repeat(64); },
      get contentKeyFingerprint() { return accountMode === 'plain' ? null : 'b'.repeat(64); }, updatedAt: 1,
    } });
    mocks.fetchSessionById.mockReset();
    mocks.fetchAccountMachineReplacements.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('rechecks an Agent-produced private fill approval without requiring public signed-root admission', async () => {
    const currentSession = { ...session('machine-local'), metadata: JSON.stringify({ machineId: 'machine-local' }) };
    mocks.fetchSessionById.mockResolvedValue(currentSession);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(TOKEN_ONLY_CREDENTIALS) });
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'owner', machineId: 'machine-local', serverId: 'home', resolveTarget,
      // Authenticated Home identity and Account token-list reads are remote boundaries.
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'identity', machineId: 'machine-local' }),
      listAccountApiTokens: async () => ({ tokens: [] }),
      resolveCurrentSessionAgentSpawnPolicyV1: async () => (
        await resolveAvailableAccountSettings({ credentials: TOKEN_ONLY_CREDENTIALS })
      )?.sessionAgentSpawnPolicyV1 ?? null,
    });
    let approval: ApprovalRequest | null = null;
    const readApproval = (): ApprovalRequest | null => approval;
    await createActionExecutor({
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'approval' }; },
      isActionApprovalRequired: () => false,
    }).execute('computer.secret.fill', {
      serverId: 'home', sessionId: currentSession.id, machineId: 'machine-local', purpose: 'Sign in',
      sourceId: 'source', target: { kind: 'window', displayId: 'display', pid: 1, windowId: 2 },
      captureId: 'capture', geometry: { captureWidth: 100, captureHeight: 100, nativeWidth: 100, nativeHeight: 100,
        originX: 0, originY: 0, scaleX: 1, scaleY: 1, crop: { x: 0, y: 0, width: 100, height: 100 } },
      field: { fieldId: 'password', focusId: 'focus' },
    }, { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      actionRequestId: 'private-fill', runtimeAccountId: 'owner', serverId: 'home', serverIdentityId: 'identity',
      defaultSessionId: currentSession.id, defaultSessionMachineId: 'machine-local' });
    const captured = readApproval();
    if (!captured || captured.v !== 2) throw new Error('Expected a produced private approval');
    expect(captured.executionOriginV1).toMatchObject({ actionId: 'computer.secret.fill', surface: 'agent' });
    expect(await resolveTarget({ actionId: 'computer.secret.fill', target: captured.executionOriginV1.target,
      currentMachineId: 'machine-local' })).not.toBeNull();
    expect(await isCurrent({ origin: captured.executionOriginV1, request: captured }),
      JSON.stringify(captured.executionOriginV1)).toBe(true);
    mocks.fetchSessionById.mockResolvedValue({ ...currentSession, metadata: JSON.stringify({ machineId: 'machine-elsewhere' }) });
    expect(await isCurrent({ origin: captured.executionOriginV1, request: captured })).toBe(false);
  });

  it.each(['automatic', 'explicit', 'unchanged'] as const)('keeps the reviewed shared Session memory target and revision through %s approval replay', async mode => {
    const sessionMetadata = { work: { memoryEnabled: true, promptStack: [] } };
    const currentSession = { ...session('machine-local'), metadataVersion: 3, metadata: JSON.stringify(sessionMetadata) };
    mocks.fetchSessionById.mockResolvedValue(currentSession);
    setActiveAccountSettingsSnapshot({
      source: 'network', settings: accountSettingsParse({}), settingsVersion: 1, loadedAtMs: 1,
      settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(TOKEN_ONLY_CREDENTIALS),
    });
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'owner', machineId: 'machine-local', serverId: 'home', resolveTarget,
      // Raw Home/Machine identity and authenticated token-list transport leaves, never the currentness predicate.
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'identity', machineId: 'machine-local' }),
      listAccountApiTokens: async () => ({ tokens: [] }),
      // Use the credential-bound current Account settings owner, as the production composition does.
      resolveCurrentSessionAgentSpawnPolicyV1: async () => (
        await resolveAvailableAccountSettings({ credentials: TOKEN_ONLY_CREDENTIALS })
      )?.sessionAgentSpawnPolicyV1 ?? null,
    });
    const artifacts = new Map<string, PromptLibraryStoredArtifact>(['project-a', 'project-b'].map(id => [id, {
      id, revision: { headerVersion: 1, bodyVersion: 1 }, header: { v: 1, kind: 'memory_doc.v1', title: id },
      body: JSON.stringify({ v: 1, index: [{ id: `fact-${id}`, text: `Original ${id}`, createdAtMs: 1, sourceSessionRef: null }], topics: [] }),
    }]));
    let projectId = 'project-a';
    let approval: ApprovalRequest | null = null;
    const readApproval = (): ApprovalRequest | null => approval;
    let writes = 0;
    const executor = createActionExecutor({
      // Unused RPC/network ports required by the shared executor; all policy and approval logic stays real.
      executionRunStart: async () => ({}), executionRunList: async () => ({}), executionRunGet: async () => ({}),
      detachedExecutionRunSend: async () => ({}), executionRunStop: async () => ({}), executionRunAction: async () => ({}), executionRunWait: async () => ({}),
      sessionOpen: async () => ({}), sessionFork: async () => ({}), sessionRollback: async () => ({}), sessionSpawnNew: async () => ({}),
      pathsListRecent: async () => ({ items: [] }), machinesList: async () => ({ items: [] }), serversList: async () => ({ items: [] }),
      reviewEnginesList: async () => ({ items: [] }), agentsBackendsList: async () => ({ items: [] }), agentsModelsList: async () => ({ items: [] }),
      sessionSendMessage: async () => ({}), sessionPermissionRespond: async () => ({}), sessionUserActionAnswer: async () => ({}),
      sessionModeSet: async () => ({}), sessionModesList: async () => ({}), sessionTargetPrimarySet: async () => ({}),
      sessionList: async () => ({}), sessionActivityGet: async () => ({}), sessionRecentMessagesGet: async () => ({}),
      daemonMemorySearch: async () => ({ v: 1, ok: true as const, hits: [] }), daemonMemoryGetWindow: async () => ({ v: 1, snippets: [], citations: [] }),
      daemonMemoryEnsureUpToDate: async () => ({}), resetGlobalVoiceAgent: async () => {},
      isApprovalExecutionOriginCurrent: isCurrent,
      memoryLibrary: { serverId: 'home', randomId: () => 'remembered', nowMs: () => 10,
        store: { read: async id => artifacts.get(id) ?? null, update: async input => {
          const prior = artifacts.get(input.artifactId);
          if (!prior) throw new Error('Missing Artifact');
          if (prior.revision.headerVersion !== input.expectedRevision.headerVersion || prior.revision.bodyVersion !== input.expectedRevision.bodyVersion) {
            throw Object.assign(new Error('conflict'), { code: 'version_mismatch' });
          }
          writes += 1;
          artifacts.set(input.artifactId, { ...prior, body: input.body,
            revision: { headerVersion: prior.revision.headerVersion + 1, bodyVersion: prior.revision.bodyVersion + 1 } });
        } },
        readSession: async () => ({ metadata: sessionMetadata, revision: currentSession.metadataVersion }),
        readArtifactHeaders: async refs => refs.map(ref => artifacts.get(ref.artifactId)?.header ?? null),
        readInheritedContext: async () => ({ projectEntries: [{ id: 'project.memory', enabled: true, placement: 'system_append',
          ref: { kind: 'doc', artifactId: projectId, serverId: 'home' } }],
          readAccountContext: async () => ({ accountEntries: [], attachAccountMemory: async () => false }),
        }),
        readExposure: async artifactId => ({ grants: { artifactId, ownerAccountId: 'owner', access: 'owner', grants: [
          { principal: { kind: 'account', accountId: 'other' }, accessLevel: 'edit', createdByAccountId: 'owner', createdAt: 1, display: { name: null } },
        ] }, publicShares: { publicShares: [] } }),
      },
      // Artifact persistence is external; schema, transition, custody and replay remain canonical.
      approvalsCreate: async ({ request }) => { approval = request; return { artifactId: 'approval' }; },
      approvalsGet: async () => readApproval(),
      approvalsUpdate: async ({ request }) => {
        if (!approval) throw new Error('Missing approval');
        const transition = decideApprovalRequestTransition(approval, request);
        if (!transition.ok) return transition;
        approval = request;
        return { ok: true };
      },
    });
    const context = { surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' },
      actionRequestId: 'reviewed-memory', defaultSessionId: currentSession.id, serverId: 'home' } as const;
    const input = { sessionRef: { serverId: 'home', sessionId: currentSession.id }, expectedMetadataRevision: 3, text: 'Reviewed preference' };
    const requested = mode === 'explicit'
      ? await executor.execute('approval.request.create', { actionId: 'memory.remember', actionArgs: input,
        summary: 'Remember', createdBy: { surface: 'agent' } }, context)
      : await executor.execute('memory.remember', input, context);
    expect(requested).toMatchObject({ ok: true });
    expect(approval).toMatchObject({ status: 'open', actionId: 'memory.remember' });
    if (mode === 'automatic') {
      const current = artifacts.get('project-a')!;
      artifacts.set('project-a', { ...current, revision: { headerVersion: 2, bodyVersion: 2 },
        body: JSON.stringify({ v: 1, index: [{ id: 'newer', text: 'Concurrent truth', createdAtMs: 2, sourceSessionRef: null }], topics: [] }) });
    } else if (mode === 'explicit') projectId = 'project-b';
    const before = new Map(artifacts);
    const captured = readApproval();
    if (!captured || captured.v !== 2) throw new Error('Expected a durable approval with execution origin');
    expect(await isCurrent({ origin: captured.executionOriginV1, request: captured }),
      JSON.stringify(captured.executionOriginV1)).toBe(true);
    expect(await executor.execute('approval.request.decide', { artifactId: 'approval', decision: 'approve' }, {
      surface: 'ui', authority: 'present_user', serverId: 'home', actionCaller: { kind: 'host' },
    })).toMatchObject({ ok: true });
    if (mode === 'unchanged') {
      const settled = readApproval();
      expect({ status: settled?.status, execution: settled?.execution }).toEqual({
        status: 'executed', execution: expect.objectContaining({ ok: true }),
      });
      expect(writes).toBe(1);
      expect(JSON.parse(artifacts.get('project-a')!.body!).index).toMatchObject([
        { id: 'fact-project-a' }, { id: 'remembered', text: 'Reviewed preference' },
      ]);
      expect(artifacts.get('project-b')).toEqual(before.get('project-b'));
    } else {
      expect(approval).toMatchObject({ status: 'failed', execution: { ok: false,
        errorCode: expect.stringMatching(/^(version_mismatch|approval_stale)$/) } });
      expect(writes).toBe(0);
      expect(artifacts).toEqual(before);
    }
  });

  it('requires daemon locality for a Companion client read while retaining remote Account reads', async () => {
    const target = { kind: 'session' as const, sessionId: session('machine-elsewhere').id };
    mocks.fetchSessionById.mockResolvedValue(session('machine-elsewhere'));
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const surface = { serverId: 'home', accountId: 'account-1', owner: { kind: 'companion' as const, sessionId: target.sessionId } };
    await expect(resolver({ actionId: 'widgets.item.inputs.get', target, currentMachineId: 'machine-local',
      actionInput: { ref: { surface, instanceId: 'checks' } } })).resolves.toBeNull();
    await expect(resolver({ actionId: 'widgets.item.inputs.get', target, currentMachineId: 'machine-local',
      actionInput: { ref: { surface: { ...surface, owner: { kind: 'home' } }, instanceId: 'checks' } } })).resolves.toEqual(target);
  });

  it('keeps a local Session caller approval current for an Account effect on a led remote Session', async () => {
    mocks.fetchSessionById.mockResolvedValue({ ...session('machine-elsewhere'), id: 'led-remote' });
    mocks.fetchAccountMachineReplacements.mockResolvedValue([]);
    const resolveTarget = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account-1', machineId: 'machine-local', serverId: 'home-1', resolveTarget,
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'home-1', machineId: 'machine-local' }),
      listAccountApiTokens: async () => ({ tokens: [] }),
      isSessionCallerCurrent: async ({ caller }) => caller.sessionId === 'local-caller',
      resolveCurrentPermissionMode: async () => 'default',
    });
    const executionOrigin = { v: 1 as const, authority: 'account_automation' as const, surface: 'agent' as const,
      caller: { kind: 'session' as const, sessionId: 'local-caller', starterDepth: 0, turnDepth: 0 }, serverId: 'home-1', accountId: 'account-1',
      machineId: 'machine-local', sessionId: 'led-remote', target: { kind: 'session' as const, sessionId: 'led-remote' },
      callerPermissionMode: 'default' as const, actionId: 'session.trigger.add' as const, requestId: 'approved-request' };
    await expect(isCurrent({ origin: executionOrigin })).resolves.toBe(true);
    expect(mocks.fetchSessionById).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'led-remote' }));
    // Explicit Machine restrictions still constrain the execution host.
    await expect(isCurrent({ origin: { ...executionOrigin, target: { kind: 'machine', machineId: 'machine-elsewhere' } } }))
      .resolves.toBe(false);
    mocks.fetchSessionById.mockResolvedValue(null);
    await expect(isCurrent({ origin: executionOrigin })).resolves.toBe(false);
  });

  it('rechecks a managed guest Session approval through Home source custody without inventing a guest-local source runner', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(19));
    const caller = { kind: 'session' as const, sessionId: 'source-session', starterDepth: 1, turnDepth: 2 };
    const causalPermissionAuthority = { kind: 'admittedSessionInputV1' as const, admittedPermissionCeiling: 'yolo' as const };
    const sessionActionOrigin = SessionActionRpcOriginV1Schema.parse({ v: 1, caller, sourceTurnId: 'accepted-turn',
      callerPermissionMode: 'yolo', causalPermissionAuthority, requestId: 'managed-creation' });
    const target = { kind: 'machine' as const, machineId: 'guest' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-child-proof', binding: {
      serverIdentityId: 'srv_home', accountId: 'account-1', custodianAccountId: 'account-1',
      machineId: 'guest', installationId: 'guest-installation', actionId: 'session.spawn_new',
      authentication: { kind: 'account', tokenEpoch: 0 }, accountEncryptionMode: 'plain',
      requestId: sessionActionOrigin.requestId, requestEnvelopeDigest: 'c'.repeat(43), target,
      sessionActionOrigin, sessionActionSource: { machineId: 'controller', installationId: 'controller-installation' },
      managedContinuation: { managedId: 'managed', creationRequestId: sessionActionOrigin.requestId,
        expectedIntentRevision: 0, controller: { machineId: 'controller', installationId: 'controller-installation' },
        acquireRequestEnvelopeDigest: 'a'.repeat(43) },
    } });
    const spawnInput = SessionSpawnNewInputV2Schema.parse({ executionTarget: { serverId: 'srv_home', machineId: 'guest' },
      directory: { kind: 'managed' }, agentTarget: { kind: 'agent', identity: { pluginId: 'acme.agent', localId: 'coding' } } });
    const spawnPolicy = accountSettingsParse({}).sessionAgentSpawnPolicyV1;
    const origin = buildApprovalExecutionOriginV1({ actionId: 'session.spawn_new', input: spawnInput, targetSessionId: null, context: {
      surface: 'agent', authority: 'account_automation', actionCaller: caller, serverId: 'home-profile',
      serverIdentityId: 'srv_home', runtimeAccountId: 'account-1', actionRequestId: sessionActionOrigin.requestId,
      externalActionTarget: target, externalActionExecutionAuthorization: authorization,
      callerPermissionMode: 'yolo', causalPermissionAuthority, sessionAgentSpawnPolicyV1: spawnPolicy,
      sessionInputSource: { sourceSessionId: caller.sessionId, sourceTurnId: sessionActionOrigin.sourceTurnId, via: 'action' },
      signExternalActionApprovalInput: ({ actionId, input, target: signedTarget }) => signExternalActionApprovalInputV1({
        authorizationToken: authorization.token, actionId, input, target: signedTarget, privateKey: keys.secretKey }),
    } });
    expect(origin).not.toBeNull();
    if (!origin) throw new Error('Canonical signed Session approval origin was unavailable');
    let homeCurrent = true;
    let permission = 'yolo';
    let currentPolicy = spawnPolicy;
    // Only Home HTTP and the current identity/permission/settings reads are
    // substituted. Signature verification, source selection and policy stay real.
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(url).toBe('https://home.example/v1/actions/session.spawn_new/execution-authorization/verify');
      return { status: homeCurrent ? 200 : 403, data: homeCurrent ? { ok: true } : {} };
    });
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account-1', machineId: 'guest', serverId: 'home-profile',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home', machineId: 'guest' }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS }),
      listAccountApiTokens: async () => ({ tokens: [] }), externalActionMachinePublicKey: keys.publicKey,
      verifyExternalExecutionAuthorization: args => verifyExternalActionExecutionAuthorizationCurrent({ ...args,
        privateKey: keys.secretKey, installationId: 'guest-installation', serverHttpBaseUrl: 'https://home.example' }),
      // The controller's source Session has no runner on this guest.
      isSessionCallerCurrent: async () => false,
      resolveCurrentPermissionMode: async () => permission,
      resolveCurrentSessionAgentSpawnPolicyV1: async () => currentPolicy,
    });
    const check = () => isCurrent({ origin, actionInput: spawnInput });
    await expect(check()).resolves.toBe(true);
    homeCurrent = false;
    await expect(check()).resolves.toBe(false);
    homeCurrent = true;
    permission = 'default';
    await expect(check()).resolves.toBe(false);
    permission = 'yolo';
    currentPolicy = { ...spawnPolicy, allowCrossMachine: false };
    await expect(check()).resolves.toBe(false);
    currentPolicy = spawnPolicy;
    // A signed Session invocation without the managed-child tuple still needs
    // its incumbent local source owner; Home signature alone is not a waiver.
    await expect(isCurrent({ origin: { ...origin, externalActionExecutionAuthorization: {
      ...authorization, binding: { ...authorization.binding, managedContinuation: undefined },
    } }, actionInput: spawnInput })).resolves.toBe(false);
  });

  it('defaults an omitted target to this daemon machine without an Account lookup', async () => {
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.spawn_new',
      target: undefined,
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'machine', machineId: 'machine-local' });

    expect(mocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('refuses an explicitly different machine without looking up a Session', async () => {
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.spawn_new',
      target: { kind: 'machine', machineId: 'machine-elsewhere' },
      currentMachineId: 'machine-local',
    })).resolves.toBeNull();

    expect(mocks.fetchSessionById).not.toHaveBeenCalled();
  });

  it('re-resolves an explicit Session against the canonical session owner immediately before execution', async () => {
    const signal = new AbortController().signal;
    mocks.fetchSessionById.mockResolvedValue(session('machine-local'));
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
      signal,
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'c111111111111111111111111',
      signal: expect.any(AbortSignal),
      deadlineAtMs: expect.any(Number),
    });
    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('uses the daemon exact-Home snapshot for collective Session target resolution', async () => {
    const serverFeaturesSnapshot = {
      status: 'unsupported' as const,
      reason: 'endpoint_missing' as const,
    };
    const resolveServerFeaturesSnapshot = vi.fn(async () => serverFeaturesSnapshot);
    mocks.fetchSessionById.mockResolvedValue(session('machine-local'));
    const resolver = createDaemonExternalActionTargetResolver({
      credentials: TOKEN_ONLY_CREDENTIALS,
      serverApiUrl: 'https://home.example.test',
      resolveServerFeaturesSnapshot,
    });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(resolveServerFeaturesSnapshot).toHaveBeenCalledOnce();
    expect(mocks.fetchSessionById).toHaveBeenCalledWith({
      token: 'daemon-token',
      sessionId: 'c111111111111111111111111',
      serverFeaturesSnapshot,
      signal: expect.any(AbortSignal),
      deadlineAtMs: expect.any(Number),
    });
  });

  it('uses the encrypted Session metadata machine identity instead of a stale raw row projection', async () => {
    accountMode = 'e2ee';
    mocks.fetchSessionById.mockResolvedValue(encryptedSessionMetadata({
      machineId: 'machine-local',
      host: 'host-local',
      homeDir: '/home/local',
      rawMachineId: 'machine-elsewhere',
    }));
    const resolver = createDaemonExternalActionTargetResolver({
      credentials: ENCRYPTED_CREDENTIALS,
      currentMachineHost: 'host-local',
      currentMachineHomeDir: '/home/local',
    });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toEqual({ kind: 'session', sessionId: 'c111111111111111111111111' });

    expect(mocks.fetchAccountMachineReplacements).not.toHaveBeenCalled();
  });

  it('refuses a Session owned by another machine when no replacement proof exists', async () => {
    mocks.fetchSessionById.mockResolvedValue(session('machine-elsewhere'));
    mocks.fetchAccountMachineReplacements.mockResolvedValue([]);
    const resolver = createDaemonExternalActionTargetResolver({ credentials: TOKEN_ONLY_CREDENTIALS });

    await expect(resolver({
      actionId: 'session.open',
      target: { kind: 'session', sessionId: 'c111111111111111111111111' },
      currentMachineId: 'machine-local',
    })).resolves.toBeNull();
  });
});
