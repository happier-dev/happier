import { readFile } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { AccountSettingsSchema, DEFAULT_PROVIDER_SETTINGS_V1, splitProviderSettingsV1 } from '@happier-dev/protocol';
import { resolveAgentCliOverrideEnvKey } from '@happier-dev/cli-common/agents/resolution';
import type { ParsedPluginManifestV2 } from '@happier-dev/protocol/plugins/manifest';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connected-service-bindings';
import { qualifiedConnectedAccountPreferenceServiceKey } from '@happier-dev/protocol/connect/connectedServiceProfilePreferences';
import { SessionModelSelectionSchema } from '@happier-dev/protocol/providers/selection/v2';
import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import { prepareExecutionRunProviderLaunch } from '@/agent/runtime/bridges/executionRun/runtime/providerLaunch';
import { projectRunnerExecutionRunProviderLaunch } from '@/daemon/agentRuntime/runnerExecutionRunProviderLaunch';
import { createConnectedAccountRequestAuthService } from '@/daemon/connectedServices/requestAuth/ConnectedAccountRequestAuthService';
import { prepareDaemonProviderLaunch } from '@/daemon/spawn/prepareDaemonProviderLaunch';
import { prepareDaemonSpawnChildEnvironment } from '@/daemon/spawn/prepareDaemonSpawnChildEnvironment';
import { withConfiguredDaemonTestHome } from '@/daemon/testkit/fakeDaemonLifecycle.testkit';
import { resolveAgentCliRuntimeSpecForLookupId } from '@/packagedRuntime/managedTools/requireAgentCliCommand';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { indexAgentRoutingIdsByContributionIdentity, readAgentRoutingIdForContributionIdentity } from '@/plugins/projection/registry/agentRoutingIdentity';
import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { createAuthoredAdmittedPluginRuntimeFixture, requireDaemonEntrypoint } from '@/plugins/testkit/admittedRuntime';
import { createProviderConnectionHttpTransport } from '@/providers/broker/providerConnectionHttpTransport';
import { openConnectedAccountProviderTransport } from '@/providers/broker/connectedAccountTransport';
import { startManagedProviderConsumerApplication } from '@/providers/broker/managedProviderConsumerApplication';
import { openPinnedHttpStream } from '@/network/pinnedHttp';
import { createProviderLaunchResourceScope } from '@/providers/lifecycle/resourceScope';
import { createRuntimeProviderModelManagementServices } from '@/providers/modelManagement/runtimeServices';
import { createProviderRedactionLease } from '@/providers/spawn/redaction';
import { writeExecutableShim } from '@/testkit/fs/executableShim';
import { resolveAccountSettingsScopeKeyForToken } from '@/settings/accountSettings/accountSettingsScopeKey';

import { PLUGIN_MANIFEST as claudeManifest } from '../../../../../packages/plugins/claude/src/manifest';
import { activate as activateClaude } from '../../../../../packages/plugins/claude/src/activate';
import { connectedAccountPortableRuntime } from '../../../../../packages/plugins/machine-vercel/src/account';
import { PLUGIN as vercelMachine } from '../../../../../packages/plugins/machine-vercel/src/manifest';
import * as vercelGateway from '../../../../../packages/plugins/vercel-ai-gateway/src/manifest';
import { VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/vercel-ai-gateway/src/provider/contribution';
import { createAgentProviderCatalogObservationService } from './agentCatalogObservation';
import { createProviderProbeHttpClient } from './client';
import { startGatewayMessagesUpstream } from './gatewayJourney.testkit';
import { createProviderProbeScheduler } from './scheduler';

const service = { pluginId: vercelMachine.manifest.id, localId: 'vercel-account' };
const provider = { pluginId: vercelGateway.PLUGIN_MANIFEST.id, localId: vercelGateway.PLUGIN_MANIFEST.contributes.providers[0]!.id };
const purpose = { consumer: provider, purpose: 'model-inference' };
const account = { service, accountId: 'selected-vercel-account' };
const modelId = 'anthropic/claude-gateway-fixture';
const teamId = 'team_selected';
const vendorToken = 'fixture-vercel-oauth-access-token';
const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
const machineId = 'controller';
const endpointTemplateId = 'vercel-anthropic';
const answer = 'Gateway completed the Claude turn';

type AuthoredPluginFixture = Parameters<typeof createAuthoredAdmittedPluginRuntimeFixture>[0]['plugins'][number];

async function packagedPluginFixture(
  manifest: ParsedPluginManifestV2,
  directory: string,
  instantiateCommittedModule?: AuthoredPluginFixture['instantiateCommittedModule'],
  daemonFiles: Readonly<Record<string, string>> = {},
): Promise<AuthoredPluginFixture> {
  const packageRoot = new URL(`../../../../../packages/plugins/${directory}/`, import.meta.url);
  const paths = manifest.contributes.resources.flatMap(resource =>
    'path' in resource && typeof resource.path === 'string' ? [resource.path] : []);
  const fileEntries = await Promise.all(paths.map(async path => [path, await readFile(new URL(path, packageRoot))] as const));
  return {
    manifest,
    files: { ...Object.fromEntries(fileEntries), [requireDaemonEntrypoint(manifest)]: 'export function activate() {}', ...daemonFiles },
    instantiateCommittedModule,
  };
}

function headerValues(headers: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < headers.length; i += 2) {
    if (headers[i]?.toLowerCase() === name) values.push(headers[i + 1]!);
  }
  return values;
}

