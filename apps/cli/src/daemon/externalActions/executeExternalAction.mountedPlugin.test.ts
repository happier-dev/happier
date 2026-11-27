import { updateMachineRegistration } from '@/daemon/machineIdentity/machineRegistrationStore';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/actionExecutor';
import { projectDeploymentReadAdmissionV1, projectPrivateMountedDatabaseReadInputV1 } from '@happier-dev/protocol/deployments/deploymentReadAdmissionV1';
import { definePlugin, selectCurrentTargetedContribution, type TargetedContributionAdmittedEntry } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { requireAdmittedTargetedOperationExecutionBinding, resolveAdmittedTargetedOperationInput } from '@happier-dev/cli-common/plugins/registration';
import { DatabaseInsightSourceContributionProtocolV1 as insightSource, DatabaseInsightSourceOperationSchemasV1 as insightSchemas,
  DATABASE_INSIGHT_SOURCES_POINT_REF_V1 } from '@happier-dev/database-protocol/v1';
import { ActionSurfaceSchema } from '@happier-dev/protocol/actions/metadata';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { createHash } from 'node:crypto';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import tweetnacl from 'tweetnacl';
import { createEmptyActionAutomationPort, createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { executeExternalAction, type ExternalActionExecutor } from './executeExternalAction';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, PluginInstallationManifestPublisherHeaderV1Schema, createPluginInstallationManifestPublisherSigningInputV1, stringifyPluginInstallationManifestCanonicalJsonV1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { AutomationConversationActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import * as installationStore from '@/daemon/identity/store';
import axios from 'axios';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import { PluginUiSelectedActionInputCarrierV1Schema, computePluginUiSelectedActionInputDigestV1 } from '@happier-dev/protocol/plugins/ui/selectedActionInput';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import type { DaemonPluginMountedInvocationV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createPluginAccountBundledSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { readCurrentMountedAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';
import { registerDaemonContributionRegistryProjectionHandler } from '@/rpc/handlers/daemonContributionRegistryProjection';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { prepareRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { createCommittedContributedActionInvoker, listRuntimeContributedActionDefinitions } from '@/plugins/runtime/invocation/actions/createCommittedContributedActionDeps';

// Network and on-disk machine credentials are the only replaced boundaries.
vi.mock('axios', async importOriginal => {
  const actual = await importOriginal<typeof import('axios')>();
  return { ...actual, default: { ...actual.default, post: vi.fn(), get: vi.fn() } };
});

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function bundledMountedFixture(pluginId: string, contributionLocalId: string) {
  const fixture = await createAdmittedPluginRuntimeFixture({
    runtimeOptions: { pluginIds: [pluginId], resolveCurrentMachineId: () => 'machine-1' },
  });
  disposers.push(fixture.dispose);
  const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
  const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
  const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId);
  if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected bundled admitted occurrence, custody and materialization');
  return { fixture, invocation: { kind: 'mountedPluginSurface' as const, mountedBinding: {
    pluginId, contributionLocalId, occurrenceId, sourceCustody, materializationRef,
  } } };
}

async function mountedFixture(pluginId = 'acme.mounted', contributionLocalId = 'client-select') {
  const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
    plugins: [{
      manifest: createPluginManifestV2Fixture({ id: pluginId, contributes: {
        actions: [{ id: contributionLocalId, title: 'Select', scopes: ['global'], surfaces: ['ui'], placementBindings: [],
          dangerLevel: 'safe', execution: { target: 'client',
            client: { artifactId: 'client-select', exportName: 'activate' }, platforms: ['web'] } }],
      } }),
      files: { 'daemon.mjs': 'export function activate() {}' },
    }],
    runtimeOptions: { resolveCurrentMachineId: () => 'machine-1' },
  });
  disposers.push(fixture.dispose);
  const occurrenceId = fixture.registry.readPluginOccurrenceId?.(pluginId);
  const sourceCustody = fixture.registry.readPluginSourceCustody?.(pluginId);
  const materializationRef = fixture.registry.resolveCurrentPluginMaterializationRef?.(pluginId);
  if (!occurrenceId || !sourceCustody || !materializationRef) throw new Error('Expected real admitted occurrence, custody and materialization');
  return { fixture, invocation: { kind: 'clientPluginAction' as const, clientActionBinding: {
    pluginId, contributionLocalId, occurrenceId, sourceCustody, materializationRef,
  } } };
}

describe('external Action mounted plugin admission', () => {
  it.each(['machine', 'account'] as const)('admits the real Inspector %s binding through the Account relay RPC into normal approval, retaining retirement checks', async placement => {
    const { fixture, invocation } = await bundledMountedFixture('happier.inspector', 'inspector-page');
    // FIX-LIVE3 captured a source-only binding for inspector-page, not the
    // materialized synthetic binding used by the prior direct-ingress tests.
    const { materializationRef: _materialization, ...machineBinding } = invocation.mountedBinding;
    const declaration = fixture.registry.contributes.pluginDeclarations?.find(plugin => plugin.pluginId === 'happier.inspector');
    if (!declaration) throw new Error('Expected admitted Inspector declaration');
    let enabled = true;
    vi.mocked(axios.post).mockImplementation(async () => ({ data: { availabilityCursor: 1,
      hostingCapability: { enabled: false }, intent: { pluginId: 'happier.inspector', desiredVersion: null, enabled,
        offlineUiHosting: 'disabled', writableCollections: [], revision: '1' }, release: null, uiArtifacts: [], packageAssets: [] } }));
    const mountedBinding = placement === 'machine' ? machineBinding : {
      pluginId: 'happier.inspector', contributionLocalId: 'inspector-page', occurrenceId: 'app-account-custody',
      pluginVersion: declaration.manifest.version,
      sourceCustody: createPluginAccountBundledSelectionV1({
        packageName: declaration.sourceSpec.locator, manifest: declaration.manifest,
      }).sourceCustody,
    };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    const envelope = { v: 1 as const, requestId: 'inspector-relay', target,
      input: {}, pluginInvocation: { kind: 'mountedPluginSurface' as const, mountedBinding } };
    const handlers = new Map<string, RpcHandler>();
    const options = {
      machineId: 'machine-1', currentServerId: 'server-1',
      resolveAccountId: async () => 'account-1', resolveInstallationId: () => 'installation-1',
      verifyExecutionAuthorization: async () => true, resolveTarget: async () => target,
      externalActionMachineRequestPrivateKey: tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(45)).secretKey,
      executor: createActionExecutor({ ...createUnavailableActionTransportDeps(),
        // Account approval policy and Artifact persistence are external boundaries.
        readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['plugins.list']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }),
        approvalsCreate: async () => ({ artifactId: 'inspector-list-review' }),
        approvalsWaitForDecision: async ({ request }) => ({ decision: 'reject' as const, request }),
        approvalsUpdate: async () => ({ ok: true }),
      }),
      acquirePluginRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Runtime unavailable');
        return lease;
      },
      resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
      resolveAccountPluginExecutionSelection: (pluginId: string) => readCurrentMountedAccountPluginExecutionSelection({
        pluginId, runtime: { credentials: { token: 'fixture', encryption: null },
          serverHttpBaseUrl: 'https://account-caller.test', isCurrent: async () => true },
      }),
    };
    registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, options);
    const run = async () => {
      const result = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)!({
        actionId: 'plugins.list', envelope,
        principal: { accountId: 'account-1', authentication, authority: 'present_user' },
        placement: { machineId: 'machine-1', target },
        executionAuthorization: { v: 1, token: 'account-root', binding: {
          serverIdentityId: 'srv_home-1', accountId: 'account-1', custodianAccountId: 'account-1', authentication,
          machineId: 'machine-1', installationId: 'installation-1', actionId: 'plugins.list', target,
          requestId: envelope.requestId, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
      }, { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal });
      const parsed = parseExternalActionDaemonDispatchResultV1(result);
      if (parsed?.kind !== 'response' || parsed.prepared.response.v !== 1) throw new Error(`Expected Account relay response: ${JSON.stringify(result)}`);
      return parsed.prepared.response.execution;
    };
    expect(await run()).toEqual({ ok: false, errorCode: 'approval_rejected', error: 'approval_rejected' });
    if (placement === 'machine') fixture.registry.fencePluginConsumers?.(['happier.inspector']);
    else enabled = false;
    expect(await run()).toMatchObject({ ok: false, errorCode: 'plugin_mounted_caller_unavailable' });
  });

  it('admits only the exact private signed selection before the target-owned Action', async () => {
    const credentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url')}.signature`, encryption: null };
    const channel = await createRequesterCurrentnessSocketHarness();
    disposers.push(async () => { resetActiveAccountSettingsSnapshotForTests(); await channel.close(); });
    vi.mocked(axios.get).mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'account-1' } };
      if (url.includes('/v2/changes?')) return { status: 200, data: { changes: [], nextCursor: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { version: 1, content: { t: 'plain', v: {} } } };
      throw new Error(`Unexpected Home read: ${new URL(url).pathname}`);
    });
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKeyForToken(credentials.token) });
    let revision = 0;
    let producerInvalidate: ((operands: unknown) => void) | undefined;
    let producerReads = 0;
    let producerDisposed = 0;
    const mountedPluginId = 'happier.database';
    const sourcePluginId = 'acme.insight-source';
    const point = { pointId: DATABASE_INSIGHT_SOURCES_POINT_REF_V1.pointId,
      protocol: DATABASE_INSIGHT_SOURCES_POINT_REF_V1.protocol };
    const sourcePlugin = definePlugin({
      id: sourcePluginId, version: '0.0.0', entrypoints: { daemon: './daemon.mjs' },
      actions: {
        list: { title: 'List findings', surfaces: insightSource.operations.list.declaration.surfaces,
          inputSchema: insightSchemas.listInput, resultSchema: insightSchemas.listResult,
          run: async () => ({ ok: true, findings: [] }) },
        detail: { title: 'Read finding', surfaces: insightSource.operations.detail.declaration.surfaces,
          inputSchema: insightSchemas.detailInput, resultSchema: insightSchemas.detailResult,
          run: async () => ({ ok: false, status: 'unavailable', code: 'capture_read_expired', reason: 'trace_expired' }) },
      },
      resources: { changes: { source: 'dynamic', kind: 'config', contentType: 'application/json', scope: 'surface',
        execution: { target: 'daemon' }, runtime: {
          read() { throw new Error('Expected contextual producer'); }, observe() { throw new Error('Expected contextual producer'); },
          createProducer(context) {
            expect(context.context).toMatchObject({ kind: 'surface', launchInput: { target: { database: 'selected' }, recordKey: 'retained-record' } });
            return { read: () => { producerReads++; return JSON.stringify({ revision }); },
              observe(invalidate) { producerInvalidate = operands => {
                if (context.context?.kind === 'surface' && sameStrictJsonValue(operands, context.context.launchInput)) invalidate();
              }; return { dispose() { producerInvalidate = undefined; } }; },
              dispose() { producerDisposed++; } };
          },
        } } },
      contributesTo: { [mountedPluginId]: { [point.pointId]: { source: insightSource.contribute({
        descriptor: { displayName: 'Fixture source', targetKinds: ['managed_deployment'], engineIds: ['postgresql'],
          evidenceSchema: { type: 'object' }, changeResourceRef: { pluginId: sourcePluginId, localId: 'changes' } },
        operations: { list: insightSource.operations.list.bind('list'), detail: insightSource.operations.detail.bind('detail') },
      }) } } },
    });
    const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
      plugins: [{ manifest: sourcePlugin.manifest, files: { 'daemon.mjs': 'export function activate() {}' },
        instantiateCommittedModule: () => ({ activate: sourcePlugin.activate }) }],
      runtimeOptions: { pluginIds: [mountedPluginId, sourcePluginId], resolveCurrentMachineId: () => 'machine-1' },
    });
    disposers.push(fixture.dispose);
    const mountedOccurrence = fixture.registry.readPluginOccurrenceId?.(mountedPluginId);
    const mountedCustody = fixture.registry.readPluginSourceCustody?.(mountedPluginId);
    const sourceOccurrence = fixture.registry.readPluginOccurrenceId?.(sourcePluginId);
    const sourceCustody = fixture.registry.readPluginSourceCustody?.(sourcePluginId);
    if (!mountedOccurrence || !mountedCustody || !sourceOccurrence || !sourceCustody) throw new Error('Missing installed fixtures');
    const databaseTarget = { kind: 'managed_deployment' as const,
      environment: { serverId: 'srv_home-1', projectSourceId: 'source', environmentId: 'environment' },
      targetLinkId: 'selected-link', contribution: { pluginId: 'happier.neon', contributionId: 'database' },
      platformProjectId: 'project', branchId: 'branch', database: 'selected' };
    const contributor = { pluginId: sourcePluginId, contributionId: 'source', sourceCustody };
    const action = { pluginId: sourcePluginId, localId: 'detail' };
    const carrier = PluginUiSelectedActionInputCarrierV1Schema.parse({
      operation: { point, contributor: { ...contributor, occurrenceId: sourceOccurrence }, role: 'detail', action },
      result: { kind: 'submitted', action, input: { target: databaseTarget, recordKey: 'retained-record' },
        selection: { target: { pluginId: mountedPluginId, sourceCustody: mountedCustody }, point, contributor },
        connectedAccount: { kind: 'none' }, presentation: { connectedAccountLabel: null, machineDisplayName: null } },
    });
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const caller = { kind: 'plugin' as const, pluginId: mountedPluginId, contributionLocalId: 'database-workbench',
      occurrenceId: mountedOccurrence, sourceCustody: mountedCustody };
    const outerAction = { pluginId: mountedPluginId, localId: 'insights/sources/read' };
    const outerInput = { action: outerAction, input: { target: databaseTarget, recordKey: 'retained-record',
      role: 'detail', sourceSelection: carrier.result.selection } };
    const selection = { carrier, input: outerInput };
    const publicInput = projectPrivateMountedDatabaseReadInputV1(outerInput)!;
    const envelope = { v: 1 as const, requestId: 'mounted-selection', target,
      input: publicInput,
      pluginInvocation: { kind: 'mountedPluginSurface' as const, mountedBinding: {
        pluginId: mountedPluginId, contributionLocalId: caller.contributionLocalId,
        occurrenceId: mountedOccurrence, sourceCustody: mountedCustody,
        materializationRef: fixture.registry.resolveCurrentPluginMaterializationRef?.(mountedPluginId) ?? undefined,
      } },
      selectedActionInputDigest: computePluginUiSelectedActionInputDigestV1(selection),
    };
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    // The executor boundary runs the same selection and opaque-handle validators
    // as the target Action, backed by the published runtime's current declarations.
    const executor = { execute: vi.fn<ExternalActionExecutor['execute']>(async (_action, _input, context) => {
      const mountedSelection = context?.mountedSelectedActionInput;
      if (!mountedSelection) throw new Error('Missing selected input at target Action');
      const signal = new AbortController().signal;
      const current = await selectCurrentTargetedContribution<TargetedContributionAdmittedEntry>({
        service: fixture.controller.getTargetedContributionsOwner().bind({ pluginId: mountedPluginId, signal, isCurrent: () => true }),
        point: { targetPluginId: mountedPluginId, id: point.pointId, protocol: point.protocol },
        selection: outerInput.input.sourceSelection, operationRole: 'detail', signal,
      });
      if (current.kind !== 'selected') throw new Error('Missing admitted detail handle');
      const seed = { plugin: { id: mountedPluginId }, occurrenceId: current.targetOccurrenceId, sourceCustody: mountedCustody,
        selectedActionInputCarrier: mountedSelection.carrier, isMountedCallerCurrent: mountedSelection.isMountedCallerCurrent };
      try {
        const result = await resolveAdmittedTargetedOperationInput({
          seed, assertCurrent: () => signal.throwIfAborted(), input: carrier.result.input,
          binding: requireAdmittedTargetedOperationExecutionBinding(current.contribution.operations?.detail, seed),
          expectedSelectedConnectedAccountRef: null, selectedActionInputClaimed: { current: false }, signal,
        });
        return { ok: true, result };
      } catch (error) {
        if (!isPluginError(error)) throw error;
        return { ok: false, errorCode: error.code, error: error.code };
      }
    }) };
    const handlers = new Map<string, RpcHandler>();
    registerDaemonContributionRegistryProjectionHandler({ registerHandler(method, handler) { handlers.set(method, handler); } }, {
      resolveRuntimeRegistry: async () => fixture.registry, resolveInstalledPackages: async () => [],
      readHostResourceAccountId: () => 'account-1',
      resolvePluginProjectionExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: target.machineId }),
    });
    type Request = typeof envelope & { resourceContinuation?: { method: typeof RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN;
      params: { machineId: string; subscriptionId: string; resource: { hostRead: 'database.insightSource'; input: typeof publicInput;
        resource: { pluginId: string; localId: string } } } } };
    const run = (received = carrier, request: Request = envelope, signedRequest: Request = envelope,
      watch?: { signal: AbortSignal; onFrame(frame: unknown): void }, execution: ExternalActionExecutor = executor) => {
      const mountedBinding = signedRequest.pluginInvocation.mountedBinding;
      const executionAuthorization = sealExternalActionRequesterAccountContextV1({
        authorization: { v: 1, token: 'fixture', binding: { authentication, accountEncryptionMode: 'plain',
          accountId: 'account-1', custodianAccountId: 'account-1', serverIdentityId: 'srv_home-1',
          machineId: target.machineId, installationId: 'installation-1', target, actionId: 'action.invoke',
          requestId: envelope.requestId, admittedMachineRole: 'manage',
          deploymentReadAdmission: projectDeploymentReadAdmissionV1('action.invoke', publicInput),
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(signedRequest) } },
        credentials, purpose: { kind: 'external_action' },
        invocation: { caller: { ...caller, occurrenceId: mountedBinding.occurrenceId, sourceCustody: mountedBinding.sourceCustody },
          surface: 'ui', authority: 'account_automation', selectedActionInput: { ...selection, carrier: received } },
        installationPublicKey: key.publicKey, randomBytes: tweetnacl.randomBytes,
      });
      return executeExternalAction({ actionId: 'action.invoke', envelope: request, executionAuthorization,
        principal: { authority: 'account_automation', accountId: 'account-1', authentication },
        currentMachineId: target.machineId, currentAccountId: 'account-1', currentServerId: 'srv_home-1',
        currentInstallationId: 'installation-1', externalActionMachineRequestPrivateKey: key.secretKey,
        verifyExecutionAuthorization: async () => true, resolveTarget: async () => target, executor: execution,
        prepareRequesterAccountContext: async ({ authorization }) => {
          if (watch) return prepareRequesterAccountActionContext({ authorization, purpose: { kind: 'external_action' },
            machineId: target.machineId, installationId: 'installation-1', installationPrivateKey: key.secretKey,
            serverId: 'srv_home-1', serverIdentityId: 'srv_home-1', serverHttpBaseUrl: channel.serverUrl, ownCredentials: credentials,
            isCurrent: async () => true, isCustodyCurrent: async () => true, isRetainedCustodyCurrent: async () => true,
            createExecutor: () => execution });
          const opened = openExternalActionRequesterAccountContextV1({ authorization, purpose: { kind: 'external_action' },
            machineId: target.machineId, installationId: 'installation-1', serverIdentityId: 'srv_home-1',
            installationPrivateKey: key.secretKey, includeInvocation: true });
          return opened ? { authorization, invocation: opened.invocation, executor: execution,
            resolveEncryption: async () => null, dispose: async () => {} } : null;
        },
        acquirePluginRuntimeRegistryLease: async () => {
          const lease = fixture.controller.tryAcquireRuntimeRegistry();
          if (!lease) throw new Error('Runtime unavailable');
          return lease;
        },
        resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: target.machineId }),
        ...(watch ? { signal: watch.signal, sendHostResourceWatchFrame: async (response: unknown) => watch.onFrame(response) } : {}),
        invokeResource: async (method, params, context) => handlers.get(method)!(params, context),
      });
    };
    const result = await run();
    expect(result, JSON.stringify(result)).toMatchObject({ kind: 'response',
      response: { execution: { ok: true, result: { recordKey: 'retained-record' } } } });
    expect(executor.execute.mock.calls[0]?.[1]).toEqual(outerInput);
    expect(JSON.stringify(envelope)).not.toContain('retained-record');
    const watch = new AbortController();
    const opened = Promise.withResolvers<unknown>();
    const changed = Promise.withResolvers<unknown>();
    let frameCount = 0;
    const watchRequest = { ...envelope, resourceContinuation: { method: RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN,
      params: { machineId: target.machineId, subscriptionId: 'selected-source', resource: {
        hostRead: 'database.insightSource', input: publicInput, resource: { pluginId: sourcePluginId, localId: 'changes' },
      } } } } satisfies Request;
    const databaseExecutor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      actionAutomations: createEmptyActionAutomationPort('account-1'),
      listContributedActionDefinitions: selection => listRuntimeContributedActionDefinitions(fixture.registry, selection),
      invokeContributedAction: createCommittedContributedActionInvoker({ acquireRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Database fixture retired');
        return lease;
      } }),
    });
    let databaseAdmissions = 0;
    const admittedDatabaseExecutor: ExternalActionExecutor = { execute(...args) {
      databaseAdmissions++;
      return databaseExecutor.execute(...args);
    } };
    const deniedFinite = await run(carrier, envelope, envelope, undefined, admittedDatabaseExecutor);
    expect(deniedFinite).toMatchObject({ kind: 'response', response: { execution: { ok: false,
      errorCode: 'deployment_target_role_unavailable' } } });
    if (deniedFinite.kind !== 'response' || deniedFinite.response.v !== 1) throw new Error('Expected typed database admission refusal');
    const admissionRefusal = deniedFinite.response.execution;
    const deniedWatch = new AbortController();
    const wrongOpen = Promise.withResolvers<unknown>();
    const deniedStream = run(carrier, watchRequest, watchRequest, { signal: deniedWatch.signal,
      onFrame: () => wrongOpen.resolve({ watchOpenedWithoutDatabaseAdmission: true }) }, admittedDatabaseExecutor);
    try {
      const denied = await Promise.race([deniedStream, wrongOpen.promise]);
      expect(denied).toMatchObject({ kind: 'response', response: { execution: admissionRefusal } });
      expect(databaseAdmissions).toBe(2);
      expect(producerReads).toBe(0);
    } finally { deniedWatch.abort(); await deniedStream; }
    const forgedReference = { ...watchRequest, resourceContinuation: { ...watchRequest.resourceContinuation,
      params: { ...watchRequest.resourceContinuation.params, resource: { ...watchRequest.resourceContinuation.params.resource,
        resource: { pluginId: sourcePluginId, localId: 'foreign-changes' } } } } };
    await expect(run(carrier, forgedReference, forgedReference, { signal: watch.signal,
      onFrame: () => { throw new Error('Forged Resource must not establish'); } })).resolves.toMatchObject({ kind: 'response',
        response: { execution: { ok: true, result: { ok: false, code: 'plugin_resource_not_found' } } } });
    const admittedReads = executor.execute.mock.calls.length;
    const stream = run(carrier, watchRequest, watchRequest, { signal: watch.signal,
      onFrame: frame => (++frameCount === 1 ? opened : changed).resolve(frame) });
    try {
      const ended = stream.then(value => { throw new Error(`Selected watch ended before push: ${JSON.stringify(value)}`); });
      expect(await Promise.race([opened.promise, ended])).toMatchObject({ execution: { ok: true,
        result: { ok: true, subscriptionId: 'selected-source' } } });
      expect(frameCount).toBe(1);
      expect(executor.execute.mock.calls.length).toBe(admittedReads + 1);
      const baselineReads = producerReads;
      producerInvalidate!({ target: { ...databaseTarget, database: 'neighbor' }, recordKey: 'retained-record' });
      await Promise.resolve();
      expect(producerReads).toBe(baselineReads);
      expect(frameCount).toBe(1);
      revision++;
      producerInvalidate!({ target: databaseTarget, recordKey: 'retained-record' });
      expect(await Promise.race([changed.promise, ended])).toMatchObject({ execution: { ok: true,
        result: { status: 'event', event: { kind: 'invalidated', subscriptionId: 'selected-source' } } } });
      expect(frameCount).toBe(2);
      expect(executor.execute.mock.calls.length).toBe(admittedReads + 1);
    } finally { watch.abort(); await stream; }
    expect(producerDisposed).toBe(1);
    await expect(run({ ...carrier, result: { ...carrier.result, input: { target: databaseTarget, recordKey: 'substituted-record' } } }))
      .resolves.toMatchObject({ kind: 'response', response: { execution: { ok: false, errorCode: 'plugin_selected_action_input_invalid' } } });
    await expect(run(carrier, { ...envelope, selectedActionInputDigest: 'b'.repeat(43) }))
      .resolves.toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
    const replaceRuntime = async (pluginIds: string[]) => {
      const next = await createAdmittedPluginRuntimeFixture({ happyHomeDir: fixture.happyHomeDir,
        controller: fixture.controller, runtimeOptions: { pluginIds, resolveCurrentMachineId: () => 'machine-1',
          preparedActivationGraphsByPluginId: fixture.preparedActivationGraphsByPluginId } });
      disposers.push(next.dispose);
      return next.registry;
    };
    const retiringWatch = new AbortController();
    const retiringOpened = Promise.withResolvers<unknown>();
    const retired = Promise.withResolvers<unknown>();
    let retiringFrames = 0;
    const retiringStream = run(carrier, watchRequest, watchRequest, { signal: retiringWatch.signal,
      onFrame: frame => (++retiringFrames === 1 ? retiringOpened : retired).resolve(frame) });
    await Promise.race([retiringOpened.promise, retiringStream.then(value => {
      throw new Error(`Selected retirement watch ended before open: ${JSON.stringify(value)}`);
    })]);
    const disabled = await replaceRuntime([mountedPluginId]);
    try {
      expect(await Promise.race([retired.promise, retiringStream.then(value => {
        throw new Error(`Selected retirement watch ended without terminal frame: ${JSON.stringify(value)}`);
      })])).toMatchObject({ execution: { ok: true, result: { status: 'event', event: { kind: 'error', code: 'stale_surface' } } } });
      await retiringStream;
      expect(producerDisposed).toBe(2);
    } finally { retiringWatch.abort(); await retiringStream; }
    expect(disabled.readPluginOccurrenceId?.(sourcePluginId)).toBeNull();
    const enabled = await replaceRuntime([mountedPluginId, sourcePluginId]);
    expect(enabled.readPluginSourceCustody?.(sourcePluginId)).toEqual(sourceCustody);
    const currentSourceOccurrence = enabled.readPluginOccurrenceId?.(sourcePluginId);
    expect(currentSourceOccurrence).toEqual(expect.any(String));
    expect(currentSourceOccurrence).not.toBe(sourceOccurrence);
    // Refresh the current mount and sign that request, retaining the stale source selection.
    const currentMountedOccurrence = enabled.readPluginOccurrenceId?.(mountedPluginId);
    const currentMountedCustody = enabled.readPluginSourceCustody?.(mountedPluginId);
    if (!currentMountedOccurrence || !currentMountedCustody) throw new Error('Missing current mount');
    expect(currentMountedCustody).toEqual(mountedCustody);
    const replay = { ...envelope, pluginInvocation: { ...envelope.pluginInvocation,
      mountedBinding: { ...envelope.pluginInvocation.mountedBinding, occurrenceId: currentMountedOccurrence,
        sourceCustody: currentMountedCustody,
        materializationRef: enabled.resolveCurrentPluginMaterializationRef?.(mountedPluginId) ?? undefined } } };
    await expect(run(carrier, replay, replay)).resolves.toMatchObject({ kind: 'response',
      response: { execution: { ok: false, errorCode: 'plugin_action_generation_retired' } } });
  });

  it('does not admit a plugin-only root Action without a mounted claim', async () => {
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    expect(await executeExternalAction({ actionId: 'automation.conversation.targets.list',
      envelope: { v: 1, requestId: 'host-targets', input: { limit: 2 } },
      principal: { authority: 'present_user' }, currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }), executor,
    })).toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_action' });
  });
  it('lists Channels targets through the real conversation executor and locally signed publisher, refusing missing publisher and stale custody', async () => {
    const { fixture, invocation } = await bundledMountedFixture('happier.channels', 'session-conversations');
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43));
    await updateMachineRegistration(() => ({ machineId: 'machine-1' }));
    vi.spyOn(installationStore, 'readOrCreateInstallationIdentity').mockResolvedValue({
      version: 1, installationId: 'local-installation', createdAt: 1,
      publicKey: Buffer.from(key.publicKey).toString('base64url'),
      privateKey: Buffer.from(key.secretKey).toString('base64url'),
    });
    const list = { items: [{ automationId: 'automation-1', label: 'Conversation target',
      execution: { targetType: 'new_session', enabled: true } }], nextCursor: null };
    vi.mocked(axios.post).mockResolvedValue({ data: list });
    const automationConversationAction = createAutomationConversationActionExecutor({
      credentials: { token: 'account-token', encryption: { type: 'legacy', secret: new Uint8Array(32) } },
      revalidateCallerMaterialization: (ref) => {
        const current = fixture.registry.resolveCurrentPluginMaterializationRef?.(ref.pluginId);
        return !!current && arePluginMachineMaterializationRefsEqual(current, ref);
      },
      revalidateCallerOccurrence: (caller) => {
        const current = fixture.registry.readPluginOccurrenceId?.(caller.pluginId);
        return current != null && current === caller.occurrenceId
          && fixture.registry.isPluginOccurrenceCurrent?.(caller.pluginId, current) === true;
      },
    });
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"automation.conversation.targets.list": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      automationConversationAction });
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const run = (claim: DaemonPluginMountedInvocationV1 = invocation) => {
      const envelope = { v: 1 as const, requestId: 'channels-targets', target,
        input: { limit: 2 }, pluginInvocation: claim };
      return executeExternalAction({ actionId: 'automation.conversation.targets.list', envelope,
      principal: { accountId: 'account-1', authentication, authority: 'present_user' }, currentMachineId: 'machine-1',
      currentServerId: 'server-1', currentInstallationId: 'installation-1',
      executionAuthorization: { v: 1, token: 'account-root', binding: {
        serverIdentityId: 'srv_home-1', accountId: 'account-1', custodianAccountId: 'account-1', authentication,
        machineId: 'machine-1', installationId: 'installation-1', actionId: 'automation.conversation.targets.list', target,
        requestId: 'channels-targets', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }, externalActionMachineRequestPrivateKey: key.secretKey, verifyExecutionAuthorization: async () => true,
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }), executor,
      acquirePluginRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Runtime unavailable');
        return lease;
      },
      resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
    }); };
    const listed = await run();
    expect(listed.kind === 'response' && listed.response.v === 1 ? listed.response.execution : listed).toEqual({ ok: true, result: list });
    expect(listed).toMatchObject({ kind: 'response', response: { requestId: 'channels-targets' } });
    const [url, body, options] = vi.mocked(axios.post).mock.calls[0]!;
    expect(body).toMatchObject({ caller: { pluginId: 'happier.channels',
      contributionLocalId: 'session-conversations', sourceCustody: invocation.mountedBinding.sourceCustody } });
    const header = options?.headers?.[PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1];
    if (typeof header !== 'string') throw new Error('Expected local publisher header');
    const { proof } = PluginInstallationManifestPublisherHeaderV1Schema.parse(
      JSON.parse(Buffer.from(header, 'base64url').toString('utf8')));
    const { signatureBase64Url, ...signedProof } = proof;
    expect(proof).toMatchObject({ machineId: 'machine-1', installationId: 'local-installation', method: 'POST',
      path: AutomationConversationActionHttpPathsV1['automation.conversation.targets.list'],
      bodySha256Base64Url: createHash('sha256').update(stringifyPluginInstallationManifestCanonicalJsonV1(body)).digest('base64url'),
    });
    expect(url.endsWith(proof.path)).toBe(true);
    expect(tweetnacl.sign.detached.verify(createPluginInstallationManifestPublisherSigningInputV1({ proof: signedProof }),
      Buffer.from(signatureBase64Url, 'base64url'), key.publicKey)).toBe(true);
    vi.mocked(axios.post).mockClear();
    const { materializationRef: _materialization, ...sourceOnlyBinding } = invocation.mountedBinding;
    expect(await run({ kind: 'mountedPluginSurface', mountedBinding: sourceOnlyBinding })).toMatchObject({
      kind: 'response', response: { execution: { ok: false,
        errorCode: 'plugin_action_caller_required' } },
    });
    expect(axios.post).not.toHaveBeenCalled();
    await updateMachineRegistration(() => ({}));
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'automation_conversation_publisher_proof_unavailable' } } });
    expect(axios.post).not.toHaveBeenCalled();
    fixture.registry.fencePluginConsumers?.(['happier.channels']);
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'plugin_mounted_caller_unavailable' } } });
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('creates a signed Inspector reload approval refused once its plugin is no longer installed, without retaining an occurrence', async () => {
    const { fixture, invocation } = await bundledMountedFixture('happier.inspector', 'inspector-app');
    const { materializationRef: _materialization, ...sourceOnlyBinding } = invocation.mountedBinding;
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(42));
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authentication = { kind: 'account' as const, tokenEpoch: 0 };
    const envelope = { v: 1 as const, requestId: 'inspector-reload', target,
      input: { pluginId: 'acme.target' }, pluginInvocation: {
        kind: 'mountedPluginSurface' as const, mountedBinding: sourceOnlyBinding,
      } };
    const authorization = { v: 1 as const, token: 'home-issued-root', binding: {
      serverIdentityId: 'srv_home-1', accountId: 'account-1', custodianAccountId: 'account-1',
      authentication, machineId: 'machine-1', installationId: 'installation-1', actionId: 'plugins.reload',
      target, requestId: 'inspector-reload', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } };
    let stored: Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null = null;
    // Artifact storage and Home authorization are genuine network/persistence boundaries.
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['plugins.reload']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }),
      approvalsCreate: async ({ request }) => { stored = request; return { artifactId: 'reload-review' }; },
    });
    const result = await executeExternalAction({ actionId: 'plugins.reload', envelope,
      principal: { accountId: 'account-1', authentication, authority: 'present_user' },
      currentMachineId: 'machine-1', currentServerId: 'server-1', currentInstallationId: 'installation-1',
      executionAuthorization: authorization, externalActionMachineRequestPrivateKey: key.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveTarget: async () => target, executor,
      acquirePluginRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Runtime unavailable');
        return lease;
      },
      resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
    });
    expect(result.kind === 'response' && result.response.v === 1 ? result.response.execution : result).toEqual({
      ok: true, result: { kind: 'approval_request_created', artifactId: 'reload-review', actionId: 'plugins.reload' },
    });
    const request = stored as Parameters<NonNullable<ActionExecutorDeps['approvalsCreate']>>[0]['request'] | null;
    if (request?.v !== 2) throw new Error('Expected stored reload approval');
    expect(request.executionOriginV1.caller).toMatchObject({ kind: 'plugin', pluginId: 'happier.inspector',
      contributionLocalId: 'inspector-app', sourceCustody: invocation.mountedBinding.sourceCustody });
    expect(request.executionOriginV1.caller).not.toHaveProperty('occurrenceId');
    expect(request.executionOriginV1.caller).not.toHaveProperty('materialization');
    expect(fixture.controller.getState().generation).toBe(1);
    const isCurrent = createDaemonApprovalExecutionOriginCurrentness({
      accountId: 'account-1', machineId: 'machine-1', serverId: 'server-1',
      resolveCurrentMachineExecutionOriginContext: async () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
      resolveTarget: async () => target, isAccountCurrent: async () => true, listAccountApiTokens: async () => ({ tokens: [] }),
      externalActionMachinePublicKey: key.publicKey, verifyExternalExecutionAuthorization: async () => true,
      isPluginInstalled: (pluginId) => readAuthoritativePluginSlotOccurrence(pluginId, { controller: fixture.controller }) !== null,
    });
    expect(await isCurrent({ origin: request.executionOriginV1, request })).toBe(true);
    await fixture.lease.release();
    await fixture.controller.shutdown();
    // No generation compare (plugins trusted); a plugin no longer installed is the person's revocation.
    expect(await isCurrent({ origin: request.executionOriginV1, request })).toBe(false);
  });
  it('refuses an unverifiable plugin claim before a host-only Action executes', async () => {
    let effects = 0;
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"sessions.external.candidates.list": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      hostExternalSessionAction: async () => { effects += 1; return { ok: true, result: { ok: true, candidates: [] } }; },
    });
    const { invocation } = await mountedFixture();
    const result = await executeExternalAction({ actionId: 'sessions.external.candidates.list',
      envelope: { v: 1, requestId: 'request-claimed-host', input: {
        machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
      }, pluginInvocation: invocation },
      principal: { authority: 'present_user' }, currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }), executor,
    });
    expect(result).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'plugin_mounted_caller_unavailable',
    } } });
    expect(effects).toBe(0);
  });

  it('does not upgrade a signed terminal principal through a mounted plugin claim', async () => {
    const { fixture, invocation } = await mountedFixture();
    const key = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(44));
    const target = { kind: 'machine' as const, machineId: 'machine-1' };
    const authentication = { kind: 'terminal' as const, tokenEpoch: 0 };
    const envelope = { v: 1 as const, requestId: 'terminal-claim', target,
      input: { pluginId: 'acme.mounted' }, pluginInvocation: invocation };
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), readActionsSettings: () => ActionsSettingsV1Schema.parse({ v: 1, actions: { ['plugins.reload']: { approvalRequiredSurfaces: Object.keys(ActionSurfaceSchema.shape) } } }),
      approvalsCreate: async () => { throw new Error('Terminal plugin claim must not create an approval'); } });
    expect(await executeExternalAction({ actionId: 'plugins.reload', envelope,
      principal: { accountId: 'account-1', authentication, authority: 'account_automation' },
      currentMachineId: 'machine-1', currentServerId: 'server-1', currentInstallationId: 'installation-1',
      executionAuthorization: { v: 1, token: 'terminal-root', binding: {
        serverIdentityId: 'srv_home-1', accountId: 'account-1', custodianAccountId: 'account-1', authentication,
        machineId: 'machine-1', installationId: 'installation-1', actionId: 'plugins.reload', target,
        requestId: 'terminal-claim', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } }, externalActionMachineRequestPrivateKey: key.secretKey, verifyExecutionAuthorization: async () => true,
      resolveTarget: async () => target, executor,
      acquirePluginRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Runtime unavailable');
        return lease;
      },
      resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
    })).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'plugin_mounted_caller_unavailable',
    } } });
  });

  it('uses admitted plugin policy and refuses a retired occurrence through the real registry', async () => {
    const { fixture, invocation } = await mountedFixture();
    let effects = 0;
    const executor = createActionExecutor({
    readActionsSettings: (context: ActionExecutorContext) => ActionsSettingsV1Schema.parse({ v: 1, ...context.actionsSettings, approvalWaivedSurfaces: {"sessions.external.candidates.list": Object.keys(ActionSurfaceSchema.shape), ...context.actionsSettings?.approvalWaivedSurfaces} }), ...createUnavailableActionTransportDeps(),
      hostExternalSessionAction: async () => { effects += 1; return { ok: true, result: { ok: true, candidates: [] } }; },
    });
    const run = (claim: unknown = invocation, principal: Parameters<typeof executeExternalAction>[0]['principal'] = { authority: 'present_user' }) => executeExternalAction({ actionId: 'sessions.external.candidates.list',
      envelope: { v: 1, requestId: 'request-mounted', input: {
        machineId: 'machine-1', agentId: 'codex', source: { kind: 'codexHome', home: 'user' },
      }, pluginInvocation: claim },
      principal, currentMachineId: 'machine-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }), executor,
      acquirePluginRuntimeRegistryLease: async () => {
        const lease = fixture.controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Runtime unavailable');
        return lease;
      },
      resolvePluginExecutionOriginContext: () => ({ serverIdentityId: 'srv_home-1', machineId: 'machine-1' }),
    });
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'action_disabled',
    } } });
    const binding = invocation.clientActionBinding;
    for (const rejectedBinding of [
      { ...binding, contributionLocalId: 'not-admitted' },
      { ...binding, materializationRef: { ...binding.materializationRef, machineId: 'another-machine' } },
      { ...binding, sourceCustody: { kind: 'managed', installSource: 'archive', immutableGenerationId: 'unadmitted-bytes' } },
    ]) {
      expect(await run({ kind: 'clientPluginAction', clientActionBinding: rejectedBinding })).toMatchObject({
        kind: 'response', response: { execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable' } },
      });
    }
    expect(await run(invocation, { accountId: 'account-1', principalId: 'pat-principal', credentialId: 'pat-1',
      authority: 'account_automation', grant: API_TOKEN_FULL_GRANT_V1 })).toMatchObject({ kind: 'response',
      response: { execution: { ok: false, errorCode: 'plugin_mounted_caller_unavailable' } } });
    fixture.registry.fencePluginConsumers?.(['acme.mounted']);
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'plugin_mounted_caller_unavailable',
    } } });
    expect(effects).toBe(0);
  });
});
