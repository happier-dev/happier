import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { getActionSpec, projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { actionSpecToActionDefinitionV1, freezeWorkflowActionContractV1 } from '@happier-dev/protocol/actions/actionCatalog';
import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionRequestEnvelopeV1Schema,
  type ExternalActionRequestEnvelope, type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { readHostReviewedParentV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionHttpError';
import { ManagedMachineV1Schema } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedConfigurationFactsV1Schema } from '@happier-dev/protocol/machines/managed/managedConfigurationV1';
import { sealManagedMachinePresetContentV1, replaceManagedMachinePresetLaunchNameV1,
  createManagedMachinePresetAcquireOverrideV1, projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { openExternalActionResponseV2, sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { createAccountScopedCryptoMaterialSnapshotV1, deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import type { AvailableAutomationAccountEncryptionV1 } from '@happier-dev/protocol/automations/automationAccountCurrentnessV1';
import { WorkflowRunStartRequestV1Schema } from '@happier-dev/protocol/workflows/actionsV1';
import { resolveWorkflowRunDataKeyV1 } from '@happier-dev/protocol/workflows/workflowRunDataKeyV1';
import { WorkflowRunRecipientKeyEnvelopesV1Schema } from '@happier-dev/protocol/workflows/workflowRunKeyV1';
import { openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1 } from '@happier-dev/protocol/workflows/workflowStoredContentV1';
import { sealExternalActionRequesterAccountContextV1, openManagedCreationActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { createWorkflowRunStorageTestkit } from '@/daemon/workflows/workflowRunStorage.testkit';
import { createWorkflowRunActionOwner } from '@/session/actions/workflowRunActions';
import { createWorkflowActionExecutor, normalizeWorkflowActionThrownError } from '@/session/actions/workflowActionExecutor';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import { createActionSettingsProvider } from '@/settings/actionsSettingsProvider';
import { createWorkflowMaterializationHostV1 } from '@/session/actions/workflowMaterializationHost';
import { dispatchManagedWorkflowStart, verifyExternalActionExecutionAuthorizationCurrent } from './externalActionExecutionAuthorization';
import { encodeStoredCredentials, updateSettings } from '@/persistence';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { configuration } from '@/configuration';
import { createDaemonManagedMachineActionAdapter } from '@/daemon/startup/managedMachineActionAdapter';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { fixture as nativeFixture } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';

const runId = '82111111-1111-4111-8111-111111111111';
const target = { kind: 'machine' as const, machineId: 'guest', project: { machineId: 'guest', directory: '/guest/repo' } };
const managedCreation = { homeId: 'srv_home', managedId: 'managed-workflow',
  controller: { machineId: 'controller', installationId: 'controller-installation' } };
const definition = { version: 1, defaults: {
  agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.test', localId: 'test' } },
}, blocks: [{ kind: 'action', id: 'command', actionId: 'machines.command.run',
  input: { command: { kind: 'literal', value: 'echo guest-workflow' } } }, 'work on the guest'] };

describe('guest Workflow Run through public external Action ingress', () => {
  beforeEach(async () => {
    const profile = { id: 'home-profile', name: 'Home', serverUrl: 'https://home.example', webappUrl: 'https://home.example',
      createdAt: 1, updatedAt: 1, lastUsedAt: 1, homeConnectionDescriptorAuthority: 'exact' as const,
      homeConnectionDescriptor: { v: 1 as const, homeServerIdentityId: 'srv_home', canonicalServerUrl: 'https://home.example',
        revision: 1, endpoints: [{ kind: 'https' as const, url: 'https://home.example' }] } };
    await updateSettings(settings => ({ ...settings, servers: { ...settings.servers,
      'home-profile': profile, [configuration.activeServerId]: { ...profile, id: configuration.activeServerId },
    } }));
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ...(['plain', 'e2ee'] as const).flatMap(mode => (['direct', 'managed', 'managed-workspace-failure', 'managed-missing-parent'] as const)
      .map(transport => [mode, transport] as const)),
    ...(['plain', 'e2ee'] as const).flatMap(mode => (['managed-project-files', 'managed-project-files-override'] as const)
      .map(transport => [mode, transport] as const)),
  ])('returns the actual guest admission or workspace failure (%s/%s)', async (mode, selectedTransport) => {
    const projectFilesCase = selectedTransport === 'managed-project-files' || selectedTransport === 'managed-project-files-override';
    const transport = projectFilesCase ? 'managed' : selectedTransport;
    const currentness = await createRequesterCurrentnessSocketHarness();
    onTestFinished(() => currentness.close());
    const secret = new Uint8Array(32).fill(63);
    const credentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'account' })).toString('base64url')}.signature`,
      encryption: mode === 'plain' ? null : { type: 'legacy' as const, secret } };
    const machineMaterial = mode === 'plain' ? null
      : { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
    const crypto = mode === 'plain' ? null : createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } });
    const encryption: AvailableAutomationAccountEncryptionV1 = crypto
      ? { kind: 'available', material: crypto, witness: { mode: 'e2ee', version: 1,
        contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(crypto.contentPublicKeyFingerprint) } }
      : { kind: 'available', witness: { mode: 'plain', version: 1, contentKeyFingerprint: null } };
    const cloudProject = { ...target.project,
      sessionPlacement: { kind: 'preset' as const, homeId: 'srv_home', presetId: 'preset',
        ...(selectedTransport === 'managed-project-files-override' ? { projectFiles: { kind: 'sync' as const, mode: 'keep_synced' as const } } : {}) } };
    const authoredProject = structuredClone(cloudProject);
    let enterWorkspace: (() => void) | undefined;
    let releaseWorkspace: (() => void) | undefined;
    const workspaceEntered = new Promise<void>(resolve => { enterWorkspace = resolve; });
    const workspaceReleased = new Promise<void>(resolve => { releaseWorkspace = resolve; });
    let workspaceEntries = 0;
    const keyCensus = { runId, ownerAccountId: 'account', ownerAccountCurrentness: encryption.witness, encryptionMode: mode,
      access: 'owner' as const, visibleTeamId: null, dataEncryptionKey: null, callerDataEncryptionKey: null, recipients: [] };
    const storage = createWorkflowRunStorageTestkit({ runId, machineId: 'guest', accountId: 'account', origin: { kind: 'direct' }, keyCensus });
    const materialize = createWorkflowMaterializationHostV1({ credentials, serverId: 'home-profile', serverIdentityId: 'srv_home',
      serverHttpBaseUrl: 'https://home.example',
      readRoleSelection: async () => { throw new Error('Fixture has no Role selection'); },
      readLaunchProfile: async () => { throw new Error('Fixture has no launch profile'); },
      readWorkflowDefinition: async () => { throw new Error('Fixture has no nested Workflow'); },
      readHostActionContract: async actionId => freezeWorkflowActionContractV1(actionSpecToActionDefinitionV1(getActionSpec(ActionIdSchema.parse(actionId)))),
      // Installed Agent inventory and capabilities are daemon RPC/OS facts.
      // The production materialization host decides availability from them.
      callMachineAction: async ({ machineId, method }) => {
        expect(machineId).toBe('guest');
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) return {
          protocolVersion: 1, projection: { v: 2, generation: 1, agentsById: { installed: {
            id: 'installed', identity: { pluginId: 'happier.agent.test', localId: 'test' },
            capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } },
          } } },
        };
        expect(method).toBe(RPC_METHODS.CAPABILITIES_DETECT);
        return { protocolVersion: 1, results: { 'cli.installed': { ok: true, data: {
          installed: true, version: '1', latestVersion: null, update: { supported: false, command: null },
          signIn: { status: 'unknown', loginSupport: 'unsupported' }, platform: { supported: true },
          install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [],
        } } } };
      },
    });
    const owner = createWorkflowRunActionOwner({ storage, resolveAccountId: async () => 'account',
      definitions: { get: async () => { throw new Error('Inline fixture has no saved source'); } },
      resolveEncryption: async () => encryption,
      // Workspace preparation is an OS boundary. Admission, materialization,
      // stored encryption and replay comparison remain the production owners.
      prepareWorkspace: async ({ projectTarget }) => {
        workspaceEntries += 1;
        expect(projectTarget).toEqual(transport === 'direct' ? target.project : cloudProject);
        if (transport === 'managed' || transport === 'managed-workspace-failure') {
          enterWorkspace?.();
          await workspaceReleased;
        }
        if (transport === 'managed-workspace-failure') return { ok: false, code: 'workspace_conflict' };
        const { sessionPlacement, ...project } = projectTarget;
        return { ok: true, workspaceTarget: { project: { ...project, checkoutRootPath: '/guest/repo' },
          ...(sessionPlacement ? { sessionPlacement } : {}),
        } };
      },
      resolveMaterializationContext: (_args, project) => materialize(project),
    });
    const makeExecutor = (runs: typeof owner, overrides: Partial<ActionExecutorDeps> = {}) => createCliActionExecutorHarness({ token: credentials.token, credentials, mode, ctx: null,
      sessionId: '', serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example',
      actionsSettingsProvider: createActionSettingsProvider({ allowEnvironmentOverride: false,
        accountSettings: AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1, actions: {},
          approvalWaivedSurfaces: { 'workflow.run.start': ['cli'], 'machines.command.run': ['cli'], 'session.spawn_new': ['cli'],
            'machines.managed.acquire': ['cli'] },
        } }) }),
    }, { workflowAction: createWorkflowActionExecutor({ isWorkflowFeatureEnabled: () => true, runs }),
      prepareHostReviewedChildren: async request => {
        if (request.actionId !== 'workflow.run.start') return null;
        try {
          return await runs.prepareStartApproval({ actionId: request.actionId,
            input: WorkflowRunStartRequestV1Schema.parse(request.input), context: request.context }, {});
        } catch (error) {
          boundaryTrace.push(error instanceof Error ? JSON.stringify({ stack: error.stack, details: Reflect.get(error, 'details') }) : String(error));
          return normalizeWorkflowActionThrownError(error);
        }
      },
      ...overrides,
    }).executor;
    const executor = makeExecutor(owner);
    // Home verification is the network trust boundary. The real receiver
    // installs the requester HTTP projection and verifies the envelope digest.
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(64));
    const controllerKeys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(65));
    const launch = { provider: { pluginId: 'acme.compute', localId: 'vm' }, schemaVersion: 1, name: 'guest', choices: {} };
    const accountKey = deriveAccountMachineKeyFromRecoverySecret(secret);
    const contentPublicKey = nacl.box.keyPair.fromSecretKey(accountKey).publicKey;
    const authored = sealManagedMachinePresetContentV1({ presetId: 'preset', mode,
      content: { v: 1, name: 'Workflow preset', launch, projectFiles: { kind: 'copy_once' } },
      ...(mode === 'e2ee' ? { recipientCensus: [{
        account: { kind: 'account' as const, accountId: 'account', firstName: 'Account', lastName: null, username: 'account', avatarUrl: null },
        readiness: { status: 'available' as const, contentPublicKey: Buffer.from(contentPublicKey).toString('base64'),
          contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(contentPublicKey) }, envelopeStatus: 'missing' as const,
      }], randomBytes } : {}),
    });
    const openPreset = { presetId: 'preset', mode, ...(mode === 'e2ee' ? { accountId: 'account', accountKey } : {}) };
    const snapshot = replaceManagedMachinePresetLaunchNameV1({ ...openPreset, content: authored.content, recipients: authored.recipients,
      launchName: launch.name, reviewedFacts: ManagedConfigurationFactsV1Schema.parse({ launch, optionStatus: 'current', prerequisites: [],
        billing: { location: 'cloud', stoppedBilling: 'unknown' }, retentionCapabilities: { supportedIntents: ['delete'] },
        retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false }),
      nativeResult: { kind: 'bound', resource: { contributionRef: launch.provider, schemaVersion: 1, value: {} } }, randomBytes });
    if (!snapshot) throw new Error('Could not seal enrolled preset snapshot');
    const presetContent = { ...authored, content: snapshot };
    const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ ...openPreset,
      projection: projectManagedMachinePresetForRecipientV1({ content: snapshot, recipients: authored.recipients, recipientAccountId: 'account' }),
      enrollmentIdentity: { kind: 'existingUser', role: 'adopted' }, randomBytes });
    if (!presetContentOverride) throw new Error('Could not seal enrolled preset override');
    const acquisition = { selection: { kind: 'preset' as const, homeId: 'srv_home', id: 'preset', revision: 1 },
      controller: managedCreation.controller, retention: { kind: 'until-delete' as const }, wakeOnAcceptedMessage: false, presetContentOverride };
    const enrolled = ManagedMachineV1Schema.parse({ id: managedCreation.managedId, homeId: 'srv_home', custodianAccountId: 'account',
      preset: { id: 'preset', revision: 1, contentEncryptionMode: mode }, controller: managedCreation.controller, allocation: 'bound',
      creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 0, enrolledMachineId: 'guest',
      retention: acquisition.retention, wakeOnAcceptedMessage: false });
    const native = nativeFixture({ credentialPurposes: [] });
    const unavailable = async (): Promise<never> => { throw new Error('Fixture has no Connected Account credentials'); };
    const authority = createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
      purposeBindingOwner: createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unavailable, subscribe: () => ({ dispose() {} }) },
        selectTarget: unavailable, resolveTarget: unavailable, materializeAccount: unavailable,
        projectTargetAccounts: unavailable, assertTargetAccountMaterializable: unavailable,
      }), requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(), resolveRequestAuthHttpPort: () => 43123,
      createRedactionLease: () => ({ add() {}, close() {} }),
    });
    const boundaryTrace: string[] = [];
    let guestRequests = 0;
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account' });
    let checkedNegativeContinuations = false;
    const adapter = createDaemonManagedMachineActionAdapter({ credentials, machineId: 'controller', serverId: 'home-profile',
      serverBaseUrl: 'https://home.example', installationIdentity: {
        installationId: managedCreation.controller.installationId, privateKey: controllerKeys.secretKey },
      managedProviderOperationAuthority: authority,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({ serverUrl: 'https://home.example',
        resolveCurrentMachineId: () => 'controller', resolveCurrentServerIdentityId: () => 'srv_home' }),
      acquireRuntimeRegistryLease: async () => ({ registry: native.runtimeRegistry, source: 'active', durableRevision: 1, release: async () => {} }),
      observeActionExecution: operations.observeExecution,
      waitForActionOperationCompletion: (...args) => operations.runner.waitForCompletion(...args),
      executeWorkflowStart: async (start, project, context, machine) => {
        expect(project).toEqual(authoredProject);
        expect(context.workflowPreparation?.project).toEqual(authoredProject);
        if (projectFilesCase) expect(start.managedProjectFiles).toEqual({ kind: 'copy_once' });
        boundaryTrace.push('enrolled-continuation');
        const reviewedParent = readHostReviewedParentV1(context);
        boundaryTrace.push(JSON.stringify({ callbackParent: reviewedParent?.actionId,
          callbackParentRunId: reviewedParent?.input.runId,
          callbackChildPort: context.hostReviewedChild !== undefined }));
        if (!context.externalActionExecutionAuthorization) throw new Error('Missing genuine controller root');
        const dispatch = { input: start, project, serverId: 'home-profile', context,
          authorization: context.externalActionExecutionAuthorization,
          continuation: { managedId: machine.id, creationRequestId: runId, expectedIntentRevision: machine.intentRevision },
          installationId: managedCreation.controller.installationId, privateKey: controllerKeys.secretKey,
          serverHttpBaseUrl: 'https://home.example', ...(machineMaterial ? { material: machineMaterial } : {}),
        };
        if (!checkedNegativeContinuations && transport === 'managed' && !projectFilesCase) {
          checkedNegativeContinuations = true;
          for (const changedProject of [
            { ...project, directory: '/guest/another-project' },
            { ...project, sessionPlacement: { kind: 'preset' as const, homeId: 'srv_home', presetId: 'another-preset' } },
          ]) {
            const refused = await dispatchManagedWorkflowStart({ ...dispatch, project: changedProject });
            expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false,
              errorCode: mode === 'plain' ? 'invalid_envelope' : 'invalid_encrypted_envelope' });
            expect(workspaceEntries).toBe(0);
          }
          for (const input of [
            { ...start, runId: '83111111-1111-4111-8111-111111111111' },
            { ...start, source: { kind: 'inline' as const, definition: { ...definition, blocks: ['different work'] } } },
            { ...start, managedCreation: { ...managedCreation, managedId: 'another-managed-machine' } },
          ]) {
            const refused = await dispatchManagedWorkflowStart({ ...dispatch, input: WorkflowRunStartRequestV1Schema.parse(input) });
            expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'forbidden' });
            expect(workspaceEntries).toBe(0);
          }
        }
        if (transport === 'managed-missing-parent') {
          const refused = await dispatchManagedWorkflowStart({ ...dispatch, context: undefined });
          expect(refused, JSON.stringify(refused)).toMatchObject({ ok: false, errorCode: 'run_access_denied' });
          return refused;
        }
        return dispatchManagedWorkflowStart(dispatch);
      },
    });
    const controllerStorage = createWorkflowRunStorageTestkit({ runId, machineId: 'controller' });
    const controllerOwner = createWorkflowRunActionOwner({ storage: controllerStorage, resolveAccountId: async () => 'account',
      definitions: { get: async () => { throw new Error('Inline controller source has no saved definition'); } },
      resolveEncryption: async () => encryption,
      prepareWorkspace: async () => { throw new Error('Controller preview must not prepare a workspace'); },
      resolveMaterializationContext: (_args, project) => materialize(project),
      acquireWorkflowPlacement: adapter.acquireWorkflowPlacement,
    });
    const controllerExecutor = makeExecutor(controllerOwner, { managedMachineAction: adapter, runActionOperation: operations.runActionOperation });
    let managedReceiver: ((body: unknown) => Promise<{ status: number; data: unknown }>) | undefined;
    vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
      boundaryTrace.push(new URL(url).pathname);
      if (url.endsWith('/controller/admit')) return { status: 200, data: { machine: enrolled, presetContent, presetContentOverride, replayed: true } };
      if (url.endsWith('/controller/current') || url.endsWith('/controller/report')) return { status: 200, data: { machine: enrolled } };
      if (url.endsWith('/controller/context')) return { status: 200, data: { requestId: runId,
        enrollmentInstallation: { machineId: 'guest', installationId: 'guest-installation',
          installationPublicKey: Buffer.from(keys.publicKey).toString('base64url') } } };
      if (url === 'https://home.example/v1/actions/workflow.run.start' && managedReceiver) {
        return await managedReceiver(body);
      }
      expect(url).toBe('https://home.example/v1/actions/workflow.run.start/execution-authorization/verify');
      return { status: 200, data: { ok: true } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/machines/controller')) return { status: 200, data: { machine: {
        id: 'controller', metadata: null, metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
        access: { custodian: { accountId: 'account', displayName: 'Account' }, role: 'manage', resourceMode: mode, accessState: 'ready' },
      } } };
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
      if (new URL(url).pathname.startsWith('/v1/artifacts/')) return { status: 404, data: { error: 'Artifact not found' } };
      expect(url).toBe('https://home.example/v1/account/encryption/currentness');
      return { status: 200, data: { mode, version: 1, settingsVersion: 0,
        signingKeyFingerprint: null, contentKeyFingerprint: encryption.witness.contentKeyFingerprint, updatedAt: 1 } };
    });
    // The managed CLI supplier reads Home's capability HTTP before acquisition.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      expect(new Request(input).url).toBe('https://home.example/v1/features');
      return Response.json({ capabilities: { guestCli: { source: 'public-release', line: '0.3', channel: 'stable' } } });
    });
    const execute = async (birth = managedCreation) => {
      const start = WorkflowRunStartRequestV1Schema.parse({ runId, managedCreation: birth, source: { kind: 'inline', definition } });
      const binding = { serverIdentityId: 'srv_home', accountId: 'account', authentication: { kind: 'account' as const, tokenEpoch: 2 },
        actionId: 'workflow.run.start' as const, requestId: 'workflow-guest-request', target };
      const envelope = machineMaterial === null
        ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target, input: start })
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
          binding, input: start, material: machineMaterial, randomBytes });
      const rootAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-workflow-admission', binding: {
        ...binding, machineId: 'guest', custodianAccountId: 'account', installationId: 'guest-installation',
        accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      const authorization = sealExternalActionRequesterAccountContextV1({ authorization: rootAuthorization,
        purpose: { kind: 'external_action' }, credentials: { secret: null, ...encodeStoredCredentials(credentials) },
        invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user', callerPermissionMode: 'default' },
        installationPublicKey: keys.publicKey, randomBytes });
      const receive = async (envelope: ExternalActionRequestEnvelope, authorization: ExternalActionExecutionAuthorizationV1,
        machine: 'guest' | 'controller' = 'guest') => {
      const currentExecutor = machine === 'guest' ? executor : controllerExecutor;
      const installationId = machine === 'guest' ? 'guest-installation' : managedCreation.controller.installationId;
      const signingKeys = machine === 'guest' ? keys : controllerKeys;
      const result = await executeExternalAction({ actionId: binding.actionId, envelope, executionAuthorization: authorization,
        principal: { accountId: 'account', authority: 'present_user', authentication: binding.authentication },
        currentMachineId: machine, currentAccountId: 'account', currentServerId: 'home-profile',
        currentServerHttpBaseUrl: 'https://home.example', currentInstallationId: installationId,
        externalActionMachineRequestPrivateKey: signingKeys.secretKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          installationId, privateKey: signingKeys.secretKey, serverHttpBaseUrl: 'https://home.example' }),
        resolveEncryption: async () => machineMaterial ? { serverIdentityId: 'srv_home', material: machineMaterial } : null,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }), executor: currentExecutor,
        prepareRequesterAccountContext: request => prepareRequesterAccountActionContext({ authorization: request.authorization,
          purpose: { kind: 'external_action' }, machineId: machine, installationId,
          installationPrivateKey: signingKeys.secretKey, serverId: 'home-profile', serverIdentityId: 'srv_home',
          serverHttpBaseUrl: 'https://home.example', ownCredentials: credentials, isCurrent: async () => true,
          createExecutor: () => currentExecutor }),
      });
      if (result.kind !== 'response') return result;
      return result.response;
      };
      if (transport !== 'direct') {
        const controllerTarget = { kind: 'machine' as const, machineId: 'controller', project: {
          ...cloudProject, machineId: 'controller',
        } };
        const parentStart = WorkflowRunStartRequestV1Schema.parse({ runId, source: { kind: 'inline', definition } });
        const parentBinding = { ...binding, target: controllerTarget };
        const workflowPreparation = { project: cloudProject, acquisition };
        const parentEnvelope = machineMaterial === null
          ? ExternalActionRequestEnvelopeV1Schema.parse({ v: 1, requestId: binding.requestId, target: controllerTarget,
            input: parentStart, workflowPreparation })
          : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
            binding: parentBinding, input: parentStart, workflowPreparation, material: machineMaterial, randomBytes });
        const parentRoot = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-controller-root', binding: {
          ...rootAuthorization.binding, machineId: 'controller', installationId: managedCreation.controller.installationId, target: controllerTarget,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(parentEnvelope),
        } });
        const parent = sealExternalActionRequesterAccountContextV1({ authorization: parentRoot,
          purpose: { kind: 'external_action' }, credentials: { secret: null, ...encodeStoredCredentials(credentials) },
          invocation: { caller: { kind: 'host' }, surface: 'cli', authority: 'present_user', callerPermissionMode: 'default' },
          installationPublicKey: controllerKeys.publicKey, randomBytes });
        managedReceiver = async body => {
          guestRequests += 1;
          const carrier = ExternalActionExecutionAuthorizationRequestV1Schema.parse(body);
          const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...rootAuthorization, token: 'home-enrolled-child', binding: {
            ...rootAuthorization.binding, target: carrier.envelope.target, requestId: carrier.envelope.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(carrier.envelope),
            managedContinuation: { ...carrier.managedContinuation,
              controller: managedCreation.controller, acquireRequestEnvelopeDigest: parent.binding.requestEnvelopeDigest },
          } });
          const opened = openManagedCreationActionCodecV1({ authorization: child, envelope: carrier.envelope, includeInvocation: true,
            machineId: 'guest', installationId: 'guest-installation', serverIdentityId: 'srv_home', installationPrivateKey: keys.secretKey });
          boundaryTrace.push(JSON.stringify({ decodedParent: opened?.reviewedParent?.actionId,
            decodedParentRunId: opened?.reviewedParent?.input && typeof opened.reviewedParent.input === 'object'
              ? Reflect.get(opened.reviewedParent.input, 'runId') : undefined,
          }));
          const response = await receive(carrier.envelope, child);
          if ('kind' in response) {
            if (response.kind !== 'invalid_request') throw new Error(JSON.stringify(response));
            const error = projectExternalActionHttpError(response.errorCode, response.requestId);
            return { status: error.statusCode, data: error.payload };
          }
          return { status: 200, data: response };
        };
        const response = await receive(parentEnvelope, parent, 'controller');
        if ('kind' in response) throw new Error(JSON.stringify(response));
        if (response.v === 2 && parentEnvelope.v === 2 && machineMaterial) return openExternalActionResponseV2({
          envelope: response, request: parentEnvelope, binding: parentBinding, material: machineMaterial });
        if (response.v !== 1) throw new Error('Unexpected controller response encryption');
        return response.execution;
      }
      const response = await receive(envelope, authorization);
      if ('kind' in response) throw new Error(JSON.stringify(response));
      if (response.v === 2 && envelope.v === 2 && machineMaterial) return openExternalActionResponseV2({
        envelope: response, request: envelope, binding, material: machineMaterial,
      });
      if (response.v !== 1) throw new Error('Unexpected response encryption');
      return response.execution;
    };
    let settled = false;
    const pending = execute().finally(() => { settled = true; });
    if (transport === 'managed' || transport === 'managed-workspace-failure') {
      const earlyResult = await Promise.race([workspaceEntered.then(() => null), pending]);
      expect(earlyResult, JSON.stringify({ earlyResult, boundaryTrace })).toBeNull();
      // The real operation runner must still be waiting for the guest OS effect.
      expect(settled).toBe(false);
      releaseWorkspace?.();
    }
    const created = await pending;
    if (transport === 'managed-missing-parent') {
      // Standalone preparation supplies no inherited consent or accepted Run.
      expect(created, JSON.stringify(created)).toMatchObject({ ok: false });
      expect(storage.calls.some(operation => operation.operation === 'admit')).toBe(false);
      expect(native.effects()).toBe(0);
      return;
    }
    if (transport === 'managed-workspace-failure') {
      expect(created, JSON.stringify(created)).toMatchObject({ ok: false, errorCode: 'target_unavailable',
        details: { errorCode: 'workspace_conflict' } });
      const failedWorkspaces = workspaceEntries;
      const failedGuestRequests = guestRequests;
      const replayedFailure = await execute();
      expect(replayedFailure, JSON.stringify({ created, replayedFailure })).toEqual(created);
      expect(workspaceEntries).toBe(failedWorkspaces);
      expect(guestRequests).toBe(failedGuestRequests);
      expect(storage.calls.some(operation => operation.operation === 'admit')).toBe(false);
      expect(native.effects()).toBe(0);
      return;
    }
    expect(created, JSON.stringify({ created, boundaryTrace, storageCalls: storage.calls })).toMatchObject({ ok: true, result: { admission: 'created' } });
    expect(storage.calls.find(operation => operation.operation === 'admit')).toMatchObject({ machineId: 'guest', managedCreation });
    if (transport === 'managed') {
      const admitted = storage.calls.find(operation => operation.operation === 'admit');
      if (!admitted || admitted.operation !== 'admit') throw new Error('Missing accepted Workflow');
      const envelopes = WorkflowRunRecipientKeyEnvelopesV1Schema.parse(admitted.recipientKeyEnvelopes);
      const ownerEnvelope = envelopes.find(row => row.recipientAccountId === 'account')?.encryptedDataKey ?? null;
      const key = resolveWorkflowRunDataKeyV1({ encryption,
        census: { ...keyCensus, dataEncryptionKey: ownerEnvelope, callerDataEncryptionKey: ownerEnvelope } });
      if (key.kind !== 'available') throw new Error('Missing accepted Workflow key');
      expect(openWorkflowAcceptedSnapshotStoredEnvelopeV1({ ...key.encryption.runCrypto,
        binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'account', runId },
        envelope: parseWorkflowStoredContentEnvelopeV1(String(storage.acceptedEnvelope())) })).toMatchObject({
        kind: 'available', content: { workspaceTarget: {
          sessionPlacement: authoredProject.sessionPlacement,
          projectFiles: authoredProject.sessionPlacement.projectFiles ?? { kind: 'copy_once' },
        } },
      });
    }
    const preparedWorkspaces = workspaceEntries;
    const dispatchedGuests = guestRequests;
    const existing = await execute();
    if (transport === 'managed') {
      // The same host operation replays its captured guest outcome, without
      // dispatching the guest or preparing its workspace a second time.
      expect(existing, JSON.stringify(existing)).toEqual(created);
      expect(workspaceEntries).toBe(preparedWorkspaces);
      expect(guestRequests).toBe(dispatchedGuests);
    } else {
      expect(existing, JSON.stringify(existing)).toMatchObject({ ok: true, result: { admission: 'existing' } });
    }
    if (transport === 'direct') expect(await execute({ ...managedCreation, managedId: 'different-managed-creation' })).toMatchObject({
      ok: false, errorCode: 'currentness_conflict',
    });
    expect(storage.calls.filter(operation => operation.operation === 'admit')).toHaveLength(1);
    expect(native.effects()).toBe(0);
  });
});
