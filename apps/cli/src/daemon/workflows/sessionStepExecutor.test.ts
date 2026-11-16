import { createSessionLiveWorkProducer } from '@/daemon/lifecycle/sessionLiveWorkProducer';
import { artifactKindListResponse, artifactReadResponse } from '@/testkit/http/artifactHome';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { HomeSessionDefaultsProjectionV1Schema } from '@happier-dev/protocol/home/governance/projection';
import { DaemonAgentInstallReadResponseSchema } from '@happier-dev/protocol/daemon/agent-install-jobs';
import { definePlugin } from '@happier-dev/plugin-sdk';
import { createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { readCurrentContributionRegistry } from '@/agent/catalog/snapshot';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import * as persistence from '@/persistence';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { WorkflowSessionAuthoringSelectionSchema } from '@happier-dev/protocol/workflows/workflowV1';
import { readRecord } from '@happier-dev/protocol/inputs/inputRecords';
import { materializeWorkflowAcceptedSnapshotV1 } from '@happier-dev/protocol/workflows/materializeWorkflowAcceptedSnapshotV1';
import { resolveWorkflowAcceptedStepSelectionV1 } from '@happier-dev/protocol/workflows/workflowStepSelectionV1';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { PROFILE_REFERENCE_GUARD_ROUTE_V1, PROFILE_ROWS_ROUTE_V1, ProfileRecordV1Schema, ProfileRowsListResponseV1Schema, sealProfileRecordContentV1 } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { logger } from '@/ui/logger';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBuiltinWorkflowDefinitionV1 } from '@happier-dev/protocol/workflows/builtins/catalog';
import { projectDiscussionModelParticipantLaunchV1 } from '@happier-dev/protocol/discussions/participants';
import { createTestWorkflowCoordinator, createInMemoryWorkflowCoordinatorStore } from './workflowCoordinator.testkit';
import { createGitWorkflowWorkspaceTestDependencies } from './workflowWorkspace.testkit';
import { statSync } from 'node:fs';
import { SpawnDaemonSessionRequestSchema } from '@/rpc/handlers/spawnSessionOptionsContract';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { TeamCredentialResourceEntitledPageV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { SessionTeamCredentialBindingIntentsV1Schema } from '@happier-dev/protocol/teams/credentials/sessionBindingIntentV1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createMachineSessionSpawnRpcHandler } from '@/session/actions/sessionLifecycleActions';
import { awaitTrackedRunnerAgentSessionOpen } from '@/daemon/agentRuntime/runnerAgentSessionOpenAttestation';
import { ChildProcess } from 'node:child_process';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { createOnChildExited } from '@/daemon/sessions/onChildExited';
import { formatSessionRunnerFailureCause, readSessionRunnerFailureCause } from '@/session/shared/spawnSessionContract';
import type { TrackedSession } from '@/daemon/types';
import { runObservedWorkflowSessionStartup as runUnadmittedObservedWorkflowSessionStartup } from './workflowSessionStartup';
import { runAdmittedObservedWorkflowSessionStartup as runObservedWorkflowSessionStartup } from './workflowSessionStartup.testkit';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { verifyRequesterSessionCredentialBinding } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { SessionCreationCorrespondenceV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationCorrespondenceV1';
import { createPlainSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { AccountEncryptionCurrentnessUnavailableError } from '@/api/client/accountEncryptionCurrentness';
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail';
import { buildSessionCreationTerminalSpawnErrorResult } from '@/daemon/sessions/onHappySessionWebhook';
import { resolveWorkflowSessionConversation, createWorkflowInvocationRecoveryObserver } from './invocationRecoveryObserver';
import { createCredentialedWorkflowMaterializationHostV1, projectWorkflowConversationRoleSelection } from '@/session/actions/workflowMaterializationHost';
import { createWorkflowActionContextResolver } from './workflowActionContext';
import { createCliActionExecutorHarness } from '@/session/actions/createCliActionExecutorHarness';
import * as cliActionExecutorHarness from '@/session/actions/createCliActionExecutorHarness';
import { prepareSessionCreationTarget } from '@/session/creation/prepareSessionCreationTarget';
import { resolveTerminalRequestFromSpawnOptions } from '@/terminal/runtime/terminalConfig';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionCreationTargetPreparationRequestV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationTargetPreparationV1';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { ApprovalRequestV2Schema, type ApprovalRequestV2 } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { decideApprovalRequestTransition } from '@happier-dev/protocol/approvals/approvalRequestTransition';
import { createDiscussionActionDeps } from '@/discussions/discussionActionDeps';
import { createWorkflowCoordinator } from './coordinator';
import { buildWorkflowActionContext } from './daemonRuntime';
import type { WorkflowActionExecutor } from './coordinator';
import { createCoordinatorWorkspaceResolver, verifyWorkflowWorkspaceCurrentness } from './resolveWorkflowWorkspace';
import { deriveWorkflowSessionInputLocalIdV2 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { readSessionRolesV1, snapshotSessionRolesAtSpawnV1 } from '@happier-dev/protocol/prompts/roles/sessionRolesSnapshot';
import { createSessionActiveModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { resolveRolesSnapshotV1 } from '@happier-dev/protocol/prompts/roles/resolveRoleSelectionV1';
import { accountSettingsParse, encodePlainArtifactStoredContent, FeaturesResponseSchema } from '@happier-dev/protocol';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1 } from '@happier-dev/protocol/account/settings/sessionAgentSpawnPolicyV1';
import { resetServerFeaturesClientForTests } from '@/features/serverFeaturesClient';

const spawnedSessionBirthMetadata = new Map<string, ReturnType<typeof buildCommittedLaunchMetadata>>();

function installWorkflowRoleAccount(credentials: Readonly<{ token: string; encryption: null }>) {
  resetActiveAccountSettingsSnapshotForTests();
  setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network',
    settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: Date.now(),
    promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
}

function installWorkflowLaunchProfileAccount(
  credentials: Readonly<{ token: string; encryption: null }>,
  profile: ReturnType<typeof LaunchProfileV2Schema.parse>,
) {
  installWorkflowRoleAccount(credentials);
  const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, enabled: true, promptStack: [], secretBindings: {},
    definition: { kind: 'inline', profile } });
  const page = ProfileRowsListResponseV1Schema.parse({ status: 'listed', rows: [{ id: record.id, revision: 1,
    content: sealProfileRecordContentV1({ mode: 'plain', material: null, record }) }],
    nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 1, transferControl: { status: 'absent' } });
  const read = readiness.get.getMockImplementation()!;
  // Only the Home HTTP boundary is supplied; Profile opening and start admission stay real.
  readiness.get.mockImplementation(async (url: string) => {
    if (new URL(url).pathname === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, []) };
    if (url.endsWith(PROFILE_ROWS_ROUTE_V1)) return { status: 200, data: page };
    if (url.endsWith(PROFILE_REFERENCE_GUARD_ROUTE_V1)) return { status: 200, data: { status: 'ready', revision: 1 } };
    if (url.endsWith(PROFILE_TRANSFER_ROUTE_V1)) return { status: 200, data: { status: 'absent' } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
    return read(url);
  });
}

const readiness = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), request: vi.fn(), callMachineRpc: vi.fn() }));
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, get: readiness.get, post: readiness.post, request: readiness.request } };
});
vi.mock('@/session/transport/rpc/machineRpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/session/transport/rpc/machineRpc')>();
  return { ...actual, callMachineRpc: readiness.callMachineRpc, callExactMachineRpc: readiness.callMachineRpc };
});
vi.mock('socket.io-client', async () => {
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  return { io: () => createApiSessionSocketStub() };
});

import {
  WORKFLOW_CANCEL_REQUESTED_ABORT_REASON,
  WorkflowRuntimeInterruption,
  type WorkflowStepExecutor,
} from './coordinator';
import {
  createProductionFreshWorkflowSessionConversation as createUnadmittedFreshWorkflowSessionConversation,
  createProductionWorkflowConversationOwner,
  createProductionWorkflowSessionStepExecutor,
  createWorkflowSessionStepExecutor,
  renderWorkflowSessionStepInput,
  type WorkflowSessionStartup,
} from './sessionStepExecutor';
import { createAdmittedFreshWorkflowSessionConversation as createProductionFreshWorkflowSessionConversation } from './workflowSessionStartup.testkit';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

const sessionChanges = createSessionLiveWorkProducer({
  readSessions: () => [],
  readActivity: async () => ({ session: 'unknown', input: 'unknown' }),
});

it('reuses a frozen full workflow prompt without duplicating role or result instructions', () => {
  const frozen = 'Original role\n\nAuthored work\n\n<happier_forge_evidence v="1">external comment</happier_forge_evidence>\n\nOriginal result contract';
  expect(renderWorkflowSessionStepInput({ input: { text: 'Reconstructed literal projection', renderedText: frozen },
    roleInstructions: 'A later role projection', result: { kind: 'json', schema: { type: 'object' } } })).toBe(frozen);
});


vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      // Source runtime tests do not consume a remote host's ignored package-build failures.
      if (String(args[0]).replaceAll('\\', '/').endsWith('/.project/tmp/bundled-plugin-publication/failures.json')) return '[]';
      return fs.readFileSync(...args);
    },
  };
});

function installSessionCreationTransport(events?: string[], agentMissing = false, agentOutdated = false) {
  // Only filesystem readiness, Home HTTP and exact-machine process transport
  // are replaced. Target preparation, creator, nonce settlement and schemas run.
  vi.spyOn(fs, 'access').mockResolvedValue(undefined);
  vi.spyOn(fs, 'stat').mockResolvedValue(statSync(process.cwd()));
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'account-1' }), { status: 200 })));
  const launches: ReturnType<typeof SpawnDaemonSessionRequestSchema.parse>[] = [];
  let readySessionId = 'new-session';
  readiness.callMachineRpc.mockClear();
  readiness.callMachineRpc.mockImplementation(async ({ method, request }: Parameters<typeof import('@/session/transport/rpc/machineRpc').callMachineRpc>[0]) => {
    const organizationPlacement = { folderId: null, tagIds: [] };
    const agentIds = [...readCurrentContributionRegistry().agentDefinitionsById.keys()];
    if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
      events?.push('inventory');
      return { protocolVersion: 1, projection: { v: 2, generation: 1, familiesById: {},
        agentsById: Object.fromEntries(agentIds.map(id => [id, { id, title: id,
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true } } }])) } };
    }
    if (method === RPC_METHODS.CAPABILITIES_DETECT) {
      return { protocolVersion: 1, results: Object.fromEntries(agentIds.map(id => [`cli.${id}`, {
        ok: true, checkedAt: 1, data: { installed: !agentMissing, version: agentOutdated ? '1.2.3' : null, latestVersion: agentOutdated ? '1.2.4' : null,
          update: { supported: agentOutdated, command: null }, signIn: { status: 'signedIn', loginSupport: 'unsupported' },
          platform: { supported: true }, install: { available: false, mode: 'none', sizeBytes: null, guideUrl: null }, dependencies: [] },
      }])) };
    }
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START) {
      events?.push('install');
      return { ok: true, jobId: 'workflow-agent-install' };
    }
    if (method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ) {
      expect(request).toMatchObject({ jobId: 'workflow-agent-install', waitForTerminal: true });
      events?.push('terminal');
      return { ok: true, events: [], steps: [], progress: [], nextCursor: 0, done: true,
        outcome: { kind: 'succeeded', version: null } };
    }
    if (method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
      return prepareSessionCreationTarget({ request: SessionCreationTargetPreparationRequestV1Schema.parse(request) });
    }
    if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
      events?.push('spawn');
      if (request && typeof request === 'object' && 'type' in request && request.type === 'resume-session'
        && 'sessionId' in request && typeof request.sessionId === 'string') {
        readySessionId = request.sessionId;
        return { type: 'success', sessionId: readySessionId };
      }
      readySessionId = 'new-session';
      const spawnRequest = SpawnDaemonSessionRequestSchema.parse(request);
      launches.push(spawnRequest);
      spawnedSessionBirthMetadata.set(readySessionId, buildCommittedLaunchMetadata({ options: spawnRequest,
        directory: '/repo', accountSettings: {} }));
      return { type: 'success', sessionId: readySessionId, sessionCreationOutcome: { disposition: 'created', organizationPlacement } };
    }
    if (method === RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE_BY_NONCE) {
      return { status: 'success', sessionId: readySessionId, sessionCreationOutcome: { disposition: 'rejoined', organizationPlacement } };
    }
    throw new Error(`Unexpected Session creation transport: ${method}`);
  });
  const read = readiness.get.getMockImplementation()!;
  readiness.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/encryption')) return { status: 200,
      data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
    if (url.endsWith('/v1/machines/machine-1')) return { status: 200, data: { machine: {
      id: 'machine-1', revokedAt: null, replacedByMachineId: null, operationProtocolCapabilitiesRevision: 1,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1, 2] } },
    } } };
    return read(url);
  });
  return launches;
}


function observeSessionSpawnAdmissions() {
  const prepareCalls: string[] = [];
  const createHarness = cliActionExecutorHarness.createCliActionExecutorHarness;
  // Call-through instrumentation counts real admissions without replacing any decision.
  vi.spyOn(cliActionExecutorHarness, 'createCliActionExecutorHarness').mockImplementation((...args) => {
    const harness = createHarness(...args);
    const prepare = harness.executor.prepare;
    vi.spyOn(harness.executor, 'prepare').mockImplementation((...request) => {
      prepareCalls.push(request[0]);
      return prepare(...request);
    });
    return harness;
  });
  return prepareCalls;
}

