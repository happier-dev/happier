import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { parsePluginManifest } from '@happier-dev/plugin-sdk/manifest';
import type { AgentSessionRuntime } from '@happier-dev/plugin-sdk/agents/runtime';

import { createPublicAcpSession, createPublicAcpExecutionRun, type PublicAcpComposerDependencies } from '@/agent/acp/runtime/publicSession/createPublicAcpSession';
import { createAcpSessionRuntimeContextFixture } from '@/agent/acp/testkit/runtimeContextFixture';
import { writeAcpTestAgentScript } from '@/agent/acp/testkit/subprocessHarness';
import { createNativeAgentSessionPublications } from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionPublications';
import { createForegroundPurposeOwnerFixture } from '@/daemon/agentRuntime/prepareForegroundAdmission.connectedServices.testkit';
import { createStablePluginConnectedAccountsHost } from '@/plugins/runtime/invocation/services/connectedAccounts';
import { createUnavailablePluginServices } from '@/plugins/runtime/invocation/services/unavailable';
import { withTempDir } from '@/testkit/fs/tempDir';
import { openAiCodexConnectedAccountRuntime } from '../../../../../../packages/plugins/codex/src/connectedAccounts/openAiCodexRuntime';

import { createConnectedAccountPurposeBindingOwner } from '@/daemon/connectedServices/purposeBindings/ConnectedAccountPurposeBindingOwner';
import type { QualifiedConnectedAccountPurposeBindingsV1 } from '@happier-dev/protocol';
import { createVercelOAuthInventoryTargetResolver } from '@/providers/probe/vercelOAuthInventory.testkit';
import { PLUGIN as vercel } from '../../../../../../packages/plugins/machine-vercel/src/manifest';
import { ACCOUNT_PURPOSE } from '../../../../../../packages/plugins/machine-vercel/src/machine/credentials';
import { callbackUrl, completion, createVercelOAuthFixture, pkce, projectId, projects,
  service as vercelService, teamId } from '../../../../../../packages/plugins/machine-vercel/src/oauth.testkit';

const service = { pluginId: 'happier.agent.codex', localId: 'openai-codex' };
const scenarios = [
  { id: 'copilot', load: async () => (await import('@happier-dev/plugins-copilot/manifest')).COPILOT_PLUGIN },
  { id: 'droid', load: async () => (await import('@happier-dev/plugins-droid/manifest')).DROID_PLUGIN },
  { id: 'codebuddy', load: async () => (await import('@happier-dev/plugins-codebuddy/manifest')).CODEBUDDY_PLUGIN },
] as const;