it('launches the selected signed-in Gateway model for a Claude Session through local request auth', async () => {
  await withConfiguredDaemonTestHome({ prefix: 'gateway-signin-' }, async ({ homeDir }) => {
    const cleanups: Array<() => unknown> = [];
    const defer = (cleanup: () => unknown) => { cleanups.unshift(cleanup); };
    try {
      const upstream = await startGatewayMessagesUpstream({ modelId, answer });
      defer(upstream.close);
      const fixture = await createAuthoredAdmittedPluginRuntimeFixture({
        happyHomeDir: homeDir,
        plugins: await Promise.all([
          packagedPluginFixture(claudeManifest, 'claude', () => ({ activate: activateClaude }), {
            // The registered runner needs a committed leaf before the Agent
            // adapter is published. This journey substitutes the Agent process.
            '.happier-plugin-build/agent/runtime/factory.js':
              'export function createClaudeAgentRuntime() { throw new Error("Unexpected Claude process"); }',
          }),
          packagedPluginFixture(vercelMachine.manifest, 'machine-vercel', () => ({ activate: vercelMachine.activate })),
          packagedPluginFixture(vercelGateway.PLUGIN_MANIFEST, 'vercel-ai-gateway', () => ({ activate: vercelGateway.activate })),
        ]),
        coldStart: true,
        async resolveContributes(happyHomeDir) {
          return createResolvedContributionRegistry(projectLoadedPluginContributes({
            loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external',
          }));
        },
      });
      defer(fixture.dispose);
      const unexpected = async (): Promise<never> => { throw new Error('Unexpected access outside the selected Gateway account'); };
      const vendorMaterialize = connectedAccountPortableRuntime.materialize;
      if (!vendorMaterialize) throw new Error('Vercel Account fixture has no materializer');
      let accountConnected = true;
      let currentRevision = revision;
      let currentToken = vendorToken;
      const rotatedToken = 'fixture-vercel-oauth-rotated-token';
      const resolveTarget = vi.fn<Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['resolveTarget']>(async target =>
        accountConnected && target.kind === 'account' && target.account.accountId === account.accountId
          ? { account, displayName: 'Selected Vercel team' } : null);
      const materializeAccount = vi.fn<Parameters<typeof createConnectedAccountPurposeBindingOwner>[0]['materializeAccount']>(
        async ({ credentialRevisionBasis, request, signal }) => {
          credentialRevisionBasis?.captureCredentialRevision(currentRevision);
          return vendorMaterialize(request, {
            account, signal,
            plugin: { id: service.pluginId, version: vercelMachine.manifest.version },
            contribution: { id: service.localId, qualifiedId: qualifiedConnectedAccountPreferenceServiceKey(service) },
            surface: 'background', invokedAtMs: Date.now(),
            services: createUnavailablePluginServices(),
            configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'configuration-1',
              values: { teamId }, getSecret: async () => null },
            credentials: { get: async name => name === 'token' ? currentToken : name === 'expiresAtMs' ? '2000000000000' : null },
          });
        },
      );
      const purposeBindings = createConnectedAccountPurposeBindingOwner({
        store: { read: async () => ({ v: 1, bindings: [] }), update: unexpected, subscribe: () => ({ dispose() {} }) },
        selectTarget: unexpected, resolveTarget, materializeAccount,
        resolveCredentialRevision: async () => currentRevision, resolveCredentialConfigurationRevision: async () => 'configuration-1',
        projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
      });
      const resolveCurrentBinding = vi.fn<Parameters<typeof createConnectedAccountRequestAuthService>[0]['resolveCurrentBinding']>(
        async input => await input.subject.bindingAuthority?.resolveCurrentBinding(input) ?? null);
      const rotateAtVendorBoundary = vi.fn(async () => {
        currentRevision = 'csr_1123456789ABCDEFGHJKMNPQRS';
        currentToken = rotatedToken;
        return { status: 'current_changed' as const };
      });
      const auth = createConnectedAccountRequestAuthService({
        resolveCurrentBinding,
        materializeHeaders: input => input.subject.bindingAuthority?.materializeHeaders(input) ?? unexpected(),
        refreshAfterAuthFailure: rotateAtVendorBoundary, reportQuotaFailure: unexpected,
      });
      const lookupRequestAuth = vi.fn(auth.lookupRequestAuth);
      const requestAuth = { lookupRequestAuth, refreshAfterAuthFailure: auth.refreshAfterAuthFailure };
      const resolveAddresses = async () => ['1.1.1.1'];
      const client = createProviderProbeHttpClient({
        resolveAddresses,
        async transport({ url, method, headers, signal }) {
          // Preserve the production path, query and headers across the vendor socket boundary.
          const requested = new URL(url);
          const response = await fetch(upstream.origin + requested.pathname + requested.search, { method, headers, signal });
          return { status: response.status, headers: Object.fromEntries(response.headers), body: new Uint8Array(await response.arrayBuffer()) };
        },
      });
      const observation = createAgentProviderCatalogObservationService({
        activatePurposeBindings: purposeBindings.activatePurposeBindings,
        readBindingObservation: purposeBindings.readBindingObservation,
        requestAuth, client, scheduler: createProviderProbeScheduler(),
        createRedactionLease: () => createProviderRedactionLease({ values: [] }),
      });
      const resolveSelection = vi.fn(purposeBindings.resolveBindingIntentSelection);
      const { catalog, defaults } = splitProviderSettingsV1(DEFAULT_PROVIDER_SETTINGS_V1);
      const snapshot = {
        source: 'cache' as const, scopeKey: resolveAccountSettingsScopeKeyForToken('gateway-signin-fixture'),
        settings: AccountSettingsSchema.parse({ providerDefaultModelSelectionsByAgentTargetKeyV1: defaults }),
        settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
        providerConnectionsCatalog: { status: 'ready' as const, revision: 1, catalog },
      };
      const models = createRuntimeProviderModelManagementServices({
        machineId, happyHomeDir: fixture.happyHomeDir, acquireRuntimeLease: async () => ({ ...fixture.lease, release: async () => {} }),
        featureGate: { isEnabled: () => true }, modelSettingsMutation: unexpected, resolveAddresses, client,
        getAccountSettingsSnapshot: () => snapshot,
        resolveManagedPurposeBindingIntentSelection: resolveSelection, observeConnectedAccountSourceModels: observation.observe,
      });
      const claudeIdentity = { pluginId: claudeManifest.id, localId: 'claude' };
      const agentId = readAgentRoutingIdForContributionIdentity(
        indexAgentRoutingIdsByContributionIdentity([...fixture.registry.contributes.agentDefinitionsById.values()]),
        claudeIdentity,
      );
      if (!agentId) throw new Error('Expected the installed Claude Agent');
      const backendTarget = { kind: 'backend' as const, backendId: agentId };
      const agentTargetKey = buildBackendTargetKeyV2(backendTarget);
      const connectedServices = ConnectedServiceBindingsV2Schema.parse({ v: 2, bindingsByServiceId: {
        [qualifiedConnectedAccountPreferenceServiceKey(service)]: { source: 'connected', profileId: account.accountId },
      } });
      const projection = await models.projectModels({ machineId, agentTargetKey, connectedServices });
      if (projection.status !== 'success') {
        throw new Error(`Connected Account catalog failed (${projection.error.code} after ${resolveSelection.mock.calls.length} source resolutions, ${lookupRequestAuth.mock.calls.length} auth lookups and ${upstream.requests.length} Gateway requests)`);
      }
      expect(projection).toMatchObject({ status: 'success', groups: expect.arrayContaining([expect.objectContaining({
        rows: expect.arrayContaining([expect.objectContaining({
          descriptor: expect.objectContaining({ id: modelId }),
          ref: { source: 'connected_account', purpose, endpointTemplateId, agentTargetKey, modelId },
        })]),
      })]) });
      expect(upstream.requests).toHaveLength(1);
      expect(lookupRequestAuth).toHaveBeenCalledTimes(1);
      expect(materializeAccount).toHaveBeenCalledTimes(1);
      const [catalogRequest] = upstream.requests;
      const catalogQuery = new URL(catalogRequest!.pathAndQuery, upstream.origin).searchParams;
      expect(catalogQuery.getAll('teamId')).toEqual([teamId]);
      expect(headerValues(catalogRequest!.rawHeaders, 'authorization').join() === `Bearer ${vendorToken}`).toBe(true);
      expect(headerValues(catalogRequest!.rawHeaders, 'x-vercel-ai-gateway-team')).toEqual([teamId]);

      const row = projection.groups.flatMap(group => group.rows).find(row => row.descriptor.id === modelId);
      const selection = SessionModelSelectionSchema.parse({ v: 2, updatedAt: 1, ref: row?.ref });
      const openHttp = vi.fn<typeof openPinnedHttpStream>(request => {
        const requested = new URL(request.url);
        return openPinnedHttpStream({ ...request, url: upstream.origin + requested.pathname + requested.search,
          validatedAddresses: ['127.0.0.1'] });
      });
      const providerConnectionHttpTransport = createProviderConnectionHttpTransport({ openHttp });
      const admissions = vi.spyOn(providerConnectionHttpTransport, 'open');
      const scope = createProviderLaunchResourceScope();
      defer(() => scope.retire());
      const redaction = createProviderRedactionLease({ values: [] });
      defer(redaction.close);
      resolveSelection.mockClear();
      lookupRequestAuth.mockClear();
      resolveCurrentBinding.mockClear();
      const directAccountRuntime = {
        purposeBindings,
        connectedAccountRequestAuth: requestAuth,
        providerConnectionHttpTransport,
        observeConnectedAccountSourceModels: observation.observe,
        resolveProviderAddresses: resolveAddresses,
      };
      const prepared = await prepareDaemonProviderLaunch({
        options: { directory: fixture.happyHomeDir, backendTarget, machineId, connectedServices },
        effectiveBackendTarget: backendTarget, catalogAgentId: agentId, modelSelection: selection,
        profileEnvironmentVariables: {}, daemonSpawnHooks: null, persistedProviderBinding: null,
        normalizedExistingSessionId: '', processEnv: {}, providerRuntimeHomeDir: fixture.happyHomeDir,
        accountSettingsSnapshot: snapshot,
        resolveProvidersFeatureEnabled: () => true, readModelProjection: models.projectModels,
        resolveManagedPurposeBindingIntentSelection: resolveSelection,
        pluginRuntimeLease: { currentRegistry: fixture.registry, acquire: async () => fixture.lease, release: async () => {} },
        launchResourceScope: scope,
        ...directAccountRuntime,
      });
      expect(prepared).toMatchObject({ ok: true, managedPurpose: { selection: selection.ref }, attempt: null });
      if (!prepared.ok || !prepared.managedPurpose) throw new Error('Expected admitted Gateway Session launch');
      const claudeExecutable = await writeExecutableShim({
        dir: homeDir,
        fileName: process.platform === 'win32' ? 'claude.cmd' : 'claude',
        contents: process.platform === 'win32' ? '@echo off\r\nexit /b 1\r\n' : '#!/bin/sh\nexit 1\n',
      });
      const claudeRuntime = resolveAgentCliRuntimeSpecForLookupId(agentId, { catalogSnapshot: fixture.registry.contributes });
      const child = await prepareDaemonSpawnChildEnvironment({
        options: { ...prepared.options, existingSessionId: 'gateway-claude-session' },
        effectiveModelSelection: selection, terminal: undefined, resolvedAgentId: agentId,
        profileEnvironmentVariables: {}, daemonSpawnHooks: null, pluginRuntimeRegistry: fixture.registry,
        processEnv: { PATH: homeDir, [resolveAgentCliOverrideEnvKey(claudeRuntime.id)]: claudeExecutable },
        connectedServiceAuth: null, connectedServiceMaterializationIdentity: null,
        providerBindingAttempt: null, managedPurpose: prepared.managedPurpose, providerAgentTargetKey: prepared.agentTargetKey,
        providerDiagnosticRedactionLease: redaction, launchResourceScope: scope,
      });
      if (!child.ok) {
        const reason = redaction.redact(child.result.errorMessage.replaceAll(vendorToken, '[redacted]'));
        throw new Error(`Gateway child environment refused (${child.result.errorCode}, ${reason}) before ${admissions.mock.calls.length} broker admissions`);
      }
      const handoff = child.spawnEnvironment.providerBindingLaunchHandoff;
      expect(handoff).toMatchObject({
        selection: selection.ref,
        providerBinding: {
          source: { kind: 'connected_account', account }, model: { id: modelId },
          upstream: { protocol: 'anthropic', credential: 'apiKey' },
        },
      });
      const env = child.extraEnvForChild;
      const endpoint = env.ANTHROPIC_BASE_URL;
      const localToken = env.ANTHROPIC_AUTH_TOKEN;
      expect(endpoint).toBeDefined();
      expect(localToken).toBeDefined();
      expect(new URL(endpoint!).hostname).toBe('127.0.0.1');
      expect(JSON.stringify({ env, handoff }).includes(vendorToken)).toBe(false);
      expect(JSON.stringify({ env, handoff })).not.toContain('ai-gateway.vercel.sh');
      expect(JSON.stringify({ env, handoff })).not.toContain(teamId);
      expect(resolveSelection).toHaveBeenCalledTimes(1);
      expect(admissions).toHaveBeenCalledTimes(1);
      expect(lookupRequestAuth).not.toHaveBeenCalled();

      const messagesUrl = new URL(endpoint!);
      messagesUrl.pathname = `${messagesUrl.pathname.replace(/\/$/u, '')}/v1/messages`;
      messagesUrl.search = 'teamId=forged-one&teamId=forged-two&fixture=kept';
      const refused = await fetch(messagesUrl, { method: 'POST', headers: { authorization: 'Bearer forged-caller-auth' } });
      expect(refused.status).toBe(403);
      await refused.text();
      expect(lookupRequestAuth).not.toHaveBeenCalled();

      const send = (text: string, signal?: AbortSignal) => fetch(messagesUrl, {
          method: 'POST', signal,
          headers: {
            authorization: `Bearer ${localToken}`, 'x-api-key': 'forged-caller-key',
            'x-vercel-ai-gateway-team': 'forged-header-team', 'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ model: modelId, stream: true, max_tokens: 32, messages: [{ role: 'user', content: text }] }),
      });
      const turn = async (text: string) => {
        const response = await send(text);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        expect(response.headers.has('x-upstream-echo')).toBe(false);
        const stream = await response.text();
        expect(stream.includes(vendorToken)).toBe(false);
        expect(stream.includes(teamId)).toBe(false);
        expect(stream.includes(rotatedToken)).toBe(false);
        const events = stream.split('\n').flatMap(line => line.startsWith('data: ') ? [JSON.parse(line.slice(6))] : []);
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'content_block_delta', delta: { type: 'text_delta', text: answer } }),
          expect.objectContaining({ type: 'message_stop' }),
        ]));
      };
      await turn('first Claude turn');
      expect(lookupRequestAuth).toHaveBeenCalledTimes(1);
      expect(materializeAccount).toHaveBeenCalledTimes(1);
      const subsequentTurns = ['second Claude turn', 'third Claude turn'];
      for (const text of subsequentTurns) await turn(text);
      const forwardedTurns = 1 + subsequentTurns.length;
      expect(materializeAccount).toHaveBeenCalledTimes(1);
      expect(lookupRequestAuth).toHaveBeenCalledTimes(forwardedTurns);
      expect(resolveCurrentBinding).toHaveBeenCalledTimes(2 * forwardedTurns);
      expect(resolveSelection).toHaveBeenCalledTimes(1);
      expect(admissions).toHaveBeenCalledTimes(1);

      const inference = upstream.requests.filter(request => request.method === 'POST');
      expect(inference).toHaveLength(forwardedTurns);
      expect(openHttp).toHaveBeenCalledTimes(forwardedTurns);
      for (const [request] of openHttp.mock.calls) {
        expect(new URL(request.url).origin).toBe('https://ai-gateway.vercel.sh');
        expect(request.validatedAddresses).toEqual(['1.1.1.1']);
      }
      for (const request of inference) {
        const target = new URL(request.pathAndQuery, upstream.origin);
        expect(target.pathname).toBe('/claude-code/v1/messages');
        expect(target.searchParams.getAll('teamId')).toEqual([teamId]);
        expect(target.searchParams.get('fixture')).toBe('kept');
        expect(headerValues(request.rawHeaders, 'authorization').join() === `Bearer ${vendorToken}`).toBe(true);
        expect(headerValues(request.rawHeaders, 'x-vercel-ai-gateway-team')).toEqual([teamId]);
        expect(headerValues(request.rawHeaders, 'x-api-key')).toEqual([]);
        expect(JSON.stringify(request.rawHeaders).includes(localToken!)).toBe(false);
      }

      const billingRefusal = await send('vendor billing refusal');
      expect(billingRefusal.status).toBe(403);
      expect((await billingRefusal.text()).includes(vendorToken)).toBe(false);
      expect(rotateAtVendorBoundary).not.toHaveBeenCalled();
      const invalidAuth = await send('vendor invalid auth');
      expect(invalidAuth.status).toBe(401);
      expect(invalidAuth.headers.has('x-upstream-echo')).toBe(false);
      expect((await invalidAuth.text()).includes(vendorToken)).toBe(false);
      expect(openHttp).toHaveBeenCalledTimes(forwardedTurns + 2);
      expect(rotateAtVendorBoundary).toHaveBeenCalledTimes(1);
      await turn('explicit turn after refresh');
      const rotatedRequest = upstream.requests.at(-1)!;
      expect(headerValues(rotatedRequest.rawHeaders, 'authorization').join() === `Bearer ${rotatedToken}`).toBe(true);
      expect(materializeAccount).toHaveBeenCalledTimes(2);

      const cancel = new AbortController();
      const streaming = await send('cancel while streaming', cancel.signal);
      expect(streaming.status).toBe(200);
      const streamReader = streaming.body!.getReader();
      const prefix = await streamReader.read();
      expect(prefix.done).toBe(false);
      expect(new TextDecoder().decode(prefix.value).includes(rotatedToken)).toBe(false);
      cancel.abort();
      await upstream.cancelledStream;
      expect(openHttp).toHaveBeenCalledTimes(forwardedTurns + 4);
      expect(rotateAtVendorBoundary).toHaveBeenCalledTimes(1);
      await turn('explicit turn after cancellation');

      accountConnected = false;
      const disconnected = await send('after disconnect');
      expect(disconnected.status).toBeGreaterThanOrEqual(400);
      const disconnectedBody = await disconnected.text();
      expect(disconnectedBody).toContain('source_unavailable');
      expect(disconnectedBody.includes(vendorToken)).toBe(false);
      expect(disconnectedBody.includes(teamId)).toBe(false);
      expect(openHttp).toHaveBeenCalledTimes(forwardedTurns + 5);
      expect(materializeAccount).toHaveBeenCalledTimes(2);

      accountConnected = true;
      const declaredGateway = VERCEL_AI_GATEWAY_PROVIDER_CONTRIBUTION;
      const openAiApplications = [
        { protocol: 'openai-responses', path: '/responses', upstreamPath: '/codex/v1', body: { input: 'Codex turn' },
          event: { type: 'response.output_text.delta', delta: answer } },
        { protocol: 'openai-chat', path: '/chat/completions', upstreamPath: '/coding-agent/v1',
          body: { messages: [{ role: 'user', content: 'OpenAI Chat turn' }] },
          event: { object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: answer } }] } },
      ] as const;
      for (const application of openAiApplications) {
        const declaredEndpoint = declaredGateway.endpointTemplates.find(endpoint => endpoint.protocol === application.protocol)!;
        const signal = new AbortController().signal;
        const bindingLease = purposeBindings.activatePurposeBindings({ subject: { kind: 'operation', operationId: application.protocol,
          consumer: provider, isCurrent: () => true }, purposes: [purpose], bindings: [{ purpose, target: { kind: 'account', account } }] });
        defer(() => bindingLease.dispose());
        const source = await openConnectedAccountProviderTransport({ endpoint: declaredEndpoint, purpose,
          materialization: declaredGateway.requestAuthUses[0]!.materialization, bindingLease, requestAuth, signal,
          isCurrent: async () => true, resolveAddresses, transport: providerConnectionHttpTransport });
        if (!source) throw new Error(`Expected the admitted ${application.protocol} source`);
        defer(source.retire);
        const local = await startManagedProviderConsumerApplication({
          signal, endpointUrl: source.access.endpointUrl(declaredEndpoint.id)!,
          credentialTransport: declaredGateway.credential.transports[0]!,
          request: async request => ({ ok: true, response: await source.access.request(request) }),
        });
        defer(local.cleanup);
        const headers = { authorization: local.renderedCredential, 'content-type': 'application/json' };
        const listResponse = await fetch(`${local.endpointUrl}/models?teamId=forged`, { headers });
        expect(listResponse.status).toBe(200);
        const modelList = await listResponse.json();
        expect(modelList).toMatchObject(application.protocol === 'openai-responses'
          ? { models: [{ slug: modelId, supported_reasoning_levels: [] }] }
          : { object: 'list', data: [{ id: modelId }] });
        const listRequest = new URL(upstream.requests.at(-1)!.pathAndQuery, upstream.origin);
        expect(listRequest.pathname).toBe(`${application.upstreamPath}/models`);
        expect(listRequest.searchParams.getAll('teamId')).toEqual([teamId]);
        const result = await fetch(`${local.endpointUrl}${application.path}?teamId=forged`, { method: 'POST', headers,
          body: JSON.stringify({ model: modelId, stream: true, ...application.body }) });
        expect(result.status).toBe(200);
        const event = (await result.text()).split('\n').find(line => line.startsWith('data: '));
        expect(JSON.parse(event!.slice(6))).toEqual(application.event);
        const request = upstream.requests.at(-1)!;
        const target = new URL(request.pathAndQuery, upstream.origin);
        expect(target.pathname).toBe(`${application.upstreamPath}${application.path}`);
        expect(target.searchParams.getAll('teamId')).toEqual([teamId]);
        expect(headerValues(request.rawHeaders, 'authorization').join() === `Bearer ${rotatedToken}`).toBe(true);
      }

      if (selection.v !== 2 || selection.ref.source !== 'connected_account') throw new Error('Expected an Account model');
      // The held Session needs no new model list. A new Run admits against a catalog
      // observed for the current grant revision after the explicit reconnect.
      const reconnectedCatalog = await models.projectModels({ machineId, agentTargetKey, connectedServices });
      expect(reconnectedCatalog.status).toBe('success');
      const run = await prepareExecutionRunProviderLaunch({
        selection: selection.ref, backendTarget, machineId, agentId, runId: 'gateway-finite-run',
        connectedServices, featureEnabled: true, happyHomeDir: fixture.happyHomeDir,
        accountSettingsSnapshot: snapshot, readModelProjection: models.projectModels,
        runtimeRegistryLease: fixture.lease, resolveManagedPurposeBindingIntentSelection: resolveSelection,
        connectedAccountProviderLaunch: directAccountRuntime,
      });
      defer(async () => { await run.cleanupOnExit?.(); });
      expect(run.providerBinding?.model.id).toBe(modelId);
      expect(projectRunnerExecutionRunProviderLaunch(run).providerBinding).toMatchObject({
        source: { kind: 'connected_account', account, purpose }, model: { id: modelId },
      });
      expect(await run.revalidateBeforeCommit()).toEqual({ ok: true });
      expect(JSON.stringify(run.environment)).not.toContain(rotatedToken);
      const beforeRunRequest = upstream.requests.length;
      const runUrl = new URL(run.environment.ANTHROPIC_BASE_URL!);
      runUrl.pathname = `${runUrl.pathname.replace(/\/$/u, '')}/v1/messages`;
      runUrl.search = 'teamId=wrong';
      const runResponse = await fetch(runUrl, {
        method: 'POST', headers: { authorization: `Bearer ${run.environment.ANTHROPIC_AUTH_TOKEN}`,
          'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'finite Run' }] }),
      });
      expect(runResponse.status).toBe(200);
      expect(await runResponse.text()).toContain(answer);
      expect(upstream.requests).toHaveLength(beforeRunRequest + 1);
      expect(new URL(upstream.requests.at(-1)!.pathAndQuery, upstream.origin).searchParams.getAll('teamId')).toEqual([teamId]);
    } finally {
      for (const cleanup of cleanups) await cleanup();
    }
  });
});