describe('workflow Session step executor', () => {
  it.each([
    { name: 'refuses fresh Workflow birth when the receiving Machine isolation policy cannot be read',
      isolationPolicyV1: {}, allowed: false, sessionPlacement: undefined },
    { name: 'uses admitted Workflow policy rather than the interactive Session sandbox choice',
      isolationPolicyV1: {
        configuredSandboxes: { interactive: { provisioner: { pluginId: 'test.sandbox', localId: 'local' }, presetId: 'interactive-only' } },
        workKinds: { sessions: { kind: 'sandbox', configuredSandboxId: 'interactive', lifecycle: 'fresh' },
          botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } },
      }, allowed: true, sessionPlacement: undefined },
    { name: 'honors a saved configured sandbox instead of the Workflow policy Directly default',
      isolationPolicyV1: {
        configuredSandboxes: { development: { provisioner: { pluginId: 'test.sandbox', localId: 'local' }, presetId: 'development' } },
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } },
      }, sessionPlacement: {
        kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'machine-1' }, configuredSandbox: {
          kind: 'sandbox' as const, configuredSandboxId: 'development', lifecycle: 'fresh' as const,
          provisioner: { pluginId: 'test.sandbox', localId: 'local' }, presetId: 'development',
        },
      }, allowed: false },
    { name: 'honors a saved Machine on the admitted Workflow Run target with its Directly policy',
      isolationPolicyV1: { configuredSandboxes: {},
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } },
      sessionPlacement: { kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'machine-1' } },
      allowed: true },
    { name: 'refuses a saved Machine outside the admitted Workflow Run target',
      isolationPolicyV1: { configuredSandboxes: {},
        workKinds: { sessions: { kind: 'directly' }, botsChannels: { kind: 'directly' }, automationsWorkflows: { kind: 'directly' } } },
      sessionPlacement: { kind: 'machine' as const, target: { serverId: 'server-1', machineId: 'other-machine' } },
      allowed: false },
  ])('$name', async ({ isolationPolicyV1, allowed, sessionPlacement }) => {
    const launches = installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null };
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId });
    const startup: WorkflowSessionStartup = input => runUnadmittedObservedWorkflowSessionStartup(input, {
      serverId: 'server-1', machineId: scope.machineId, observeExecution: operations.observeExecution, rpcContext: {},
      readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1,
        metadata: { isolationPolicyV1 } }),
      transport: () => ({ spawn: (request, options) => readiness.callMachineRpc({
        method: RPC_METHODS.SPAWN_HAPPY_SESSION, request, ...options }),
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1',
      machineId: scope.machineId, workDepth: 0, originRunId: 'isolated-workflow',
      ...(sessionPlacement ? { sessionPlacement } : {}),
      machineAdmissionTransport: vi.fn(), sessionStartup: startup });
    const created = create({ creationKey: 'workflow:isolation-unreadable',
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} } },
      workspace: { machineId: scope.machineId, directory: '/repo', checkoutRootPath: '/repo' },
    });
    if (allowed) {
      await expect(created).resolves.toMatchObject({ sessionId: 'new-session' });
      expect(launches).toHaveLength(1);
      expect(launches[0]?.managedTargetPlacement).toBeUndefined();
    } else {
      await expect(created).rejects.toMatchObject({ code: 'target_unavailable' });
      expect(launches).toEqual([]);
    }
  });

  it('admits Workflow birth once and observes retained startup without another admission', async () => {
    const launches = installSessionCreationTransport();
    const prepareCalls = observeSessionSpawnAdmissions();
    const credentials = { token: 'token', encryption: null };
    const machineId = 'machine-1';
    const scope = { accountId: 'account-1', machineId };
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => scope.accountId });
    const host = { serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {} };
    const startup: WorkflowSessionStartup = input => runUnadmittedObservedWorkflowSessionStartup(input, {
      ...host,
      readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
      transport: () => ({ spawn: (request, options) => readiness.callMachineRpc({ method: RPC_METHODS.SPAWN_HAPPY_SESSION, request, ...options }),
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId,
      workDepth: 0, originRunId: 'counted-birth', machineAdmissionTransport: vi.fn(), sessionStartup: startup });
    const input = { creationKey: 'workflow:counted-birth',
      selection: { agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: null }, workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } };
    await expect(create(input)).resolves.toMatchObject({ sessionId: 'new-session' });
    const [operation] = operations.store.list(scope).items;
    expect(operation).toBeDefined();
    await expect(create({ ...input, retainedStartupOperation: { key: 'startup', serverId: 'server-1', machineId,
      operationId: operation!.operationId } })).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(prepareCalls.filter(id => id === 'session.spawn_new')).toHaveLength(1);
    expect(launches).toHaveLength(1);
  });

  it.each(['creator', 'observer'] as const)('refuses fresh Workflow birth without Action context at the %s entry', async entry => {
    const launches = installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null };
    const machineId = 'machine-1';
    const scope = { accountId: 'account-1', machineId };
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => scope.accountId });
    const request = { credentials, machineId, directory: '/repo',
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } };
    const startup: WorkflowSessionStartup = input => runUnadmittedObservedWorkflowSessionStartup(input, {
      serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
      transport: () => ({ spawn: (request, options) => readiness.callMachineRpc({ method: RPC_METHODS.SPAWN_HAPPY_SESSION, request, ...options }),
        resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    const birth = entry === 'observer' ? startup({ creationKey: 'workflow:missing-context', request })
      : createUnadmittedFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId,
          workDepth: 0, originRunId: 'missing-context', machineAdmissionTransport: vi.fn() })({
          creationKey: 'workflow:missing-context', selection: { agentTarget: request.agentTarget, connectedServices: null },
          workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } });
    await expect(birth).rejects.toMatchObject({ code: 'approval_context_unavailable' });
    expect(launches).toHaveLength(0);
  });

  it('refuses reuse when a workflow requests skills that the retained Session did not launch with', async () => {
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo', runtimeSelection: {} }),
    });
    const execution = WorkflowSessionAuthoringSelectionSchema.parse({ capabilitySelection: {
      skills: { v: 1, forceIncludeSkillIds: ['lint'], forceExcludeSkillIds: [], excludeNativeSkillNames: [] },
    } });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution } as never))
      .rejects.toMatchObject({ code: 'workflow_conversation_unavailable', details: { reason: 'capabilitySelection' } });
  });
  it.each(['allowedTools', 'unlistedTools', 'approvalProfileId'] as const)('rejects a conflicting %s recipe for an explicit retained Session', async (field) => {
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: { allowedTools: ['mcp__wilson-brief__*'], unlistedTools: 'deny', approvalProfileId: 'profile:old' } }),
    });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {
      conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' },
      [field]: field === 'allowedTools' ? ['Read'] : field === 'approvalProfileId' ? 'profile:new' : 'ask',
    } } as never)).rejects.toMatchObject({ code: 'workflow_conversation_unavailable', details: { reason: field } });
  });

  it.each(['profile:same', null] as const)('reuses a Session with the same approval reference %s without changing it', async approvalProfileId => {
    const retained = { sessionId: 'retained', machineId: 'machine-1', directory: '/repo',
      runtimeSelection: approvalProfileId === null ? {} : { approvalProfileId } };
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => retained,
    });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {
      conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' }, approvalProfileId,
    } } as never)).resolves.toMatchObject({ kind: 'workflow_session_conversation', existing: retained });
  });

  const reuseSelection = WorkflowSessionAuthoringSelectionSchema.parse({
    agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
    profileId: 'reviewer', acpSessionModeId: 'plan',
    sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: { reasoning: { value: 'PRIVATE_CONFIG', updatedAt: 1 } } },
    capabilitySelection: { mcp: { v: 1, managedServersEnabled: false, forceIncludeServerIds: ['mcp-1'], forceExcludeServerIds: [] } },
    connectedServices: { v: 2, bindingsByServiceId: {} }, transcriptStorage: 'direct',
    terminal: { mode: 'tmux', tmux: { sessionName: 'PRIVATE_TITLE', isolated: true } },
    windowsRemoteSessionLaunchMode: 'windows_terminal', windowsRemoteSessionConsole: 'hidden',
    windowsTerminalWindowName: 'PRIVATE_TITLE', runtimeDescriptorV1: null,
  });
  it.each(Object.keys(reuseSelection))('identifies the rejected reuse field %s without disclosing configuration', async (field) => {
    // File logging is an OS boundary; keep the refusal and serialization real.
    const log = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo', runtimeSelection: {} }),
    });
    const execution = WorkflowSessionAuthoringSelectionSchema.parse({ [field]: reuseSelection[field as keyof typeof reuseSelection] });
    const preparation = conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution } as never);
    await expect(preparation)
      .rejects.toMatchObject({ code: 'workflow_conversation_unavailable', details: {
        reason: field, expected: expect.objectContaining({ kind: expect.any(String) }), observed: { kind: 'unset' },
      } });
    try { await preparation; }
    catch (error) { expect(JSON.stringify(error)).not.toMatch(/PRIVATE_CONFIG|PRIVATE_TITLE/); }
    expect(log.mock.calls).toHaveLength(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ event: 'workflow_conversation_refused', reason: field });
    expect(log.mock.calls[0]![0]).not.toMatch(/PRIVATE_CONFIG|PRIVATE_TITLE/);
  });
  it.each([
    ['recovery_execution_missing', { invocation: { logicalInvocationRecordId: 'inv-1', recovery: { conversation: 'same_conversation' } } }],
    ['target_kind_mismatch', { invocation: { logicalInvocationRecordId: 'inv-1', recovery: { conversation: 'same_conversation' } },
      recoveryPreviousExecution: { kind: 'detached_run', runId: 'detached', localInputId: 'input' } }],
    ['session_unavailable', { execution: { conversation: { kind: 'existing_session', sessionId: 'missing', machineId: 'machine-1' } } }],
    ['producer_conversation_missing', { execution: { conversation: { kind: 'from_step', producer: { blockId: 'previous', scope: { kind: 'current' } } } } }],
    ['origin_session_missing', { execution: { conversation: { kind: 'origin_session' } } }],
  ])('identifies resolver refusal %s', async (reason, overrides) => {
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => null,
    });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {},
      onOriginInputOffered: async () => {}, ...overrides } as never)).rejects.toMatchObject({
      code: 'workflow_conversation_unavailable', details: { reason },
    });
  });
  it('keeps incoming model and permission choices outside the reuse refusal checks', async () => {
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: { modelSelection: null, permissionMode: 'read_only' } }),
    });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {
      permissionMode: 'default', modelSelection: { v: 1, updatedAt: 1,
        ref: { agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'another-model' } },
    } } as never)).resolves.toMatchObject({ existing: { sessionId: 'retained' } });
  });
  it('identifies absent retained delegation depth after the reuse resolver succeeds', async () => {
    const retained = { sessionId: 'retained', machineId: 'machine-1', directory: '/repo', origin: { kind: 'run_step' as const, runId: 'run-1' } };
    const execute = createProductionWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(), createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => retained, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => retained,
      sessionInput: { enqueue: async () => { throw new Error('must not admit'); }, observe: async () => { throw new Error('must not observe'); } },
    });
    await expect(execute({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      step: { result: { kind: 'text' } }, execution: {}, authorization: { admittedPermissionCeiling: 'default' },
      workspace: { machineId: 'machine-1', directory: '/repo' },
    } as never)).resolves.toMatchObject({ kind: 'failed', code: 'workflow_conversation_unavailable',
      reasonDetails: { reason: 'work_depth_unavailable', expected: { kind: 'number' }, observed: { kind: 'unset' } } });
  });
  it.each([
    { reason: 'origin_session_missing', code: 'workflow_conversation_unavailable', existing: null },
    { reason: 'session_identity_mismatch', code: 'workflow_conversation_unavailable', existing: { sessionId: 'other', machineId: 'machine-1', directory: '/repo' } },
    { reason: 'machine_mismatch', code: 'conversation_workspace_mismatch', existing: { sessionId: 'origin', machineId: 'other-machine', directory: '/repo' } },
    { reason: 'workspace_mismatch', code: 'conversation_workspace_mismatch', existing: { sessionId: 'origin', machineId: 'machine-1', directory: '/other' } },
  ])('identifies a prepared origin refusal $reason', async ({ reason, code, existing }) => {
    const execute = createProductionWorkflowSessionStepExecutor({ credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(), createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null, resolveExistingSessionConversation: async () => null,
      sessionInput: { enqueue: async () => { throw new Error('must not admit'); }, observe: async () => { throw new Error('must not observe'); } },
    });
    await expect(execute({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, originSessionId: 'origin',
      preparedStep: { kind: 'workflow_session_conversation', existing, inputPath: 'origin_session' },
      step: { result: { kind: 'text' } }, execution: { conversation: { kind: 'origin_session' } }, authorization: { admittedPermissionCeiling: 'default' },
      workspace: { machineId: 'machine-1', directory: '/repo' }, onOriginInputOffered: async () => {},
    } as never)).resolves.toMatchObject({ kind: 'failed', code, reasonDetails: { reason } });
  });
  it('names configuration mismatch when the requested option exists but its value differs', async () => {
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo',
        runtimeSelection: { sessionConfigOptionOverrides: { v: 1, updatedAt: 1,
          overrides: { reasoning: { value: 'OTHER_PRIVATE_VALUE', updatedAt: 1 } } } } }),
    });
    const prepared = conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { sessionConfigOptionOverrides: reuseSelection.sessionConfigOptionOverrides } } as never);
    await expect(prepared).rejects.toMatchObject({ details: { reason: 'sessionConfigOptionOverrides',
      expected: { kind: 'object', ids: ['reasoning'] }, observed: { kind: 'object', ids: ['reasoning'] } } });
    try { await prepared; } catch (error) { expect(JSON.stringify(error)).not.toContain('PRIVATE_VALUE'); }
  });
  it.each([
    ['session_identity_mismatch', 'machine-1', 'other-session', true],
    ['session_unavailable', 'machine-1', 'retained', false],
  ])('identifies reused identity check %s', async (reason, machineId, sessionId, origin) => {
    const retained = { sessionId, machineId, directory: '/repo' };
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('must not create'); },
      resolveSharedRunConversation: async () => retained, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => reason === 'session_unavailable' ? null : retained,
    });
    await expect(conversations.prepare({ runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: origin ? { conversation: { kind: 'origin_session' } } : {},
      originSessionId: origin ? 'expected-origin' : undefined, onOriginInputOffered: async () => {},
    } as never)).rejects.toMatchObject({ code: 'workflow_conversation_unavailable', details: { reason } });
  });
  it.each([
    ['workspace_mismatch', 'conversation_workspace_mismatch', { sessionId: 'retained', machineId: 'machine-1', directory: '/other' }, false],
    ['account_scope_unavailable', 'workflow_conversation_unavailable', { sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }, true],
    ['machine_mismatch', 'workflow_conversation_unavailable', null, false],
    ['workspace_mismatch', 'workflow_conversation_unavailable', null, false],
  ])('identifies materialization refusal %s (%s)', async (reason, code, existing, inputless) => {
    const conversations = createProductionWorkflowConversationOwner({ machineId: 'machine-1',
      createFreshConversation: async () => ({ sessionId: 'fresh',
        machineId: reason === 'machine_mismatch' ? 'other-machine' : 'machine-1', directory: '/other' }),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => null,
    });
    await expect(conversations.materialize({ kind: 'workflow_session_conversation', existing }, {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, step: { inputMode: inputless ? 'none' : 'prompt' },
      execution: { agentTarget: reuseSelection.agentTarget }, workspace: { machineId: 'machine-1', directory: '/repo' },
    } as never)).rejects.toMatchObject({ code, details: { reason } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetActiveAccountSettingsSnapshotForTests(); });
  beforeEach(() => {
    resetServerFeaturesClientForTests();
    spawnedSessionBirthMetadata.clear();
    // HTTP and machine process launch are the external readiness boundaries;
    // authorization, resume normalization and conversation ownership stay real.
    let readySessionId = '';
    readiness.request.mockImplementation(async ({ url }: { url: string }) => {
      if (url.endsWith('/v1/home/governance/get')) return { status: 200,
        data: HomeSessionDefaultsProjectionV1Schema.parse({ homeDefaults: null }) };
      throw new Error(`Unexpected Home Action HTTP request: ${url}`);
    });
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200,
        data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: { v: 1, bindings: [] } } },
      } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
      } };
      const id = /\/v2\/sessions\/([^/?]+)/.exec(url)?.[1];
      if (!id) throw new Error(`Unexpected readiness read: ${url}`);
      return { status: 200, data: { session: createSessionRecordFixture({ id, active: true,
        encryptionMode: 'plain', machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1',
          path: id === 'existing-session' ? '/repo/subdir' : '/repo', claudeSessionId: 'native-session',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
          ...spawnedSessionBirthMetadata.get(id),
        }) }) } };
    });
    readiness.callMachineRpc.mockImplementation(async ({ method, request }: { method: string; request: { sessionId?: string } }) => {
      if (method === RPC_METHODS.SPAWN_HAPPY_SESSION) {
        readySessionId = request.sessionId!;
        return { type: 'success', sessionId: readySessionId };
      }
      return { status: 'success', sessionId: readySessionId };
    });
    readiness.post.mockImplementation(async (url: string, body: { tags: string[] }) => {
      if (!url.endsWith('/v2/sessions/lookup-by-tags')) throw new Error(`Unexpected readiness write: ${url}`);
      if (body.tags[0]?.startsWith('create:v1:')) {
        const sessions = [];
        for (const [id, metadata] of spawnedSessionBirthMetadata) {
          const correspondence = SessionCreationCorrespondenceV1Schema.safeParse(metadata.sessionCreationCorrespondenceV1);
          if (correspondence.success && body.tags.includes(correspondence.data.sessionCreationTag)) {
            sessions.push((await readiness.get(`/v2/sessions/${id}`)).data.session);
          }
        }
        return { status: 200, data: { sessions } };
      }
      const response = await readiness.get(`/v2/sessions/${body.tags[0]}`);
      return { status: 200, data: { sessions: [response.data.session] } };
    });
  });
  it.each([
    { code: 'outside_root', source: 'unknown', failureReason: 'permission_denied' },
    { code: 'agent_startup_rpc_rejected', source: 'usage_limit', failureReason: 'usage_limit' },
    { code: 'no_eligible_member', source: 'unknown', failureReason: 'unknown' },
  ] as const)('retains the typed $code startup cause through the real Workflow step', async ({ code, source, failureReason }) => {
    installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null } as const;
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => 'typed-startup' });
    const failureCause = { phase: 'client_start' as const, code, failureReason, retryable: true,
      providerErrorMessage: 'PRIVATE_NATIVE_PROSE https://private.example/path' };
    const startup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup(input, {
      serverId: 'server-1', machineId: scope.machineId, observeExecution: operations.observeExecution, rpcContext: {},
      // Native launch and Home HTTP are boundaries; Action admission, startup,
      // original-operation observation and step settlement are production code.
      transport: () => ({ spawn: async () => ({ type: 'error', errorCode: 'SPAWN_FAILED',
        errorMessage: 'PRIVATE_NATIVE_PROSE https://private.example/path',
        errorDetail: { kind: 'launch_error', code, message: 'PRIVATE_NATIVE_PROSE https://private.example/path', failureCause } }),
        resolveSpawnSessionByNonce: async () => { throw new Error('A definite refusal must not relaunch'); } }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
        ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    const machineAdmissionTransport = async () => { throw new Error('Refused startup cannot enqueue input'); };
    const execute = createProductionWorkflowSessionStepExecutor({ credentials, machineId: scope.machineId,
      machineAdmissionTransport, createFreshConversation: createProductionFreshWorkflowSessionConversation({
        credentials, serverId: 'server-1', machineId: scope.machineId, workDepth: 0, originRunId: 'typed-run',
        machineAdmissionTransport, sessionStartup: startup,
      }), resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => null });
    const result = await execute({ runId: 'typed-run', invocationRecordId: 'typed-invocation',
      step: { kind: 'step', id: 'create', inputMode: 'none', document: { text: '', references: [], attachments: [] },
        input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'create', scope: [] }, attempt: '0', logicalInvocationRecordId: 'typed-invocation' },
      input: { text: '', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' }, agentTarget: {
        kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: scope.machineId, directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => { throw new Error('No accepted input'); },
      onSessionReady: async () => { throw new Error('No ready Session'); },
    });
    expect(result).toMatchObject({ kind: source === 'usage_limit' ? 'needs_attention' : 'failed', code,
      runtimeIssueV1: { source, code, failureCause: { phase: 'client_start', code, failureReason, retryable: true } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_NATIVE_PROSE|private\.example/);
    expect(operations.store.get(scope, 'typed-startup')).toMatchObject({ state: 'failed',
      error: { errorCode: 'spawn_failed', error: 'spawn_failed' },
      result: { type: 'error', code: 'spawn_failed', retryable: true, launchError: { kind: 'launch_error', code, failureCause } } });
  });

  it('retains the absent Agent catalog cause in the settled Workflow invocation', async () => {
    const launches = installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null } as const;
    const machineAdmissionTransport = async () => { throw new Error('Absent Agent cannot enqueue input'); };
    const executeStep = createProductionWorkflowSessionStepExecutor({ credentials, machineId: 'machine-1',
      machineAdmissionTransport, createFreshConversation: createProductionFreshWorkflowSessionConversation({
        credentials, serverId: 'server-1', machineId: 'machine-1', workDepth: 0, originRunId: 'catalog-refusal',
        machineAdmissionTransport,
      }), resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => null });
    const store = createInMemoryWorkflowCoordinatorStore();
    const coordinator = createTestWorkflowCoordinator({ store, executeStep,
      resolveWorkspace: async () => ({ ok: true, workspace: {
        machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } }),
    });
    await coordinator.run({ runId: 'catalog-refusal', inputs: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      definition: { version: 1, inputs: [], defaults: { agentTarget: { kind: 'agent',
        identity: { pluginId: 'missing.agent', localId: 'absent' } } }, blocks: [{ kind: 'step', id: 'create',
        execution: { conversation: { kind: 'fresh' } }, inputMode: 'none',
        document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' } }] },
    });
    expect(store.list().find(row => row.blockId === 'create')).toMatchObject({
      lifecycle: 'failed', reason: 'target_unavailable', failureCause: {
        phase: 'session.agent_target', errorClass: 'Error', errorCode: 'agent_contribution_unavailable', httpStatus: null,
      },
    });
    expect(launches).toEqual([]);
  });

  it('retains the absent Agent catalog cause through original startup and cold rejoin', async () => {
    const launches = installSessionCreationTransport();
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId,
      resolveAccountId: async () => scope.accountId, generateOperationId: () => 'catalog-startup' });
    const host = { serverId: 'server-1', machineId: scope.machineId,
      observeExecution: operations.observeExecution, rpcContext: {},
      transport: () => ({ spawn: async () => { throw new Error('Absent Agent must not launch'); },
        resolveSpawnSessionByNonce: async () => { throw new Error('Definite refusal must not relaunch'); } }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    } satisfies Parameters<typeof runObservedWorkflowSessionStartup>[1];
    const input = { creationKey: 'workflow:catalog-startup', request: {
      credentials: { token: 'token', encryption: null }, directory: '/repo', machineId: scope.machineId,
      agentTarget: { kind: 'agent', identity: { pluginId: 'missing.agent', localId: 'absent' } },
    } } satisfies Parameters<WorkflowSessionStartup>[0];
    const expected = { code: 'target_unavailable', failureCause: {
      phase: 'session.agent_target', errorClass: 'Error', errorCode: 'agent_contribution_unavailable', httpStatus: null,
    }, runtimeIssueV1: undefined };
    await expect(runObservedWorkflowSessionStartup(input, host)).rejects.toMatchObject(expected);
    const original = operations.store.get(scope, 'catalog-startup');
    expect(original).toMatchObject({ state: 'failed', result: { type: 'error', code: expected.code,
      retryable: false, failureCause: expected.failureCause } });
    await expect(runObservedWorkflowSessionStartup({ ...input,
      retainedOperation: { key: 'startup', serverId: host.serverId, machineId: scope.machineId, operationId: 'catalog-startup' },
      retainedOperationSnapshot: original,
    }, { ...host, observeExecution: async () => { throw new Error('Cold refusal cannot admit another operation'); } }))
      .rejects.toMatchObject(expected);
    expect(launches).toEqual([]);
  });

  it('records inputless Session creation and rejoins it without fabricating an input', async () => {
    const launches = installSessionCreationTransport();
    const createdFacts: unknown[] = [];
    const credentials = { token: 'token', encryption: null };
    const machineAdmissionTransport = async () => { throw new Error('Inputless creation cannot enqueue'); };
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials, machineId: 'machine-1', machineAdmissionTransport,
      createFreshConversation: createProductionFreshWorkflowSessionConversation({
        credentials, serverId: 'server-1', machineId: 'machine-1', workDepth: 0,
        originRunId: 'run-inputless', machineAdmissionTransport,
      }),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo' }),
    });
    const base = {
      runId: 'run-inputless', invocationRecordId: 'inv-inputless',
      step: { kind: 'step' as const, id: 'create', inputMode: 'none' as const,
        document: { text: '', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
      invocation: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const,
        invocationPath: { blockId: 'create', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: '', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' as const },
        agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2 as const, bindingsByServiceId: {} } },
      executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {},
      onInputAccepted: async () => { throw new Error('No input was accepted'); },
      onSessionReady: async (value: unknown) => { createdFacts.push(value); },
    };
    await expect(execute(base)).resolves.toEqual({ kind: 'completed', result: '' });
    expect(createdFacts).toEqual([{ kind: 'session_ready', sessionId: 'new-session' }]);
    await expect(execute({ ...base, invocation: { ...base.invocation,
      execution: { kind: 'session_ready', sessionId: 'new-session' } } })).resolves.toEqual({ kind: 'completed', result: '' });
    expect(launches).toHaveLength(1);
  });

  it.each([{ selected: false, miswired: false }, { selected: true, miswired: false }, { selected: false, miswired: true }])('snapshots the complete lead Role set through Workflow leaf birth (selected=%s)', async ({ selected, miswired }) => {
    const launches = installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null };
    const roles = resolveRolesSnapshotV1({ defaultEngine: { agentTargetKey: 'agent:happier.agent.claude/claude' } });
    for (let index = 0; index < 5; index++) {
      const roleId = `plugin:external.roles/role-${index}`;
      roles[roleId] = { ...roles.builder!, roleId, instructions: `External Role ${index}`, workspaceWrites: 'deny' };
    }
    const leadRoles = { ...snapshotSessionRolesAtSpawnV1({ leadSessionId: 'prior-lead', roles, notes: 'Lead notes' }),
      overrides: { builder: { roleId: 'builder', instructionsOverride: 'Session-specific builder' } } };
    let roleCatalogReads = 0;
    const read = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/sessions/workflow-lead')) return { status: 200, data: { session: createSessionRecordFixture({
        id: 'workflow-lead', encryptionMode: 'plain', machineId: 'machine-1', workDepth: 0,
        metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo', flavor: 'claude',
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} }, work: { sessionRolesV1: leadRoles } }),
      }) } };
      if (url.includes('/v1/artifacts')) {
        roleCatalogReads++;
        expect(new URL(url).searchParams.get('kinds')).toBe(JSON.stringify(['role.v1']));
        const data = artifactKindListResponse([]);
        return { status: 200, data: miswired ? { items: data.items, hasUnclassified: data.hasUnclassified } : data };
      }
      return read(url);
    });
    installWorkflowRoleAccount(credentials);
    const machineAdmissionTransport = async () => { throw new Error('Inputless leaf must not enqueue'); };
    const execute = createProductionWorkflowSessionStepExecutor({ credentials, machineId: 'machine-1', machineAdmissionTransport,
      createFreshConversation: createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1',
        machineId: 'machine-1', workDepth: 1, originRunId: 'workflow-run', originSessionId: 'workflow-lead', machineAdmissionTransport }),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo' }),
      resolveFrozenRole: params => params.role,
    });
    try {
      const executing = execute({ runId: 'workflow-run', invocationRecordId: 'leaf-invocation',
        step: { kind: 'step', id: 'leaf', inputMode: 'none', document: { text: '', references: [], attachments: [] },
          input: [], result: { kind: 'text' } },
        invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'leaf', scope: [] },
          attempt: '0', logicalInvocationRecordId: 'logical-leaf' },
        input: { text: '', references: [], attachments: [], values: [] },
        execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent',
          identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: { v: 2, bindingsByServiceId: {} } },
        ...(selected ? { role: { ...roles.builder!, instructions: 'Frozen Workflow pin', workspaceWrites: 'deny' } } : {}),
        executionTarget: { kind: 'session' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
        workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
        beforeInputAdmission: async () => {}, onInputAccepted: async () => { throw new Error('No input'); },
        onSessionReady: async () => {},
      });
      if (miswired) {
        await expect(executing).rejects.toMatchObject({ code: 'artifact_content_unavailable' });
        expect(launches).toEqual([]);
        return;
      }
      await expect(executing).resolves.toEqual({ kind: 'completed', result: '' });
      expect(launches).toHaveLength(1);
      const snapshot = readSessionRolesV1(spawnedSessionBirthMetadata.get('new-session'));
      expect(snapshot?.inheritedFrom).toBe('workflow-lead');
      expect(Object.keys(snapshot?.sessionRoles ?? {}).sort()).toEqual(Object.keys(roles).sort());
      expect(snapshot?.notes).toBe('Lead notes');
      expect(snapshot?.sessionRoles.builder).toMatchObject({ instructions: selected ? 'Frozen Workflow pin' : 'Session-specific builder' });
      expect(snapshot?.roleId).toBe(selected ? 'builder' : undefined);
      expect(roleCatalogReads).toBe(1);
      for (let index = 0; index < 5; index++) expect(snapshot?.sessionRoles[`plugin:external.roles/role-${index}`]).toMatchObject(roles[`plugin:external.roles/role-${index}`]!);
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });

  it.each([
    { name: 'unreviewable detach', approvalProfileId: null, review: 'unavailable' },
    { name: 'unreviewable change', approvalProfileId: 'builtin:full-trust', review: 'unavailable' },
    { name: 'reviewed detach', approvalProfileId: null, review: 'approve' },
    { name: 'reviewed change', approvalProfileId: 'builtin:full-trust', review: 'approve' },
    { name: 'reviewed parent covers Agent install before Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'approve', readiness: 'install' },
    { name: 'same selection', approvalProfileId: 'builtin:full-trust', review: 'none' },
    { name: 'omitted selection', approvalProfileId: undefined, review: 'none' },
    { name: 'direct human selection', approvalProfileId: 'builtin:full-trust', review: 'none', human: true },
    { name: 'current Agent before Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'none', human: true, readiness: true },
    { name: 'reviewed Agent install before Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'approve', human: true, readiness: 'install' },
    { name: 'swapped Agent install operand', approvalProfileId: 'builtin:full-trust', review: 'approve', human: true, readiness: 'install', tamper: 'operand' },
    { name: 'swapped Agent install origin request', approvalProfileId: 'builtin:full-trust', review: 'approve', human: true, readiness: 'install', tamper: 'origin' },
    { name: 'refused Agent install before Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'approve', human: true, readiness: 'refused' },
    { name: 'skipped optional Agent update does not hold Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'none', human: true, readiness: 'update' },
    { name: 'skipped optional update status review does not hold Workflow birth', approvalProfileId: 'builtin:full-trust', review: 'none', human: true, readiness: 'update-status' },
  ] as const)('admits native Workflow Session profile selection: $name', async testCase => {
    const { approvalProfileId, review } = testCase;
    const readinessEvents: string[] = [];
    const launches = installSessionCreationTransport(readinessEvents, 'readiness' in testCase
      && (testCase.readiness === 'install' || testCase.readiness === 'refused'),
      'readiness' in testCase && (testCase.readiness === 'update' || testCase.readiness === 'update-status'));
    if ('readiness' in testCase && testCase.readiness === 'refused') {
      const originalRpc = readiness.callMachineRpc.getMockImplementation()!;
      readiness.callMachineRpc.mockImplementation(async request => request.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ
        ? DaemonAgentInstallReadResponseSchema.parse({ ok: true, events: [], steps: [], progress: [], nextCursor: 0, done: true,
            outcome: { kind: 'failed', code: 'install_failed', stepId: 'verify', message: 'Native installation failed' } })
        : originalRpc(request));
    }
    const artifacts = new Map<string, { id: string } & Record<string, unknown>>();
    let publish!: (artifactId: string) => void;
    const published = new Promise<string>(resolve => { publish = resolve; });
    const originalRead = readiness.get.getMockImplementation()!;
    const originalWrite = readiness.post.getMockImplementation()!;
    // Home's real versioned Artifact transport is the review boundary. The
    // production startup factory owns routing, storage codecs and live waiting.
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200,
        data: AccountEncryptionModeResponseSchema.parse({ mode: 'plain', updatedAt: 1 }) };
      if (url.includes('/v1/artifacts/')) {
        const id = url.split('/').at(-1)!;
        return { status: artifacts.has(id) ? 200 : 404, data: artifacts.get(id) };
      }
      return originalRead(url);
    });
    readiness.post.mockImplementation(async (url: string, body: Record<string, unknown>) => {
      if (url.endsWith('/v1/artifacts/read')) return artifactReadResponse(body, id => artifacts.get(id) ?? null);
      if (url.endsWith('/v1/artifacts')) {
        const id = String(body.id);
        artifacts.set(id, { ...body, id, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
          headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
        publish(id);
        return { status: 200, data: { id, headerVersion: 1, bodyVersion: 1 } };
      }
      if (url.includes('/v1/artifacts/')) {
        const id = url.split('/').at(-1)!;
        const current = artifacts.get(id);
        if (!current) return { status: 404, data: { error: 'artifact_not_found' } };
        if (body.expectedHeaderVersion !== current.headerVersion || body.expectedBodyVersion !== current.bodyVersion) {
          return { status: 200, data: { success: false, error: 'version-mismatch' } };
        }
        const headerVersion = Number(current.headerVersion) + (body.header === undefined ? 0 : 1);
        const bodyVersion = Number(current.bodyVersion) + (body.body === undefined ? 0 : 1);
        artifacts.set(id, { ...current, ...(body.header === undefined ? {} : { header: body.header }),
          ...(body.body === undefined ? {} : { body: body.body }), headerVersion, bodyVersion });
        return { status: 200, data: { success: true, headerVersion, bodyVersion } };
      }
      return originalWrite(url, body);
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: {
      serverIdentity: { serverIdentityId: 'server-1' },
      encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
    } });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(
      String(url).includes('/features') ? features : { id: 'account-1' }), { status: 200 })));
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    const settings = accountSettingsParse({ actionsSettingsV1: { v: 1,
      actions: 'readiness' in testCase && testCase.readiness === 'update-status'
        ? { 'machines.agents.install.status': { approvalRequiredSurfaces: ['agent'] } }
        : { 'machines.agents.install': { approvalRequiredSurfaces: ['agent'] } },
      approvalWaivedSurfaces: { 'session.spawn_new': ['agent'],
        ...('readiness' in testCase && testCase.readiness === 'update-status'
          ? { 'machines.agents.install': ['agent'] } : {}) } } });
    setActiveAccountSettingsSnapshot({ scopeKey: resolveAccountSettingsScopeKey(credentials), source: 'network', settings,
      rawSettings: {}, settingsVersion: 1, settingsSecretsReadKeys: [], loadedAtMs: Date.now(),
      promptLibraryCatalog: { status: 'ready', rows: [], tombstones: [], diagnostics: [] } });
    const machineId = 'machine-1';
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => 'account-1' });
    const { executor, deps: actionDeps } = createCliActionExecutorHarness({ credentials, token: credentials.token, sessionId: 'origin-session',
      serverId: 'server-1', serverIdentityId: 'server-1', serverHttpBaseUrl: resolveServerHttpBaseUrl(), mode: 'plain', ctx: null });
    const action: WorkflowActionExecutor = { executor, buildContext: async execution => ({ ...buildWorkflowActionContext(execution),
      ...(review === 'unavailable' ? { interactivePresentation: 'unavailable' as const } : {}),
      sessionAgentSpawnPolicyV1: DEFAULT_SESSION_AGENT_SPAWN_POLICY_V1,
      agentStartContext: { caller: { kind: 'originless', runId: execution.runId, runDepth: 0 },
        baseline: { machineId, directory: '/repo' }, roles: {}, ledSubtreeSessionIds: [],
        callerPermissionCeiling: 'default', workDepthLimit: 4 },
    }), observeRun: async () => { throw new Error('Session creation must not start an Execution Run'); } };
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId,
      workDepth: 0, originRunId: 'run-profile', machineAdmissionTransport: vi.fn(), action,
      sessionStartup: input => runObservedWorkflowSessionStartup(input, {
        serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
        transport: () => ({ spawn: (request, options) => readiness.callMachineRpc({ method: RPC_METHODS.SPAWN_HAPPY_SESSION, request, ...options }),
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) }),
        observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
          ...(options.waitForTerminal ? { waitForTerminal: true } : {}), ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }),
        cancelOperation: async target => operations.runner.cancel({ accountId: 'account-1', machineId }, target.operationId),
        cleanupOnFailure: async () => {},
      }) });
    const pending = create({ creationKey: `workflow:profile:${testCase.name}`,
      startupAuthorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' },
      origin: { kind: 'direct', actionPolicy: { surface: 'agent', authority: 'account_automation',
        approvalProfileId: review === 'none' && !('human' in testCase) ? 'builtin:full-trust' : 'builtin:apply-safe' },
        ...('human' in testCase ? { authenticatedStarterV1: { requestRef: 'person-request',
          requester: { serverId: 'server-1', accountId: 'account-1' } } } : {}),
        actionRequestAttributionV1: { requestRef: 'person-request', requester: { serverId: 'server-1', accountId: 'account-1' },
          persona: { serverId: 'server-1', sessionId: 'origin-session' }, origin: null } },
      selection: { ...(approvalProfileId === undefined ? {} : { approvalProfileId }), connectedServices: null,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' },
    });
    if (review === 'unavailable') {
      await expect(pending).rejects.toMatchObject({ code: 'action_interactive_review_required' });
      expect(launches).toHaveLength(0);
      return;
    }
    if (review === 'approve') {
      const first = await Promise.race([published, pending]);
      expect(first, JSON.stringify(first)).toEqual(expect.any(String));
      if (typeof first !== 'string') throw new Error('Startup escaped review');
      const request = await actionDeps.approvalsGet!({ artifactId: first, serverId: 'server-1' });
      expect(request).toMatchObject({ status: 'open', approval: { flow: 'blocking' } });
      expect(launches).toHaveLength(0);
      if ('tamper' in testCase) {
        const original = ApprovalRequestV2Schema.parse(request);
        const changed = ApprovalRequestV2Schema.parse(testCase.tamper === 'operand'
          ? { ...original, actionArgs: { ...readRecord(original.actionArgs), agentId: 'codex' } }
          : { ...original, executionOriginV1: { ...original.executionOriginV1, requestId: 'different-native-request' } });
        const artifact = artifacts.get(first)!;
        // Substitute only persisted Home bytes; the live issuer operand and
        // native operation remain the original admitted Session invocation.
        artifacts.set(first, { ...artifact, body: encodePlainArtifactStoredContent({ body: JSON.stringify(changed) }),
          bodyVersion: Number(artifact.bodyVersion) + 1 });
      }
      const tamperedStartup = 'tamper' in testCase
        ? expect(pending).rejects.toMatchObject({ code: 'approval_stale' }) : undefined;
      const decision = await executor.execute('approval.request.decide', { artifactId: first, decision: 'approve' }, {
        surface: 'ui', authority: 'present_user', serverId: 'server-1', serverIdentityId: 'server-1', runtimeAccountId: 'account-1',
      });
      if ('tamper' in testCase) {
        await tamperedStartup;
        expect(launches).toHaveLength(0);
        expect(readinessEvents).toEqual(['inventory']);
        return;
      }
      expect(decision, JSON.stringify(decision)).toMatchObject({ ok: true });
    }
    if ('readiness' in testCase && testCase.readiness === 'refused') {
      await expect(pending).rejects.toMatchObject({ code: 'agent_cli_not_ready',
        runtimeIssueV1: { code: 'agent_cli_not_ready', failureCause: { retryable: false } } });
      expect(launches).toHaveLength(0);
      const startup = operations.store.list({ accountId: 'account-1', machineId }).items.find(
        operation => operation.requestId === `workflow:profile:${testCase.name}`);
      expect(startup).toBeDefined();
      expect(operations.store.get({ accountId: 'account-1', machineId }, startup!.operationId)).toMatchObject({ state: 'failed',
        result: { type: 'error', code: 'agent_cli_not_ready', agentId: expect.any(String), retryable: false } });
      return;
    }
    await expect(pending).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(launches).toHaveLength(1);
    expect(launches[0]?.approvalProfileId).toBe(approvalProfileId === undefined ? 'builtin:full-trust' : approvalProfileId);
    expect(artifacts.size).toBe(review === 'approve' ? 1 : 0);
    if ('readiness' in testCase && (testCase.readiness === 'update' || testCase.readiness === 'update-status')) {
      expect(readiness.callMachineRpc.mock.calls.filter(([request]) =>
        request.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_START || request.method === RPC_METHODS.DAEMON_AGENTS_INSTALL_READ)).toHaveLength(0);
      const startup = operations.store.list({ accountId: 'account-1', machineId }).items.find(
        operation => operation.requestId === `workflow:profile:${testCase.name}`);
      expect(startup).toBeDefined();
      expect(operations.store.get({ accountId: 'account-1', machineId }, startup!.operationId)).toMatchObject({
        state: 'succeeded', result: { sessionId: 'new-session', agentUpdate: { agentId: 'claude', status: 'pending',
          requestId: `workflow:profile:${testCase.name}` } },
      });
    }
    if ('readiness' in testCase) expect(readinessEvents).toEqual(testCase.readiness === 'install'
      ? ['inventory', 'install', 'terminal', 'spawn'] : ['inventory', 'spawn']);
  });

  it.each([false, true])('creates Workflow birth correspondence accepted by requester custody (miswired=%s)', async miswired => {
    installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null } as const;
    const machineId = 'machine-1';
    const scope = { accountId: 'account-1', machineId };
    const operations = createHostActionOperationRuntime({ machineId, resolveAccountId: async () => scope.accountId });
    let metadata: ReturnType<typeof buildCommittedLaunchMetadata> | undefined;
    const read = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => url.endsWith('/v1/account/profile')
      ? { status: 200, data: { id: scope.accountId } }
      : url.endsWith('/v2/sessions/new-session') && metadata
      ? { status: 200, data: { session: createSessionRecordFixture({ id: 'new-session', machineId,
        encryptionMode: 'plain', metadata: JSON.stringify(metadata) }) } } : read(url));
    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async options => {
      metadata = buildCommittedLaunchMetadata({ options, directory: '/repo', accountSettings: {} });
      // The real requester verifier consumes the real committed metadata producer.
      // Home HTTP and the native process are the only replaced boundaries.
      const admitted = await verifyRequesterSessionCredentialBinding({ credentials, sessionId: 'new-session',
        attribution: { serverId: 'server-1', accountId: scope.accountId, machineId, installationId: 'installation' },
        serverHttpBaseUrl: 'http://workflow-home.test', expectedSessionCreationTag: options.sessionCreationTag ?? 'missing-tag',
        verifyMachineAdmissionCurrent: async () => true });
      if (!admitted) return { type: 'error', errorCode: 'DAEMON_RPC_UNAVAILABLE', errorMessage: 'Requester Session custody unavailable' };
      return { type: 'success', sessionId: 'new-session', sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] } } };
    }, stopSession: async () => { throw new Error('An opened Session must not be retired during startup'); } },
      awaitAgentSessionOpen: async () => ({ status: 'opened', request: { kind: 'create', sessionId: 'new-session', cwd: '/repo' } }) });
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1', machineId,
      workDepth: 0, originRunId: 'run-1', machineAdmissionTransport: vi.fn(), sessionStartup: input => runObservedWorkflowSessionStartup(input, {
        serverId: 'server-1', machineId, observeExecution: operations.observeExecution, rpcContext: {},
        transport: operation => ({ spawn: (request, options) => {
          const { sessionCreationCorrespondence, ...withoutCorrespondence } = request;
          return handler(miswired ? withoutCorrespondence : { ...withoutCorrespondence, sessionCreationCorrespondence },
            { ...options, localActionContext: operation });
        }, resolveSpawnSessionByNonce: async () => { throw new Error('No replay'); } }),
        observeOperation: async (target, options) => operations.handlers.getV2({ operationId: target.operationId,
          ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
          ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }),
        cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
      }) });
    const creating = create({ creationKey: 'workflow:run-1:birth',
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: null,
        sessionConfigOptionOverrides: { v: 1, updatedAt: 7, overrides: { effort: { value: 'high', updatedAt: 7 } } } },
      workspace: { machineId, directory: '/repo', checkoutRootPath: '/repo' } });
    if (miswired) await expect(creating).rejects.toMatchObject({ code: 'DAEMON_RPC_UNAVAILABLE' });
    else {
      await expect(creating).resolves.toMatchObject({ sessionId: 'new-session' });
      expect(metadata).toMatchObject({ sessionCreationCorrespondenceV1: { recipe: { configuration: { options: {
        effort: { value: 'high', updatedAtMs: 7 },
      } } } } });
    }
  });

  it('retains a startup refusal before operation admission when requester cleanup fails', async () => {
    const refusal = Object.assign(new Error('Requester identity unavailable'), { code: 'broker_unavailable' });
    const operations = createHostActionOperationRuntime({ machineId: 'machine-1',
      // Account identity is supplied by the authenticated Home boundary.
      resolveAccountId: async () => { throw refusal; } });
    await expect(runObservedWorkflowSessionStartup({ creationKey: 'workflow:before-admission',
      request: { credentials: { token: 'token', encryption: null }, directory: '/repo', machineId: 'machine-1' },
    }, { serverId: 'server-1', machineId: 'machine-1', observeExecution: operations.observeExecution, rpcContext: {},
      transport: () => { throw new Error('Refused startup must not launch'); },
      observeOperation: async () => { throw new Error('No operation admitted'); },
      cancelOperation: async () => { throw new Error('No operation admitted'); },
      cleanupOnFailure: async () => { throw new Error('Cleanup failed after requester refusal'); },
    })).rejects.toBe(refusal);
  });

  it.each([
    { miswired: false, code: 'DAEMON_RPC_UNAVAILABLE', cleanupFails: false },
    { miswired: true, code: 'DAEMON_RPC_UNAVAILABLE', cleanupFails: false },
    { miswired: false, code: 'broker_unavailable', cleanupFails: false },
    { miswired: false, code: 'CHILD_EXITED_BEFORE_WEBHOOK', cleanupFails: false },
    { miswired: false, code: 'currentness_unavailable', cleanupFails: false },
    { miswired: false, code: 'broker_unavailable', cleanupFails: true },
  ])('retains cold startup custody and original $code refusal (miswired=$miswired, cleanupFails=$cleanupFails)', async ({ miswired, code, cleanupFails }) => {
    installSessionCreationTransport();
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'original-refusal', supportsCoreCancellation: () => true });
    const observations: import('@happier-dev/protocol/actions').ActionOperationSnapshotV1[] = [];
    let launches = 0;
    let observedBeforeLaunch = false;
    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async () => {
      // Correspondence must already be committed before entering the native boundary,
      // including when the boundary immediately refuses startup.
      observedBeforeLaunch = observations.some(operation => operation.operationId === 'original-refusal' && operation.state === 'running');
      launches++;
      if (code === 'currentness_unavailable') {
        const detail = readSessionCreationTerminalSpawnErrorDetail(new AccountEncryptionCurrentnessUnavailableError(
          undefined, undefined, { cause: Object.assign(new Error('Request timed out'), { code: 'ECONNABORTED' }) },
        ));
        if (!detail) throw new Error('Expected currentness refusal');
        return buildSessionCreationTerminalSpawnErrorResult(detail);
      }
      return { type: 'error', errorCode: code === 'DAEMON_RPC_UNAVAILABLE' ? code : 'SPAWN_FAILED',
        errorMessage: 'Requester Session custody unavailable',
        ...(code === 'DAEMON_RPC_UNAVAILABLE' ? {} : { errorDetail: { kind: 'launch_error' as const, code,
          message: 'Native startup refused', ...(code === 'CHILD_EXITED_BEFORE_WEBHOOK'
            ? { childExit: { code: 1, signal: null } } : {}) } }),
      };
    }, stopSession: async () => { throw new Error('No runner admitted for retirement'); } },
      awaitAgentSessionOpen: async () => { throw new Error('No runner admitted'); } });
    const startup = runObservedWorkflowSessionStartup({ creationKey: 'workflow:refusal',
      request: { credentials: { token: 'token', encryption: null }, directory: '/repo', machineId: scope.machineId,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      onObservation: async operation => { observations.push(operation); },
    }, { serverId: 'server-1', machineId: scope.machineId, observeExecution: operations.observeExecution, rpcContext: {},
      transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
        resolveSpawnSessionByNonce: async () => { throw new Error('No replacement launch'); } }),
      observeOperation: async (target, options) => operations.handlers.getV2({
        operationId: miswired ? 'foreign-operation' : target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
      }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {
        if (cleanupFails) throw new Error('Cleanup failed after native refusal');
      },
    });
    await expect(startup).rejects.toMatchObject(miswired
      ? { message: 'workflow_invocation_fact_conflict' }
      : { code });
    expect(launches).toBe(miswired ? 0 : 1);
    expect(observedBeforeLaunch).toBe(!miswired);
    if (miswired) expect(observations).toEqual([]);
    else expect(observations.at(-1)).toMatchObject({ operationId: 'original-refusal', state: 'failed',
      error: { errorCode: code === 'DAEMON_RPC_UNAVAILABLE' ? code : 'spawn_failed' },
      ...(code === 'DAEMON_RPC_UNAVAILABLE' ? {} : { result: { type: 'error', code: 'spawn_failed', launchError: { code } } }) });
    expect(operations.store.list(scope).items[0]).toMatchObject({ operationId: 'original-refusal', state: 'failed' });
  });

  it('retains the runner stderr cause through Workflow startup when Home diagnostics are unavailable after the webhook', async () => {
    installSessionCreationTransport();
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'runner-refusal', supportsCoreCancellation: () => true });
    const child = new ChildProcess();
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(101), pid: 101, processStartTimeMs: 1000, startedBy: 'daemon',
      happySessionId: 'runner-refused-session', childProcess: child };
    const sessions = new Map([[tracked.trackingKey, tracked]]);
    const onChildExited = createOnChildExited({ trackedSessionsByKey: sessions,
      spawnResourceCleanupByKey: new Map(), sessionAttachCleanupByKey: new Map(),
      getApiMachineForSessions: () => null, removeSessionMarkerFn: async () => {} });
    const failureCause = { code: 'project_workspace_unavailable', retryable: false, phase: 'client_start',
      preparationCause: { code: 'project_workspace_unavailable', stage: 'dispatch' },
      failureReason: 'unclassified_provider_error' } as const;
    let exit: Promise<void> | undefined;
    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async () => {
      // The webhook has acknowledged this runner; only OS exit and Home IO are substituted.
      setImmediate(() => {
        Object.defineProperty(child, 'exitCode', { value: 1 });
        exit = onChildExited(tracked.pid, { reason: 'process-exited', code: 1, signal: null,
          failureCause: readSessionRunnerFailureCause(formatSessionRunnerFailureCause(failureCause)) })
          .then(() => sessionChanges.notifyChanged());
      });
      return { type: 'success', sessionId: tracked.happySessionId! };
    }, stopSession: async () => { throw new Error('Exited runner does not need Stop'); } },
      awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ subscribeChanges: listener => sessionChanges.subscribe(listener), ...input,
        getTrackedSessions: () => [...sessions.values()],
        readStartupFailure: async () => { throw new Error('Home unavailable'); } }) });
    const startup = runObservedWorkflowSessionStartup({ creationKey: 'workflow:runner-refusal',
      request: { credentials: { token: 'token', encryption: null }, directory: '/repo', machineId: scope.machineId,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } },
    }, { serverId: 'server-1', machineId: scope.machineId, observeExecution: operations.observeExecution, rpcContext: {},
      transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
        resolveSpawnSessionByNonce: async () => { throw new Error('No replacement launch'); } }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}) }),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    try {
      await expect(startup).rejects.toMatchObject({ code: failureCause.code,
        runtimeIssueV1: { code: failureCause.code, failureCause: { code: failureCause.code,
          retryable: false, phase: 'client_start', failureReason: 'unclassified_provider_error' } } });
      expect(operations.store.get(scope, 'runner-refusal')).toMatchObject({ state: 'failed',
        result: { type: 'error', launchError: { code: failureCause.code, failureCause } } });
    } finally { await exit; }
  });

  it.each(['fresh', 'same_key', 'retained'] as const)('waits for original Session spawn completion before offering first Workflow input (%s)', async recovery => {
    installSessionCreationTransport();
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'lazy-start', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(101), pid: 101, startedBy: 'daemon', happySessionId: 'lazy-session',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
    let releaseLaunch!: () => void;
    const launchReady = new Promise<void>(resolve => { releaseLaunch = resolve; });
    let launches = 0;
    let accepted!: () => void;
    const acceptedResponse = new Promise<void>(resolve => { accepted = resolve; });
    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async options => {
      launches++;
      spawnedSessionBirthMetadata.set('lazy-session', buildCommittedLaunchMetadata({ options, directory: '/repo', accountSettings: {} }));
      await launchReady;
      return { type: 'success', sessionId: 'lazy-session', sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
      } };
    }, stopSession: async () => { throw new Error('No refused runner'); } },
      awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ subscribeChanges: listener => sessionChanges.subscribe(listener), getTrackedSessions: () => [tracked], ...input }) });
    const startup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup(input, {
      serverId: 'server-1', machineId: scope.machineId, observeExecution: async request => {
        const response = await operations.observeExecution(request);
        accepted();
        return response;
      }, rpcContext: {},
      transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
        resolveSpawnSessionByNonce: async () => { throw new Error('No replacement launch'); } }),
      observeOperation: (target, options) => operations.handlers.getV2({ operationId: target.operationId,
        ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
        ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
      cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
    });
    const create = createProductionFreshWorkflowSessionConversation({ credentials: { token: 'token', encryption: null },
      serverId: 'server-1', machineId: scope.machineId, workDepth: 0, originRunId: 'lazy-run',
      machineAdmissionTransport: async () => { throw new Error('Conversation creation does not enqueue'); }, sessionStartup: startup });
    const request = { creationKey: 'workflow:lazy-run:step', selection: {
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      connectedServices: { v: 2 as const, bindingsByServiceId: {} },
    }, workspace: { machineId: scope.machineId, directory: '/repo', checkoutRootPath: '/repo' } };
    const controller = new AbortController();
    const first = create({ ...request, signal: controller.signal });
    const firstOutcome = first.catch(error => error);
    let conversation = first;
    try {
      await expect.poll(() => launches).toBe(1);
      if (recovery !== 'fresh') {
        controller.abort(new WorkflowRuntimeInterruption());
        await expect(firstOutcome).resolves.toBeInstanceOf(WorkflowRuntimeInterruption);
        conversation = create({ ...request, ...(recovery === 'retained' ? {
          retainedStartupOperation: { key: 'startup', serverId: 'server-1', machineId: scope.machineId, operationId: 'lazy-start' },
        } : {}) });
      }
      let ready: Awaited<typeof conversation> | undefined;
      const observed = conversation.then(value => { ready = value; }, () => undefined);
      releaseLaunch();
      await acceptedResponse;
      // Drain the in-process acceptance response while native spawn completion
      // remains held at its real tracked-runner boundary.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(ready).toBeUndefined();
      expect(tracked.agentRuntimeDaemonServiceSessionOpenAttestation).toBeUndefined();
      expect(operations.store.get(scope, 'lazy-start')).toMatchObject({ state: 'running' });
      // A slow native start eventually settles its original spawn operation.
      tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
        request: { kind: 'create', sessionId: 'lazy-session', cwd: '/repo' }, providerSessionId: 'native',
      };
      sessionChanges.notifyChanged();
      await expect(operations.handlers.getV2({ operationId: 'lazy-start', waitForTerminal: true })).resolves.toMatchObject({
        kind: 'found', operation: { state: 'succeeded' },
      });
      await expect(conversation).resolves.toMatchObject({ sessionId: 'lazy-session' });
      await observed;
      expect(launches).toBe(1);
    } finally {
      releaseLaunch();
      operations.runner.cancel(scope, 'lazy-start');
      await firstOutcome;
      await conversation.catch(() => undefined);
    }
  });

  it.each(['open', 'cancel', 'interrupt', 'rejoin_open', 'rejoin_cancel', 'rejoin_interrupt', 'rejoin_miswired', 'rejoin_retention_refused', 'cancel_before_entry', 'interrupt_before_entry'] as const)('keeps cold Session creation under its original startup observation owner (%s)', async outcome => {
    installSessionCreationTransport();
    const observations: unknown[] = [];
    const scope = { accountId: 'account-1', machineId: 'machine-1' };
    const operations = createHostActionOperationRuntime({ machineId: scope.machineId, resolveAccountId: async () => scope.accountId,
      generateOperationId: () => 'original-start', supportsCoreCancellation: () => true });
    const tracked: TrackedSession = { trackingKey: legacyPidSessionTrackingKey(101), pid: 101, startedBy: 'daemon', happySessionId: 'original-session',
      agentRuntimeDaemonServiceAuthorityFilePath: '/private/authority.json' };
    let launches = 0;
    // Only the native runner/process is substituted. It reports setup and
    // native-open through the actual operation and tracked-runner owners.
    const handler = createMachineSessionSpawnRpcHandler({ handlers: { spawnSession: async options => {
      launches++;
      spawnedSessionBirthMetadata.set('original-session', buildCommittedLaunchMetadata({ options, directory: '/repo', accountSettings: {} }));
      const operation = options.projectSetupOperation;
      if (!operation?.operationReview) throw new Error('Missing original startup custody');
      operation.operationOwnerUpdate.update({ domainRef: { kind: 'projectCommand', purpose: 'setup',
        serverId: 'server-1', machineId: scope.machineId, workspaceRefId: 'workspace', cwd: '/repo' } });
      const review = { kind: 'pendingApproval' as const, code: 'project_setup_consent_required' as const,
        reviewedEffectDigest: 'setup', reviewedEffect: { commands: [] } };
      let approved = false;
      do {
        await operation.operationReview.waitForResume(review, { review: async selected => {
          approved = selected?.reviewedEffectDigest === 'setup';
          return approved ? null : review;
        } });
        // Rejoining wakes setup to remeasure; it is not human consent.
      } while (outcome.startsWith('rejoin_') && !approved);
      // The native boundary cannot report committed birth before setup consent.
      tracked.agentRuntimeDaemonServiceSessionOpenAttestation = {
        request: { kind: 'create', sessionId: 'original-session', cwd: '/repo' }, providerSessionId: 'native',
      };
      return { type: 'success', sessionId: 'original-session', sessionCreationOutcome: {
        disposition: 'created', organizationPlacement: { folderId: null, tagIds: [] },
      } };
    }, stopSession: async () => { throw new Error('Setup review does not refuse a native child'); } },
      awaitAgentSessionOpen: input => awaitTrackedRunnerAgentSessionOpen({ subscribeChanges: listener => sessionChanges.subscribe(listener), getTrackedSessions: () => [tracked], ...input }) });
    let miswireObservation = false;
    const startup: WorkflowSessionStartup = input => runObservedWorkflowSessionStartup(input, { serverId: 'server-1', machineId: scope.machineId,
        observeExecution: operations.observeExecution, rpcContext: {},
        transport: operation => ({ spawn: (request, options) => handler(request, { ...options, localActionContext: operation }),
          resolveSpawnSessionByNonce: async () => { throw new Error('No replacement startup'); } }),
        observeOperation: async (target, options) => await operations.handlers.getV2({ operationId: miswireObservation ? 'foreign-operation' : target.operationId,
          ...(options.waitForTerminal ? { waitForTerminal: true } : {}),
          ...(options.includeSetupReview ? { includeSetupReview: true } : {}) }, options.signal ? { signal: options.signal } : undefined),
        cancelOperation: async target => operations.runner.cancel(scope, target.operationId), cleanupOnFailure: async () => {},
      });
    if (outcome === 'cancel_before_entry' || outcome === 'interrupt_before_entry') {
      const controller = new AbortController();
      controller.abort(outcome === 'interrupt_before_entry' ? new WorkflowRuntimeInterruption() : WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
      try {
        await expect(startup({ creationKey: 'already-stopped', request: { credentials: { token: 'token', encryption: null },
          directory: '/repo', machineId: scope.machineId, signal: controller.signal } })).rejects.toBeDefined();
        expect(operations.store.list(scope).items).toEqual([]);
        expect(launches).toBe(0);
      } finally { operations.runner.cancel(scope, 'original-start'); }
      return;
    }
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'run-1', machineAdmissionTransport: vi.fn(), sessionStartup: startup,
    });
    const controller = new AbortController();
    const request = { creationKey: 'workflow:run-1:inv-1',
      selection: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        connectedServices: { v: 2, bindingsByServiceId: {} } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      onStartupObservation: async (value: unknown) => {
        // The coordinator ignores observation when its claim was interrupted
        // before commit; that must not cancel the admitted launch.
        if (outcome.startsWith('rejoin_') && !controller.signal.aborted) {
          controller.abort(new WorkflowRuntimeInterruption());
          return;
        }
        if (outcome === 'rejoin_retention_refused') throw new Error('retention_refused');
        observations.push(value);
      },
    } satisfies Parameters<typeof create>[0];
    const creating = create({ ...request, signal: controller.signal });
    const rejection = creating.catch(error => error);
    let resumed = creating;
    let resumedRejection = rejection;
    try {
      if (outcome.startsWith('rejoin_')) await expect.poll(() => launches).toBe(1);
      else await expect.poll(() => observations).toContainEqual(expect.objectContaining({ operationId: 'original-start',
        setupReview: expect.objectContaining({ code: 'project_setup_consent_required' }) }));
      expect(operations.store.list(scope).items).toHaveLength(1);
      expect(launches).toBe(1);
      if (outcome === 'interrupt') {
        controller.abort(new WorkflowRuntimeInterruption());
        await expect(rejection).resolves.toBeInstanceOf(WorkflowRuntimeInterruption);
        expect(operations.store.list(scope).items[0]?.state).toBe('running');
        resumed = create({ ...request, retainedStartupOperation: { key: 'startup', serverId: 'server-1',
          machineId: scope.machineId, operationId: 'original-start' } });
      }
      if (outcome.startsWith('rejoin_')) {
        controller.abort(new WorkflowRuntimeInterruption());
        await expect(rejection).resolves.toBeInstanceOf(WorkflowRuntimeInterruption);
        expect(operations.store.list(scope).items[0]?.state).toBe('running');
        observations.length = 0;
        miswireObservation = outcome === 'rejoin_miswired';
        const rejoining = new AbortController();
        // A claim interrupted before committing startup correspondence retries
        // the same key without a retained address, while launch stays admitted.
        resumed = create({ ...request, signal: rejoining.signal });
        resumedRejection = resumed.catch(error => error);
        if (miswireObservation) {
          await expect(resumedRejection).resolves.toMatchObject({ message: 'workflow_invocation_fact_conflict' });
          expect(observations).toEqual([]);
          return;
        }
        if (outcome === 'rejoin_retention_refused') {
          await expect(resumedRejection).resolves.toMatchObject({ message: 'retention_refused' });
          expect(observations).toEqual([]);
          expect(operations.store.list(scope).items[0]?.state).toBe('running');
          expect(launches).toBe(1);
          return;
        }
        await expect.poll(() => observations).toContainEqual(expect.objectContaining({ operationId: 'original-start',
          setupReview: expect.objectContaining({ code: 'project_setup_consent_required' }) }));
        expect(launches).toBe(1);
        if (outcome === 'rejoin_interrupt') {
          rejoining.abort(new WorkflowRuntimeInterruption());
          await expect(resumedRejection).resolves.toBeInstanceOf(WorkflowRuntimeInterruption);
          expect(operations.store.list(scope).items[0]?.state).toBe('running');
          return;
        }
        if (outcome === 'rejoin_cancel') {
          rejoining.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
          await expect(resumedRejection).resolves.toBeDefined();
          // Cancellation requests settle at the operation owner after the observer leaves.
          expect(await operations.handlers.getV2({ operationId: 'original-start', waitForTerminal: true }))
            .toMatchObject({ operation: { state: 'cancelled' } });
          return;
        }
      }
      if (outcome === 'cancel') {
        expect(operations.runner.cancel(scope, 'original-start')).toEqual({ kind: 'requested' });
        await expect(rejection).resolves.toMatchObject({ code: 'cancelled' });
        expect(await operations.runner.decideSetupReview(scope, 'original-start', { serverId: 'server-1', machineId: scope.machineId,
          workspaceId: 'workspace', rootPath: '/repo' }, 'setup', { reviewedEffectDigest: 'setup', skipForInvocation: false })).toBeNull();
      } else {
        await operations.runner.decideSetupReview(scope, 'original-start', { serverId: 'server-1', machineId: scope.machineId,
          workspaceId: 'workspace', rootPath: '/repo' }, 'setup', { reviewedEffectDigest: 'setup', skipForInvocation: false });
        await expect(resumed).resolves.toMatchObject({ sessionId: 'original-session', origin: { kind: 'run_step', runId: 'run-1' }, workDepth: 1 });
      }
      expect(launches).toBe(1);
    } finally { operations.runner.cancel(scope, 'original-start'); await rejection; await resumedRejection; }
  });

  it('recovers inputless creation before its Workflow fact through observation-only Session creation custody', async () => {
    const request = { selection: { agentTarget: { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: { v: 2 as const, bindingsByServiceId: {} } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-inputless:inv-inputless', observationOnly: true,
    };
    const launches = installSessionCreationTransport();
    const create = createProductionFreshWorkflowSessionConversation({ credentials: { token: 'token', encryption: null },
      serverId: 'server-1', machineId: 'machine-1', workDepth: 0, originRunId: 'run-inputless',
      machineAdmissionTransport: async () => { throw new Error('Inputless rejoin cannot enqueue an input'); },
    });
    await create({ ...request, observationOnly: false });
    launches.length = 0;
    readiness.callMachineRpc.mockClear();
    await expect(create(request)).resolves.toMatchObject({ sessionId: 'new-session', origin: { kind: 'run_step', runId: 'run-inputless' }, workDepth: 1 });
    expect(launches).toEqual([]);
    expect(readiness.callMachineRpc.mock.calls.map(([call]) => ({ method: call.method, request: call.request })))
      .toEqual([]);
  });

  it.each([
    { incomingAt: 100, savedClear: false }, { incomingAt: 200, savedClear: false },
    { incomingAt: 300, savedClear: false }, { incomingAt: null, savedClear: false },
    { incomingAt: 100, savedClear: true }, { incomingAt: 200, savedClear: true },
    { incomingAt: 300, savedClear: true },
  ])('resolves existing Session controls by predecessor timestamps (%j)', async ({ incomingAt, savedClear }) => {
    const admitted: unknown[] = [];
    const target = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const model = (modelId: string) => ({ agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId });
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(), createFreshConversation: async () => { throw new Error('Existing target'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo', agentTarget: target,
        runtimeSnapshot: { permissionMode: { value: 'read-only' as const, updatedAt: 200 }, modelSelection: { value: savedClear ? null : model('saved-model'), updatedAt: 200 } },
      }),
      sessionInput: { enqueue: async (request) => { admitted.push(request); return { status: 'accepted', localId: 'input' }; },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({ runId: 'run',
      step: { kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' }, agentTarget: target,
        permissionMode: incomingAt === null ? null : 'default', permissionModeUpdatedAt: incomingAt ?? undefined,
        modelSelection: incomingAt === null ? null : { v: 1, ref: model('incoming-model'), updatedAt: incomingAt } },
      executionTarget: { kind: 'session' }, authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    });
    expect(admitted).toEqual([expect.objectContaining({ permissionMode: incomingAt === null ? null : incomingAt < 200 ? 'read-only' : 'default',
      modelSelectionInput: expect.objectContaining({ modelId: incomingAt === null || (savedClear && incomingAt < 200)
        ? null : incomingAt < 200 ? 'saved-model' : 'incoming-model' }),
      ...(incomingAt === null ? {} : { modelSelectionUpdatedAt: incomingAt < 200 ? 200 : incomingAt }),
    })]);
  });

  it('anchors an unmaterialized generation timeout to the exact host input across rejoin', async () => {
    const acceptedTimes: number[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('owned input cannot prepare'); },
      materializeConversation: async () => { throw new Error('owned input cannot materialize'); },

      sessionInput: { enqueue: async () => { throw new Error('owned input cannot enqueue'); },
        observe: async (params) => {
          expect(params.deadlineMs).toBeUndefined();
          expect(params.timeoutAfterInputMs).toBe(100);
          expect(params.onInputMaterialized).toBeTypeOf('function');
          await params.onInputMaterialized?.(123);
          return { ok: true, sessionId: 'session', localId: 'generated-input', result: { kind: 'final_text', text: 'done' } };
        },
      },
    });
    expect(await execute({ runId: 'run', step: { kind: 'step', id: 'draft', timeoutMs: 100,
      document: { text: 'Generate', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'draft', scope: [] },
        attempt: '1', logicalInvocationRecordId: 'logical', execution: { kind: 'session', sessionId: 'session', localInputId: 'generated-input' } },
      input: { text: 'Generate', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } }, workspace: { machineId: 'machine', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => { throw new Error('owned input cannot admit'); },
      onInputAccepted: async (_execution, acceptedAtMs) => { if (acceptedAtMs !== undefined) acceptedTimes.push(acceptedAtMs); },
    })).toEqual({ kind: 'completed', result: 'done' });
    expect(acceptedTimes).toEqual([123]);
  });
  it('binds the portable origin choice to its frozen authorized Session and refuses replacement', async () => {
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('origin cannot be replaced'); },
      resolveSharedRunConversation: async () => { throw new Error('origin has no shared pointer'); },
      resolveProducerConversation: async () => { throw new Error('origin is not a producer reference'); },
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => sessionId === 'frozen-origin'
        ? { sessionId, machineId, directory: '/origin/cwd', agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } }
        : null,
    });
    const base = {
      runId: 'run-1', originSessionId: 'frozen-origin',
      invocation: { kind: 'happier.workflow-progress.v1' as const, blockKind: 'step' as const, invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1' },
      step: { kind: 'step' as const, id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' as const } },
      execution: { conversation: { kind: 'origin_session' as const }, agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      executionTarget: { kind: 'session' as const },
      authorization: { admittedPermissionCeiling: 'default' as const, principal: { kind: 'host' as const } },
      onOriginInputOffered: async () => {},
    };
    await expect(conversations.prepare(base)).resolves.toMatchObject({ inputPath: 'origin_session', existing: {
      sessionId: 'frozen-origin', directory: '/origin/cwd', agentTarget: { identity: { localId: 'codex' } },
    } });
    await expect(conversations.prepare({ ...base, originSessionId: undefined })).rejects.toMatchObject({
      code: 'workflow_conversation_unavailable', details: { reason: 'origin_session_missing' } });
    await expect(conversations.prepare({ ...base, onOriginInputOffered: undefined })).rejects.toMatchObject({ code: 'workflow_origin_input_offer_unavailable' });
    await expect(conversations.prepare({ ...base, invocation: { ...base.invocation,
      recovery: { conversation: 'fresh_agent', input: { kind: 'original' } } } })).rejects.toMatchObject({ code: 'workflow_recovery_conversation_unsupported' });
  });

  it('FIX75 prepares a live configured origin without requiring inactive native resume identity', async () => {
    const read = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => url.includes('/v2/sessions/origin')
      ? { status: 200, data: { session: createSessionRecordFixture({ id: 'origin', active: true, encryptionMode: 'plain',
        machineId: 'machine-1', metadata: JSON.stringify({ machineId: 'machine-1', path: '/repo',
          runtimeDescriptorV1: { v: 1, agentId: 'custom-acp', agent: {} },
          acpConfiguredBackendV1: { v: 1, updatedAt: 1, backendId: 'configured-test', title: 'Configured Agent' },
        }) }) } } : read(url));
    readiness.callMachineRpc.mockClear();
    const conversations = createProductionWorkflowConversationOwner({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',
      createFreshConversation: async () => { throw new Error('origin cannot be replaced'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo' }),
    });
    const params: Parameters<WorkflowStepExecutor>[0] = {
      runId: 'run-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'continue', document: { text: 'Continue', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'continue', scope: [] },
        attempt: '0', logicalInvocationRecordId: 'logical-1' },
      input: { text: 'Continue', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {}, onOriginInputOffered: async () => {},
    };
    await expect(conversations.materialize(await conversations.prepare(params), params)).resolves.toMatchObject({ sessionId: 'origin' });
    expect(readiness.callMachineRpc).not.toHaveBeenCalled();
  });

  it('commits an origin input for pull delivery and observes its exact result without Session Pending', async () => {
    const accepted: unknown[] = [];
    const offeredText: string[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      resolveRoleInstructions: () => 'Frozen workflow role',
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', inputPath: 'origin_session',
        existing: { sessionId: 'origin', machineId: 'machine-1', directory: '/repo' } }),
      materializeConversation: async () => ({ sessionId: 'origin',
        machineAdmissionTransport: async () => { throw new Error('origin must not enqueue'); } }),

      sessionInput: { enqueue: async () => { throw new Error('origin must not enqueue'); },
        observe: async ({ sessionId, localId }) => {
          expect(accepted).toEqual([{ kind: 'session', sessionId, localInputId: localId }]);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'origin result' } };
        },
      },
    });
    await expect(execute({
      runId: 'run-1', invocationRecordId: 'inv-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {},
      onOriginInputOffered: async (value, text) => { accepted.push(value); offeredText.push(text); },
      onInputAccepted: async () => { throw new Error('offered input is not yet admitted by the host'); },
    })).resolves.toEqual({ kind: 'completed', result: 'origin result' });
    expect(offeredText).toEqual(['Frozen workflow role\n\nwork']);
  });

  it.each(['withdrawn', 'dispatched'] as const)('settles an origin abort only through the input owner (%s)', async (answer) => {
    const controller = new AbortController();
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    let exactTurnStops = 0;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('admitted input must not prepare'); },
      materializeConversation: async () => { throw new Error('admitted input must not materialize'); },

      originSessionInput: {
        withdraw: async () => answer,
        cancelDispatched: async () => { exactTurnStops += 1; },
      },
      sessionInput: { enqueue: async () => { throw new Error('admitted input must not enqueue'); },
        cancel: async () => { throw new Error('Session Pending cannot retire origin input'); },
        observe: async ({ signal }) => signal?.aborted ? { ok: false, code: 'cancelled' }
          : { ok: true, sessionId: 'origin', localId: 'exact-origin-input', result: { kind: 'final_text', text: 'settled dispatched turn' } },
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        execution: { kind: 'session', sessionId: 'origin', localInputId: 'exact-origin-input' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, signal: controller.signal,
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual(answer === 'withdrawn'
      ? { kind: 'cancelled', code: 'workflow_origin_input_withdrawn' }
      : { kind: 'completed', result: 'settled dispatched turn' });
    expect(exactTurnStops).toBe(answer === 'dispatched' ? 1 : 0);
  });

  it('withdraws a paused origin offer through the queue owner while waiting for its host event', async () => {
    const withdrawals: unknown[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('rejoin does not prepare'); },
      materializeConversation: async () => { throw new Error('origin has no Pending'); },

      originSessionInput: { withdraw: async (input) => { withdrawals.push(input); return 'withdrawn'; }, cancelDispatched: async () => { throw new Error('Pause cannot stop a dispatched turn'); } },
      sessionInput: { enqueue: async () => { throw new Error('origin has no Pending'); },
        observe: async (params) => {
          await params.beforeInputObservation?.();
          return { ok: false, code: 'cancelled' };
        },
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin', readOriginInputControl: async () => 'pause_requested',
      step: { kind: 'step', id: 'a', timeoutMs: 100, document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        execution: { kind: 'session', sessionId: 'origin', localInputId: 'exact-origin-input' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual({ kind: 'cancelled', code: 'workflow_origin_input_withdrawn' });
    expect(withdrawals).toEqual([{ sessionId: 'origin', localInputId: 'exact-origin-input' }]);
  });

  it.each([true, false])('settles a deleted origin as unavailable without starting a replacement (rejoin: %s)', async (rejoin) => {
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', machineAdmissionTransport: vi.fn(),
      createFreshConversation: async () => { throw new Error('origin cannot be replaced'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'origin', machineId: 'machine-1', directory: '/repo' }),
      sessionInput: { enqueue: async () => { throw new Error('admitted input cannot be replaced'); },
        observe: async () => ({ ok: false, code: 'session_not_found' }),
      },
    });
    await expect(execute({
      runId: 'run-1', originSessionId: 'origin',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical-1',
        ...(rejoin ? { execution: { kind: 'session' as const, sessionId: 'origin', localInputId: 'exact-origin-input' } } : {}) },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: { conversation: { kind: 'origin_session' } }, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {}, onOriginInputOffered: async () => {},
    })).resolves.toMatchObject({ kind: 'failed', code: 'workflow_conversation_unavailable',
      reasonDetails: { reason: 'session_unavailable', expected: { kind: 'session', ids: ['origin'] } } });
  });

  it('fences Session enqueue after asynchronous conversation preparation', async () => {
    const admissionClosed = new Error('pause_won');
    let closed = false;
    let sent = 0;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => {
        closed = true;
        return { sessionId: 'session-1', machineAdmissionTransport: vi.fn() };
      },
      sessionInput: { enqueue: async () => { sent += 1; return { status: 'accepted', localId: 'exact' }; },
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'exact', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => { if (closed) throw admissionClosed; }, onInputAccepted: async () => {},
    })).rejects.toBe(admissionClosed);
    expect(sent).toBe(0);
  });

  it('stops a late accepted Session identity even when its durable report fails', async () => {
    const controller = new AbortController();
    const stopped: string[] = [];
    const reportFailed = new Error('report_failed');
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: async () => { controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON); return { status: 'accepted', localId: 'late-input' }; },
        observe: async () => { throw new Error('cannot observe through cancelled signal'); },
        cancel: async ({ sessionId, localId }) => { stopped.push(`${sessionId}:${localId}`); return { kind: 'turn_cancel_requested' }; },
      },
    });
    await expect(execute({
      runId: 'run-1', step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, signal: controller.signal,
      beforeInputAdmission: async () => {}, onInputAccepted: async () => { throw reportFailed; },
    })).rejects.toBe(reportFailed);
    expect(stopped).toEqual(['session-1:late-input']);
  });
  it('observes the exact admitted Session input before checking a new selection', async () => {
    const observed: string[] = [];
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => { throw new Error('selection must not run'); },
      materializeConversation: async () => { throw new Error('creation must not run'); },

      sessionInput: { enqueue: async () => { throw new Error('admitted input must not be sent again'); },
        observe: async ({ sessionId, localId }) => {
          observed.push(`${sessionId}:${localId}`);
          return { ok: true, sessionId, localId, result: { kind: 'final_text', text: 'exact result' } };
        },
      },
    });
    const params: Parameters<WorkflowStepExecutor>[0] = {
      runId: 'run-1',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: {
        kind: 'happier.workflow-progress.v1', blockKind: 'step',
        invocationPath: { blockId: 'a', scope: [] }, attempt: '1', logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'session', sessionId: 'exact-session', localInputId: 'exact-input' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' }, permissionMode: 'yolo' },
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    };
    await expect(execute(params)).resolves.toEqual({ kind: 'completed', result: 'exact result' });
    expect(observed).toEqual(['exact-session:exact-input']);
  });

  it.each([false, true])('keeps a Session without reply text in result-unavailable attention (rejoin=%s)', async (rejoin) => {
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),

      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: { kind: 'terminal_no_result', reason: 'missing_final_assistant_text', usage: { inputTokens: 8 } },
        }),
      },
    });
    const invocation: Parameters<WorkflowStepExecutor>[0]['invocation'] = {
      kind: 'happier.workflow-progress.v1', blockKind: 'step',
      invocationPath: { blockId: 'a', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1',
      ...(rejoin ? { execution: { kind: 'session' as const, sessionId: 'session-1', localInputId: 'local-1' } } : {}),
    };
    await expect(execute({
      runId: 'run-1',
      step: { kind: 'step', id: 'a', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation, input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toEqual({ kind: 'needs_attention', code: 'session_input_result_unavailable', usage: { inputTokens: 8 } });
  });

  it('fresh-agent recovery creates a replacement Session while same recovery retains the exact prior target', async () => {
    const workspace = { machineId: 'machine-1', directory: '/repo/dirty', checkoutRootPath: '/repo' };
    const created: string[] = [];
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: async ({ workspace: target }) => {
        created.push(target.directory);
        return { sessionId: 'replacement', machineId: 'machine-1', directory: target.directory };
      },
      resolveSharedRunConversation: async () => null,
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: workspace.directory,
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } }),
    });
    const base = {
      runId: 'run-1', step: { result: { kind: 'text' } },
      execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      recoveryPreviousExecution: { kind: 'session', sessionId: 'original', localInputId: 'old-input' },
      recoveryPreviousWorkspace: workspace,
      workspace,
    };
    const fresh = { ...base, invocation: { logicalInvocationRecordId: 'fresh', recovery: { conversation: 'fresh_agent' } } };
    const prepared = await conversations.prepare(fresh as never);
    await expect(conversations.materialize(prepared, fresh as never)).resolves.toMatchObject({ sessionId: 'replacement', directory: '/repo/dirty' });
    const same = { ...base, invocation: { logicalInvocationRecordId: 'same', recovery: { conversation: 'same_conversation' } } };
    await expect(conversations.materialize(await conversations.prepare(same as never), same as never)).resolves.toMatchObject({ sessionId: 'original', directory: '/repo/dirty' });
    expect(created).toEqual(['/repo/dirty']);
  });

  it('passes the selected scope and class to the shared pointer reader', async () => {
    let selectedScope: unknown;
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: async () => { throw new Error('unexpected creation'); },
      resolveSharedRunConversation: async (params) => { selectedScope = params; return null; },
      resolveProducerConversation: async () => null, resolveExistingSessionConversation: async () => null,
    });
    const conversationBinding = { kind: 'shared', scopeOwnerKey: 'item-a', targetClass: 'session' };
    await conversations.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' }, execution: {}, conversationBinding,
    } as never);
    expect(selectedScope).toMatchObject({ conversationBinding });
  });

  it('checks the actual retained Session Agent before materialization, while an existing Session keeps its own Agent', async () => {
    const createFreshConversation = vi.fn();
    const conversations = createProductionWorkflowConversationOwner({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', createFreshConversation,
      resolveSharedRunConversation: async () => ({ sessionId: 'retained', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } },
      }),
    });
    const params = {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
    };
    await expect(conversations.prepare(params as never)).rejects.toMatchObject({ code: 'workflow_conversation_unavailable',
      details: { reason: 'agentTarget', expected: { kind: 'agent', ids: ['happier.agent.claude/claude'] },
        observed: { kind: 'agent', ids: ['happier.agent.codex/codex'] } } });
    await expect(conversations.prepare({
      ...params,
      execution: { ...params.execution, conversation: { kind: 'existing_session', sessionId: 'retained', machineId: 'machine-1' } },
    } as never)).resolves.toMatchObject({ existing: { sessionId: 'retained' } });
    expect(createFreshConversation).not.toHaveBeenCalled();
  });

  it('preserves an explicit automatic model and null permission intent at Session Pending admission', async () => {
    let accepted: unknown;
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      workDepth: 2,
      resolveRoleInstructions: () => 'Frozen reviewer instructions',
      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),

      sessionInput: { enqueue: async (params) => { accepted = params; return { status: 'accepted', localId: 'new-input' }; },
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'new-input', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: null, modelSelection: null },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } as never);
    expect(accepted).toMatchObject({ permissionMode: null, modelSelectionInput: { modelId: null }, workDepth: 3,
      text: expect.stringContaining('Frozen reviewer instructions') });
  });

  it('retains the Session creation depth for shared and from-step continuations while external Session inputs use the frozen Run depth', async () => {
    const depths: number[] = [];
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', workDepth: 2,

      machineAdmissionTransport: vi.fn(),
      createFreshConversation: async () => { throw new Error('continuations must not create'); },
      resolveSharedRunConversation: async () => ({ sessionId: 'step-session', machineId: 'machine-1', directory: '/repo' }),
      resolveProducerConversation: async () => ({ sessionId: 'step-session', machineId: 'machine-1', directory: '/repo' }),
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: '/repo', origin: { kind: 'run_step' as const, runId: 'run-1' }, workDepth: 3,
      }),
      sessionInput: { enqueue: async ({ workDepth }) => {
          depths.push(workDepth!);
          return { status: 'accepted', localId: `input-${depths.length}` };
        },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }),
      },
    });
    const base = {
      runId: 'run-1',
      step: { kind: 'step', id: 'work', document: { text: 'Implement', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'Implement', references: [], attachments: [], values: [] },
      execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } satisfies Parameters<WorkflowStepExecutor>[0];
    await execute({ ...base, execution: { conversation: { kind: 'shared_run' } } });
    await execute({ ...base, execution: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } } });
    await execute({ ...base, execution: { conversation: { kind: 'existing_session', sessionId: 'step-session', machineId: 'machine-1' } } });
    await execute({ ...base, recoveryPreviousExecution: { kind: 'session', sessionId: 'step-session', localInputId: 'prior-input' },
      recoveryPreviousWorkspace: base.workspace,
      invocation: { ...base.invocation, recovery: { conversation: 'same_conversation', input: { kind: 'original' } } } });
    expect(depths).toEqual([3, 3, 2, 3]);
  });

  it('retains owned Discussion model birth depth when recovering the same conversation', async () => {
    let admittedDepth: number | undefined;
    const ref = { discussionId: 'discussion-1', participantSlotId: 'workflow:run-1:logical' };
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', workDepth: 2,
      machineAdmissionTransport: vi.fn(), createFreshConversation: async () => { throw new Error('must retain'); },
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo',
        origin: { kind: 'discussion', discussionParticipant: ref }, workDepth: 4 }),
      sessionInput: { enqueue: async ({ workDepth }) => { admittedDepth = workDepth; return { status: 'accepted', localId: 'input-1' }; },
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: 'done' } }) },
    });
    await expect(execute({ runId: 'run-1',
      step: { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0',
        logicalInvocationRecordId: 'logical', recovery: { conversation: 'same_conversation', input: { kind: 'original' } } },
      recoveryPreviousExecution: { kind: 'session', sessionId: 'model-session', localInputId: 'previous-input' },
      recoveryPreviousWorkspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      origin: { kind: 'direct', discussion: { discussion: { serverId: 'server-1', discussionId: ref.discussionId }, messageId: 'question-1', throughSeq: 1 } },
      participant: { kind: 'model', launch: { executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: { kind: 'path', path: '/repo' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } },
      input: { text: 'Work', references: [], attachments: [], values: [] }, execution: {}, executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    })).resolves.toMatchObject({ kind: 'completed' });
    expect(admittedDepth).toBe(4);
  });

  it('titles freshly created step Sessions with the authored name or prompt and frozen ordinal (FIN M3)', async () => {
    // The real creator forwards the title to the process-launch boundary.
    const launches = installSessionCreationTransport();
    const createFreshConversation = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'run-1', machineAdmissionTransport: vi.fn(),
      discussionOrigin: { discussion: { serverId: 'server-1', discussionId: 'discussion-1' }, messageId: 'question-1', throughSeq: 1 },
    });
    const personallyRenamed = { sessionId: 'shared', machineId: 'machine-1', directory: '/repo', title: 'My own title',
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      runtimeSelection: { connectedServices: { v: 2 as const, bindingsByServiceId: {} } } };
    const conversations = createProductionWorkflowConversationOwner({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1', createFreshConversation,
      resolveSharedRunConversation: async () => ({ sessionId: 'shared', machineId: 'machine-1', directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        runtimeSelection: { connectedServices: { v: 2, bindingsByServiceId: {} } } }),
      resolveProducerConversation: async () => ({ sessionId: 'shared', machineId: 'machine-1', directory: '/repo',
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
        runtimeSelection: { connectedServices: { v: 2, bindingsByServiceId: {} } } }),
      resolveExistingSessionConversation: async () => personallyRenamed,
    });
    const base = {
      runId: 'run-1', stepOrdinal: '3',
      step: { kind: 'step', id: 'work', name: 'Implement', document: { text: 'A different prompt', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'logical' },
      input: { text: 'Implement', references: [], attachments: [], values: [] },
      execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } }, connectedServices: { v: 2, bindingsByServiceId: {} } },
      executionTarget: { kind: 'session' },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async () => {},
    } satisfies Parameters<WorkflowStepExecutor>[0];
    const fresh = base;
    await conversations.materialize(await conversations.prepare(fresh), fresh);
    expect(launches.at(-1)).toMatchObject({ initialTitle: '3 · Implement' });
    const scalarItem = { ...fresh, invocation: { ...fresh.invocation, logicalInvocationRecordId: 'logical-scalar' }, item: { value: 'parser.ts', index: 3, position: 4, count: 8 } };
    await conversations.materialize(await conversations.prepare(scalarItem), scalarItem);
    expect(launches.at(-1)).toMatchObject({ initialTitle: '3 · Implement · parser.ts' });
    const structuredItem = { ...fresh, invocation: { ...fresh.invocation, logicalInvocationRecordId: 'logical-structured' }, item: { value: { name: 'Not a label' }, index: 3, position: 4, count: 8 } };
    await conversations.materialize(await conversations.prepare(structuredItem), structuredItem);
    expect(launches.at(-1)).toMatchObject({ initialTitle: '3 · Implement · 4' });
    const { name: _name, ...unnamedStep } = fresh.step;
    const empty = { ...scalarItem, invocation: { ...fresh.invocation, logicalInvocationRecordId: 'logical-unnamed' }, step: unnamedStep };
    await conversations.materialize(await conversations.prepare(empty), empty);
    expect(launches.at(-1)).toMatchObject({ initialTitle: '3 · A different prompt · parser.ts' });
    const shared = { ...fresh, execution: { ...fresh.execution, conversation: { kind: 'shared_run' as const } } };
    expect(launches).toHaveLength(4);
    await conversations.materialize(await conversations.prepare(shared), shared);
    const fromStep = { ...fresh, execution: { ...fresh.execution,
      conversation: { kind: 'from_step' as const, producer: { blockId: 'prior', scope: { kind: 'current' as const } } } } };
    await conversations.materialize(await conversations.prepare(fromStep), fromStep);
    const existing = { ...fresh, execution: { ...fresh.execution,
      conversation: { kind: 'existing_session' as const, sessionId: 'shared', machineId: 'machine-1' } } };
    expect(await conversations.materialize(await conversations.prepare(existing), existing)).toBe(personallyRenamed);
    const retained = { ...fresh,
      recoveryPreviousExecution: { kind: 'session' as const, sessionId: 'shared', localInputId: 'prior-input' },
      recoveryPreviousWorkspace: fresh.workspace,
      invocation: { ...fresh.invocation, recovery: { conversation: 'same_conversation' as const, input: { kind: 'original' as const } } } };
    expect(await conversations.materialize(await conversations.prepare(retained), retained)).toBe(personallyRenamed);
    expect(personallyRenamed.title).toBe('My own title');
    expect(launches).toHaveLength(4);
  });





  it('preserves the provider failure message and owner-reported usage when the exact Session input fails', async () => {
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),

      materializeConversation: async () => ({
        sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
      }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: {
            kind: 'failed', message: 'provider failed',
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
          },
        }),
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({
      kind: 'failed', code: 'session_input_failed',
      message: 'provider failed',
      usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
    });
  });

  it('preserves terminal cancellation and usage instead of replacing them with a stop acknowledgement', async () => {
    const cancel = vi.fn(async () => ({ kind: 'pending_retired' as const }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),

      materializeConversation: async () => ({
        sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
      }),
      sessionInput: { enqueue: async () => ({ status: 'accepted', localId: 'local-1' }),
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: {
            kind: 'cancelled', message: 'provider cancelled',
            usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
          },
        }),
        cancel,
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({
      kind: 'cancelled', code: 'session_input_cancelled',
      usage: { inputTokens: 8, outputTokens: 3, costUsd: 0.02 },
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it('admits the current Session path without a protocol capability read', async () => {
    const materializeConversation = vi.fn(async () => ({
      sessionId: 'session-1', machineAdmissionTransport: vi.fn(),
    }));
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },
      prepareConversation: async () => ({
        kind: 'workflow_session_conversation',
        existing: null,
      }),

      materializeConversation,
      sessionInput: { enqueue,
        observe: async () => ({
          ok: true, sessionId: 'session-1', localId: 'local-1',
          result: { kind: 'final_text', text: 'done' },
        }),
      },
    } as Parameters<typeof createWorkflowSessionStepExecutor>[0]);

    await expect(execute({
      runId: 'run-1', stepOrdinal: '5', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'completed', result: 'done' });
    expect(materializeConversation).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    // The step's visible number is stamped on its input's provenance at write time.
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ workflow: expect.objectContaining({ stepOrdinal: '5' }) }));
  });

  it('persists exact input correspondence after admission and before observation', async () => {
    const events: string[] = [];
    const enqueueWorkflowSessionInput = vi.fn();
    const observeWorkflowSessionInputResult = vi.fn();
    enqueueWorkflowSessionInput.mockResolvedValue({ status: 'accepted', localId: 'local-1' });
    observeWorkflowSessionInputResult.mockImplementation(async () => {
      events.push('observe');
      return { ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async (params) => {
        expect(params.workspace).toEqual({ machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' });
        return { kind: 'workflow_session_conversation', existing: null };
      },
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue: enqueueWorkflowSessionInput,
        observe: observeWorkflowSessionInputResult,
      },
    });
    await expect(execute({
      runId: 'run-1', step: { timeoutMs: 100 }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: async (value: Parameters<WorkflowStepExecutor>[0]['invocation']['execution']) => {
        events.push('commit');
        expect(value).toEqual({ kind: 'session', sessionId: 'session-1', localInputId: 'local-1' });
      },
    } as never)).resolves.toEqual({ kind: 'completed', result: 'done' });
    expect(events).toEqual(['commit', 'observe']);
  });

  it('reobserves durable Session correspondence without preparing or enqueueing a second input', async () => {
    const prepareConversation = vi.fn();
    const enqueue = vi.fn();
    const observe = vi.fn(async () => ({
      ok: true as const,
      sessionId: 'session-1',
      localId: 'local-1',
      result: { kind: 'final_text' as const, text: 'rejoined' },
    }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue, observe },
    });
    await expect(execute({
      runId: 'run-1', step: {},
      invocation: {
        logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'completed', result: 'rejoined' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'session-1', localId: 'local-1' }));
  });

  it('propagates the coordinator currentness signal to an in-flight Session observation without a default deadline', async () => {
    const controller = new AbortController();
    const observe = vi.fn(async (input: { signal?: AbortSignal; deadlineMs?: number }) => {
      expect(input.signal).toBe(controller.signal);
      expect(input).not.toHaveProperty('deadlineMs');
      controller.abort();
      return {
        ok: true as const,
        sessionId: 'session-1',
        localId: 'local-1',
        result: { kind: 'cancelled' as const, message: 'cancelled' },
      };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(),
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), observe,
        cancel: async () => ({ kind: 'turn_cancel_requested' }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'cancelled', code: 'session_input_cancelled' });
  });

  it('reports an aborted exact observation as cancellation rather than attention', async () => {
    const controller = new AbortController();
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(),
        observe: async () => ({ ok: false, code: 'cancelled' }),
        cancel: async () => ({ kind: 'pending_retired' }),
      },
    });
    await expect(execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'cancelled', code: 'session_input_pending_retired' });
  });

  it('refuses to reinterpret detached Run correspondence as Session correspondence', async () => {
    const prepareConversation = vi.fn();
    const observe = vi.fn();
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation,
      materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), observe },
    });
    await expect(execute({
      runId: 'run-1', step: {},
      invocation: {
        logicalInvocationRecordId: 'inv-1',
        execution: { kind: 'detached_run', runId: 'execution-run-1', localInputId: 'local-1' },
      },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_execution_target_mismatch' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(observe).not.toHaveBeenCalled();
  });

  it('adds the canonical per-turn result instruction before exact Session admission', async () => {
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: '"continue"' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'decision', decisions: ['continue', 'stop'] } },
      invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'Judge', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Return only one strict JSON string'),
    }));
  });

  it('refuses a step broader than the immutable admitted Run ceiling before Session mutation', async () => {
    const prepareConversation = vi.fn();
    const enqueue = vi.fn();
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, prepareConversation,

      materializeConversation: vi.fn(),
      sessionInput: { enqueue, observe: vi.fn(), cancel: vi.fn() },
    });
    await expect(execute({
      runId: 'run-1', step: {}, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo' },
      authorization: { admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never)).resolves.toEqual({ kind: 'failed', code: 'workflow_permission_escalation_denied' });
    expect(prepareConversation).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('leaves live Session permission revalidation with canonical input admission', async () => {
    const read = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => url.endsWith('/reply-capability')
      ? { status: 200, data: { v: 1, protocolVersions: [1] } } : read(url));
    const credentials = { token: 'token', encryption: null };
    const machineAdmissionTransport = vi.fn(async (_request: Parameters<Parameters<typeof createProductionWorkflowSessionStepExecutor>[0]['machineAdmissionTransport']>[0]) => ({
      status: 'rejected' as const,
      code: 'session_input_permission_ceiling_rejected' as const,
    }));
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials, machineId: 'machine-1', machineAdmissionTransport,
      createFreshConversation: createProductionFreshWorkflowSessionConversation({
        credentials, serverId: 'server-1', machineId: 'machine-1', workDepth: 0,
        originRunId: 'run-1', machineAdmissionTransport,
      }),
      resolveSharedRunConversation: async () => null, resolveProducerConversation: async () => null,
      resolveExistingSessionConversation: async () => ({ sessionId: 'session-1', machineId: 'machine-1', directory: '/repo' }),
    });
    await expect(execute({
      runId: 'run-1',
      step: { kind: 'step', id: 'work', document: { text: 'work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      invocation: { kind: 'happier.workflow-progress.v1', blockKind: 'step', invocationPath: { blockId: 'work', scope: [] }, attempt: '0', logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] },
      execution: { permissionMode: 'safe-yolo', conversation: { kind: 'existing_session', sessionId: 'session-1', machineId: 'machine-1' } },
      executionTarget: { kind: 'session' },
      authorization: {
        admittedPermissionCeiling: 'safe-yolo',
        principal: { kind: 'host' },
        sourceAuthority: {
          mediatorPluginId: 'happier.channels',
          sourceRef: 'channels:binding:binding-1',
          sourceRevisionOrEpoch: '4:7',
          remoteApprovalMaxScope: 'session',
        },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    })).resolves.toEqual({
      kind: 'failed',
      code: 'session_input_permission_ceiling_rejected',
    });
    expect(machineAdmissionTransport).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1', targetMachineId: 'machine-1',
      content: { t: 'plain', v: expect.objectContaining({
        meta: expect.objectContaining({ happierInputRequestV1: expect.objectContaining({
          permission: { requestedPermissionCeiling: 'safe-yolo' },
          sourceAuthority: {
            mediatorPluginId: 'happier.channels',
            sourceRef: 'channels:binding:binding-1',
            sourceRevisionOrEpoch: '4:7',
            remoteApprovalMaxScope: 'session',
          },
        }) }),
      }) },
    }), expect.anything());
  });

  it('uses the contextual default rather than widening an omitted Session step to the Run ceiling', async () => {
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({
        kind: 'workflow_session_conversation', existing: null,
      }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'safe-yolo', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ permissionMode: 'default' }));
  });

  it.each([
    { kind: 'turn_cancel_requested' as const },
    { kind: 'turn_cancel_refused' as const, status: 'notRunning' as const, code: 'notRunning' },
  ])('observes the exact accepted Session input after cancellation ($kind) and preserves its real terminal result', async (cancellation) => {
    const controller = new AbortController();
    const cancel = vi.fn(async () => cancellation);
    const observe = vi.fn(async (input: { signal?: AbortSignal }) => {
      if (!input.signal) return { ok: true as const, sessionId: 'session-1', localId: 'local-1',
        result: { kind: 'final_text' as const, text: 'finished before cancellation', usage: { inputTokens: 2, outputTokens: 3 } } };
      expect(input.signal).toBe(controller.signal);
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false as const, code: 'cancelled' as const };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), cancel,
        observe,
      },
    });
    const execution = execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    controller.abort(WORKFLOW_CANCEL_REQUESTED_ABORT_REASON);

    await expect(execution).resolves.toEqual({ kind: 'completed', result: 'finished before cancellation', usage: { inputTokens: 2, outputTokens: 3 } });
    expect(cancel).toHaveBeenCalledWith({
      credentials: { token: 'token', encryption: null },
      sessionId: 'session-1', localId: 'local-1',
    });
  });

  it('leaves the accepted Session input running when the claim is interrupted without a cancellation reason', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const observe = vi.fn(async (input: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return { ok: false as const, code: 'cancelled' as const };
    });
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: vi.fn(), materializeConversation: vi.fn(),
      sessionInput: { enqueue: vi.fn(), cancel, observe },
    });
    const execution = execute({
      runId: 'run-1', step: {}, signal: controller.signal,
      invocation: { logicalInvocationRecordId: 'inv-1', execution: { kind: 'session', sessionId: 'session-1', localInputId: 'local-1' } },
      input: { text: 'work', references: [], attachments: [], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    await vi.waitFor(() => expect(observe).toHaveBeenCalledOnce());
    // Daemon shutdown / lease loss: this attempt only stops observing.
    controller.abort();

    await expect(execution).rejects.toBeInstanceOf(WorkflowRuntimeInterruption);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('carries portable Composer attachments into canonical Session structured-input admission', async () => {
    const attachment = {
      v: 1 as const,
      instanceId: 'workflow-attachment-1',
      attachment: { pluginId: 'acme.review', localId: 'review-context' },
      key: 'review-42',
      value: { reviewId: 42 },
      presentation: { label: 'Review 42', typeLabel: 'Review' },
    };
    const enqueue = vi.fn(async () => ({ status: 'accepted' as const, localId: 'local-1' }));
    const execute = createWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null },

      prepareConversation: async () => ({ kind: 'workflow_session_conversation', existing: null }),
      materializeConversation: async () => ({ sessionId: 'session-1', machineAdmissionTransport: vi.fn() }),
      sessionInput: { enqueue,
        observe: async () => ({ ok: true, sessionId: 'session-1', localId: 'local-1', result: { kind: 'final_text', text: 'done' } }),
      },
    });
    await execute({
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1' },
      input: { text: 'Review', references: [], attachments: [attachment], values: [] }, execution: {},
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    } as never);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ attachments: [attachment] }));
  });

  it('materializes shared, fresh, from-step, and existing conversations without a workflow-owned Session registry', async () => {
    const createFreshConversation = vi.fn(async () => ({ sessionId: 'new-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const resolveSharedRunConversation = vi.fn(async () => ({ sessionId: 'shared-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const resolveProducerConversation = vi.fn(async () => ({ sessionId: 'producer-session', machineId: 'machine-1', directory: '/repo/subdir' }));
    const execute = createProductionWorkflowSessionStepExecutor({
      credentials: { token: 'token', encryption: null }, machineId: 'machine-1',

      machineAdmissionTransport: vi.fn(), createFreshConversation,
      resolveSharedRunConversation, resolveProducerConversation,
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId, directory: '/repo/subdir' }),
      sessionInput: { enqueue: async ({ sessionId }) => ({ status: 'accepted', localId: `local-${sessionId}` }),
        observe: async ({ sessionId, localId }) => ({ ok: true, sessionId, localId, result: { kind: 'final_text', text: sessionId } }),
      },
    });
    const base = {
      runId: 'run-1', step: { result: { kind: 'text' } }, invocation: { logicalInvocationRecordId: 'inv-1', invocationPath: { blockId: 'work', scope: [] } },
      input: { text: 'work', references: [], attachments: [], values: [] },
      authorization: { admittedPermissionCeiling: 'default', principal: { kind: 'host' } },
      workspace: { machineId: 'machine-1', directory: '/repo/subdir', checkoutRootPath: '/repo' }, beforeInputAdmission: async () => {}, onInputAccepted: vi.fn(),
    };
    await expect(execute({ ...base, execution: { conversation: { kind: 'shared_run' } } } as never)).resolves.toMatchObject({ result: 'shared-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-2' }, execution: { conversation: { kind: 'fresh' }, agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } } } as never)).resolves.toMatchObject({ result: 'new-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-3' }, execution: { conversation: { kind: 'from_step', producer: { blockId: 'prior', scope: { kind: 'current' } } } } } as never)).resolves.toMatchObject({ result: 'producer-session' });
    await expect(execute({ ...base, invocation: { ...base.invocation, logicalInvocationRecordId: 'inv-4' }, execution: { conversation: { kind: 'existing_session', sessionId: 'existing-session', machineId: 'machine-1' } } } as never)).resolves.toMatchObject({ result: 'existing-session' });
    expect(createFreshConversation).toHaveBeenCalledWith(expect.objectContaining({
      creationKey: 'workflow:run-1:inv-2',
      workspace: { machineId: 'machine-1', directory: '/repo/subdir', checkoutRootPath: '/repo' },
      selection: expect.objectContaining({
        agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      }),
    }));
  });

  it('compares retained Session workspace paths through the canonical cross-platform path owner', async () => {
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1',
      createFreshConversation: vi.fn(),
      resolveSharedRunConversation: async () => ({
        sessionId: 'shared-session',
        machineId: 'machine-1',
        directory: 'C:\\Users\\Alice\\repo\\packages\\app',
      }),
      resolveProducerConversation: vi.fn(),
      resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({ sessionId, machineId,
        directory: 'C:\\Users\\Alice\\repo\\packages\\app' }),
    });

    const prepared = await conversations.prepare({
      runId: 'run-1',
      invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
    } as never);
    expect(prepared).toMatchObject({ existing: { sessionId: 'shared-session' } });
    await expect(conversations.materialize(prepared, {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      step: { kind: 'step', id: 'work', document: { text: 'Work', references: [], attachments: [] }, input: [], result: { kind: 'text' } },
      execution: { conversation: { kind: 'shared_run' } },
      workspace: {
        machineId: 'machine-1',
        directory: 'c:/users/alice/repo/packages/app',
        checkoutRootPath: 'c:/users/alice/repo',
      },
    } as never)).resolves.toMatchObject({ sessionId: 'shared-session' });

    const sibling = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: vi.fn(),
      resolveSharedRunConversation: async () => ({
        sessionId: 'shared-session', machineId: 'machine-1',
        directory: 'C:\\Users\\Alice2\\repo\\packages\\app',
      }),
      resolveProducerConversation: vi.fn(), resolveExistingSessionConversation: async ({ sessionId, machineId }) => ({
        sessionId, machineId, directory: 'C:\\Users\\Alice2\\repo\\packages\\app',
      }),
    });
    const siblingPrepared = await sibling.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
    } as never);
    await expect(sibling.materialize(siblingPrepared, {
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: { conversation: { kind: 'shared_run' } },
      workspace: {
        machineId: 'machine-1', directory: 'c:/users/alice/repo/packages/app',
        checkoutRootPath: 'c:/users/alice/repo',
      },
    } as never)).rejects.toMatchObject({ code: 'conversation_workspace_mismatch', details: { reason: 'workspace_mismatch' } });
  });

  it('rejects an existing Session with a new worktree during conversation preflight', async () => {
    const resolveExistingSessionConversation = vi.fn();
    const conversations = createProductionWorkflowConversationOwner({
      machineId: 'machine-1', createFreshConversation: vi.fn(),
      resolveSharedRunConversation: vi.fn(), resolveProducerConversation: vi.fn(),
      resolveExistingSessionConversation,
    });

    await expect(conversations.prepare({
      runId: 'run-1', invocation: { logicalInvocationRecordId: 'inv-1' },
      execution: {
        conversation: { kind: 'existing_session', sessionId: 'session-1', machineId: 'machine-1' },
        workspace: { kind: 'new_worktree', source: { kind: 'original' } },
      },
    } as never)).rejects.toMatchObject({ code: 'conversation_workspace_mismatch', details: { reason: 'workspace_mismatch',
      expected: { kind: 'object', ids: ['new_worktree'] } } });
    expect(resolveExistingSessionConversation).not.toHaveBeenCalled();
  });

  it.each([{ miswired: false, pending: false }, { miswired: false, pending: true }, { miswired: true, pending: false }])('spawns a literal-engine Workflow leaf on its origin Session non-default Connected profile (miswired=$miswired, pending=$pending)', async ({ miswired, pending }) => {
    const launches = installSessionCreationTransport();
    const originSessionId = 'c111111111111111111111111';
    const credentials = { token: 'token', encryption: null };
    installWorkflowRoleAccount(credentials);
    const agentTarget = { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.codex', localId: 'codex' } };
    const connectedServices = { v: 2 as const, bindingsByServiceId: {
      'happier.agent.codex/openai-codex': { source: 'connected' as const, selection: 'profile' as const, profileId: 'origin-non-default' },
    } };
    const read = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => url.includes('/v1/artifacts')
      ? { status: 200, data: artifactKindListResponse([]) } : url.endsWith(`/v2/sessions/${originSessionId}`)
      ? { status: 200, data: { session: createSessionRecordFixture({ id: originSessionId, active: !pending, encryptionMode: 'plain', workDepth: 0,
        metadataLayoutVersion: 1, metadata: JSON.stringify({ v: 1 }), share: null,
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1({ v: 1,
          workspace: { machineId: 'machine-1', path: '/repo' },
          nativeSession: { runtimeDescriptorV1: { v: 1, agentId: 'codex', agent: {} } },
          connectedServices: { connectedServices },
          ...(pending ? { runtime: {
            modelSelectionIntentV1: { v: 1, selection: { agentTargetKey: 'agent:happier.agent.codex/codex',
              providerConnectionId: null, modelId: 'origin-pending-model' }, updatedAt: 2 },
            sessionModelsV1: { v: 1, agentId: 'codex', updatedAt: 1, currentModelId: 'origin-applied-model', availableModels: [],
              activeSelectionV1: createSessionActiveModelSelection({ selection: { agentTargetKey: 'agent:happier.agent.codex/codex',
                providerConnectionId: null, modelId: 'origin-applied-model' }, source: 'runtime_readback',
                runner: { pid: 1, processStartTimeMs: 1 }, teamCredentialModel: null }) ?? undefined },
          } } : {}),
        }),
      }) } } : read(url));
    const origin = await resolveWorkflowSessionConversation({ credentials, sessionId: originSessionId, machineId: 'machine-1' });
    expect(origin).not.toBeNull();
    if (!origin) throw new Error('Origin Session unavailable');
    const modelSelection = { v: 1 as const, updatedAt: 1, ref: {
      agentTargetKey: 'agent:happier.agent.codex/codex', providerConnectionId: null, modelId: 'gpt-6-luna',
    } };
    const definition = { version: 1 as const, defaults: { agentTarget, modelSelection, sessionConfigOptionOverrides: { v: 1 as const, updatedAt: 0, overrides: { reasoning_effort: { value: 'low', updatedAt: 0 } } } },
      blocks: [{ kind: 'step' as const, id: 'work', document: { text: 'Reply READY.', references: [], attachments: [] } }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: {}, machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } },
        origin: { kind: 'direct', originSessionId }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, roleSelection: projectWorkflowConversationRoleSelection(origin, miswired ? 'other-machine' : origin.machineId),
      effects: { resolveTargetAvailability: async () => true } });
    expect(accepted.ok, JSON.stringify(accepted)).toBe(true);
    if (!accepted.ok) throw new Error(accepted.error.code);
    const leaf = accepted.snapshot.materializedLeaves[0]!;
    expect(leaf.selection.connectedServices).toEqual(miswired ? undefined : connectedServices);
    if (miswired) return;
    const create = createProductionFreshWorkflowSessionConversation({ credentials,
      serverId: 'server-1', machineId: 'machine-1', workDepth: 0, originRunId: 'run-1', originSessionId,
      machineAdmissionTransport: vi.fn() });
    await expect(create({ selection: resolveWorkflowAcceptedStepSelectionV1(leaf).selection,
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-1:connected-leaf' })).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(launches).toMatchObject([{ connectedServices, originSessionId, manager: { sessionId: originSessionId }, modelSelection,
      sessionConfigOptionOverrides: { overrides: { reasoning_effort: { value: 'low' } } } }]);
    const snapshot = readSessionRolesV1(spawnedSessionBirthMetadata.get('new-session'));
    expect(snapshot?.inheritedFrom).toBe(originSessionId);
    expect(snapshot?.sessionRoles.builder.engine).toEqual({ agentTargetKey: modelSelection.ref.agentTargetKey,
      modelId: modelSelection.ref.modelId });
    expect(snapshot?.sessionRoles.reviewer.engine).toEqual(snapshot?.sessionRoles.builder.engine);
    expect(Object.values(snapshot?.sessionRoles ?? {}).map(role => role.engine?.modelId))
      .not.toContain('origin-pending-model');
    expect(Object.values(snapshot?.sessionRoles ?? {}).map(role => role.engine?.modelId))
      .not.toContain('origin-applied-model');
  });

  it.each(['profile:step', null] as const)('refuses a selected approval reference without canonical startup admission: %s', async approvalProfileId => {
    const launches = installSessionCreationTransport();
    const create = createUnadmittedFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null },
      serverId: 'server-1',
      machineId: 'machine-1',
      workDepth: 2,
      originRunId: 'run-1',
      machineAdmissionTransport: vi.fn(),
    });
    const agentTarget = {
      kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
    };
    await expect(create({
      selection: {
        agentTarget,
        approvalProfileId,
        connectedServices: { v: 2, bindingsByServiceId: {} },
        permissionMode: 'read_only',
        allowedTools: ['mcp__wilson-brief__*'],
        unlistedTools: 'deny',
        sessionConfigOptionOverrides: { v: 1, updatedAt: 1, overrides: {} },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-1:inv-1',
    })).rejects.toMatchObject({ code: 'approval_context_unavailable' });
    expect(launches).toEqual([]);
  });

  it.each([
    [undefined, true],
    [undefined, false],
    [undefined, undefined],
    ['integrated', true],
  ] as const)('preserves ordinary launch preparation and frozen Workflow selections (terminal=%s, memory=%s)', async (terminalMode, memoryEnabled) => {
    const launches = installSessionCreationTransport();
    const credentials = { token: 'token', encryption: null };
    const launch = SessionSpawnNewInputV2Schema.parse({
      creationKey: 'ordinary-preparation-parity',
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } },
      modelSelection: { v: 1, updatedAt: 7, ref: { agentTargetKey: 'agent:happier.agent.claude/claude',
        providerConnectionId: null, modelId: 'frozen-model' } },
      permissionMode: 'read-only', connectedServices: { v: 2, bindingsByServiceId: {} },
      ...(terminalMode ? { terminal: { mode: terminalMode } } : {}),
      ...(memoryEnabled === undefined ? {} : { memoryEnabled }),
    });
    const { executor } = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: '', mode: 'plain', ctx: null,
      serverId: 'server-1', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      // Replace only exact-Machine IPC; both paths run the real target and birth owners.
      sessionSpawnDirectTargetTransport: { machineId: 'machine-1',
        readMachineMetadataSnapshot: () => ({ status: 'ready', metadataVersion: 1, metadata: {} }),
        prepare: (request, options) => prepareSessionCreationTarget({ request, signal: options?.signal }),
        spawnedSession: { spawn: async (request) => readiness.callMachineRpc({ method: RPC_METHODS.SPAWN_HAPPY_SESSION, request }),
          resolveSpawnSessionByNonce: async () => ({ status: 'not_found' }) },
      },
      machineActionDirectTargetTransport: { machineId: 'machine-1', invoke: async (method, request, options) => {
        if (method === RPC_METHODS.DAEMON_SESSION_CREATION_PREPARE
          || method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) {
          return await prepareSessionCreationTarget({ request: SessionCreationTargetPreparationRequestV1Schema.parse(request),
            signal: options?.signal });
        }
        return await readiness.callMachineRpc({ method, request });
      } },
    });
    const ordinaryExecution = await executor.execute('session.spawn_new', launch, {
      surface: 'cli', authority: 'present_user', serverId: 'server-1', actionCaller: { kind: 'host' },
    });
    expect(ordinaryExecution, JSON.stringify(ordinaryExecution)).toMatchObject({ ok: true });
    const ordinaryResult = ordinaryExecution.ok ? ordinaryExecution.result : null;
    expect(ordinaryResult, JSON.stringify(ordinaryResult)).toMatchObject({ type: 'success', sessionId: 'new-session' });
    const create = createProductionFreshWorkflowSessionConversation({ credentials, serverId: 'server-1',
      machineId: 'machine-1', workDepth: 0, originRunId: 'preparation-parity', machineAdmissionTransport: vi.fn() });
    await expect(create({ launch, selection: { agentTarget: launch.agentTarget,
      modelSelection: { ...launch.modelSelection!, ref: { ...launch.modelSelection!.ref, modelId: 'later-mutable-model' } } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:preparation-parity:step',
    })).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(launches).toHaveLength(2);
    const [ordinary, workflow] = launches;
    expect(workflow).toMatchObject({ directory: ordinary!.directory,
      modelSelection: ordinary!.modelSelection, permissionMode: ordinary!.permissionMode });
    expect(workflow!.modelSelection?.ref.modelId).toBe('frozen-model');
    if (terminalMode === 'integrated') {
      for (const launched of launches) {
        expect(resolveTerminalRequestFromSpawnOptions({ happyHomeDir: '/happier', terminal: launched.terminal,
          environmentVariables: { TMUX_SESSION_NAME: 'profile-terminal' } })).toEqual({ requested: 'plain' });
      }
    }
    const { approvalProfileId: ordinaryApproval, ...ordinaryRecipe } = ordinary!.sessionCreationCorrespondence!.recipe;
    const { approvalProfileId: workflowApproval, ...workflowRecipe } = workflow!.sessionCreationCorrespondence!.recipe;
    // The Workflow Action host explicitly selects full trust; ordinary present-user admission resolves its own policy.
    expect(ordinaryApproval).toBeNull();
    expect(workflowApproval).toBe('builtin:full-trust');
    expect(workflowRecipe).toEqual(ordinaryRecipe);
  });

  it.each([false, true])('preserves the model recipe and applies the accepted read-only step restriction (%s)', async restricted => {
    const launches = installSessionCreationTransport();
    installWorkflowLaunchProfileAccount({ token: 'token', encryption: null }, LaunchProfileV2Schema.parse({
      v: 2, id: 'chosen-profile', name: 'Chosen Profile', createdAt: 1, updatedAt: 1,
    }));
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'run-model', machineAdmissionTransport: vi.fn(),
    });
    const agentTarget = { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const modelSelection = { v: 1 as const, updatedAt: 12, ref: {
      agentTargetKey: 'agent:happier.agent.claude/claude', providerConnectionId: null, modelId: 'chosen-model',
    } };
    const launch = {
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/review' }, agentTarget, modelSelection,
      profileId: 'chosen-profile', permissionMode: 'default' as const, agentModeId: 'plan',
      configuration: { mode: { value: 'plan', updatedAtMs: 9 }, model: { value: 'chosen-model', updatedAtMs: 12 },
        permissionIntent: { value: 'default' as const, updatedAtMs: 10 }, workspaceWrites: 'deny' as const,
        options: { reasoning_effort: { value: 'high', updatedAtMs: 11 } } },
      connectedServices: { v: 2 as const, bindingsByServiceId: {} },
      organizationPlacement: { folderId: null, tagIds: [] }, memoryEnabled: false,
      title: 'Chosen participant', transcriptStorage: 'direct' as const,
    };
    await expect(create({ selection: restricted ? { permissionMode: 'read-only' } : {}, launch, workspace: { machineId: 'machine-1', directory: '/review', checkoutRootPath: '/review' },
      creationKey: 'workflow:run-model:inv-1' })).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(launches).toEqual([expect.objectContaining({
      originKind: 'run_step', originRunId: 'run-model', directory: '/review',
      backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' }, modelSelection,
      profileId: 'chosen-profile', permissionMode: restricted ? 'read-only' : 'default', agentModeId: 'plan', workspaceWrites: 'deny',
      sessionConfigOptionOverrides: expect.objectContaining({ overrides: { reasoning_effort: { value: 'high', updatedAt: 11 } } }),
      connectedServices: { v: 2, bindingsByServiceId: {} }, memoryEnabled: false,
      initialTitle: 'Chosen participant', transcriptStorage: 'direct',
    })]);
  });

  it('launches an authored Workflow step with every New Session choice the step or its defaults set', async () => {
    const launches = installSessionCreationTransport();
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'run-choices', machineAdmissionTransport: vi.fn(),
    });
    const choices = {
      title: 'Nightly review', organizationPlacement: { folderId: 'folder-1', tagIds: ['tag-1'] }, memoryEnabled: false,
      secretReferenceOverlay: { v: 1 as const, bindings: { OPENAI_API_KEY: { ref: 'happier:shared-secret:v1:shared-1', revision: 7 } } },
      teamCredentialBindings: SessionTeamCredentialBindingIntentsV1Schema.parse([{ v: 1, slot: { kind: 'connected_service_purpose',
        purpose: { consumer: { pluginId: 'happier.agent.claude', localId: 'claude' }, purpose: 'repository_api' } },
        resourceId: 'resource-2', expectedResourceRevision: 3, deliveryMode: 'direct' }]),
    };
    const agentTarget = { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    await expect(create({ selection: { agentTarget, connectedServices: { v: 2, bindingsByServiceId: {} }, ...choices },
      workspace: { machineId: 'machine-1', directory: '/review', checkoutRootPath: '/review' },
      creationKey: 'workflow:run-choices:inv-1', initialTitle: 'Derived step title' })).resolves.toMatchObject({ sessionId: 'new-session' });
    const { title, organizationPlacement, ...spawned } = choices;
    // Folder and tags are recorded in the Session's creation recipe, exactly as for an ordinary New Session.
    expect(launches).toEqual([expect.objectContaining({ ...spawned, initialTitle: title,
      sessionCreationCorrespondence: expect.objectContaining({ recipe: expect.objectContaining({ organization: organizationPlacement }) }) })]);
  });

  it.each([
    { denied: false, boundSessionId: 'new-session', policy: 'waive', surface: 'agent' },
    { denied: true, boundSessionId: 'new-session', policy: 'waive', surface: 'agent' },
    { denied: false, boundSessionId: 'stale-run-step', policy: 'waive', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'require', surface: 'cli' },
    { denied: false, boundSessionId: 'new-session', policy: 'require', surface: 'ui' },
    { denied: false, boundSessionId: 'new-session', policy: 'default', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'reject', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'disabled', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-reclaim', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-unknown', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-reject', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-automation', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-current-require', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-missing-starter', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-substituted-starter', surface: 'agent' },
    { denied: false, boundSessionId: 'new-session', policy: 'composed-replay-profile', surface: 'agent' },
  ] as const)('creates a selected Discussion model only after reserving its retained ordinary participant slot (%j)', async ({ denied, boundSessionId, policy, surface }) => {
    const launches = installSessionCreationTransport();
    const spawnAdmissions = observeSessionSpawnAdmissions();
    const frozenRole = policy === 'waive' && !denied && boundSessionId === 'new-session'
      ? { ...resolveRolesSnapshotV1({ defaultEngine: { agentTargetKey: 'agent:happier.agent.claude/claude' } }).builder!,
        roleId: 'plugin:external.roles/frozen-reviewer', instructions: 'Frozen Discussion review instructions', workspaceWrites: 'deny' as const }
      : undefined;
    const externalAgent = policy === 'composed';
    if (externalAgent) {
      const baseline = readCurrentContributionRegistry();
      const plugin = definePlugin({ id: 'external.review-agent', version: '1.0.0', entrypoints: { daemon: './daemon.mjs' },
        agents: { reviewer: { declaration: { title: 'External reviewer', runtime: { kind: 'custom' }, primary: 'sessions',
          capabilities: { sessions: { open: ['create'], delivery: ['newTurn'], cancel: true, workspaceWrites: 'deny' } } },
          factory: async () => ({ sessions: { async open() { throw new Error('Session startup uses the Machine process boundary'); } } }),
          sessionRunnerFactory: { module: './agent.mjs', export: 'createRuntime', runtimeApiVersion: 1 },
        } } });
      const admitted = await createAuthoredAdmittedPluginRuntimeFixture({ controller: pluginReloadController,
        plugins: [{ manifest: plugin.manifest, files: {
          'agent.mjs': 'export async function createRuntime() { return { sessions: { async open() { throw new Error("Machine process boundary"); } } }; }',
          'daemon.mjs': 'import { createRuntime } from "./agent.mjs"; export function activate(api) { api.agents.register("reviewer", createRuntime, { sessionRunnerFactory: { module: "./agent.mjs", export: "createRuntime", runtimeApiVersion: 1 } }); }',
        } }] });
      onTestFinished(async () => {
        await admitted.dispose();
        await pluginReloadController.adoptPreparedRuntimeRegistry({
          registry: await resolveExecutablePluginRuntimeRegistry({ contributes: baseline, pluginIds: [] }),
          changedPluginIds: ['external.review-agent'], runningSessionDisposition: 'retainRunningSessions',
        });
      });
    }
    const launch = { executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/repo' },
      agentTarget: { kind: 'agent' as const, identity: externalAgent
        ? { pluginId: 'external.review-agent', localId: 'reviewer' }
        : { pluginId: 'happier.agent.claude', localId: 'claude' } },
      connectedServices: { v: 2 as const, bindingsByServiceId: {} },
      ...(frozenRole ? { roleId: frozenRole.roleId, permissionMode: 'read-only' as const, approvalProfileId: 'builtin:full-trust' } : {}) };
    const creationKey = 'workflow:discussion-run:invocation-1';
    const ref = { discussionId: 'discussion-1', participantSlotId: creationKey };
    const reservations: unknown[] = [];
    const births: unknown[] = [];
    const originalPost = readiness.post.getMockImplementation()!;
    readiness.post.mockImplementation(async (url: string, body: { sharedMetadata: { ciphertext: string }; ownerMetadata: unknown }) => {
      if (!url.endsWith('/v1/sessions')) return originalPost(url, body);
      births.push(body);
      return { status: 200, data: { session: { id: 'new-session', seq: 0, createdAt: 1, updatedAt: 1, active: false, activeAt: 1,
        metadataLayoutVersion: 1, metadata: body.sharedMetadata.ciphertext, ownerMetadata: body.ownerMetadata, metadataVersion: 1,
        encryptionMode: 'plain', agentState: null, agentStateVersion: 0, dataEncryptionKey: null, share: null }, created: true } };
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/features') ? {
      features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } },
      capabilities: { encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' } },
    } : { id: 'account-1' }), { status: 200 })));
    const originalGet = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/access-keys/new-session/machine-1')) return { status: 200, data: { accessKey: 'existing' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      return url.includes('/features') ? { status: 200, data: {
        features: { sessions: { enabled: true, conversations: { enabled: true } }, sharing: { enabled: true, session: { enabled: true } } }, capabilities: {},
      } } : originalGet(url);
    });
    const originalRequest = readiness.request.getMockImplementation()!;
    readiness.request.mockImplementation(async ({ url, method, data }: { url: string; method: string; data?: string }) => {
      if (url.endsWith('/v1/discussions/discussion-1') && method === 'GET') return { status: 200, data: { discussion: {
        id: 'discussion-1', ownerAccountId: 'account-1', encryptionMode: 'plain', anchor: null, access: 'owner', keyReadiness: true,
        dataEncryptionKey: null, creationLocalId: 'create-1', titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
        latestMessage: { id: 'question-1', localId: 'question-local', seq: 1, authorAccountId: null,
          accountActor: null, producerV1: null, createdAt: 1 },
        messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt: null,
        capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false },
      } } };
      if (url.endsWith('/v1/discussions/discussion-1/participants/invite') && method === 'POST') {
        reservations.push(JSON.parse(data!));
        return denied ? { status: 403, data: { error: 'discussion_access_forbidden' } } : { status: 200, data: {
          discussionId: ref.discussionId, ownerAccountId: 'account-1', access: 'owner', grants: [], changed: reservations.length === 1,
          modelParticipant: { participant: { kind: 'model', participantSlotId: creationKey }, launch,
            sessionId: null, answerPolicy: 'when_addressed', createdAt: 1 },
        } };
      }
      if (url.endsWith('/v1/discussions/discussion-1/participants') && method === 'GET') return { status: 200, data: {
        discussionId: ref.discussionId, ownerAccountId: 'account-1', access: 'owner', grants: [],
        participants: [{ participant: { kind: 'model', participantSlotId: creationKey }, launch,
          sessionId: boundSessionId, answerPolicy: 'when_addressed', createdAt: 1 }],
      } };
      return originalRequest({ url, method, data });
    });
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    const resolveRoleContext = frozenRole ? createWorkflowActionContextResolver(createCredentialedWorkflowMaterializationHostV1({
      credentials, accountId: 'account-1', serverId: 'server-1', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      callMachineAction: request => readiness.callMachineRpc(request), readWorkflowDefinition: async () => null,
    })) : undefined;
    const composed = policy.startsWith('composed');
    const originSurface = policy === 'composed-automation' ? 'agent' : 'ui';
    const settings = ActionsSettingsV1Schema.parse({ v: 1,
      ...(policy === 'waive' || (composed && policy !== 'composed-automation') ? { approvalWaivedSurfaces: { 'discussion.invite': [surface] } } : {}),
      ...(policy === 'composed-current-require' ? { approvalWaivedSurfaces: { 'discussion.invite': [originSurface, surface] } } : {}),
      ...(policy === 'require' || composed && policy !== 'composed-current-require' ? { actions: { 'discussion.invite': {
        approvalRequiredSurfaces: [composed ? originSurface : surface],
      } } } : {}),
      ...(policy === 'disabled' ? { actions: { 'discussion.invite': { enabled: false } } } : {}),
    });
    let stored: ApprovalRequestV2 | undefined;
    let invitationCards = 0;
    let retainedInvitationApproval: Extract<NonNullable<import('@happier-dev/protocol/workflows').WorkflowProgressEnvelopeV1['execution']>, { kind: 'action' }> | undefined;
    const host = createCliActionExecutorHarness({ token: credentials.token, credentials, sessionId: 'workflow-host', mode: 'plain', ctx: null,
      serverId: 'server-1', serverIdentityId: 'srv_home', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
      // Production always supplies a provider. Its newer waiver cannot erase
      // the Require policy captured when this Run was accepted.
      actionsSettingsProvider: { getActionsSettings: () => policy === 'composed-current-require'
        ? ActionsSettingsV1Schema.parse({ v: 1, actions: { 'discussion.invite': { approvalRequiredSurfaces: ['ui'] } } })
        : composed ? ActionsSettingsV1Schema.parse({ v: 1, approvalWaivedSurfaces: { 'discussion.invite': ['ui', 'agent'] } }) : settings,
        getAccountSettings: () => null },
    }, {
      ...createDiscussionActionDeps({ credentials, serverId: 'server-1', serverHttpBaseUrl: resolveServerHttpBaseUrl() }),
      approvalsCreate: async ({ request }) => { invitationCards++; stored = ApprovalRequestV2Schema.parse(request); return { artifactId: 'invitation-approval' }; },
      approvalsGet: async () => stored ?? null,
      approvalsUpdate: async ({ request }) => {
        if (!stored) throw new Error('missing approval');
        const transition = decideApprovalRequestTransition(stored, request);
        if (!transition.ok) return transition;
        stored = ApprovalRequestV2Schema.parse(request);
        return { ok: true };
      },
      // Current host/Account authority is the external replay-currentness boundary.
      isApprovalExecutionOriginCurrent: async () => true,
    });
    const executor = host.executor;
    const action: WorkflowActionExecutor = { executor, buildContext: async execution => ({
        ...(resolveRoleContext ? await resolveRoleContext(execution) : buildWorkflowActionContext(execution)), surface, authority: 'account_automation',
        serverId: 'server-1', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1', actionsSettings: settings,
        externalActionTarget: { kind: 'machine', machineId: 'machine-1', project: { machineId: 'machine-1', directory: '/repo' } },
      }),
        ...(composed && policy !== 'composed-reclaim' && policy !== 'composed-unknown' ? { observeApproval: async ({ artifactId, actionRequestId, signal }: Parameters<NonNullable<WorkflowActionExecutor['observeApproval']>>[0]) => host.observeRecordedApprovalExecution({
          artifactId, signal, expectedOrigin: { actionId: 'discussion.invite', requestId: actionRequestId,
            accountId: 'account-1', serverIdentityId: 'srv_home', machineId: 'machine-1' },
          isCurrent: async () => !signal.aborted,
        }) } : {}),
        observeRun: async () => { throw new Error('reservation must not start an Execution Run'); } };
    const discussionOrigin = { discussion: { serverId: 'server-1', discussionId: ref.discussionId }, messageId: 'question-1', throughSeq: 1 };
    const create = createProductionFreshWorkflowSessionConversation({ credentials,
      serverId: 'server-1', machineId: 'machine-1', workDepth: 0, originRunId: 'discussion-run',
      discussionOrigin, action,
      machineAdmissionTransport: vi.fn() });
    if (composed) {
      const store = createInMemoryWorkflowCoordinatorStore();
      const workspace = { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' };
      let accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: { version: 1, defaults: {}, inputs: [
        { name: 'reviewer', valueType: 'json', required: true, inputType: { hostType: 'agentParticipant' } },
      ], blocks: [{ kind: 'step', id: 'review', input: [], result: { kind: 'text' },
        document: { text: 'Review the question', references: [], attachments: [] }, execution: { participant: { kind: 'input', name: 'reviewer' } } }] },
      context: { source: { kind: 'inline' }, inputs: { reviewer: { kind: 'model', launch } }, machineId: workspace.machineId,
        executionTarget: { kind: 'session' }, workspaceTarget: { project: workspace },
        origin: { kind: 'direct', discussion: discussionOrigin,
          ...(policy === 'composed-automation' || policy === 'composed-missing-starter' ? {} : { authenticatedStarterV1: {
            requestRef: 'authenticated-start', requester: { serverId: 'srv_home',
              accountId: policy === 'composed-substituted-starter' ? 'substituted-person' : 'account-1' },
          } }),
          actionPolicy: { surface: originSurface, authority: policy === 'composed-automation' ? 'account_automation' : 'present_user', actionsSettings: settings } },
        authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
      if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
      if (policy === 'composed-replay-profile') {
        // A new replay inherits its initiating profile while retaining the old
        // frozen model leaf, whose original selection had no profile reference.
        const previous = accepted.snapshot;
        const origin = { ...previous.origin!, actionPolicy: { ...previous.origin?.actionPolicy,
          authority: 'present_user' as const, approvalProfileId: 'builtin:full-trust' } };
        const replaySource = { ...previous, origin };
        accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: replaySource.authoredDefinition,
          replay: { snapshot: replaySource }, context: { source: replaySource.source, inputs: replaySource.inputs,
            machineId: replaySource.machineId, executionTarget: replaySource.executionTarget,
            workspaceTarget: replaySource.workspaceTarget, origin,
            authorization: { principal: replaySource.authorization.principal } },
          admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
        if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
        expect(accepted.snapshot.materializedLeaves[0]?.selection.approvalProfileId).toBeUndefined();
        expect(accepted.snapshot.origin?.actionPolicy?.approvalProfileId).toBe('builtin:full-trust');
      }
      const inputs: unknown[] = [];
      const conversations = createProductionWorkflowConversationOwner({ credentials, serverId: 'server-1', machineId: workspace.machineId,
        createFreshConversation: create, resolveSharedRunConversation: async () => null,
        resolveProducerConversation: async () => null, resolveExistingSessionConversation: async () => null });
      const coordinator = createWorkflowCoordinator({ store, action, allocateInvocationRecordId: () => 'invocation-1',
        prepareStep: async params => ({ preparedStep: await conversations.prepare(params),
          conversationWorkspace: { machineId: launch.executionTarget.machineId, directory: launch.directory.path } }),
        resolveWorkspace: createCoordinatorWorkspaceResolver({ store, projectWorkspace: workspace, scm: {
          inspectLocation: async () => ({ inspection: { rootPath: workspace.checkoutRootPath } }),
          verifyRecordedWorkspace: async (descriptor, creationIntent) => verifyWorkflowWorkspaceCurrentness(descriptor, {
            creationIntent, pathIsDirectory: async () => true,
            inspectLocation: async () => ({ inspection: { rootPath: workspace.checkoutRootPath } }),
          }),
        } }),
        executeStep: createWorkflowSessionStepExecutor({ credentials, workDepth: 0,
          prepareConversation: async params => await conversations.prepare(params),
          materializeConversation: async (prepared, params) => ({ sessionId: (await conversations.materialize(prepared, params)).sessionId,
            machineAdmissionTransport: vi.fn() }),
          // Native Session input/observation transports are system boundaries;
          // input classification and coordinator settlement remain real.
          sessionInput: { enqueue: async request => {
            expect(store.list().find(row => row.blockId === 'review')?.lifecycle).toBe('admitting');
            inputs.push(request); return { status: 'accepted',
            localId: deriveWorkflowSessionInputLocalIdV2(request.workflow) }; },
            observe: async request => ({ ok: true, sessionId: request.sessionId, localId: request.localId,
              result: { kind: 'final_text', text: 'review finished' } }),
          } }),
      });
      const lifetime = new AbortController();
      const run = { ...accepted.snapshot, runId: 'discussion-run', signal: lifetime.signal };
      const running = coordinator.run(run).then(result => ({ result }), error => ({ error }));
      try {
        if (policy === 'composed-automation' || policy === 'composed-missing-starter' || policy === 'composed-substituted-starter') {
          expect(await running).toMatchObject({ result: { state: 'interrupted' } });
          expect(store.list().find(row => row.blockId === 'review')).toMatchObject({ reason: 'approval_requester_unavailable' });
          expect(stored).toBeUndefined(); expect(invitationCards).toBe(0);
          expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]); expect(inputs).toEqual([]);
          return;
        }
        await vi.waitFor(() => {
          const row = store.list().find(row => row.blockId === 'review');
          expect(row, JSON.stringify({ reason: row?.reason, execution: row?.execution,
            approvalStatus: stored?.status, reservations: reservations.length, launches: launches.length }))
            .toMatchObject({ lifecycle: 'waiting_for_approval' });
        });
        const held = store.list().find(row => row.blockId === 'review');
        expect(stored).toMatchObject({ requestedSurface: 'agent', executionOriginV1: { caller: {
          kind: 'workflowRun', discussionModelReservation: { policySurface: originSurface },
          authenticatedStarterV1: accepted.snapshot.origin?.authenticatedStarterV1,
        } } });
        expect(held).toMatchObject({ recordId: 'invocation-1', lifecycle: 'waiting_for_approval', execution: {
          kind: 'action', actionId: 'discussion.invite', output: { kind: 'approval_request_created', artifactId: 'invitation-approval' },
        } });
        expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]);
        expect(invitationCards).toBe(1);
        expect(inputs).toEqual([]);
        if (policy === 'composed-unknown') {
          expect(await running).toMatchObject({ result: { state: 'paused', reason: 'approval_required' } });
          if (!stored) throw new Error('Expected retained invitation Approval');
          stored = ApprovalRequestV2Schema.parse({ ...stored, status: 'outcome_unknown',
            decision: { kind: 'approve', authority: 'present_user', decidedAtMs: Date.now() },
            execution: { executedAtMs: Date.now(), ok: false, effectAttempted: true,
              errorCode: 'approval_execution_outcome_unknown', error: 'Acknowledgement lost' } });
          expect(await coordinator.run(run)).toMatchObject({ state: 'interrupted', reason: 'approval_execution_outcome_unknown' });
          expect(await coordinator.run(run)).toMatchObject({ state: 'interrupted', reason: 'approval_execution_outcome_unknown' });
          expect(store.list().find(row => row.blockId === 'review')).toMatchObject({ lifecycle: 'outcome_uncertain' });
          expect(invitationCards).toBe(1);
          expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]); expect(inputs).toEqual([]);
          return;
        }
        if (policy === 'composed-reclaim') expect(await running).toMatchObject({ result: { state: 'paused', reason: 'approval_required' } });
        expect(await executor.execute('approval.request.decide', { artifactId: 'invitation-approval',
          decision: policy === 'composed-reject' ? 'reject' : 'approve' },
          { surface: 'ui', authority: 'present_user', serverId: 'server-1', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1' }))
          .toMatchObject({ ok: true });
        if (policy === 'composed-reject') {
          expect(await running).toMatchObject({ result: { reason: 'approval_rejected' } });
          expect(store.list().find(row => row.blockId === 'review')).toMatchObject({ lifecycle: 'failed', reason: 'approval_rejected' });
          expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]); expect(inputs).toEqual([]);
          return;
        }
        if (policy === 'composed-reclaim') expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
        else expect(await running).toMatchObject({ result: { state: 'succeeded' } });
        expect(store.list().find(row => row.blockId === 'review')).toMatchObject({ recordId: held?.recordId, lifecycle: 'completed' });
        expect(reservations).toHaveLength(1); expect(launches).toHaveLength(1); expect(births).toHaveLength(1);
        if (policy === 'composed-replay-profile') expect(births[0]).toMatchObject({ ownerMetadata: {
          v: { runtime: { approvalProfileId: 'builtin:full-trust' } },
        } });
        expect(inputs).toHaveLength(1);
        expect(invitationCards).toBe(1);
        expect(await coordinator.run(run)).toMatchObject({ state: 'succeeded' });
        expect(reservations).toHaveLength(1); expect(launches).toHaveLength(1); expect(births).toHaveLength(1);
        expect(inputs).toHaveLength(1);
      } finally {
        lifetime.abort();
        await running;
      }
      return;
    }
    const invoke = () => create({ selection: {}, launch, creationKey, ...(frozenRole ? { frozenRole } : {}),
      origin: { kind: 'direct', actionPolicy: { surface, authority: policy === 'require' ? 'present_user' : 'account_automation',
        actionsSettings: settings, ...(frozenRole ? { approvalProfileId: 'builtin:full-trust' } : {}) }, authenticatedStarterV1: {
          requestRef: 'authenticated-start', requester: { serverId: 'srv_home', accountId: 'account-1' },
        } },
      ...(retainedInvitationApproval ? { retainedInvitationApproval } : {}),
      onInvitationApproval: async execution => { retainedInvitationApproval = execution; },
      startupAuthorization: { principal: { kind: 'host' }, admittedPermissionCeiling: frozenRole ? 'read-only' : 'default' },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' } });
    if (policy === 'disabled') {
      await expect(invoke()).rejects.toMatchObject({ code: 'action_disabled' });
      expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]);
      return;
    }
    if (policy !== 'waive') {
      await expect(invoke()).rejects.toMatchObject({ code: 'approval_required' });
      expect(stored).toMatchObject({ status: 'open', actionId: 'discussion.invite', requestedSurface: surface });
      expect(reservations).toEqual([]); expect(launches).toEqual([]); expect(births).toEqual([]);
      // Re-entry observes the same Artifact, without enrolling another request.
      await expect(invoke()).rejects.toMatchObject({ code: 'approval_required' });
      if (policy === 'require' && surface === 'cli') {
        const retained = retainedInvitationApproval!;
        retainedInvitationApproval = { ...retained, input: { ...retained.input, discussionId: 'another-discussion' } };
        await expect(invoke()).rejects.toMatchObject({ code: 'approval_unavailable' });
        retainedInvitationApproval = retained;
        expect(reservations).toEqual([]);
      }
      const decision = await executor.execute('approval.request.decide', { artifactId: 'invitation-approval',
        decision: policy === 'reject' ? 'reject' : 'approve' },
      { surface: 'ui', authority: 'present_user', serverId: 'server-1', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1' });
      expect(decision).toMatchObject({ ok: true });
      // Approval may reserve the exact slot, but the Workflow remains the sole Session creator.
      expect(launches).toEqual([]); expect(births).toEqual([]);
      if (policy === 'reject') {
        await expect(invoke()).rejects.toMatchObject({ code: 'approval_rejected' });
        expect(reservations).toEqual([]);
        return;
      }
      expect(reservations).toHaveLength(1);
      if (policy === 'require' && surface === 'cli') {
        const observe = createWorkflowInvocationRecoveryObserver({ credentials, machineId: 'machine-1', actionExecutor: executor });
        expect(await observe({ run: { id: 'discussion-run' }, progress: { kind: 'happier.workflow-progress.v1', blockKind: 'step',
          invocationPath: { blockId: 'review', scope: [] }, attempt: '0', logicalInvocationRecordId: 'invocation-1',
          execution: retainedInvitationApproval }, terminalParent: false, cancellationRequested: false }))
          .toMatchObject({ kind: 'unresolved', code: 'workflow_native_startup_ready' });
        expect(await executor.execute('approval.request.decide', { artifactId: 'invitation-approval', decision: 'approve' },
          { surface: 'ui', authority: 'present_user', serverId: 'server-1', serverIdentityId: 'srv_home', runtimeAccountId: 'account-1' }))
          .toMatchObject({ ok: true });
        expect(reservations).toHaveLength(1);
      }
    }
    if (denied) {
      await expect(invoke()).rejects.toMatchObject({ code: 'discussion_access_forbidden' });
      expect(launches).toEqual([]);
      expect(births).toEqual([]);
    } else if (boundSessionId !== 'new-session') {
      await expect(invoke()).rejects.toMatchObject({ code: 'discussion_subject_ineligible' });
    } else {
      await expect(invoke()).resolves.toMatchObject({ sessionId: 'new-session', origin: { kind: 'discussion', discussionParticipant: ref } });
      expect(spawnAdmissions.filter(id => id === 'session.spawn_new')).toHaveLength(1);
      expect(births).toEqual([expect.objectContaining({ originKind: 'discussion', discussionParticipant: ref,
        discussionParticipantLaunch: launch, ownerMetadata: expect.objectContaining({ v: expect.objectContaining({
          system: expect.objectContaining({ sessionCreationCorrespondenceV1: expect.objectContaining({ recipe: expect.objectContaining({ discussionParticipant: ref }) }) }),
        }) }) })]);
      expect(births[0]).not.toHaveProperty('originRunId');
      expect(launches).toEqual([expect.objectContaining({ existingSessionId: 'new-session' })]);
      if (frozenRole) {
        expect(launches[0]).toMatchObject({ permissionMode: 'read-only' });
        expect(births[0]).toMatchObject({ ownerMetadata: { t: 'plain', v: { work: { sessionRolesV1: {
          roleId: frozenRole.roleId, sessionRoles: { [frozenRole.roleId]: frozenRole },
        } } } } });
      }
    }
    expect(reservations).toEqual([{ participant: { kind: 'model', participantSlotId: creationKey, launch } }]);
  });

  it('launches the admitted effective Role model and profile with the frozen Team credential choice', async () => {
    const launches = installSessionCreationTransport();
    const agentTarget = { kind: 'agent' as const,
      identity: { pluginId: 'happier.agent.claude', localId: 'claude' } };
    const profile = LaunchProfileV2Schema.parse({ v: 2, id: 'role-profile', name: 'Role Profile',
      extraEnvironmentVariables: [], defaultPermissionModeByTargetKey: {
        'agent:happier.agent.claude/claude': 'read-only',
      }, defaultPersistenceModeByTargetKey: {}, compatibilityByTargetKey: {
        'agent:happier.agent.claude/claude': true,
      }, createdAt: 1, updatedAt: 1 });
    installWorkflowLaunchProfileAccount({ token: 'token', encryption: null }, profile);
    const offered = { kind: 'model' as const, launch: {
      executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: '/review' }, agentTarget, roleId: 'builder',
      connectedServices: { v: 2 as const, bindingsByServiceId: {} },
      teamCredentialBindings: [{ v: 1 as const, slot: { kind: 'provider_model' as const },
        resourceId: 'credential-1', expectedResourceRevision: 7, deliveryMode: 'brokered' as const, teamId: 'team-1' }],
    } };
    const authored = { version: 1 as const, defaults: {}, inputs: [{ name: 'reviewer', valueType: 'json' as const,
      required: true, inputType: { hostType: 'agentParticipant' as const } }],
      blocks: [{ kind: 'step' as const, id: 'review', document: { text: 'Review', references: [], attachments: [] },
        execution: { participant: { kind: 'input' as const, name: 'reviewer' } } }] };
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition: authored,
      context: { source: { kind: 'inline' }, inputs: { reviewer: offered }, machineId: 'machine-1',
        executionTarget: { kind: 'session' }, workspaceTarget: { project: { machineId: 'machine-1',
          directory: '/repo', checkoutRootPath: '/repo' } }, origin: { kind: 'direct' },
        authorization: { principal: { kind: 'host' } } }, admission: { kind: 'user' },
      roleSelection: { settingsOverrides: { builder: { roleId: 'builder',
        engine: { agentTargetKey: 'agent:happier.agent.claude/claude', modelId: 'role-model', effort: 'high' },
        profileId: 'role-profile' } } },
      effects: { resolveTargetAvailability: async () => true, readLaunchProfile: async () => profile } });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    const selected = resolveWorkflowAcceptedStepSelectionV1(accepted.snapshot.materializedLeaves[0]!,
      undefined, accepted.snapshot.inputs);
    expect(selected.participant?.kind).toBe('model');
    if (selected.participant?.kind !== 'model') return;
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'role-run', machineAdmissionTransport: vi.fn(),
    });
    await expect(create({ selection: selected.selection, launch: selected.participant.launch,
      ...(selected.role ? { frozenRole: selected.role } : {}),
      workspace: { machineId: 'machine-1', directory: '/review', checkoutRootPath: '/review' },
      creationKey: 'workflow:role-run:review' })).resolves.toMatchObject({ sessionId: 'new-session' });
    expect(launches).toEqual([expect.objectContaining({
      directory: '/review', profileId: 'role-profile', permissionMode: 'read-only', modelSelection: expect.objectContaining({
        ref: expect.objectContaining({ modelId: 'role-model' }),
      }), sessionConfigOptionOverrides: expect.objectContaining({ overrides: expect.objectContaining({
        reasoning_effort: expect.objectContaining({ value: 'high' }),
      }) }), teamCredentialBindings: offered.launch.teamCredentialBindings,
    })]);
  });

  it('rebases a frozen model launch onto a real generated worktree before Session spawn', async () => {
    const launches = installSessionCreationTransport();
    const root = await fs.mkdtemp(join(tmpdir(), 'workflow-model-worktree-'));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const git = promisify(execFile);
    const source = join(root, 'source');
    const worktree = join(root, 'candidate');
    await fs.mkdir(source);
    await git('git', ['init', source]);
    await git('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
    await git('git', ['-C', source, 'worktree', 'add', '--detach', worktree]);
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'worktree-run', machineAdmissionTransport: vi.fn(),
    });
    const launch = projectDiscussionModelParticipantLaunchV1({ executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: source }, connectedServices: { v: 2 as const, bindingsByServiceId: {} },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
    const conversation = await create({ selection: {}, launch,
      workspace: { machineId: 'machine-1', directory: worktree, checkoutRootPath: worktree },
      creationKey: 'workflow:worktree-run:implementation' });
    expect(conversation.directory).toBe(worktree);
    expect(launches).toEqual([expect.objectContaining({ directory: worktree })]);
    expect(launch.directory).toEqual({ kind: 'path', path: source });
    expect((await git('git', ['rev-parse', '--show-toplevel'], { cwd: launches[0]!.directory })).stdout.trim()).toBe(worktree);
  });

  it('runs every parallel implementation starter branch through Session creation in its own real worktree', async () => {
    const launches = installSessionCreationTransport();
    vi.mocked(fs.access).mockRestore();
    vi.mocked(fs.stat).mockRestore();
    const root = await fs.mkdtemp(join(tmpdir(), 'workflow-race-'));
    onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
    const git = promisify(execFile);
    const source = join(root, 'source');
    await fs.mkdir(source);
    await git('git', ['init', source]);
    await git('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial']);
    const revision = (await git('git', ['-C', source, 'rev-parse', 'HEAD'])).stdout.trim();
    const definition = resolveBuiltinWorkflowDefinitionV1('parallel-implementations')?.definition;
    if (!definition) throw new Error('missing_starter');
    const launch = projectDiscussionModelParticipantLaunchV1({ executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
      directory: { kind: 'path' as const, path: source }, connectedServices: { v: 2 as const, bindingsByServiceId: {} },
      agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } });
    const accepted = await materializeWorkflowAcceptedSnapshotV1({ definition,
      context: { source: { kind: 'inline' }, inputs: { request: 'Implement a candidate',
        first: { kind: 'model', launch }, second: { kind: 'model', launch }, third: { kind: 'model', launch } },
        machineId: 'machine-1', executionTarget: { kind: 'session' },
        workspaceTarget: { project: { machineId: 'machine-1', directory: source, checkoutRootPath: source }, originalCommittedRevision: revision },
        origin: { kind: 'direct' }, authorization: { principal: { kind: 'host' } } },
      admission: { kind: 'user' }, effects: { resolveTargetAvailability: async () => true } });
    if (!accepted.ok) throw new Error(JSON.stringify(accepted.error));
    const store = createInMemoryWorkflowCoordinatorStore();
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'race', machineAdmissionTransport: vi.fn(),
    });
    const directories: string[] = [];
    const coordinator = createTestWorkflowCoordinator({ store,
      resolveWorkspace: createCoordinatorWorkspaceResolver({ store, scm: createGitWorkflowWorkspaceTestDependencies(),
        originalCommittedRevision: revision,
        projectWorkspace: { machineId: 'machine-1', directory: source, checkoutRootPath: source } }),
      executeStep: async params => {
        await params.beforeInputAdmission();
        if (params.participant?.kind !== 'model') throw new Error('model_required');
        const conversation = await create({ selection: params.execution, launch: params.participant.launch,
          workspace: params.workspace, creationKey: `workflow:race:${params.step.id}` });
        const directory = conversation.directory;
        if (params.step.id === 'compare') {
          expect(directory).toBe(source);
          expect(params.input.text).toContain(directories[0]);
          for (const candidate of directories) expect(await fs.readFile(join(candidate, 'candidate.txt'), 'utf8')).toBe(candidate);
          return { kind: 'completed', result: 'Recommend a candidate; await your choice.' };
        }
        expect(directory).not.toBe(source);
        expect((await git('git', ['rev-parse', 'HEAD'], { cwd: directory })).stdout.trim()).toBe(revision);
        // The native process boundary receives this actual cwd; model work is represented by a file effect there.
        expect(launches).toContainEqual(expect.objectContaining({ directory }));
        await fs.writeFile(join(directory, 'candidate.txt'), directory);
        directories.push(directory);
        return { kind: 'completed', result: directory };
      },
    });
    expect(await coordinator.run({ ...accepted.snapshot, runId: 'race' })).toMatchObject({ state: 'waiting_for_review' });
    expect(new Set(directories).size).toBe(3);
    expect(launches.map(request => request.directory).sort()).toEqual([...directories, source].sort());
    expect(launches.at(-1)?.permissionMode).toBe('read-only');
    await expect(fs.access(join(source, 'candidate.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await git('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no'])).stdout).toBe('');
  });

  it('refuses a model launch on another Machine before spawn', async () => {
    const launches = installSessionCreationTransport();
    const create = createProductionFreshWorkflowSessionConversation({
      credentials: { token: 'token', encryption: null }, serverId: 'server-1', machineId: 'machine-1',
      workDepth: 0, originRunId: 'run-model', machineAdmissionTransport: vi.fn(),
    });
    await expect(create({ selection: {}, launch: { executionTarget: { serverId: 'server-1', machineId: 'other-machine' },
      directory: { kind: 'path', path: '/repo' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.claude', localId: 'claude' } } },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-model:inv-2' })).rejects.toMatchObject({ code: 'target_unavailable' });
    expect(launches).toEqual([]);
  });

  it('resolves fresh Team resource defaults through the current paginated Home catalog', async () => {
    const launches = installSessionCreationTransport();
    const credentials = { token: `header.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    // Account identity/currentness and catalog opening stay real; only persisted
    // credentials and Home HTTP responses are supplied at their boundaries.
    vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
    const readinessRead = readiness.get.getMockImplementation()!;
    readiness.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      if (url.endsWith('/v2/account/settings/history')) return { status: 200, data: { snapshots: [] } };
      if (url.endsWith('/v1/account/entity-rows/connected-accounts/purposes')) return { status: 200, data: {
        status: 'present', revision: 1, content: { t: 'plain', v: { key: 'purposes', value: {
          v: 1, bindings: [], teamResourceSelections: [{
            purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
            teamId: 'team-1', selection: { source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered' },
          }],
        } } },
      } };
      return readinessRead(url);
    });
    const resourcePage = TeamCredentialResourceEntitledPageV1Schema.parse({
      resources: [{
        id: 'resource-1', teamId: 'team-1', displayName: {
          content: { t: 'plain', v: 'Shared Codex account' }, recipientEnvelope: null,
        },
        resourceRevision: 4, readiness: { kind: 'available' as const }, recoveryAction: null,
        mayBroker: true, mayReceiveDirect: false, directMaterialState: 'never_delivered' as const,
        sessionUsePolicy: 'personal_allowed' as const, providerModels: [],
        connectedServiceSelections: [{
          source: 'team_resource' as const, resourceId: 'resource-1', deliveryMode: 'brokered' as const,
        }],
        sourcePresentation: {
          kind: 'connected_service' as const,
          service: { pluginId: 'happier.agent.codex', localId: 'openai-codex' },
        },
      }],
      nextCursor: null,
    });
    const firstPage = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', { teamId: 'team-1' });
    const nextPage = bindHomeDomainActionHttpRequestV1('teams.credentials.entitled.list', {
      teamId: 'team-1', cursor: 'resource-page-2',
    });
    const serverHttpBaseUrl = resolveServerHttpBaseUrl();
    // These pages share a POST URL; the cursor lives in the strict request body.
    const requestHome = readiness.request.getMockImplementation()!;
    const pageRequests: unknown[] = [];
    readiness.request.mockImplementation(async (request: { url: string; method: string; data?: unknown }) => {
      if (request.url !== `${serverHttpBaseUrl}${firstPage.path}`) return requestHome(request);
      pageRequests.push(request);
      if (pageRequests.length === 1) {
        expect(request).toMatchObject({ method: firstPage.method, data: firstPage.body });
        return { status: 200, data: { resources: [], nextCursor: 'resource-page-2' } };
      }
      expect(pageRequests).toHaveLength(2);
      expect(request).toMatchObject({ method: nextPage.method, data: nextPage.body });
      return { status: 200, data: resourcePage };
    });
    const create = createProductionFreshWorkflowSessionConversation({
      credentials,
      serverId: 'server-1',
      machineId: 'machine-1',
      machineAdmissionTransport: vi.fn(),
      workDepth: 0,
      originRunId: 'run-1',
    });

    await create({
      selection: {
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      workspace: { machineId: 'machine-1', directory: '/repo', checkoutRootPath: '/repo' },
      creationKey: 'workflow:run-1:inv-team',
    });

    expect(launches).toMatchObject([{
      connectedServices: {
        v: 2,
        bindingsByServiceId: {
          'happier.agent.codex/openai-codex': {
            source: 'team_resource', resourceId: 'resource-1', deliveryMode: 'brokered',
          },
        },
      },
      // The defaulted Team target is admitted only through the Session's own
      // Team slot binding, created with the Session.
      teamCredentialBindings: [{
        v: 1,
        slot: {
          kind: 'connected_service_purpose',
          purpose: { consumer: { pluginId: 'happier.agent.codex', localId: 'codex' }, purpose: 'primary' },
        },
        resourceId: 'resource-1',
        expectedResourceRevision: 4,
        deliveryMode: 'brokered',
        teamId: 'team-1',
      }],
    }]);
  });
});