for (const scenario of scenarios) {
  it(`${scenario.id} carries the real account header decoder through its writer and ACP child on create and restart/resume`, async () => {
    await withTempDir(`happier-account-wire-${scenario.id}-`, async dir => {
      const plugin = await scenario.load();
      const parsed = parsePluginManifest(plugin.manifest);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.diagnostics));
      const agent = parsed.manifest.contributes.agents?.find(row => row.id === scenario.id);
      const declaration = agent?.connectedAccounts?.find(row => typeof row.service !== 'string' && row.service.pluginId === service.pluginId && row.service.localId === service.localId);
      if (!agent || !declaration) throw new Error('The executable Agent must declare its optional ChatGPT Account route');
      const host = await createPluginTestkit({ manifest: parsed.manifest, module: { activate: plugin.activate } });
      const factory = host.registration('agents', scenario.id)?.factory;
      if (!factory) throw new Error('The Account route requires the registered executable factory');
      const account = { service, accountId: 'selected-chatgpt-account' };
      const signal = new AbortController().signal;
      const unavailable = createUnavailablePluginServices();
      let accessToken = 'fixture-access-before-restart';
      const reads: string[] = [];
      // Only persistence and OS execution are replaced. The qualified purpose
      // owner, SDK service admission, real Codex decoder and Agent writer run.
      const fixture = createForegroundPurposeOwnerFixture({
        consumer: { pluginId: parsed.manifest.id, localId: scenario.id }, service,
        accountId: account.accountId, purpose: declaration.purpose,
        materializeAccount: ({ request }) => openAiCodexConnectedAccountRuntime.materialize(request, {
          plugin: { id: service.pluginId, version: '0.0.0' },
          contribution: { id: service.localId, qualifiedId: `${service.pluginId}/${service.localId}` },
          surface: 'agent', invokedAtMs: Date.now(), signal, services: unavailable, account,
          configuration: { target: { kind: 'account', account, modeId: 'oauth' }, revision: 'fixture-config', values: {}, async getSecret() { return null; } },
          credentials: { async get(key) {
            reads.push(key);
            return key === 'accessToken' ? accessToken : key === 'providerAccountId' ? 'fixture-provider-account'
              : key === 'refreshToken' ? 'host-only-refresh-must-never-leave' : null;
          } },
        }),
      });
      const accountHost = createStablePluginConnectedAccountsHost(fixture.owner);
      const connectedAccounts = accountHost.bind({
        plugin: { id: parsed.manifest.id, version: parsed.manifest.version },
        contribution: { id: scenario.id, qualifiedId: `${parsed.manifest.id}/agents/${scenario.id}` },
        occurrenceId: 'wire-fixture', correlationId: 'wire-fixture', surface: 'agent',
        signal, retirementSignal: signal, isOccurrenceCurrent: () => true,
      }, [{ purpose: declaration.purpose, serviceRefs: [service], operations: ['use'], materializationKinds: ['httpHeaders'] }]);
      try {
        for (const kind of ['create', 'resume'] as const) {
          if (kind === 'resume') accessToken = 'fixture-access-after-restart';
          const capture = join(dir, `${kind}.json`);
          const script = writeAcpTestAgentScript({ dir, fileName: `${kind}.mjs`, source: `
            import { createInterface } from 'node:readline';
            import { readFileSync, writeFileSync } from 'node:fs';
            const agent = ${JSON.stringify(scenario.id)};
            const settingsIndex = process.argv.indexOf('--settings');
            const settings = settingsIndex < 0 ? null : JSON.parse(readFileSync(process.argv[settingsIndex + 1], 'utf8'));
            const configured = agent === 'copilot' ? JSON.parse(readFileSync(process.env.COPILOT_PROVIDERS_CONFIG, 'utf8'))
              : agent === 'codebuddy' ? JSON.parse(process.env.ACC_PRODUCT_CONFIG_V3) : settings;
            const ownedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('HAPPIER_DROID_') || key.startsWith('HAPPIER_CODEBUDDY_') || key.startsWith('CODEBUDDY_') || key.startsWith('COPILOT_PROVIDER_')));
            const model = agent === 'copilot' ? process.env.COPILOT_MODEL : agent === 'droid' ? 'custom:fixture-native-model' : 'gpt-5.3-codex';
            const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model,
              options: [{ value: model, name: settings?.customModels?.[0]?.displayName ?? 'Selected model' },
                { value: 'native-ineligible-model', name: 'Unrelated native model' }] }];
            const requests = [];
            for await (const line of createInterface({ input: process.stdin })) {
              const request = JSON.parse(line); if (request.id === undefined) continue;
              requests.push(request.method);
              writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ configured, ownedEnv, requests }));
              const result = request.method === 'initialize' ? { protocolVersion: 1, agentCapabilities: { loadSession: true } }
                : request.method === 'session/new' || request.method === 'session/load' ? { sessionId: 'native-session', configOptions }
                : request.method === 'session/set_config_option' ? { configOptions } : {};
              process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
            }
          ` });
          const publications = createNativeAgentSessionPublications({ agentId: scenario.id, session: null, signal, isCurrent: () => true, supportsInFlightSteer: false });
          const dependencies: PublicAcpComposerDependencies = {
            pluginId: parsed.manifest.id, agentId: scenario.id, signal, isCurrent: () => true,
            systemTools: { resolve: async () => ({ toolId: `${scenario.id}-cli`, launch: { kind: 'binary', executablePath: process.execPath, args: [script] } }) },
            interactions: { async request() { throw new Error('Unexpected interaction'); } },
            media: { async registerSourceRoot() { throw new Error('Unexpected media'); } },
            models: publications.services.models, modes: publications.services.modes,
          };
          const context = createAcpSessionRuntimeContextFixture({
            agent, pluginId: parsed.manifest.id, publications, sessionId: 'session', directory: dir, signal,
            services: { ...unavailable, connectedAccounts, exec: { ...unavailable.exec, run: async () => ({
              termination: { observed: { kind: 'exit', exitCode: 0 }, requestedBy: { kind: 'none' } },
              stdout: new TextEncoder().encode('--acp'), stderr: new Uint8Array(), stdoutTruncated: false, stderrTruncated: false,
            }) } },
            protocols: { acp: {
              open: (request, options) => createPublicAcpSession(request, options, dependencies),
              openExecutionRunV1: (request, options) => createPublicAcpExecutionRun(request, options, dependencies),
            } },
          });
          let session: AgentSessionRuntime | undefined;
          try {
            const runtime = await factory({ plugin: { id: parsed.manifest.id, version: parsed.manifest.version }, agent: { id: scenario.id }, signal });
            if (!runtime.sessions) throw new Error('Expected executable Sessions');
            const common = { sessionId: 'session', cwd: dir, launchEnvironment: { values: { HOME: dir }, unset: [] },
              configuration: { model: { value: 'gpt-5.3-codex', updatedAtMs: 1, selectionSource: 'explicit' as const }, mode: { value: null, updatedAtMs: 1 },
                permissionIntent: { value: 'default' as const, updatedAtMs: 1 }, options: {} } };
            session = await runtime.sessions.open(kind === 'create' ? { ...common, kind } : { ...common, kind, providerSessionId: 'native-session' }, context.context);
            expect(publications.modelsSource.read().models.map(model => model.id)).toEqual(['gpt-5.3-codex']);
            const captured: { configured: unknown; ownedEnv: Record<string, string>; requests: string[] } = JSON.parse(readFileSync(capture, 'utf8'));
            const serialized = JSON.stringify({ configured: captured.configured, env: captured.ownedEnv });
            expect(serialized).toContain(accessToken);
            expect(serialized).toContain('fixture-provider-account');
            expect(serialized).toContain('https://chatgpt.com/backend-api/codex');
            expect(serialized).not.toContain('host-only-refresh-must-never-leave');
            if (kind === 'resume') expect(serialized).not.toContain('fixture-access-before-restart');
            expect(captured.requests).toContain(kind === 'create' ? 'session/new' : 'session/load');
          } finally {
            await session?.dispose();
            await context.dispose();
            publications.dispose();
          }
        }
        expect(reads).not.toContain('refreshToken');
      } finally {
        accountHost.retire();
        await host.dispose();
      }
    });
  });
}

