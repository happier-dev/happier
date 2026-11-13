import { createManagedProviderOperationAuthority } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import { createConnectedAccountRequestAuthSubjectRegistry } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthSubjectRegistry';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { AccountSettingsSchema, ActionIdSchema, FeaturesResponseSchema, MachineSetupApplyInputV1Schema, normalizeActionsSettingsV1, deriveMachineSetupCombinedRunIdV1, openWorkflowAcceptedSnapshotStoredEnvelopeV1, parseWorkflowStoredContentEnvelopeV1, type ActionId } from '@happier-dev/protocol';
import type { ManagedMachineV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { ManagedMachineActionOutputSchemasV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { QualifiedConnectedAccountListResponseV4Schema, QualifiedConnectedAccountProfileV4Schema } from '@happier-dev/protocol/connect/qualified-connected-account-projections';
import { TeamsListInputV1Schema, TeamsPageV1Schema } from '@happier-dev/protocol/teams/projections';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { PluginAvailabilityActionHttpPathsV1, PluginAvailabilityIntentsListActionInputV1Schema, PluginAvailabilityIntentsListActionOutputV1Schema, PluginAvailabilityIntentReadActionOutputV1Schema } from '@happier-dev/protocol/plugins/availability';
import { normalizePluginManifestV2 } from '@/plugins/manifest/normalize';
import { fixture as managedFixture, pluginId as managedPluginId } from '@/plugins/runtime/invocation/actions/managedCustody.testkit';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { createCommittedContributedActionInvoker } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';
import { executeCliManagedAccountPower } from '@/machines/managed/accountPower';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { prepareCliManagedProvisionerAdmission } from '@/machines/managed/provisionerAdmission';
import { projectContributedActionFailure } from '@/plugins/runtime/invocation/actions/contributedActionFailure';
import type { ManagedMachineOperationSettlementContext, ManagedNativeOperationSettlement } from '@/machines/managed/managedIntentReconciler';
import axios from '@/api/client/credentialAxios';
import { logger } from '@/ui/logger';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';

import { createAccountServerActionDeps } from './accountServerActionDeps';
import { createCliActionExecutor } from '@/session/actions/createCliActionExecutor';
import { createCliActionExecutorFromCredentials } from '@/session/actions/createCliActionExecutorFromCredentials';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { listCompiledActionCliCommands } from '@/cli/actions/compiledCommands';
import { runCompiledActionCliCommand } from '@/cli/actions/executeCommand';
import { fetchServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { createActionToolExecutorBridge } from '@/agent/tools/happierTools/createActionToolExecutorBridge';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/machines/machineStoredContent';
import { socketRpcCodec } from '@happier-dev/sync-client';
import type { MachineWorkSummaryV1 } from '@happier-dev/protocol/machines/machineWorkSummaryV1';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { createWorkflowRunStorageTestkit, type WorkflowRunStorageTestkitOperation } from '@/daemon/workflows/workflowRunStorage.testkit';
import { WORKFLOW_RUN_STORAGE_HTTP_PATH } from '@/daemon/workflows/workflowRunStorageClient';
import { pluginReloadController } from '@/plugins/runtime/reload/singleton';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { SESSION_FOLLOW_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/api';
import { DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { DaemonContributionRegistryProjectionDescribeResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { registerPlainArtifactRoutes } from '@/session/actions/widgetApproval.testkit';
import { createDaemonApprovalExecutionOriginCurrentnessFromCredentials } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { decodeStoredCredentials } from '@/persistence';

const socketBoundary = vi.hoisted(() => ({
  connections: [] as Array<{ serverUrl: string; token?: string }>,
  respond: undefined as ((event: string, payload: unknown) => Promise<unknown>) | undefined,
}));
vi.mock('socket.io-client', async () => {
  const { createApiSessionSocketStub } = await import('@/testkit/backends/apiSessionSocketHarness');
  return { io: (serverUrl: string, options?: { auth?: { token?: string } }) => {
    socketBoundary.connections.push({ serverUrl, token: options?.auth?.token });
    return createApiSessionSocketStub({ emitWithAck: (event, payload) => {
      if (!socketBoundary.respond) throw new Error(`Unexpected Socket.IO request: ${event}`);
      return socketBoundary.respond(event, payload);
    } });
  } };
});

describe('managed inventory CLI Home adapter', () => {
  let app = fastify();
  let restore = () => {};
  afterAll(async () => {
    if (pluginReloadController.getState().activeRegistry) await pluginReloadController.shutdown();
  });
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    setActiveAccountSettingsSnapshot({ source: 'network', settings: AccountSettingsSchema.parse({ actionsSettingsV1: policy }),
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken('bound') });
    socketBoundary.respond = undefined;
    socketBoundary.connections.length = 0;
    app = fastify();
    app.get('/v1/account/encryption', async () => ({ mode: 'plain', updatedAt: 1 }));
    restore = installAxiosFastifyAdapter({ app, origin: 'http://home.test' });
  });
  afterEach(async () => { restore(); await app.close(); resetActiveAccountSettingsSnapshotForTests(); });

  const machine = {
    id: 'managed-1', homeId: 'srv_home', custodianAccountId: 'owner',
    launch: { provider: { pluginId: 'happier.machine.lima', localId: 'lima' }, schemaVersion: 1, name: 'Guest', choices: { cores: 2 } },
    controller: { machineId: 'controller-1', installationId: 'installation-1' },
    allocation: 'may-exist', creationState: 'active', desired: 'start', desiredWhen: 'now', intentRevision: 1,
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  } as const satisfies ManagedMachineV1;
  const context = { surface: 'cli', authority: 'account_automation', serverId: 'route-home' } as const;
  const policy = normalizeActionsSettingsV1({ v: 1, actions: {}, approvalWaivedSurfaces: {
    'machines.presets.update': ['cli', 'agent', 'mcp'],
    'machines.access.grant.remove': ['cli', 'agent', 'mcp'],
    'machines.setup.apply': ['cli', 'agent', 'mcp'],
    'session.stop': ['cli', 'agent', 'mcp'],
    'execution.run.stop': ['cli', 'agent', 'mcp'],
  } });

  function invoke(cli: ReturnType<typeof createCliActionExecutor>, surface: 'cli' | 'agent' | 'mcp', actionId: ActionId, input: unknown,
    defaultSessionId = 'cli-global') {
    if (surface === 'cli') return cli.execute(actionId, input, { ...context, actionsSettings: policy });
    return createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy })
      .executeActionByToolName('action_execute', { actionId, input }, defaultSessionId,
        { actionRequestId: `parity-${surface}-${actionId}` });
  }

  function executor(overrides: Partial<Pick<Parameters<typeof createAccountServerActionDeps>[0],
    'serverIdentityId' | 'resolveServerFeaturesSnapshot' | 'isCredentialCurrent'>> = {}) {
    return createCliActionExecutor({
      token: 'bound', sessionId: 'cli-global', serverId: 'route-home', serverHttpBaseUrl: 'http://home.test',
      mode: 'plain', ctx: null,
      accountServerActionDeps: createAccountServerActionDeps({
        token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test', ...overrides,
      }),
    });
  }

  // QA-M-CATALOG request 1a1666fd-458f-46f4-8298-f6985bc9bc87:
  // delegated preset acquisition has no controller grant or root homeId.
  const delegatedAcquire = {
    selection: { kind: 'preset', homeId: 'srv_niq7wbpMyJviL4EtO5YlTEd0Us0Ou0nN', id: 'qa-m-catalog-docker-1111', revision: 0 },
    enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' },
    retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
  } as const;

  it.each(['stop', 'suspend'] as const)('admits deferred %s through the control endpoint without native dispatch', async intent => {
    const actionInput = { homeId: 'srv_home', managedId: machine.id, when: 'after-idle' as const, intent };
    const requests: unknown[] = [];
    app.post('/v1/machines/managed/controller/admit-control', async request => {
      requests.push(request.body);
      return { machine: { ...machine, desired: intent, desiredWhen: 'after-idle', intentRevision: 2 }, replayed: false };
    });
    await app.ready();
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    expect(await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: actionInput,
      context: { ...context, actionRequestId: 'deferred-power' } })).toEqual({ kind: 'accepted', managedId: machine.id, intentRevision: 2 });
    expect(requests).toEqual([{ action: 'machines.managed.power.set', input: actionInput, requestId: 'deferred-power' }]);
  });

  it('refuses a foreign acquisition Home with a typed failure before dispatch', async () => {
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    await app.ready();
    await expect(deps.managedMachineAction!({ actionId: 'machines.managed.acquire', input: delegatedAcquire, context }))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
  });

  it('refuses a missing acquisition Home with a typed failure before dispatch', async () => {
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    await app.ready();
    const { homeId: _omitted, ...selection } = delegatedAcquire.selection;
    // @ts-expect-error Exercise malformed wire input with the required Home omitted.
    await expect(deps.managedMachineAction!({ actionId: 'machines.managed.acquire', input: { ...delegatedAcquire, selection }, context }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
  });

  it.each([undefined, 'controller-1'])('discovers Account provisioner declarations through CLI composition with transport Machine %s', async machineId => {
    let inventoryReads = 0;
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
      inventoryReads++;
      const input = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
      const pluginIds = input.knownPluginIds ?? [];
      return PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
        pluginIds, failedPluginIds: [], intentReads: pluginIds.map(pluginId => ({
          pluginId, response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] }),
        })),
      });
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return features;
    });
    app.get('/v1/features', async () => features);
    await app.ready();
    const command = listCompiledActionCliCommands().find(candidate => candidate.actionId === 'machines.provisioners.list');
    if (!command) throw new Error('The provisioner list Action must advertise its CLI command');
    // Replace only HTTP and credential/profile persistence. The compiled command,
    // credential-based composition and Action executor remain the production path.
    const fetchBoundary = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('http://home.test');
      const response = await app.inject({ method: 'GET', url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    });
    const output: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(value => { output.push(String(value)); return true; });
    const previousExitCode = process.exitCode;
    let result: unknown;
    try {
      await runCompiledActionCliCommand({ command,
        argv: ['machines', 'provisioners', 'list', '--home-id', 'srv_home', '--server-id', 'route-home', '--json',
          ...(machineId ? ['--machine-id', machineId] : [])],
        deps: {
          readCredentialsFn: async () => ({ token: 'bound', encryption: null }),
          readCredentialsForServerIdFn: async () => ({ token: 'bound', encryption: null }),
          getServerProfileFn: async () => ({ id: 'route-home', name: 'Home', serverUrl: 'http://home.test', webappUrl: 'http://home.test',
            createdAt: 1, updatedAt: 1, lastUsedAt: 1 }),
        },
        consumeSuccess: value => { result = value; return true; },
      });
    } finally {
      fetchBoundary.mockRestore(); stdout.mockRestore(); process.exitCode = previousExitCode;
    }
    expect(result, output.join('')).toMatchObject({ provisioners: expect.arrayContaining([
      expect.objectContaining({ contribution: { pluginId: 'happier.machine.lima', localId: 'lima' } }),
      expect.objectContaining({ contribution: { pluginId: 'happier.machine.vercel', localId: 'vercel' } }),
      expect.objectContaining({ contribution: { pluginId: 'happier.machine.agent37', localId: 'agent37' } }),
      expect.objectContaining({ contribution: { pluginId: 'happier.machine.docker-sandboxes', localId: 'docker-sandboxes' } }),
    ]) });
    // The chooser needs one declaration census, no per-plugin reads or provider activation.
    expect(inventoryReads).toBe(1);
    expect(socketBoundary.connections).toEqual([]);
  });

  it.each(['failed', 'missing'] as const)('refuses a %s Account declaration census instead of silently hiding a bundled provider', async failure => {
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intents.list'], async request => {
      const { knownPluginIds = [] } = PluginAvailabilityIntentsListActionInputV1Schema.parse(request.body);
      const unread = 'happier.machine.agent37';
      const successful = knownPluginIds.filter(pluginId => pluginId !== unread);
      return PluginAvailabilityIntentsListActionOutputV1Schema.parse({ availabilityCursor: 1,
        pluginIds: failure === 'failed' ? knownPluginIds : successful,
        failedPluginIds: failure === 'failed' ? [unread] : [],
        intentReads: successful.map(pluginId => ({ pluginId,
          response: PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
            hostingCapability: { enabled: false }, intent: null, release: null, uiArtifacts: [], packageAssets: [] }),
        })),
      });
    });
    await app.ready();
    await expect(executor().execute('machines.provisioners.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_failed', error: 'plugin_account_execution_unavailable' });
  });

  it('uses the selected Account declaration for exact provisioner discovery and preserves a disabled refusal', async () => {
    let enabled = true;
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async request => {
      expect(request.body).toEqual({ pluginId: 'happier.machine.lima' });
      return PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1,
        hostingCapability: { enabled: false }, release: null, uiArtifacts: [], packageAssets: [],
        intent: enabled ? null : { pluginId: 'happier.machine.lima', desiredVersion: null, enabled: false,
          offlineUiHosting: 'disabled', writableCollections: [], revision: 'disabled' },
      });
    });
    await app.ready();
    const cli = executor();
    const input = { homeId: 'srv_home', contribution: { pluginId: 'happier.machine.lima', localId: 'lima' } };
    const result = await cli.execute('machines.provisioners.list', input, context);
    expect(result).toMatchObject({ ok: true, result: { provisioners: [expect.objectContaining({ contribution: input.contribution })] } });
    enabled = false;
    await expect(cli.execute('machines.provisioners.list', input, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'plugin_disabled' });
  });

  it('includes connected Account metadata only for the exact provisioner form', async () => {
    const contribution = { pluginId: 'happier.machine.vercel', localId: 'vercel' };
    const service = { pluginId: contribution.pluginId, localId: 'vercel-account' };
    const profile = QualifiedConnectedAccountProfileV4Schema.parse({ ref: { service, accountId: 'selected-account' },
      status: 'connected', authenticationModeId: 'token', revisionSemantics: 'revisioned',
      credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS', configurationRevision: 'selected-config',
      configurationReady: true, displayName: 'Selected', scopes: [] });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () =>
      PluginAvailabilityIntentReadActionOutputV1Schema.parse({ availabilityCursor: 1, hostingCapability: { enabled: false },
        intent: null, release: null, uiArtifacts: [], packageAssets: [] }));
    let metadataReads = 0;
    app.get('/v4/connect/qualified/accounts', async request => {
      metadataReads++;
      expect(JSON.parse(new URL(request.url, 'http://home.test').searchParams.get('service')!)).toEqual(service);
      return QualifiedConnectedAccountListResponseV4Schema.parse({ service, accounts: [profile] });
    });
    app.post('/v1/teams/list', async request => {
      expect(TeamsListInputV1Schema.parse(request.body)).toEqual({ v: 1, scope: 'member', archived: 'active' });
      return TeamsPageV1Schema.parse({ items: [], nextCursor: null });
    });
    await app.ready();
    const result = await executor().execute('machines.provisioners.list', { homeId: 'srv_home', contribution }, context);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { provisioners: [expect.objectContaining({ contribution,
      credentialPurposes: [expect.objectContaining({ options: [{ value: profile.ref, label: 'Selected' }] })],
    })] } });
    expect(metadataReads).toBe(1);
  });

  it('reports unavailable guest diagnostics when Account inspection cannot reach the retained controller', async () => {
    const retained = { ...machine, enrolledMachineId: 'offline-guest' };
    app.post('/v1/machines/managed/actions/get', async () => retained);
    app.post('/v1/machines/managed/actions/inspect', async request => {
      expect(request.body).toEqual({ homeId: machine.homeId, managedId: machine.id });
      return ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse({ machine: retained });
    });
    await app.ready();
    const result = await executor().execute('machines.managed.inspect', {
      homeId: machine.homeId, managedId: machine.id, includeGuestDiagnostics: true,
    }, { ...context, runtimeAccountId: 'owner', actionsSettings: policy });
    expect(result).toMatchObject({ ok: true, result: { machine: { id: machine.id },
      guestDiagnostics: { status: 'unavailable', code: 'provider_unavailable' } } });
  });

  it('reads installed guest diagnostics through the selected Account native exec role', async () => {
    const base = managedFixture({ nativeTransport: true });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action, hostAccess: undefined,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const provisioner = manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {} };
    const retained: ManagedMachineV1 = { ...machine, controller: undefined, launch, enrolledMachineId: 'guest-account',
      allocation: 'bound', resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
    app.post('/v1/machines/managed/actions/get', async () => retained);
    app.post('/v1/machines/managed/actions/inspect', async () =>
      ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse({ machine: retained }));
    app.post('/v1/machines/managed/controller/context', async () => ({ machine: retained, requestId: 'retained-creation' }));
    app.post('/v1/machines/managed/controller/report', async () => ({ machine: retained }));
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    const inspectInput = { homeId: retained.homeId, managedId: retained.id, includeGuestDiagnostics: true };
    const actionContext: ActionExecutorContext = { ...context, actionRequestId: 'guest-log-read', runtimeAccountId: 'owner' };
    const roles: string[] = [];
    actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.inspect', input: inspectInput,
      context: actionContext, plan: { children: [
        { action: { pluginId: provider.pluginId, localId: provisioner.actions.inspect }, role: 'inspect' },
        { action: { pluginId: provider.pluginId, localId: 'exec' }, role: 'exec' },
      ] },
      // The provider process is the system boundary; selection, private port,
      // credential binding and the managed read owner remain real.
      execute: async body => {
        if (body && typeof body === 'object' && 'action' in body && body.action && typeof body.action === 'object'
          && 'localId' in body.action && body.action.localId === provisioner.actions.inspect) {
          roles.push('inspect');
          return { ok: true, result: { observedAt: 2, availability: 'present', power: 'running', storage: 'retained' } };
        }
        expect(body).toMatchObject({ action: { pluginId: provider.pluginId, localId: 'exec' }, input: {
          resource: { id: 'same-native' }, argv: ['sh', '-c', expect.stringContaining("'doctor' '--json' '--include-daemon-log'")],
        } });
        roles.push('exec');
        const snapshot = { daemonState: { pid: 1, httpPort: 1, startedAt: 1, startedWithCliVersion: 'guest-version',
          machineId: 'guest-account', hasControlToken: true, daemonLogPath: null }, daemonLogs: [], doctorSnapshot: null,
          stackContext: null, runtime: { cwd: '', platform: 'linux', nodeVersion: '' },
          sessionDiagnostics: { context: { sessionId: '', metadataStatus: 'unavailable' }, logs: [] } };
        return { ok: true, result: { stdoutBase64: Buffer.from(JSON.stringify(snapshot)).toString('base64'), stderrBase64: '',
          stdoutTruncated: false, stderrTruncated: false,
          termination: { requestedBy: { kind: 'none' }, observed: { kind: 'exit', exitCode: 0 } } } };
      } });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    const result = await deps.managedMachineAction!({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext });
    expect(result).toMatchObject({ machine: { id: retained.id }, guestDiagnostics: { status: 'collected',
      snapshot: { daemonState: { machineId: 'guest-account' } } } });
    expect(roles).toEqual(['exec']);
  });

  it.each([['account', false], ['account', true], ['native', false], ['native', true]] as const)(
    'executes the admitted Account power intent rather than treating its Home write as native success (%s consumer, refused=%s)', async (entry, refused) => {
    const service = { pluginId: 'acme.accounts', localId: 'cloud' };
    const disclosed: string[] = [];
    const owner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => ({ kind: 'account', account: { service, accountId: 'mutable-default' } }),
      resolveTarget: async target => target.kind === 'account' ? { account: target.account, displayName: target.account.accountId } : null,
      materializeAccount: async ({ account }) => { disclosed.push(account.accountId); return { kind: 'environment', env: { TOKEN: account.accountId } }; },
      projectTargetAccounts: async () => { throw new Error('No account listing'); },
      assertTargetAccountMaterializable: async () => { throw new Error('No listed account use'); },
    });
    const base = managedFixture({ credentialOwner: owner });
    const provisioner = base.manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: managedPluginId, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, credentials: [{
      purpose: { consumer: provider, purpose: 'upstream' }, account: { service, accountId: 'selected-account' },
    }] };
    let retained: ManagedMachineV1 = { id: 'retained', homeId: 'srv_home', custodianAccountId: 'owner', launch,
      allocation: 'bound', creationState: 'active', desired: 'stop', desiredWhen: 'now', intentRevision: 2,
      resource: { contributionRef: provider, schemaVersion: 1, value: {} },
      retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false },
      observation: { observedAt: 1, availability: 'present', power: 'stopped', storage: 'retained' },
    };
    const powerInput = { homeId: retained.homeId, managedId: retained.id, expectedRevision: 2, when: 'now' as const, intent: 'start' as const };
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url); });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const reference = normalizePluginManifestV2({ schemaVersion: 2, id: service.pluginId, version: '1.0.0', displayName: 'Cloud', runtime: { apiVersion: 1 },
      contributes: { connectedAccountDescriptors: [{ id: service.localId, title: 'Cloud', authentication: { defaultModeId: 'token', modes: [{
        id: 'token', kind: 'manual', outcomeReconciliation: 'none', fields: [{ id: 'token', title: 'Token', schema: { type: 'string' }, secret: true }],
      }] } }] } });
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    // A noncustodian cannot borrow an inventory row. The power admission owns
    // the specific refusal and returns the sole native-effect descriptor.
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => refused
      ? reply.code(403).send({ code: 'permission_denied' }) : retained);
    app.post('/v1/machines/managed/controller/admit-control', async (_request, reply) => {
      if (refused) return reply.code(403).send({ code: 'managed_power_required' });
      retained = { ...retained, desired: 'start', intentRevision: 3 };
      return { machine: retained, replayed: false };
    });
    app.post('/v1/machines/managed/controller/submit-intent', async () => ({ machine: retained, submitted: true }));
    app.post('/v1/machines/managed/controller/report-intent', async request => {
      expect(request.body).toMatchObject({ expectedIntentRevision: 3, requestId: 'original-power', result: { kind: 'confirmed' } });
      return { machine: retained };
    });
    const native: string[] = [];
    const nativeResults = { inspect: { observedAt: 2, availability: 'present' as const, power: 'stopped' as 'stopped' | 'running', storage: 'retained' as const } };
    const runtime = managedFixture({ fixtureManifest: manifest, executionRealm: 'account', credentialOwner: owner, referenceManifests: [reference],
      onNativeRole: role => { native.push(role); if (role === 'power') nativeResults.inspect.power = 'running'; },
      onInspect: () => { native.push('inspect'); }, nativeRoleResults: nativeResults });
    const invoke = createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => ({ registry: runtime.runtimeRegistry,
      source: 'ephemeral', durableRevision: -1, release: async () => {} }), managedProviderOperationAuthority: createManagedProviderOperationAuthority({ materializationBaseDir: tmpdir(),
        purposeBindingOwner: owner, requestAuthRegistry: createConnectedAccountRequestAuthSubjectRegistry(),
        resolveRequestAuthHttpPort: () => 43123, createRedactionLease: () => ({ add() {}, close() {} }),
      }) });
    const actionContext: ActionExecutorContext = { ...context, actionRequestId: 'original-power', runtimeAccountId: refused ? 'other' : 'owner',
      operationAcceptance: { operationId: 'original-operation', accept() {} }, operationOwnerUpdate: { update() {} } };
    // This constructs the consumer's canonical private-port boundary; it is
    // not evidence that production preparation has published the role plan.
    actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: powerInput,
      context: actionContext, reviewAdmitted: true,
      plan: { children: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role })) },
      policies: ['power', 'inspect'].map(role => ({ action: { pluginId: provider.pluginId, localId: role }, role, surface: 'cli' })),
      execute: async (body, childContext, actionId) => {
        expect(actionId).toBe('action.invoke');
        if (!body || typeof body !== 'object' || !('action' in body) || !body.action || typeof body.action !== 'object'
          || !('localId' in body.action) || typeof body.action.localId !== 'string') throw new Error('Expected provider Action');
        if (!('input' in body)) throw new Error('Expected provider operand');
        expect(body).toMatchObject({ input: { resource: {} } });
        return invoke({ action: { pluginId: provider.pluginId, localId: body.action.localId }, input: body.input, context: childContext });
      } });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    const result = entry === 'account'
      ? await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: powerInput, context: actionContext })
      : await executeCliManagedAccountPower({ body: powerInput, context: actionContext, credentials: { token: 'bound', encryption: null }, serverUrl: 'http://home.test',
        post: async (suffix, request, schema) => {
          const response = await axios.post(`http://home.test/v1/machines/managed/controller/${suffix}`, request,
            { headers: { Authorization: 'Bearer bound' }, validateStatus: () => true });
          if (response.status >= 400) throw new ManagedMachineControllerError('managed_power_required');
          return schema.parse(response.data);
        } }).catch((error: unknown) => {
          if (error instanceof ManagedMachineControllerError) return { ok: false, errorCode: error.code, error: error.code };
          throw error;
        });
    expect(result).toMatchObject(refused ? { ok: false, errorCode: 'managed_power_required' }
      : { kind: 'accepted', managedId: retained.id, intentRevision: 3 });
    expect(native).toEqual(refused ? [] : ['inspect', 'power', 'inspect']);
    // The native power handler materializes the selected token. The fixture's
    // Inspect returns its observed state without acquiring another token.
    expect(disclosed).toEqual(refused ? [] : ['selected-account']);
    expect(paths.filter(path => path.endsWith('/admit-control'))).toHaveLength(1);
    expect(paths.some(path => path.endsWith('/execution-authorization'))).toBe(false);
  });

  async function failedAccountPowerFixture(kind: 'unknown' | 'refused', nativeFailure?: ActionExecuteFailure | Error, reportRefused = false,
    returnedOutcome?: 'refused' | 'guest-startup-failed' | 'confirmed') {
    const guestStartup = returnedOutcome === 'guest-startup-failed';
    const base = managedFixture({ nativeTransport: guestStartup });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action, hostAccess: undefined,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const provisioner = manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {} };
    const intent = guestStartup ? 'start' as const : 'stop' as const;
    const retained: ManagedMachineV1 = { ...machine, controller: undefined, launch, allocation: 'bound', desired: intent,
      ...(guestStartup ? { enrolledMachineId: 'enrolled-guest', enrollmentIdentity: { kind: 'guestProcess', role: 'sandbox' } } : {}),
      resource: { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } },
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    const reports: unknown[] = [];
    app.post('/v1/machines/managed/controller/admit-control', async () => ({ machine: retained, replayed: false }));
    app.post('/v1/machines/managed/controller/submit-intent', async () => ({ machine: retained, submitted: true }));
    app.post('/v1/machines/managed/controller/report-intent', async (request, reply) => {
      reports.push(request.body);
      if (reportRefused) return reply.code(503).send({ code: 'managed_request_failed' });
      return { machine: retained };
    });
    const actionInput = { homeId: retained.homeId, managedId: retained.id, expectedRevision: 0, when: 'now' as const, intent };
    const actionContext: ActionExecutorContext = { ...context, actionRequestId: 'failed-power', runtimeAccountId: 'owner' };
    const native: string[] = [];
    let powered = false;
    const roles = readMachineProvisionerActionRolesV1(provisioner);
    actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.power.set', input: actionInput,
      context: actionContext, plan: { children: roles.filter(({ role }) => role === 'power' || returnedOutcome && (role === 'inspect'
        || guestStartup && (role === 'bootstrap' || role === 'exec'))).map(({ role, action }) => ({
          action: { pluginId: provider.pluginId, localId: action }, role })) },
      // The native provider boundary distinguishes a proven refusal from ambiguous delivery.
      execute: async body => {
        if (returnedOutcome) {
          if (!body || typeof body !== 'object' || !('action' in body) || !body.action || typeof body.action !== 'object'
            || !('localId' in body.action)) throw new Error('Expected provider Action');
          const localId = body.action.localId;
          const role = roles.find(candidate => candidate.action === localId)?.role;
          if (!role) throw new Error('Expected declared provider role');
          native.push(role);
          if (role === 'inspect') return { ok: true, result: { observedAt: 2, availability: 'present',
            power: guestStartup && powered ? 'running' : 'stopped', storage: 'retained' } };
          if (role === 'power') {
            powered = true;
            return { ok: true, result: returnedOutcome === 'refused'
              ? { kind: 'refused', code: 'native_permission_denied', nativeCause: { httpStatusClass: '4xx' } } : { kind: 'confirmed' } };
          }
          if (role === 'bootstrap') return { ok: true, result: { kind: 'native',
            transport: { contributionRef: provider, schemaVersion: 1 } } };
        }
        if (nativeFailure instanceof Error) throw nativeFailure;
        return nativeFailure ?? projectContributedActionFailure({
          errorCode: kind === 'refused' ? 'native_permission_denied' : 'native_transport_unavailable',
          error: 'Native failure', ...(kind === 'refused' ? { actionHandlerInvocation: 'notStarted' as const } : {}),
        });
      } });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    return { retained, reports, actionInput, actionContext, deps, native };
  }

  it.each(['unknown', 'refused'] as const)('reports a thrown Account power outcome as %s before preserving its failure', async kind => {
    const { retained, reports, actionInput, actionContext, deps } = await failedAccountPowerFixture(kind);
    expect(await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: actionInput, context: actionContext }))
      .toMatchObject({ ok: false, errorCode: kind === 'refused' ? 'native_permission_denied' : 'native_transport_unavailable' });
    expect(reports).toEqual([expect.objectContaining({ requestId: 'failed-power', expectedIntentRevision: retained.intentRevision,
      result: { kind, code: kind === 'refused' ? 'native_permission_denied' : 'native_transport_unavailable' } })]);
  });

  it('preserves the exact native exception when Account outcome reporting fails and records its closed report warning', async () => {
    const authored = projectContributedActionFailure({ errorCode: 'native_transport_unavailable', error: 'Reconnect the native provider',
      data: { failureCause: { phase: 'action.invoke', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } } });
    const nativeFailure = ManagedMachineControllerError.fromActionFailure(authored, 'action.invoke');
    // Console/file logging is an external IO boundary; keep its diagnostic payload observable.
    const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const { reports, actionInput, actionContext } = await failedAccountPowerFixture('unknown', nativeFailure, true);
      await expect(executeCliManagedAccountPower({ body: actionInput, context: actionContext,
        credentials: { token: 'bound', encryption: null }, serverUrl: 'http://home.test',
        post: async (suffix, request, schema) => {
          const response = await axios.post(`http://home.test/v1/machines/managed/controller/${suffix}`, request,
            { headers: { Authorization: 'Bearer bound' }, validateStatus: () => true });
          if (response.status >= 400) throw new ManagedMachineControllerError('managed_request_failed');
          return schema.parse(response.data);
        } })).rejects.toBe(nativeFailure);
      expect(nativeFailure.cause).toMatchObject({ errorCode: authored.errorCode, error: authored.error, failureCause: authored.failureCause });
      expect(reports).toEqual([expect.objectContaining({ result: { kind: 'unknown', code: 'native_transport_unavailable' } })]);
      expect(warnings).toHaveBeenCalledWith(expect.any(String),
        projectActionFailureCauseV1(new ManagedMachineControllerError('managed_request_failed'), 'machines.managed.power.set'));
    } finally { warnings.mockRestore(); }
  });

  it.each(['guest-startup-failed', 'refused', 'confirmed'] as const)(
    'preserves a known returned Account power failure when reporting fails while exposing confirmed report failure (%s)', async outcome => {
      const authored = projectContributedActionFailure({ errorCode: 'native_transport_unavailable', error: 'Reconnect the native provider',
        data: { failureCause: { phase: 'action.invoke', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } } });
      const nativeFailure = ManagedMachineControllerError.fromActionFailure(authored, 'action.invoke');
      const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        const { reports, actionInput, actionContext, native } = await failedAccountPowerFixture('unknown', nativeFailure, true, outcome);
        const execution = executeCliManagedAccountPower({ body: actionInput, context: actionContext,
          credentials: { token: 'bound', encryption: null }, serverUrl: 'http://home.test',
          post: async (suffix, request, schema) => {
            const response = await axios.post(`http://home.test/v1/machines/managed/controller/${suffix}`, request,
              { headers: { Authorization: 'Bearer bound' }, validateStatus: () => true });
            if (response.status >= 400) throw new ManagedMachineControllerError('managed_request_failed');
            return schema.parse(response.data);
          } });
        if (outcome === 'guest-startup-failed') await expect(execution).rejects.toBe(nativeFailure);
        else await expect(execution).rejects.toMatchObject({ code: outcome === 'refused' ? 'native_permission_denied' : 'managed_request_failed' });
        expect(reports).toEqual([expect.objectContaining({ result: expect.objectContaining(outcome === 'refused'
          ? { kind: 'refused', code: 'native_permission_denied' } : { kind: 'confirmed' }) })]);
        expect(native).toEqual(outcome === 'guest-startup-failed' ? ['inspect', 'power', 'inspect', 'bootstrap', 'exec']
          : outcome === 'refused' ? ['power'] : ['power', 'inspect']);
        if (outcome === 'confirmed') expect(warnings).not.toHaveBeenCalled();
        else expect(warnings).toHaveBeenCalledWith(expect.any(String),
          { phase: 'machines.managed.power.set', errorClass: 'ManagedMachineControllerError', errorCode: 'managed_request_failed', httpStatus: null });
      } finally { warnings.mockRestore(); }
    });

  it('preserves the closed returned native refusal cause when Home outcome reporting succeeds', async () => {
    const { reports, actionInput, actionContext, deps } = await failedAccountPowerFixture('unknown', undefined, false, 'refused');
    expect(await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: actionInput, context: actionContext }))
      .toMatchObject({ ok: false, errorCode: 'native_permission_denied',
        details: { kind: 'managedNative', nativeCause: { httpStatusClass: '4xx' } } });
    expect(reports).toEqual([expect.objectContaining({ result: {
      kind: 'refused', code: 'native_permission_denied', nativeCause: { httpStatusClass: '4xx' },
    } })]);
  });

  it('preserves the admitted authored native failure and its original cause at the Account Action boundary', async () => {
    const failureCause = { phase: 'action.invoke', errorClass: 'Error', errorCode: 'EPIPE', httpStatus: null } as const;
    const authored = projectContributedActionFailure({ errorCode: 'native_transport_unavailable', error: 'Reconnect the native provider',
      data: { failureCause } });
    const { actionInput, actionContext, deps } = await failedAccountPowerFixture('unknown', authored);
    expect(await deps.managedMachineAction!({ actionId: 'machines.managed.power.set', input: actionInput, context: actionContext }))
      .toMatchObject({ ok: false, errorCode: authored.errorCode, error: authored.error, failureCause,
        details: { name: 'PluginError', code: authored.errorCode, message: authored.error } });
  });

  it.each(['bound', 'pending-power', 'pending-acquisition', 'denied-read', 'missing-reviewed-child', 'wrong-purpose'] as const)('inspects Account native power and acquisition without a second effect and reports through retained correlation (%s)', async state => {
    const pending = state === 'pending-power';
    const acquiring = state === 'pending-acquisition';
    const credentialOwner = createConnectedAccountPurposeBindingOwner({
      store: { read: async () => ({ v: 1, bindings: [] }), update: async mutate => mutate({ v: 1, bindings: [] }), subscribe: () => ({ dispose() {} }) },
      selectTarget: async () => { throw new Error('Inspect must use its retained credential selection'); },
      resolveTarget: async () => { throw new Error('Wrong-purpose credential must not be resolved'); },
      materializeAccount: async () => { throw new Error('Wrong-purpose credential must not be materialized'); },
      projectTargetAccounts: async () => { throw new Error('Inspect must not list Accounts'); },
      assertTargetAccountMaterializable: async () => { throw new Error('Inspect must not probe an unrelated Account'); },
    });
    const base = managedFixture({ reconciliation: true, ...(state === 'wrong-purpose' ? { credentialOwner } : {}) });
    const manifest = normalizePluginManifestV2({ ...base.manifest, contributes: { ...base.manifest.contributes,
      actions: base.manifest.contributes.actions.map(action => ({ ...action, hostAccess: state === 'wrong-purpose' ? action.hostAccess : undefined,
        execution: { target: 'account', account: { artifactId: 'native', exportName: 'activate' } } })),
    } });
    const provisioner = manifest.contributes.machineProvisioners[0]!;
    const provider = { pluginId: manifest.id, localId: provisioner.id };
    const launch = { provider, schemaVersion: 1, name: 'Retained', choices: {}, ...(state === 'wrong-purpose' ? { credentials: [{
      purpose: { consumer: provider, purpose: 'another-purpose' }, account: { service: { pluginId: 'acme.accounts', localId: 'cloud' }, accountId: 'unrelated' },
    }] } : {}) };
    const resource = { contributionRef: provider, schemaVersion: 1, value: { id: 'same-native' } };
    let retained: ManagedMachineV1 = { ...machine, controller: undefined, launch, allocation: acquiring ? 'may-exist' : 'bound',
      ...(acquiring ? { nativeOperationRef: { contributionRef: provider, schemaVersion: 1, value: { requestId: 'original-allocation' } } } : { resource }),
      ...(pending ? { submittedNativeEffect: { intent: 'stop', requestId: 'original-power', intentRevision: 0 } } : {}),
      reviewedFacts: { launch, provisioner, optionStatus: 'current', prerequisites: [], billing: provisioner.billing,
        retentionCapabilities: provisioner.retention, retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false } };
    app.post(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.intent.read'], async () => ({
      availabilityCursor: 1, hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
      intent: { pluginId: provider.pluginId, desiredVersion: '1.0.0', enabled: true, offlineUiHosting: 'enabled', writableCollections: [], revision: 'intent-1' },
      release: { ref: { pluginId: provider.pluginId, version: '1.0.0' }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
        normalizedManifest: manifest, collectionContracts: [], uiSlots: [],
        packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] } },
      uiArtifacts: [], packageAssets: [],
    }));
    const paths: string[] = [];
    app.addHook('onRequest', async request => { paths.push(request.url); });
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => state === 'denied-read'
      ? reply.code(403).send({ code: 'permission_denied' }) : retained);
    app.post('/v1/machines/managed/controller/context', async () => ({ machine: retained, requestId: 'creation-request' }));
    const observation = { observedAt: 20, availability: 'present' as const, power: 'stopped' as const, storage: 'retained' as const };
    app.post(`/v1/machines/managed/controller/${pending ? 'report-intent' : 'report'}`, async request => {
      expect(request.body).toMatchObject({ requestId: pending ? 'original-power' : 'creation-request',
        expectedIntentRevision: pending ? 0 : retained.intentRevision, result: { kind: pending ? 'unknown' : 'bound' }, observation });
      const { submittedNativeEffect: _settled, ...current } = retained;
      retained = { ...current, resource, allocation: 'bound', observation };
      return { machine: retained };
    });
    const deps = createAccountServerActionDeps({ token: 'bound', serverId: 'route-home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'http://home.test' });
    const inspectInput = { homeId: retained.homeId, managedId: retained.id };
    const settlements: ManagedNativeOperationSettlement[] = [];
    const actionContext: ManagedMachineOperationSettlementContext = { ...context, actionRequestId: 'inspect-request', runtimeAccountId: 'owner',
      settleManagedNativeOperation: settlement => { settlements.push(settlement); } };
    const plan = await prepareCliManagedProvisionerAdmission({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext },
      { credentials: { token: 'bound', encryption: null }, serverUrl: 'http://home.test', managedMachineAction: deps.managedMachineAction });
    if (state === 'denied-read') {
      expect(plan).toEqual({ children: [] });
      expect(await deps.managedMachineAction!({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext }))
        .toMatchObject({ ok: false, errorCode: 'permission_denied' });
      expect(paths.every(path => path === '/v1/machines/managed/actions/get')).toBe(true);
      expect(settlements).toEqual([]);
      return;
    }
    expect(plan).toMatchObject({ children: expect.arrayContaining([{ action: { pluginId: provider.pluginId, localId: provisioner.actions.inspect }, role: 'inspect' }]) });
    if (!plan || !('children' in plan)) throw new Error('Expected prepared inspection roles');
    const native: string[] = [];
    if (state !== 'missing-reviewed-child') actionContext.hostReviewedChild = createHostReviewedChildPortV1({ actionId: 'machines.managed.inspect', input: inspectInput,
      context: actionContext, plan, execute: async body => {
        if (body && typeof body === 'object' && 'action' in body && body.action && typeof body.action === 'object'
          && 'localId' in body.action && body.action.localId === provisioner.reconciliation?.action) {
          expect(body).toMatchObject({ input: { nativeOperation: { requestId: 'original-allocation' } } });
          native.push('reconcile');
          return { ok: true, result: { kind: 'bound', resource } };
        }
        expect(body).toMatchObject({ action: { pluginId: provider.pluginId, localId: provisioner.actions.inspect }, input: { resource: { id: 'same-native' } } });
        native.push('inspect');
        return { ok: true, result: observation };
      } });
    if (state === 'missing-reviewed-child' || state === 'wrong-purpose') {
      expect(await deps.managedMachineAction!({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext }))
        .toMatchObject({ ok: false, errorCode: state === 'wrong-purpose' ? 'credential_unavailable' : 'admission_unavailable' });
      expect(native).toEqual([]);
      expect(settlements).toEqual([]);
      expect(paths.some(path => path.endsWith('/report') || path.endsWith('/report-intent') || path.endsWith('/submit-intent'))).toBe(false);
      return;
    }
    expect(await deps.managedMachineAction!({ actionId: 'machines.managed.inspect', input: inspectInput, context: actionContext }))
      .toMatchObject({ machine: { observation } });
    expect(native).toEqual(acquiring ? ['reconcile', 'inspect'] : ['inspect']);
    expect(settlements).toEqual(pending ? [{ managedId: retained.id, controller: undefined, resource,
      requestId: 'original-power', intentRevision: 0, intent: 'stop', succeeded: true }] : []);
    expect(paths.some(path => path.endsWith('/admit-control') || path.endsWith('/submit-intent') || path.endsWith('/execution-authorization'))).toBe(false);
    expect(paths).not.toContain('/v1/machines/managed/actions/inspect');
  });

  it('lists and gets retained resources through the real CLI executor without a controller or answering app', async () => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { machines: [machine] };
    });
    app.post('/v1/machines/managed/actions/get', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return machine;
    });
    const cli = executor();
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toEqual({ ok: true, result: { machines: [machine] } });
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: machine.id }, context))
      .resolves.toEqual({ ok: true, result: machine });
    expect(seen).toEqual([
      { url: '/v1/machines/managed/actions/list', body: { homeId: 'srv_home' }, authorization: 'Bearer bound' },
      { url: '/v1/machines/managed/actions/get', body: { homeId: 'srv_home', managedId: machine.id }, authorization: 'Bearer bound' },
    ]);
  });

  it('keeps a named managed refusal distinct from an older Home without the endpoint', async () => {
    app.post('/v1/machines/managed/actions/get', async (_request, reply) => reply.code(404).send({ code: 'managed_not_found' }));
    const cli = executor();
    await expect(cli.execute('machines.managed.get', { homeId: 'srv_home', managedId: 'missing' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'managed_not_found' });
    await expect(cli.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
  });

  it.each(['cli', 'agent', 'mcp'] as const)('retries the exact managed birth read through the real %s Action without listing Sessions', async surface => {
    const actionId = ActionIdSchema.parse('machines.managed.birth.get');
    const seen: string[] = [];
    let runId: string | null = 'run-birth';
    let sessionId: string | null = 'session-birth';
    let refused = false;
    const path = '/v1/machines/managed/actions/birth.get';
    app.post(path, async (request, reply) => {
      seen.push(request.url);
      expect(request.body).toEqual({ homeId: 'srv_home', managedId: machine.id });
      expect(request.headers.authorization).toBe('Bearer bound');
      return refused ? reply.code(403).send({ code: 'permission_denied' })
        : { source: runId ? { kind: 'run', source: { kind: 'workflow_run', runId } }
          : sessionId ? { kind: 'session', sessionId } : null };
    });
    const cli = executor();
    const read = () => invoke(cli, surface, actionId, { homeId: 'srv_home', managedId: machine.id });
    expect(await read()).toEqual({ ok: true, result: { source: { kind: 'run', source: { kind: 'workflow_run', runId } } } });
    expect(seen.splice(0)).toEqual([path]);
    runId = null;
    expect(await read()).toEqual({ ok: true, result: { source: { kind: 'session', sessionId } } });
    expect(seen.splice(0)).toEqual([path]);
    sessionId = null;
    expect(await read()).toEqual({ ok: true, result: { source: null } });
    seen.length = 0;
    refused = true;
    expect(await read()).toMatchObject({ ok: false, errorCode: 'permission_denied' });
    expect(seen).toEqual([path]);
    seen.length = 0;
    expect(await invoke(cli, surface, actionId, { homeId: 'foreign', managedId: machine.id })).toMatchObject({ ok: false });
    expect(seen).toEqual([]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Home inventory, preset edits, pools and sharing through the real %s adapter', async surface => {
    const seen: Array<{ url: string; body: unknown; authorization?: string }> = [];
    const preset = { id: 'preset-1', homeId: 'srv_home', revision: 2, name: 'Changed',
      owner: { kind: 'account', accountId: 'owner' }, launch: machine.launch, controller: machine.controller };
    app.post('/v1/machines/managed/actions/get', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return machine;
    });
    app.post('/v1/machines/presets/update', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { kind: 'saved', preset };
    });
    app.delete('/v1/machines/controller-1/access', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return { kind: 'removed', effectiveAccess: 'none' };
    });
    const poolId = '06986bf6-681b-46f1-8d68-bb619ac0c7f0';
    const resolvedPool = { kind: 'resolved', poolId, machineId: 'controller-1', priorityTier: 1 };
    app.post('/v1/machines/pools/resolve', async request => {
      seen.push({ url: request.url, body: request.body, authorization: request.headers.authorization });
      return resolvedPool;
    });
    const cli = executor();
    await expect(invoke(cli, surface, 'machines.managed.get', { homeId: 'srv_home', managedId: machine.id }))
      .resolves.toEqual({ ok: true, result: machine });
    const edit = { homeId: 'srv_home', id: preset.id, expectedRevision: 1, patch: { name: preset.name } };
    await expect(invoke(cli, surface, 'machines.presets.update', edit))
      .resolves.toEqual({ ok: true, result: { kind: 'saved', preset } });
    const principal = { kind: 'account', accountId: 'recipient' };
    await expect(invoke(cli, surface, 'machines.access.grant.remove', { serverId: 'route-home', machineId: 'controller-1', principal }))
      .resolves.toEqual({ ok: true, result: { kind: 'removed', effectiveAccess: 'none' } });
    const poolInput = { poolId, requestKey: `parity-${surface}`, purpose: 'session' };
    await expect(invoke(cli, surface, 'machines.pools.resolve', poolInput))
      .resolves.toEqual({ ok: true, result: resolvedPool });
    expect(seen).toEqual([
      { url: '/v1/machines/managed/actions/get', body: { homeId: 'srv_home', managedId: machine.id }, authorization: 'Bearer bound' },
      { url: '/v1/machines/presets/update', body: edit, authorization: 'Bearer bound' },
      { url: '/v1/machines/controller-1/access', body: { principal }, authorization: 'Bearer bound' },
      { url: '/v1/machines/pools/resolve', body: poolInput, authorization: 'Bearer bound' },
    ]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('admits the reviewed Setup Run and invokes terminals and authenticated work summary through the exact-machine %s transport', async surface => {
    if (!pluginReloadController.getState().activeRegistry) {
      const lease = await pluginReloadController.acquireRuntimeRegistry({
        resolveRuntimeRegistry: () => resolveExecutablePluginRuntimeRegistry({ contributes: createResolvedContributionRegistry({}) }),
      });
      await lease.release();
    }
    const seen: Array<{ method: string; request: unknown }> = [];
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'owner', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const requestId = `parity-${surface}-machines.setup.apply`;
    const setupPolicy = normalizeActionsSettingsV1({ ...policy,
      actions: { ...policy.actions, 'machines.setup.apply': { approvalRequiredSurfaces: ['cli', 'agent', 'mcp'] } },
      approvalWaivedSurfaces: { ...policy.approvalWaivedSurfaces, 'machines.setup.apply': [] },
    });
    const settings = AccountSettingsSchema.parse({ actionsSettingsV1: setupPolicy });
    setActiveAccountSettingsSnapshot({ source: 'network', settings,
      settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(token) });
    const environment = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'controller-1', targets: [{
      homeId: 'srv_home', machineId: 'controller-1', desiredRevision: 0, exclusions: [], recipePlans: [], sources: [
      { kind: 'accountPreset', presetId: 'preset-1', presetRevision: 2, setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }],  } },
      { kind: 'direct', setup: {} },
    ] }] });
    const terminals = { ok: true, terminals: [{ terminalId: 'terminal-1', terminalKey: 'setup', cwd: '/workspace', ended: false, exit: null }] };
    const workSummary = { kind: 'current', requesters: [{ accountId: 'recipient', displayName: 'Recipient', sessions: 2, tasks: 1, terminals: 3 }] } satisfies MachineWorkSummaryV1;
    const homeMachine = { id: 'controller-1', kind: 'persistent', active: true, activeAt: Date.now(),
      installationId: 'installation-1', revokedAt: null, replacedByMachineId: null,
      storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER, runnerContentKeyBinding: null,
      access: { custodian: { accountId: 'owner', displayName: 'Owner' }, role: 'manage', resourceMode: 'plain', accessState: 'ready' } };
    app.get('/v1/machines/controller-1', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return { machine: homeMachine };
    });
    app.get('/v1/machines', async () => [homeMachine]);
    app.get('/v1/account/profile', async () => ({ id: 'owner' }));
    app.get('/v1/account/encryption/currentness', async () => createAccountEncryptionCurrentnessFixture());
    app.get(SESSION_FOLLOW_HTTP_PATHS_V1.preferences, async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return { ...DEFAULT_SESSION_AUTO_FOLLOW_PREFERENCES_V1, ...DEFAULT_SESSION_FOLLOW_CREATION_POLICIES_V1 };
    });
    const features = FeaturesResponseSchema.parse({ features: { automations: { enabled: true }, workflows: { enabled: true } },
      capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    app.get('/v1/features', async () => features);
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return features;
    });
    // Agent and MCP tools originate in a real Session. Account-host labels such
    // as cli-global carry no machine, workspace or native caller baseline.
    const originSessionId = 'c333333333333333333333333';
    const originMetadata = createTestMetadata({ machineId: 'controller-1', path: '/workspace', permissionMode: 'default' });
    const originSession = createSessionRecordFixture({ id: originSessionId, active: true, encryptionMode: 'plain',
      metadata: JSON.stringify(originMetadata), workDepth: 0 });
    app.get('/v2/sessions/:sessionId', async request => {
      expect(request.params).toEqual({ sessionId: originSessionId });
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      return { session: originSession };
    });
    registerPlainArtifactRoutes(app, 'owner');
    app.get('/v2/account/settings', async () => ({ content: { t: 'plain', v: settings }, version: 1 }));
    const runId = deriveMachineSetupCombinedRunIdV1({ homeId: 'srv_home', accountId: 'owner', requestId });
    const storage = createWorkflowRunStorageTestkit({ accountId: 'owner', runId, machineId: 'controller-1', origin: { kind: 'direct' } });
    const storageFailures: Array<{ operation: 'get' | 'other'; errorClass: 'Error' | 'other';
      httpStatus: number; errorCode: 'run_not_found' | 'currentness_conflict' | 'unclassified' }> = [];
    app.post(WORKFLOW_RUN_STORAGE_HTTP_PATH, async (request, reply) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      // This is Home's opaque persistence boundary, not a preaccepted Run or a
      // substituted composition owner. The real owner materializes admission.
      const operation = request.body as WorkflowRunStorageTestkitOperation;
      if (operation.operation === 'wait') return reply.code(503).send({ error: 'storage_unavailable' });
      try {
        return await storage.execute(operation);
      } catch (error) {
        const response = error && typeof error === 'object' && 'response' in error ? error.response : null;
        if (!response || typeof response !== 'object' || !('status' in response)
          || typeof response.status !== 'number' || !('data' in response)) throw error;
        const code = response.data && typeof response.data === 'object' && 'error' in response.data
          ? response.data.error : null;
        storageFailures.push({ operation: operation.operation === 'get' ? 'get' : 'other',
          errorClass: error instanceof Error ? 'Error' : 'other', httpStatus: response.status,
          errorCode: code === 'run_not_found' || code === 'currentness_conflict' ? code : 'unclassified' });
        // Preserve the storage boundary's HTTP failure; Fastify otherwise turns
        // the testkit's Axios-shaped not-found rejection into an unrelated 500.
        return reply.code(response.status).send(response.data);
      }
    });
    const operations = createHostActionOperationRuntime({ serverId: 'route-home', machineId: 'controller-1',
      resolveAccountId: async () => 'owner', generateOperationId: () => `setup-${surface}` });
    socketBoundary.respond = async (event, payload) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!payload || typeof payload !== 'object') throw new Error('Missing machine RPC request');
      const method: unknown = Reflect.get(payload, 'method');
      expect(method).toBe(`controller-1:${RPC_METHODS.MACHINES_WORK_SUMMARY_GET}`);
      if (typeof method !== 'string') throw new Error('Missing machine RPC method');
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, Reflect.get(payload, 'params'), method);
      seen.push({ method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: decoded.params });
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, workSummary, decoded.callId) };
    };
    // The access.key reader owns terminal sign-in provenance. A bearer-shaped
    // object alone is automation and cannot approve the persisted request.
    const credentials = decodeStoredCredentials({ token });
    if (!credentials) throw new Error('Expected stored terminal credentials');
    const approvals: string[] = [];
    const cli = createCliActionExecutor({ token, credentials, sessionId: originSessionId, rawSession: originSession,
      serverId: 'route-home', serverIdentityId: 'srv_home',
      serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null,
      runActionOperation: operations.runActionOperation,
      isApprovalExecutionOriginCurrent: createDaemonApprovalExecutionOriginCurrentnessFromCredentials({ credentials,
        machineId: 'controller-1', serverId: 'route-home', serverApiUrl: 'http://home.test',
        // Local installation identity is the OS boundary; Home, Account and
        // exact-target review currentness still use their canonical owners.
        resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller-1', serverIdentityId: 'srv_home' }),
      }),
      onApprovalRequested: async (artifactId, signal) => {
        approvals.push(artifactId);
        return await cli.execute('approval.request.decide', { artifactId, decision: 'approve' }, {
          surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
          actionRequestId: `review-${requestId}`, signal,
        });
      },
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', token,
        fetchImpl: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.origin).toBe('http://home.test');
          const response = await app.inject({ method: 'GET', url: url.pathname,
            headers: Object.fromEntries(new Headers(init?.headers).entries()) });
          return new Response(response.payload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
        } }),
      // Only the daemon IPC boundary is substituted; the Action/tool executors,
      // exact-target adapter, schema validation and admission remain real.
      machineActionDirectTargetTransport: { machineId: 'controller-1', invoke: async (method, request) => {
        seen.push({ method, request });
        if (method === RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE) {
          return DaemonContributionRegistryProjectionDescribeResponseSchema.parse({ protocolVersion: 1,
            projection: { v: 2, generation: 1, familiesById: {} } });
        }
        if (method === RPC_METHODS.DAEMON_TERMINAL_LIST) return terminals;
        throw new Error(`Unexpected daemon method: ${method}`);
      } },
    });
    // Malformed Setup fails before admission. The valid request below reaches
    // the real composed Run owner and persists its reviewed parent in Home.
    await expect(invoke(cli, surface, 'machines.setup.apply', { ...environment, targets: environment.targets.map(target => ({ ...target,
      sources: target.sources.map(source => source.kind === 'accountPreset' ? { ...source, presetRevision: '2' } : source) })) }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
    const applied = surface === 'cli'
      ? await cli.execute('machines.setup.apply', environment, { ...context, actionsSettings: setupPolicy, actionRequestId: requestId })
      : await createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: setupPolicy,
          resolveCallerPermissionMode: () => originMetadata.permissionMode ?? null })
        .executeActionByToolName('action_execute', { actionId: 'machines.setup.apply', input: environment }, originSessionId,
          { actionRequestId: requestId });
    expect(applied, JSON.stringify(storageFailures)).toEqual({ ok: true, result: { operationId: `setup-${surface}`, runId } });
    // Agent/MCP acknowledge their Operation through its admission response.
    // Observe that same Operation through its public RPC owner.
    // The public uncertainty projection contains a typed failure, while the
    // CombinedRun receipt and accepted snapshot below retain exact Run identity.
    expect(await operations.handlers.getV2({ operationId: `setup-${surface}`, waitForTerminal: true }))
      .toMatchObject({ kind: 'found', operation: { operationId: `setup-${surface}`, requestId,
        actionId: 'machines.setup.apply', state: 'running', cancellation: 'unsupported',
        error: { errorCode: 'outcome_uncertain' } } });
    const accepted = storage.acceptedEnvelope();
    if (!accepted) throw new Error('Setup Run was not admitted to Home');
    const opened = openWorkflowAcceptedSnapshotStoredEnvelopeV1({ mode: 'plain',
      binding: { v: 1, purpose: 'accepted_snapshot', accountId: 'owner', runId },
      envelope: parseWorkflowStoredContentEnvelopeV1(accepted) });
    expect(opened).toMatchObject({ kind: 'available', content: {
      approvedOperation: { parent: { actionId: 'machines.setup.apply', input: environment } },
    } });
    expect(approvals).toHaveLength(1);
    await expect(invoke(cli, surface, 'machines.terminal.list', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: terminals });
    await expect(invoke(cli, surface, 'machines.work.summary.get', { serverId: 'route-home', machineId: 'controller-1' }))
      .resolves.toEqual({ ok: true, result: workSummary });
    expect(seen).toEqual([{ method: RPC_METHODS.DAEMON_MERGED_CONTRIBUTION_REGISTRY_PROJECTION_DESCRIBE,
      request: { machineId: 'controller-1', selection: 'workflowMaterialization' } },
      { method: RPC_METHODS.DAEMON_TERMINAL_LIST, request: {} },
      { method: RPC_METHODS.MACHINES_WORK_SUMMARY_GET, request: { serverId: 'route-home', machineId: 'controller-1' } }]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('retains the public Setup CombinedRun receipt and credential lifetime through the %s API-token bridge', async surface => {
    const token = 'hap_v1_11111111-1111-4111-8111-111111111111_' + 'A'.repeat(43);
    const credentials = { token, encryption: null, credentialProvenance: 'api_token' as const };
    const input = MachineSetupApplyInputV1Schema.parse({ homeId: 'srv_home', machineId: 'controller-1', targets: [{
      homeId: 'srv_home', machineId: 'controller-1', desiredRevision: 0, exclusions: [], recipePlans: [],
      sources: [{ kind: 'direct', setup: { scripts: [{ body: 'echo reviewed', affects: 'none' }] } }],
    }] });
    const result = ManagedMachineActionOutputSchemasV1['machines.setup.apply'].parse({
      operationId: `setup-${surface}`, runId: `setup-run-${surface}`,
    });
    const requests: unknown[] = [];
    app.post('/v1/actions/machines.setup.apply', async request => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      const envelope = ExternalActionRequestEnvelopeV1Schema.parse(request.body);
      expect(envelope).toEqual({ v: 1, requestId: `parity-${surface}-machines.setup.apply`,
        target: { kind: 'machine', machineId: 'controller-1' }, input });
      requests.push(envelope);
      // Home HTTP is the system boundary. Return the canonical owner's complete
      // receipt, keeping the public SDK's correlation and output parsing real.
      return { v: 1, actionId: 'machines.setup.apply', requestId: envelope.requestId,
        execution: { ok: true, result } };
    });
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    let current = true;
    const cli = createCliActionExecutorFromCredentials({ credentials,
      readCredentials: async () => current ? credentials : null,
      serverId: 'route-home', serverIdentityId: 'srv_home', serverApiUrl: origin, machineId: 'controller-1' });
    const execute = () => surface === 'cli'
      ? cli.execute('machines.setup.apply', input, { surface, actionRequestId: `parity-${surface}-machines.setup.apply` })
      : createActionToolExecutorBridge({ executor: cli, surface, actionsSettings: policy })
        .executeActionByToolName('action_execute', { actionId: 'machines.setup.apply', input }, 'cli-global',
          { actionRequestId: `parity-${surface}-machines.setup.apply` });
    await expect(execute()).resolves.toEqual({ ok: true, result });
    current = false;
    await expect(execute()).resolves.toMatchObject({ ok: false, errorCode: 'not_authenticated' });
    expect(requests).toHaveLength(1);
    expect(socketBoundary.connections).toEqual([]);
  });

  it.each(['cli', 'agent', 'mcp'] as const)('invokes Session and Run Stop through the real %s control owners on the captured Home', async surface => {
    const sessionId = 'c111111111111111111111111';
    const runId = 'stop-run';
    const seenHttp: Array<{ url: string; authorization?: string }> = [];
    const seenRpc: Array<{ method: string; request: unknown }> = [];
    app.get('/v2/sessions/:sessionId', async request => {
      seenHttp.push({ url: request.url, authorization: request.headers.authorization });
      return { session: createSessionRecordFixture({ id: sessionId, active: true, encryptionMode: 'plain',
        metadata: JSON.stringify(createTestMetadata({ machineId: 'controller-1' })) }) };
    });
    app.get('/v1/account/encryption/currentness', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return createAccountEncryptionCurrentnessFixture();
    });
    app.get('/v1/machines/controller-1', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return { machine: { id: 'controller-1', storageMode: 'plain', dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER } };
    });
    // Only physical Home HTTP and Socket.IO acknowledgements are substituted.
    // Session resolution, metadata opening, stop policy and Run control remain real.
    socketBoundary.respond = async (event, payload) => {
      expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
      if (!payload || typeof payload !== 'object') throw new Error('Missing Stop RPC request');
      const method: unknown = Reflect.get(payload, 'method');
      if (typeof method !== 'string') throw new Error('Missing Stop RPC method');
      const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, Reflect.get(payload, 'params'), method);
      seenRpc.push({ method, request: decoded.params });
      const response = method === `controller-1:${RPC_METHODS.STOP_SESSION}` ? { status: 'requested' }
        : method === `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}` ? { ok: true }
        : undefined;
      if (!response) throw new Error(`Unexpected Stop RPC target: ${method}`);
      return { ok: true, result: await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId) };
    };
    const cli = createCliActionExecutor({ token: 'bound', credentials: { token: 'bound', encryption: null },
      sessionId, serverId: 'route-home', serverHttpBaseUrl: 'http://home.test', mode: 'plain', ctx: null });
    await expect(invoke(cli, surface, 'session.stop', { sessionId }, sessionId)).resolves.toEqual({ ok: true,
      result: { ok: true, sessionId, stopped: false,
        stopOutcome: { status: 'physical_stop_unconfirmed', reason: 'daemon_stop_requested' } } });
    await expect(invoke(cli, surface, 'execution.run.stop', { sessionId, runId }, sessionId))
      .resolves.toEqual({ ok: true, result: surface === 'cli' ? { ok: true } : {} });
    expect(seenRpc).toEqual([
      { method: `controller-1:${RPC_METHODS.STOP_SESSION}`, request: { sessionId } },
      { method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_STOP}`, request: { runId } },
    ]);
    expect(seenHttp.length).toBeGreaterThan(0);
    expect(seenHttp.every(request => request.url.startsWith(`/v2/sessions/${sessionId}`)
      && request.authorization === 'Bearer bound')).toBe(true);
    expect(socketBoundary.connections.length).toBeGreaterThan(0);
    expect(socketBoundary.connections.every(connection => connection.serverUrl === 'http://home.test'
      && connection.token === 'bound')).toBe(true);
  });

  it('binds reads to the authenticated Home and withholds retired Account output', async () => {
    let current = true;
    const seen: unknown[] = [];
    app.post('/v1/machines/managed/actions/list', async request => {
      seen.push(request.body);
      current = false;
      return { machines: [machine] };
    });
    const features = FeaturesResponseSchema.parse({ features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_home' } } });
    app.get('/v1/features/authenticated', async request => {
      expect(request.headers.authorization).toBe('Bearer bound');
      return features;
    });
    app.get('/v1/features', async () => features);
    // Only Fetch's HTTP boundary is replaced; feature parsing and provenance
    // come from the same observation owner used by credentialed CLI execution.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe('http://home.test');
      const response = await app.inject({ method: 'GET', url: url.pathname,
        headers: Object.fromEntries(new Headers(init?.headers).entries()) });
      return new Response(response.payload, { status: response.statusCode, headers: { 'Content-Type': 'application/json' } });
    };
    const authenticated = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', token: 'bound', fetchImpl }),
      isCredentialCurrent: () => current });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'route-home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    const advisory = executor({ serverIdentityId: undefined,
      resolveServerFeaturesSnapshot: () => fetchServerFeaturesSnapshot({ serverUrl: 'http://home.test', fetchImpl }) });
    await expect(advisory.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'unsupported_action' });
    expect(seen).toEqual([]);
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    await expect(authenticated.execute('machines.managed.list', { homeId: 'srv_home' }, context))
      .resolves.toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(seen).toEqual([{ homeId: 'srv_home' }]);
  });
});
