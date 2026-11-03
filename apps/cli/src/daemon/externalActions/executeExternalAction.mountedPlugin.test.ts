import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import tweetnacl from 'tweetnacl';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createPluginManifestV2Fixture } from '@/plugins/testkit/manifestV2Fixture';
import { executeExternalAction } from './executeExternalAction';
import { arePluginMachineMaterializationRefsEqual } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1, PluginInstallationManifestPublisherHeaderV1Schema, createPluginInstallationManifestPublisherSigningInputV1, stringifyPluginInstallationManifestCanonicalJsonV1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { AutomationConversationActionHttpPathsV1 } from '@happier-dev/protocol/automations/event';
import * as persistence from '@/persistence';
import * as installationStore from '@/daemon/identity/store';
import axios from 'axios';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol';
import type { DaemonPluginMountedInvocationV1 } from '@happier-dev/protocol/plugins/actions/daemonInvocationV1';
import { createAdmittedPluginRuntimeFixture, createAuthoredAdmittedPluginRuntimeFixture } from '@/plugins/testkit/admittedRuntime';
import { createAutomationConversationActionExecutor } from '@/plugins/runtime/automations/automationConversationActionExecutor';
import { createDaemonApprovalExecutionOriginCurrentness } from './daemonExternalActionTargetResolver';
import { readAuthoritativePluginSlotOccurrence } from '@/plugins/runtime/reload/runtimeLease';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, parseExternalActionDaemonDispatchResultV1 } from '@happier-dev/protocol';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/rpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createPluginAccountBundledSelectionV1 } from '@happier-dev/protocol/plugins/availability';
import { readCurrentMountedAccountPluginExecutionSelection } from '@/plugins/runtime/accountPluginActivationSource';

// Network and on-disk machine credentials are the only replaced boundaries.
vi.mock('axios', () => ({ default: { post: vi.fn(), get: vi.fn() } }));

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
        isActionApprovalRequired: () => true,
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
    const settings = vi.spyOn(persistence, 'readSettings').mockResolvedValue({
      schemaVersion: 6, onboardingCompleted: true, machineId: 'machine-1',
    });
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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      automationConversationAction, isActionApprovalRequired: () => false });
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
    settings.mockResolvedValue({ schemaVersion: 6, onboardingCompleted: true });
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'automation_conversation_publisher_proof_unavailable' } } });
    expect(axios.post).not.toHaveBeenCalled();
    fixture.registry.fencePluginConsumers?.(['happier.channels']);
    expect(await run()).toMatchObject({ kind: 'response', response: { execution: {
      ok: false, errorCode: 'plugin_mounted_caller_unavailable' } } });
    expect(axios.post).not.toHaveBeenCalled();
  });
  it('creates a signed Inspector reload approval and rechecks durable source custody without retaining an occurrence', async () => {
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
      isActionApprovalRequired: () => true,
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
      resolveCurrentPluginSourceCustody: async (pluginId) => readAuthoritativePluginSlotOccurrence(pluginId,
        { controller: fixture.controller })?.sourceCustody ?? null,
    });
    expect(await isCurrent({ origin: request.executionOriginV1, request })).toBe(true);
    await fixture.lease.release();
    await fixture.controller.shutdown();
    expect(await isCurrent({ origin: request.executionOriginV1, request })).toBe(false);
  });
  it('refuses an unverifiable plugin claim before a host-only Action executes', async () => {
    let effects = 0;
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      hostExternalSessionAction: async () => { effects += 1; return { ok: true, result: { ok: true, candidates: [] } }; }, isActionApprovalRequired: () => false,
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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), isActionApprovalRequired: () => true,
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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(),
      hostExternalSessionAction: async () => { effects += 1; return { ok: true, result: { ok: true, candidates: [] } }; }, isActionApprovalRequired: () => false,
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