it('allocates the first Vercel Sandbox using the published purpose of the account that just signed in', async () => {
  const h = await createVercelOAuthFixture();
  const consumer = { pluginId: vercel.manifest.id, localId: 'acquire' };
  const purpose = { consumer, purpose: ACCOUNT_PURPOSE };
  const account = h.read.account;
  const revision = 'csr_0123456789ABCDEFGHJKMNPQRS';
  const empty = { v: 1, bindings: [] } satisfies QualifiedConnectedAccountPurposeBindingsV1;
  let stored: QualifiedConnectedAccountPurposeBindingsV1 = empty;
  let published: QualifiedConnectedAccountPurposeBindingsV1 = empty;
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected fallback selection'); };
  const owner = createConnectedAccountPurposeBindingOwner({
    store: {
      read: async (_signal, options) => options?.published ? published : stored,
      update: async mutate => (stored = mutate(stored)),
      subscribe: () => ({ dispose() {} }),
    },
    selectTarget: unexpected, projectTargetAccounts: unexpected, assertTargetAccountMaterializable: unexpected,
    resolveTarget: createVercelOAuthInventoryTargetResolver({
      account, displayName: 'Example site', kind: 'oauth', readCredentialRevision: () => revision,
    }),
    resolveCredentialRevision: async () => revision,
    materializeAccount: ({ request, signal, credentialRevisionBasis }) => {
      credentialRevisionBasis?.captureCredentialRevision(revision);
      return h.runtime.materialize(request, { ...h.read, credentials: h.staged.store, signal });
    },
  });
  const host = createStablePluginConnectedAccountsHost(owner);
  const controller = new AbortController();
  const { signal } = controller;
  const connectedAccounts = host.bind({
    plugin: { id: consumer.pluginId, version: vercel.manifest.version },
    contribution: { id: consumer.localId, qualifiedId: `${consumer.pluginId}/actions/${consumer.localId}` },
    occurrenceId: 'sandbox-fixture', correlationId: 'sandbox-fixture', surface: 'plugin',
    signal, retirementSignal: signal, isOccurrenceCurrent: () => true,
  }, [{ purpose: ACCOUNT_PURPOSE, serviceRefs: [vercelService], operations: ['use'],
    materializationKinds: ['httpHeaders', 'environment'] }]);
  const kit = await createPluginTestkit({ manifest: vercel.manifest, module: vercel,
    services: { connectedAccounts, http: createPluginHttpFixture({ request: h.request }) } });
  try {
    h.routes.set('/v10/projects', projects);
    h.routes.set(`/v2/teams/${teamId}`, { status: 200, body: { id: teamId, name: 'Example team', billing: { plan: 'pro' } } });
    h.routes.set(`/v9/projects/${projectId}`, { status: 200, body: { id: projectId, name: 'Example site', accountId: teamId } });
    await h.mode.begin({ callbackUrl, state: completion.state, pkce }, h.authentication);
    expect(await h.mode.complete(completion, h.authentication)).toMatchObject({ status: 'configurationRequired' });
    h.values.projectId = projectId;
    expect(await h.mode.reconcile!(h.authentication)).toMatchObject({ status: 'connected' });
    const selection = await owner.resolveBindingIntent({
      purpose, target: { kind: 'account', account }, serviceRefs: [vercelService], signal,
    });
    stored = { v: 1, bindings: [selection] };

    const managedId = 'machine-one';
    const name = `happier-${managedId}`;
    h.routes.set('/v4/sandboxes', { status: 200, body: {
      sandbox: { name, tags: { 'happier-managed-id': managedId }, createdAt: 1000, currentSessionId: 'sbx_one',
        status: 'running', persistent: true },
      session: { id: 'sbx_one', sourceSandboxName: name, projectId, createdAt: 1000 }, routes: [],
    } });
    const acquire = () => kit.invokeAction('acquire', { managedId,
      launch: { image: 'vercel/sandbox/universal:latest', region: 'iad1', vcpus: 1, timeoutMs: 300000, snapshotExpirationMs: 0 },
    }, { surface: 'plugin' });
    const allocations = () => h.requests.filter(request => new URL(request.url).pathname === '/v4/sandboxes');

    const notSelected = 'plugin_host_access_resource_not_selected';
    await expect(connectedAccounts.materialize(ACCOUNT_PURPOSE, { kind: 'environment', keys: ['VERCEL_TEAM_ID', 'VERCEL_PROJECT_ID'] }))
      .rejects.toMatchObject({ code: notSelected });
    // The signed-in Account still cannot allocate while its purpose is unpublished.
    // The separate refusal-mapper change turns a rejected result into a typed throw.
    const refused = await acquire().then(
      result => result !== null && typeof result === 'object' && 'kind' in result && result.kind === 'rejected',
      (error: unknown) => error instanceof Error && 'code' in error && error.code === notSelected,
    );
    expect(refused).toBe(true);
    expect(allocations().length).toBe(0);

    published = stored;
    const acquired = await acquire();
    expect(acquired, acquired && typeof acquired === 'object' && 'code' in acquired ? String(acquired.code) : undefined)
      .toMatchObject({ kind: 'bound' });
    const [allocated] = allocations();
    expect(allocated).toBeDefined();
    expect(new URL(allocated!.url).searchParams.get('teamId')).toBe(teamId);
    expect(JSON.parse(new TextDecoder().decode(allocated!.body as Uint8Array))).toMatchObject({ projectId });
    expect(allocated!.headers?.authorization === `Bearer ${await h.staged.store.get('token')}`).toBe(true);
  } finally {
    controller.abort();
    host.retire();
    await Promise.all([kit.dispose(), h.kit.dispose()]);
  }
});
