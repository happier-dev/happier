import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDefinitionV1Schema, createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  type AutomationDefinitionDetail, type AutomationDefinitionCreateRequest, type AutomationDefinitionReconcileRequest } from '@happier-dev/protocol';
import { AUTOMATION_TEMPLATE_V02_PLAIN, AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED } from '../../../../../packages/protocol/src/automations/automationTemplateV02.testFixtures';
import { openSessionRequesterBootstrapRpcRequestV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import tweetnacl from 'tweetnacl';

const network = vi.hoisted(() => ({ currentness: vi.fn(), session: vi.fn(), list: vi.fn(), get: vi.fn(), create: vi.fn(), reconcile: vi.fn(), remove: vi.fn(),
  publishedMachine: vi.fn(), machineRpc: vi.fn() }));
// These are network transport adapters; Workflow semantics and the Account codec remain real.
vi.mock('@/api/client/connectedServiceCredentialApi', () => ({ fetchAccountEncryptionCurrentness: network.currentness }));
vi.mock('@/api/automations', () => ({ listAutomationDefinitions: network.list, listAutomationDefinitionDetails: network.list, getAutomationDefinition: network.get,
  createAutomationDefinition: network.create, reconcileAutomationDefinition: network.reconcile, deleteAutomationDefinition: network.remove }));
vi.mock('@/session/transport/http/sessionsHttp', () => ({ fetchSessionById: network.session }));
vi.mock('@/api/machine/readPublishedMachineRow', () => ({ readPublishedMachineRowWithLegacyOwnerProof: network.publishedMachine }));
vi.mock('@/session/transport/rpc/machineRpc', () => ({ callExactMachineRpc: network.machineRpc }));
// Genuine socket boundary: the receiver's live Account observation is not part of these contracts.
vi.mock('socket.io-client', () => ({ io: () => { throw new Error('Account socket unavailable'); } }));

const definition = WorkflowDefinitionV1Schema.parse({ version: 1,
  defaults: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
  blocks: [{ kind: 'step', id: 'prompt', document: { text: 'Review', references: [], attachments: [] }, input: [], result: { kind: 'text' } }],
});
const trigger = { kind: 'schedule' as const, enabled: true,
  schedule: { kind: 'interval' as const, scheduleExpr: null, everyMs: 60_000, timezone: null } };

describe('CLI workflow trigger Account codec', () => {
  let stored: AutomationDefinitionDetail;
  beforeEach(() => {
    for (const adapter of Object.values(network)) adapter.mockReset();
    network.create.mockImplementation(async ({ input }: { input: AutomationDefinitionCreateRequest }) => {
      stored = { id: input.automationId, name: input.name, description: null,
      enabled: true, targetType: null, existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: input.workflowDefinitionId ?? null, scopeSessionId: input.scopeSessionId ?? null,
      executionRecipe: input.executionRecipe, assignments: (input.assignments ?? []).map((assignment) => ({ ...assignment,
        enabled: assignment.enabled ?? true, priority: assignment.priority ?? 0, updatedAt: 1 })),
      triggers: [] };
      network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
      return stored;
    });
    network.get.mockImplementation(async () => stored);
    network.list.mockResolvedValue({ automations: [], nextCursor: null });
  });
  it('pauses retained encrypted rows before disclosure and requires explicit device Save for a plain Workflow', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    stored = { id: 'automation-old', name: 'Old', description: null, enabled: true, targetType: 'existingSession',
      existingSessionId: null, templateVersion: 1, lastRunAt: null, createdAt: 1, updatedAt: 1,
      workflowDefinitionId: null, scopeSessionId: null, templateCiphertext: AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
    network.session.mockResolvedValue({ id: 'session-old', encryptionMode: 'e2ee', dataEncryptionKey: null, share: null });
    network.reconcile.mockImplementation(async ({ input }: { input: AutomationDefinitionReconcileRequest }) => {
      stored = { ...stored, templateVersion: stored.templateVersion + 1, enabled: input.enabled,
        ...(input.executionRecipe === undefined ? {} : { targetType: null, templateCiphertext: undefined,
          executionRecipe: input.executionRecipe }) };
      return stored;
    });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array(32).fill(7) } },
      resolveWorkflow: async () => ({ definition }),
      resolveSession: async () => ({ project: { machineId: 'machine', directory: '/repo' }, nativeGoalOwner: false,
        executionSelection: { agentTarget: definition.defaults!.agentTarget! } }) });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ enabled: false, health: 'source_unavailable',
      legacy: { lockedReason: 'review_required' } });
    expect(stored.executionRecipe).toBeUndefined();
    expect(network.session).not.toHaveBeenCalled();
    expect(stored.templateCiphertext).toBe(AUTOMATION_TEMPLATE_V02_EXISTING_ENCRYPTED);
    const caller = { surface: 'cli' as const, authority: 'present_user' as const };
    const reviewed = (await actions.list({ review: true, automationId: stored.id }, caller)).sets[0]!;
    expect(reviewed).toMatchObject({ health: 'available', legacy: { lockedReason: 'review_required' },
      target: { definition: { defaults: { conversation: { sessionId: 'session-old' } } } } });
    expect(stored.executionRecipe).toBeUndefined();
    const keyless = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => ({ definition }) });
    await expect(keyless.list({ review: true, automationId: stored.id }, caller))
      .rejects.toMatchObject({ code: 'session_key_required' });
    if (!reviewed.target || !reviewed.project) throw new Error('review_did_not_open_source');
    await actions.update({ automationId: stored.id, expectedRevision: reviewed.revision, confirmLegacyConversion: true,
      patch: { target: reviewed.target, project: reviewed.project, enabled: true } }, caller);
    expect(stored).toMatchObject({ id: 'automation-old', enabled: true, executionRecipe: { v: 2, workflow: { t: 'plain' } } });
    expect(stored.templateCiphertext).toBeUndefined();
  });
  it('converts predecessor rows in place without changing their Channels association identity', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    stored = { id: 'automation-old', name: 'Old', description: null, enabled: true,
      targetType: 'newSession', existingSessionId: null, templateVersion: 1, lastRunAt: null,
      createdAt: 1, updatedAt: 1, workflowDefinitionId: null, scopeSessionId: null,
      templateCiphertext: AUTOMATION_TEMPLATE_V02_PLAIN,
      assignments: [{ machineId: 'machine', enabled: true, priority: 0, updatedAt: 1 }], triggers: [] };
    network.list.mockResolvedValue({ automations: [stored], nextCursor: null });
    network.reconcile.mockImplementation(async ({ input }: { input: AutomationDefinitionReconcileRequest }) => {
      stored = { ...stored, templateVersion: 2, templateCiphertext: undefined, executionRecipe: input.executionRecipe, enabled: input.enabled };
      return stored;
    });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => ({ definition }) });
    expect((await actions.list({ scope: 'account_all' })).sets[0]).toMatchObject({ automationId: 'automation-old',
      revision: 2, health: 'available', context: { workspace: { directory: '/repo' } } });
    expect(stored.id).toBe('automation-old');
    expect(stored.executionRecipe).toMatchObject({ v: 2 });
  });
  it('writes a keyless plain Account inline payload through the Automation owner', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => ({ definition }) });
    const written = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger });
    expect(written.set.health).toBe('available');
    expect(written.set.context).toMatchObject({ inlineDefinition: definition, executionTarget: { kind: 'session' } });
    expect(network.create.mock.calls[0]?.[0].input).toMatchObject({
      name: 'Automation', description: null,
      executionRecipe: { workflow: { t: 'plain', v: {
        workspace: { directory: '/work' },
        display: { name: 'Workflow triggers', description: null },
      } } },
    });
  });
  // A shared Machine receives the requester's sign-in with no consent step (owner ruling 2026-11-23).
  it.each(['accepted', 'write-refused'] as const)('settles shared Machine trigger custody when the save is %s', async decision => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(17));
    network.publishedMachine.mockResolvedValue({ row: { id: 'shared-machine', installationId: 'installation',
      installationPublicKey: Buffer.from(installation.publicKey).toString('base64'), access: {
      custodian: { accountId: 'machine-owner', displayName: 'Owner' },
    } }, legacyOwnerOnly: false });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const token = 'fixture.' + Buffer.from(JSON.stringify({ sub: 'requester' })).toString('base64url') + '.fixture';
    const refused = Object.assign(new Error('fixture refused the write'), { status: 403 });
    if (decision === 'write-refused') network.create.mockRejectedValueOnce(refused);
    network.machineRpc.mockImplementation(async ({ request, machineId, method }) => {
      expect(machineId).toBe('shared-machine');
      expect(method).toBe(RPC_METHODS.DAEMON_WORKFLOW_REQUESTER_CUSTODY);
      expect(JSON.stringify(request)).not.toContain(token);
      const operation = request.input.operation;
      if (operation === 'retain') expect(network.create).not.toHaveBeenCalled();
      else expect(network.create).toHaveBeenCalledOnce();
      expect(openSessionRequesterBootstrapRpcRequestV1({ request, machineId, installationId: 'installation',
        installationPrivateKey: installation.secretKey })).toMatchObject({
        scope: 'workflow_trigger', input: { executionTarget: { serverId: 'home', machineId },
          operation, scopeId: expect.any(String), automationId: expect.any(String) },
        requesterBootstrap: { credentials: { token } },
      });
      return { ok: true };
    });
    const actions = createCliWorkflowTriggerActions({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      resolveWorkflow: async () => ({ definition }),
      requesterCustody: { serverId: 'home' } });
    const write = actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'shared-machine', directory: '/work' }, trigger },
      { surface: 'cli', authority: 'present_user' });
    if (decision === 'write-refused') {
      await expect(write).rejects.toBe(refused);
      const operations = network.machineRpc.mock.calls.map(([call]) => call.request.input);
      expect(operations).toEqual([
        expect.objectContaining({ operation: 'retain', scopeId: expect.any(String) }),
        expect.objectContaining({ operation: 'retire', scopeId: operations[0]?.scopeId }),
      ]);
    } else {
      const admitted = await write;
      const request = network.machineRpc.mock.calls[0]?.[0].request;
      expect(request?.input?.scopeId).toBe(admitted.triggerId);
      expect(request?.input?.automationId).toBe(admitted.set.automationId);
      expect(network.create).toHaveBeenCalledOnce();
    }
  });
  it.each(['saved profile', 'verified invocation'] as const)('arms a guest\'s recurring trigger on a Machine shared for Use (%s)', async homeSource => {
    // The requester's and the receiver's saved profile ids differ; only the Home identity is shared.
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const [{ default: fastify }, { installAxiosFastifyAdapter }, { RpcHandlerManager }, { authorizeMachineRpcRequest },
      { registerSessionSpawnNewRpcHandlers }, { acquireWorkflowRequesterCredentials }, { adoptServerProfileHomeConnectionDescriptor },
      { configuration }, { mkdtemp, rm }, { tmpdir }, { join }] = await Promise.all([import('fastify'),
      import('@/testkit/http/axiosAdapter'), import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
      import('@/rpc/handlers/sessionLifecycle'), import('@/daemon/workflows/requesterCustody'), import('@/server/serverProfiles'),
      import('@/configuration'), import('node:fs/promises'), import('node:os'), import('node:path')]);
    const origin = 'http://shared-home.test';
    const homeId = 'srv_shared_home';
    if (homeSource === 'saved profile') await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: configuration.activeServerId, createIfMissing: true,
      observation: 'exact', descriptor: { v: 1, homeServerIdentityId: homeId, canonicalServerUrl: 'https://shared-home.example.test',
        revision: 1, endpoints: [{ kind: 'https', url: 'https://shared-home.example.test' }] } });
    // Home HTTP is the authentication boundary for the receiver's requester admission.
    const app = fastify();
    app.get('/v1/account/profile', async () => ({ id: 'requester' }));
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: {} }, version: 1 }));
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'guest-trigger-custody-'));
    const installation = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
    let granted = true;
    const receiver = new RpcHandlerManager({ scopePrefix: 'shared-machine', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId: 'shared-machine',
        resolveCustodianAccountId: async () => 'machine-owner', resolveInstallationId: () => 'installation',
        // Home's current-grant read is the boundary: a revoked grant is refused at the next admission.
        verifyMachineAdmission: async () => granted }) });
    registerSessionSpawnNewRpcHandlers({ rpcHandlerManager: receiver,
      requesterBootstrapBoundary: { serverId: 'owner-profile', serverHttpBaseUrl: origin, happyHomeDir,
        getObservedServerIdentityId: () => homeId,
        readInstallation: async () => ({ machineId: 'shared-machine', identity: { installationId: 'installation', version: 1, createdAt: 1,
          publicKey: Buffer.from(installation.publicKey).toString('base64url'),
          privateKey: Buffer.from(installation.secretKey).toString('base64url') } }),
        spawnLifecycleHandler: async () => { throw new Error('trigger custody never launches a Session'); } } });
    // Network transport: Home relays the guest's exact-Machine RPC with the Use admission it just checked.
    network.machineRpc.mockImplementation(async ({ request, method }) => receiver.invokeLocal(method, request, { rpcContext: {
      callerAuthority: 'present_user', verifyMachineAdmissionCurrent: async () => granted,
      machineAdmission: { actorAccountId: 'requester', custodianAccountId: 'machine-owner', machineId: 'shared-machine',
        installationId: 'installation', role: 'use', encryptionMode: 'plain' } } }));
    network.publishedMachine.mockResolvedValue({ row: { id: 'shared-machine', installationId: 'installation',
      installationPublicKey: Buffer.from(installation.publicKey).toString('base64'),
      access: { custodian: { accountId: 'machine-owner', displayName: 'Owner' }, role: 'use', resourceMode: 'plain', accessState: 'ready' } },
      legacyOwnerOnly: false });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'requester', tokenEpoch: 1,
      provenance: { v: 1, kind: 'terminal', authority: 'account_automation' } })).toString('base64url')}.fixture`;
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const requesterCustody = homeSource === 'saved profile' ? { serverId: configuration.activeServerId }
      : { serverId: 'requester-url-only-profile', serverIdentityId: homeId };
    const actions = createCliWorkflowTriggerActions({ credentials: { token, encryption: null, credentialProvenance: 'stored_session' },
      serverHttpBaseUrl: origin, resolveWorkflow: async () => ({ definition }),
      requesterCustody });
    const add = () => actions.add({ target: { kind: 'inline', definition },
      project: { machineId: 'shared-machine', directory: '/work' }, trigger }, { surface: 'cli', authority: 'present_user' });
    const retained = (scopeId: string) => acquireWorkflowRequesterCredentials({ scopeId, happyHomeDir, serverId: 'owner-profile',
      machineId: 'shared-machine', installationId: 'installation', serverHttpBaseUrl: origin });
    try {
      const armed = await add();
      const custody = await retained(armed.triggerId);
      expect(custody?.attribution).toMatchObject({ accountId: 'requester', machineId: 'shared-machine', installationId: 'installation' });
      await custody?.release();
      // No Use grant: Home stamps no Machine admission, and the receiver keeps nothing.
      const [{ request: sealed, method }] = network.machineRpc.mock.calls[0]!;
      expect(await receiver.invokeLocal(method, sealed, { rpcContext: { callerAuthority: 'present_user' } })).toMatchObject({ ok: false });
      // Revocation applies at the next admission: nothing new is armed or retained.
      granted = false;
      network.create.mockClear();
      await expect(add()).rejects.toMatchObject({ code: 'requester_custody_unavailable',
        failureCause: { phase: 'workflow.trigger.add', errorCode: expect.any(String) } });
      expect(network.create).not.toHaveBeenCalled();
    } finally {
      restore(); await app.close(); await rm(happyHomeDir, { recursive: true, force: true });
    }
  }, 60_000);
  it('opens real E2EE context only while the Account mode and key witness match', async () => {
    const secret = new Uint8Array(32).fill(7);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    network.currentness.mockResolvedValue({ mode: 'e2ee', version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint), updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: { type: 'legacy', secret } },
      resolveWorkflow: async () => ({ definition }) });
    const written = await actions.add({ target: { kind: 'inline', definition }, project: { machineId: 'machine', directory: '/work' }, trigger });
    expect(stored.executionRecipe?.v === 2 && stored.executionRecipe.workflow.t).toBe('encrypted');
    expect(written.set.context?.inlineDefinition).toEqual(definition);
    network.currentness.mockResolvedValue({ mode: 'plain', version: 2, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 });
    await expect(actions.list({ scope: 'account_inline' })).rejects.toMatchObject({ code: 'content_unavailable' });
  });
  it.each(['plain', 'e2ee'] as const)('validates the saved Workflow audience before encoding the %s trigger context', async (mode) => {
    const secret = new Uint8Array(32).fill(7);
    const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    network.currentness.mockResolvedValue({ mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: mode === 'plain' ? null
        : convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint), updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret } },
      resolveWorkflow: async () => ({ definition }), resolveWorkflowTeamIds: async () => ['team-one', 'team-two'] });
    const input = { workflow: '11111111-1111-4111-8111-111111111111', project: { machineId: 'machine', directory: '/work' }, trigger };
    await expect(actions.add(input)).rejects.toMatchObject({ code: 'visible_team_not_granted' });
    expect(network.create).not.toHaveBeenCalled();
    const written = await actions.add({ ...input, visibleTeamId: 'team-two' });
    expect(written.set.context?.visibleTeamId).toBe('team-two');
    expect(stored.executionRecipe).toMatchObject({ v: 2, workflow: { t: mode === 'plain' ? 'plain' : 'encrypted' } });
  });
  it('keeps scoped trigger writes in the authorized Session and the keyless Account codec', async () => {
    network.currentness.mockResolvedValue({ mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 });
    const { createCliWorkflowTriggerActions } = await import('./workflowTriggers');
    const actions = createCliWorkflowTriggerActions({ credentials: { token: 'token', encryption: null }, resolveWorkflow: async () => ({ definition }),
      resolveSession: async () => ({ project: { machineId: 'session-machine', directory: '/session-work' }, nativeGoalOwner: false }) });
    const written = await actions.add({ lifetimeSession: { sessionId: 'session-one',
      onComplete: { kind: 'originating_session' } }, target: { kind: 'inline', definition }, trigger });
    expect(written.set.health).toBe('available');
    expect(stored).toMatchObject({ scopeSessionId: 'session-one', assignments: [{ machineId: 'session-machine' }], executionRecipe: {
      v: 2, workflow: { t: 'plain', v: { workspace: { directory: '/session-work' }, onComplete: { kind: 'originating_session' } } },
    } });
    expect((await actions.list({ scope: 'account_inline' })).sets).toEqual([]);
    expect((await actions.list({ lifetimeSession: { sessionId: 'session-one' } })).sets).toHaveLength(1);
  });
});
