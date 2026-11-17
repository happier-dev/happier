import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { registerLanguageIntelligenceHandlers } from './languageIntelligence';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { accountSettingsParse, DEFAULT_PROVIDER_SETTINGS_V1, ProviderContributionV1Schema, ProviderSettingsV1Schema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { DaemonLspQueryResponseSchema } from '@happier-dev/protocol/machines/languageIntelligence';
import { applyWorkspaceFileTextEdits } from '@happier-dev/protocol/machines/workspaceFilesReplace';
import { resolveProviderConnectionForMachine } from '@/providers/registry/resolve';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { loadInstalledPlugins } from '@/plugins/discovery/load/installed';
import { projectLoadedPluginContributes } from '@/plugins/projection/registry/fullProjection';
import { createMergedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import { resolveProviderContributionRegistryView } from '@/providers/registry/contributions';
import { writeCommittedLocalPathPluginFixture } from '@/plugins/store/state.testkit';
import { createLocalPathPluginDistributionIdentity, createPluginTrustRecord } from '@/plugins/store/install/trustIdentity';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { resolveExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { readCurrentCommittedPluginGenerations } from '@/plugins/store/registry/generationStore';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { createPublicManagedProviderRuntimeStartOperation } from '@/providers/connections/publicManagedRuntimeStart';
import { commitActiveProviderConnectionsCatalog, getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { DEEPSEEK_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/deepseek/src/provider/contribution';
import { OLLAMA_PROVIDER_CONTRIBUTION } from '../../../../../packages/plugins/ollama/src/provider/contribution';
import type { ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { createAccountProviderActionExecuteV1 } from '@happier-dev/protocol/providers/connections/accountProviderActionV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createProviderActionExecuteV1 } from '@happier-dev/protocol/providers/executeProviderActionV1';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

describe('Machine inline suggestion policy', () => {
  const roots: string[] = [];
  afterEach(async () => { resetActiveAccountSettingsSnapshotForTests(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
  it('refuses an opted-out direct Machine query before Provider acquisition, without needing an LSP', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-inline-rpc-'));
    roots.push(rootPath);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
      loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine' });
    expect(await handlers.get(RPC_METHODS.DAEMON_LSP_QUERY)!({ rootPath, path: 'a.ts', kind: 'ai.inlineSuggest',
      version: 2, position: { line: 0, character: 1 }, languageId: 'typescript',
      inlineSuggestion: { connectionId: 'pc_local', modelId: 'base', prefix: 'a', suffix: '' } }))
      .toEqual({ status: 'error', errorCode: 'ai_disabled' });
  });

  it('refuses next-edit direct queries before Provider acquisition when the deliberate preference is off', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-next-edit-rpc-'));
    roots.push(rootPath);
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({ filesEditorAiSuggestionsV1: {
      enabled: true, connectionId: 'pc_local', modelId: 'edit-model', nextEditEnabled: false,
    } }), settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [] });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine' });
    expect(await handlers.get(RPC_METHODS.DAEMON_LSP_QUERY)!({ rootPath, path: 'a.ts', kind: 'ai.nextEdit',
      version: 2, position: { line: 0, character: 3 }, languageId: 'typescript',
      nextEdit: { connectionId: 'pc_local', modelId: 'edit-model', document: 'new();', target: {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, text: 'new();' }, recentEdits: [
        { baseVersion: 1, version: 2, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, oldText: 'old', newText: 'new' },
      ] } })).toEqual({ status: 'error', errorCode: 'ai_disabled' });
  });

  async function fixture(mode: 'native-fim' | 'raw-fim-template' | 'chat-fallback' | 'next-edit-codec' = 'native-fim', options: Readonly<{
    managed?: boolean; credentialRequired?: boolean; model?: ProviderModelDescriptorV1; inlineModel?: ProviderModelDescriptorV1; wireFormat?: 'openai-text-completions';
  }> = {}) {
    const managed = options.managed === true;
    const rootPath = await mkdtemp(join(tmpdir(), 'happier-inline-http-'));
    roots.push(rootPath);
    const requests: Array<Record<string, unknown>> = [];
    const requestPaths: string[] = [];
    let providersEnabled = true;
    let managedStarts = 0;
    let respond = (response: ServerResponse) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(options.wireFormat === 'openai-text-completions'
        ? { choices: [{ text: '🦊\r\nnext', finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }
        : mode === 'chat-fallback'
        ? { choices: [{ message: { content: '🦊\r\nnext' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 3 } }
        : { response: mode === 'next-edit-codec' ? 'function renamed() {}\r\nrenamed();\r\n' : '🦊\r\nnext', done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 3 }));
    };
    const server = createServer(async (request, response) => {
      if (request.url === '/v1/features') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(FeaturesResponseSchema.parse({ features: { providers: { enabled: providersEnabled } }, capabilities: {} })));
        return;
      }
      if (request.url === '/managed-started') { managedStarts += 1; response.end('ok'); return; }
      if (request.url === '/health') { response.end('ok'); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requestPaths.push(request.url!);
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
      respond(response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    onTestFinished(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing controlled endpoint');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const definition = ProviderContributionV1Schema.parse({ v: 1, id: 'fixture', name: 'Controlled FIM', kind: 'local',
      endpointTemplates: [{ id: 'generate', protocol: options.wireFormat ? 'openai-completions' : mode === 'chat-fallback' ? 'openai-chat' : 'ollama-native', baseUrl,
        capabilities: { streaming: 'supported', toolRoundTrips: 'unsupported', statefulResponses: 'unsupported', reasoningControls: 'unsupported' } }],
      inlineCompletion: [{ id: options.model?.nextEdit?.operationId ?? options.model?.inlineCompletion?.operationId ?? 'inline', mode,
        ...(mode === 'next-edit-codec' ? { codec: 'rewrite-window-v1' } : {}), endpointTemplateId: 'generate', path: '/generate', wireFormat: options.wireFormat ?? (mode === 'chat-fallback' ? 'openai-chat' : 'ollama-generate') },
        ...(options.inlineModel ? [{ id: options.inlineModel.inlineCompletion!.operationId, mode: 'native-fim', endpointTemplateId: 'generate', path: '/generate', wireFormat: 'ollama-generate' }] : [])],
      ...(options.credentialRequired ? { credential: { kind: 'apiKey', slotId: 'apiKey', required: true, transports: [{
        id: 'runtime-key', protocols: [mode === 'chat-fallback' ? 'openai-chat' : 'ollama-native'], uses: ['runtime'],
        destination: { kind: 'httpHeader', name: 'authorization', format: 'bearer' },
      }] } } : {}),
      ...(managed ? { managedRuntime: { kind: 'managed', endpointTemplateIds: ['generate'] } } : {}),
      catalog: { source: 'static', manualModelPolicy: 'catalog-only', staticModels: [...(options.inlineModel ? [options.inlineModel] : []), options.model ?? { id: 'base', name: 'Controlled base', contextWindowTokens: 4096,
        inlineCompletion: { operationId: 'inline', tokenAccounting: 'utf8-bytes', outputTokens: 64, promptOverheadTokens: 256,
          ...(mode === 'raw-fim-template' ? { rawFimTemplate: { prefix: '<prefix>', suffix: '<suffix>', middle: '<middle>' } } : {}) } }] } });
    const pluginId = 'fixture.fim';
    const pluginRoot = join(rootPath, 'provider-plugin');
    const happyHomeDir = join(rootPath, 'plugin-home');
    await mkdir(join(pluginRoot, '.happier-plugin'), { recursive: true });
    const manifestPath = join(pluginRoot, '.happier-plugin/plugin.json');
    const writeManifest = async (provider = definition) => await writeFile(manifestPath, JSON.stringify({ schemaVersion: 2,
      id: pluginId, version: '1.0.0', displayName: 'Controlled FIM source', engines: { happier: '^0.2.0' }, runtime: { apiVersion: 1 },
      entrypoints: { daemon: './daemon.mjs' }, contributes: { providers: [provider] } }));
    await writeManifest();
    await writeFile(join(pluginRoot, 'daemon.mjs'), managed ? `export function activate(api) {
      api.providers.register('fixture', { async start(request, context) {
        await fetch(${JSON.stringify(baseUrl + '/managed-started')});
        const service = await context.managedServices.supervise({ id:'controlled-fim', mode:{kind:'attach',baseUrl:${JSON.stringify(baseUrl)}},
          healthCheck:{kind:'http',target:{kind:'servicePath',path:'/health'}} });
        await service.waitUntilHealthy();
        return {service,endpoints:[{endpointTemplateId:'generate',endpoint:{kind:'servicePath',path:'/'}}]};
      }});
    }` : 'export function activate() {}');
    const admitInstalledSource = async () => {
      const distribution = await createLocalPathPluginDistributionIdentity(pluginRoot);
      await writeCommittedLocalPathPluginFixture({ happyHomeDir, pluginId, sourceRootPath: pluginRoot,
      plugin: { source: { kind: 'path', locator: pluginRoot, trustPolicy: 'local_trusted', installPolicy: 'link', resolvedPath: pluginRoot, manifestPath },
        compatibility: { status: 'unknown', diagnostics: [] },
        install: { mode: 'link', manifestVersion: '1.0.0', installedPath: null, trust: createPluginTrustRecord({ pluginId, distribution, approvedAtMs: Date.now() }) },
        state: { enabled: true } } });
    };
    await admitInstalledSource();
    // The real filesystem plugin loader and registry projection admit this
    // external declaration. Only the daemon's plugin-source location differs.
    const resolveRegistry = async () => resolveProviderContributionRegistryView(createMergedContributionRegistry(projectLoadedPluginContributes({
      loadResult: await loadInstalledPlugins({ happyHomeDir }), provenance: 'external', existingAgentIds: new Set(),
    }), {}), 1);
    const registry = await resolveRegistry();
    const controller = createPluginReloadController();
    onTestFinished(async () => { await controller.shutdown(); });
    if (managed) {
      const initialRuntime = await controller.acquireRuntimeRegistry({ resolveRuntimeRegistry: async () => {
        const contributes = createMergedContributionRegistry(projectLoadedPluginContributes({ loadResult: await loadInstalledPlugins({ happyHomeDir }),
          provenance: 'external', existingAgentIds: new Set() }), {});
        const generationAuthority = await readCurrentCommittedPluginGenerations(resolvePluginStorePaths({ happyHomeDir }), {});
        if (!generationAuthority) throw new Error('Missing controlled plugin authority');
        return await resolveExecutablePluginRuntimeRegistry({ happyHomeDir, contributes, generationAuthority, resolveCurrentMachineId: () => 'machine' });
      } });
      await initialRuntime.release();
    }
    const initial = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{ v: 1, id: 'pc_local',
      source: { kind: 'contribution', contributionKey: 'fixture.fim/fixture' }, role: 'default', displayName: 'Controlled', displayNameMode: 'automatic',
      ...(managed ? { deployment: { kind: 'managedLocal' } } : {}),
      revision: 1, createdAt: 1, updatedAt: 1 }] });
    const resolved = resolveProviderConnectionForMachine({ connectionId: 'pc_local', machineId: 'machine', providerSettings: initial,
      registry, dnsEvidenceByEndpointUrl: new Map([[baseUrl, ['127.0.0.1']]]) });
    if (resolved.status !== 'resolved') throw new Error(`Fixture resolution ${resolved.status}`);
    const providerSettings = ProviderSettingsV1Schema.parse({ ...initial, machineGrants: [{ v: 1, machineId: 'machine', connectionId: 'pc_local',
      connectionSecurityFingerprint: resolved.record.connectionSecurityFingerprint, endpointSetFingerprint: resolved.record.endpointSetFingerprint, confirmedAt: 1 }] });
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = providerSettings;
    let snapshot: ActiveAccountSettingsSnapshot = { source: 'network', scopeKey: `fixture:${rootPath}`, settingsVersion: 1, loadedAtMs: Date.now(), settingsSecretsReadKeys: [],
      settings: accountSettingsParse({ filesEditorAiSuggestionsV1: { enabled: true, nextEditEnabled: mode === 'next-edit-codec', connectionId: 'pc_local', modelId: options.inlineModel?.id ?? options.model?.id ?? 'base',
        ...(options.inlineModel ? { nextEditModelId: options.model!.id } : {}) } }),
      providerConnectionsCatalog: { status: 'ready', revision: 1, catalog } };
    setActiveAccountSettingsSnapshot(snapshot);
    const account = createAccountProviderActionExecuteV1({ assertCurrent() {}, now: () => 2,
      readDefinitions: async () => [{ contributionKey: 'fixture.fim/fixture', definition, provenance: 'external' }],
      readCatalog: async () => {
        if (snapshot.providerConnectionsCatalog?.status !== 'ready') throw new Error('Missing fixture Account catalog');
        return snapshot.providerConnectionsCatalog;
      },
      writeCatalog: async input => {
        const captured = snapshot.providerConnectionsCatalog;
        if (captured?.status !== 'ready') throw new Error('Missing fixture Account catalog');
        expect(input.expectedRevision).toBe(captured.revision);
        if (!snapshot.scopeKey) throw new Error('Missing fixture Account scope');
        expect(commitActiveProviderConnectionsCatalog({ scopeKey: snapshot.scopeKey,
          lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(),
          catalog: { status: 'ready', revision: input.expectedRevision + 1, catalog: input.catalog },
        })).toBe(true);
        const current = getActiveAccountSettingsSnapshot();
        if (!current) throw new Error('Missing committed fixture Account');
        snapshot = current;
        return { status: 'updated' };
      },
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), providerActionExecute: createProviderActionExecuteV1({
      assertCurrent() {}, account, async rpc() { throw new Error('Allowance authoring must stay on the Account'); },
      async setDefault() { throw new Error('No Agent default'); },
    }) });
    const handlers = new Map<string, RpcHandler>();
    const registrar: RpcHandlerRegistrar = { registerHandler: (method, handler) => { handlers.set(method, handler); } };
    registerLanguageIntelligenceHandlers(registrar, rootPath, { machineId: 'machine', inlineSuggestionDependencies: {
      resolveRegistry, resolveAddresses: async () => ['127.0.0.1'], serverUrl: baseUrl,
      ...(managed ? { acquireRegistryLease: async () => {
        const lease = controller.tryAcquireRuntimeRegistry();
        if (!lease) throw new Error('Missing controlled serving plugin registry');
        return lease;
      } } : {}),
    } });
    return { requests, requestPaths, rootPath,
      callNext: (path = 'a.ts', signal?: AbortSignal) => handlers.get(RPC_METHODS.DAEMON_LSP_QUERY)!({ rootPath, path,
        kind: 'ai.nextEdit', version: 2, position: { line: 0, character: 16 }, languageId: 'typescript',
        nextEdit: { connectionId: 'pc_local', modelId: options.model?.id ?? 'base', document: 'function renamed() {}\r\nold();\r\n',
          target: { range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } }, text: 'function renamed() {}\r\nold();\r\n' },
          recentEdits: [{ baseVersion: 1, version: 2, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, oldText: 'old', newText: 'renamed' }] },
      }, signal ? { signal } : undefined),
      call: (path = 'a.ts', signal?: AbortSignal) => handlers.get(RPC_METHODS.DAEMON_LSP_QUERY)!({ rootPath, path,
      kind: 'ai.inlineSuggest', version: 2, position: { line: 0, character: 5 }, languageId: 'typescript',
      inlineSuggestion: { connectionId: 'pc_local', modelId: options.inlineModel?.id ?? options.model?.id ?? 'base', prefix: 'const', suffix: '\r\nnext()' } }, signal ? { signal } : undefined),
      configureAllowance: (maxTokens: number) => executor.execute('providers.connections.update', {
        action: 'update', connectionId: 'pc_local',
        expectedRevision: snapshot.providerConnectionsCatalog?.status === 'ready'
          ? snapshot.providerConnectionsCatalog.catalog.connections[0]!.revision : -1,
        modelSettings: { [options.model?.id ?? 'base']: { maxTokens }, ...(options.inlineModel ? { [options.inlineModel.id]: { maxTokens } } : {}) },
      }, { surface: 'ui', bypassApprovals: true }),
      setPolicy: (policy: Record<string, unknown>) => { snapshot = { ...snapshot, settingsVersion: snapshot.settingsVersion + 1,
        settings: accountSettingsParse({ filesEditorAiSuggestionsV1: { ...snapshot.settings.filesEditorAiSuggestionsV1, ...policy } }) };
        setActiveAccountSettingsSnapshot(snapshot); },
      setResponder: (next: typeof respond) => { respond = next; },
      setProvidersEnabled: (enabled: boolean) => { providersEnabled = enabled; },
      managedStarts: () => managedStarts,
      startManaged: async () => await createPublicManagedProviderRuntimeStartOperation({ machineId: 'machine', happyHomeDir, controller })({
        connectionId: 'pc_local', contributionKey: 'fixture.fim/fixture', identity: { pluginId, localId: 'fixture' },
        request: { reason: 'explicitStartLocal', endpointTemplateIds: ['generate'] }, purposeBindings: { v: 1, bindings: [] },
        isAuthorizationCurrent: () => snapshot.settings.filesEditorAiSuggestionsV1.enabled,
        revalidateAuthorization: async () => snapshot.settings.filesEditorAiSuggestionsV1.enabled,
      }),
      stopManaged: async () => {
        const lease = controller.tryAcquireRuntimeRegistry();
        try { await lease?.registry.retireManagedProviderExplicitStart?.({ identity: { pluginId, localId: 'fixture' }, machineId: 'machine' }); }
        finally { await lease?.release(); }
      },
      replaceOperationPath: async () => { await writeManifest(ProviderContributionV1Schema.parse({ ...definition,
        inlineCompletion: definition.inlineCompletion!.map(operation => ({ ...operation, path: '/changed' })) })); await admitInstalledSource(); },
      close: async () => { await controller.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    };
  }

  it.each([
    [DEEPSEEK_PROVIDER_CONTRIBUTION.catalog.staticModels[1], 'openai-text-completions'],
    [OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels[0], undefined],
  ] as const)('uses the public persisted allowance for the exact bundled model (%#)', async (model, wireFormat) => {
    const f = await fixture('native-fim', { model, wireFormat });
    try {
      if (wireFormat) {
        // The documented DeepSeek FIM ceiling is usable on fresh configuration.
        expect(await f.call()).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest' });
        expect(f.requests).toEqual([expect.objectContaining({ model: model.id, max_tokens: 4096 })]);
      } else {
        expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
        expect(f.requests).toHaveLength(0);
      }
      const initialRequests = f.requests.length;
      expect(await f.configureAllowance(128)).toMatchObject({ ok: true });
      expect(await f.call()).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest', text: '🦊\r\nnext' });
      expect(f.requests.at(-1)).toEqual(expect.objectContaining({ model: model.id,
        ...(wireFormat ? { max_tokens: 128 } : { options: { num_predict: 128, num_ctx: model.contextWindowTokens } }),
      }));
      expect(await f.configureAllowance(0)).toMatchObject({ ok: true });
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
      expect(f.requests).toHaveLength(initialRequests + 1);
    } finally { await f.close(); }
  });

  it('dispatches configured inline and next-edit models independently through the real registered Machine handler', async () => {
    const model = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!;
    const inlineModel = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'inlineCompletion' in model)!;
    const f = await fixture('next-edit-codec', { model, inlineModel });
    try {
      expect(await f.configureAllowance(512)).toMatchObject({ ok: true });
      f.setResponder(response => response.end(JSON.stringify({ response: 'suffix', done: true, done_reason: 'stop' })));
      expect(await f.call()).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest', text: 'suffix' });
      f.setResponder(response => response.end(JSON.stringify({ response: 'function renamed() {}\r\nrenamed();\r\n', done: true, done_reason: 'stop' })));
      expect(await f.callNext()).toMatchObject({ status: 'ok', kind: 'ai.nextEdit' });
      expect(f.requests.map(request => request.model)).toEqual([inlineModel.id, model.id]);
      f.setPolicy({ nextEditModelId: inlineModel.id });
      expect(await f.callNext()).toEqual({ status: 'error', errorCode: 'stale_query' });
      f.setPolicy({ nextEditModelId: null });
      expect(await f.callNext()).toEqual({ status: 'error', errorCode: 'stale_query' });
      expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('decodes the dedicated rewrite through real Machine admission without writing files, and excludes content before inference', async () => {
    const model = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!;
    const f = await fixture('next-edit-codec', { model });
    const original = 'function renamed() {}\r\nold();\r\n';
    try {
      await writeFile(join(f.rootPath, 'a.ts'), original);
      expect(await f.configureAllowance(512)).toMatchObject({ ok: true });
      const result = DaemonLspQueryResponseSchema.parse(await f.callNext());
      expect(result).toMatchObject({ status: 'ok', kind: 'ai.nextEdit', version: 2, usage: { inputTokens: 9, outputTokens: 3 } });
      if (result.status !== 'ok' || result.kind !== 'ai.nextEdit') throw new Error('Expected a predicted edit');
      expect(applyWorkspaceFileTextEdits(original, result.edits.map(edit => ({ range: edit.range, text: edit.newText }))).text)
        .toBe('function renamed() {}\r\nrenamed();\r\n');
      expect(await readFile(join(f.rootPath, 'a.ts'), 'utf8')).toBe(original);
      expect(f.requests).toEqual([expect.objectContaining({ model: model.id, raw: true, stream: false,
        prompt: expect.stringContaining('<|file_sep|>original/a.ts\nfunction old() {}'),
        options: { num_predict: 512, num_ctx: model.contextWindowTokens, stop: ['<|file_sep|>', '</s>'], temperature: 0 },
      })]);
      expect(await f.callNext('.env.local')).toEqual({ status: 'error', errorCode: 'ai_excluded' });
      f.setPolicy({ nextEditEnabled: false }); expect(await f.callNext()).toEqual({ status: 'error', errorCode: 'ai_disabled' });
      f.setPolicy({ nextEditEnabled: true, disabledLanguageIds: ['typescript'] });
      expect(await f.callNext()).toEqual({ status: 'error', errorCode: 'ai_language_disabled' });
      expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('refuses truncated/malformed dedicated output and drops a complete no-op without falling back to inline completion', async () => {
    const model = OLLAMA_PROVIDER_CONTRIBUTION.catalog.staticModels.find(model => 'nextEdit' in model)!;
    const f = await fixture('next-edit-codec', { model });
    try {
      expect(await f.configureAllowance(512)).toMatchObject({ ok: true });
      for (const output of [{ response: 'function rename', done_reason: 'length' }, { response: '<|file_sep|>other.ts\nunsafe', done_reason: 'stop' }]) {
        f.setResponder(response => response.end(JSON.stringify({ ...output, done: true })));
        expect(await f.callNext()).toEqual({ status: 'error', errorCode: 'request_failed' });
      }
      f.setResponder(response => response.end(JSON.stringify({ response: 'function renamed() {}\r\nold();\r\n', done: true, done_reason: 'stop' })));
      expect(await f.callNext()).toEqual({ status: 'ok', kind: 'ai.nextEdit', version: 2, edits: [] });
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
      expect(f.requests).toHaveLength(3);
    } finally { await f.close(); }
  });

  it('sends one admitted native FIM request, preserves exact insertion bytes, and refuses off/excluded/language policy with zero further requests', async () => {
    const f = await fixture();
    try {
      const result = await f.call();
      expect(DaemonLspQueryResponseSchema.parse(result)).toEqual({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '🦊\r\nnext', usage: { inputTokens: 9, outputTokens: 3 } });
      expect(f.requests).toEqual([{ model: 'base', prompt: 'const', suffix: '\r\nnext()', stream: false, options: { num_predict: 64, num_ctx: 4096 } }]);
      expect(await f.call('.env.local')).toEqual({ status: 'error', errorCode: 'ai_excluded' });
      expect(await f.call('src/secrets/key.txt')).toEqual({ status: 'error', errorCode: 'ai_excluded' });
      f.setPolicy({ disabledLanguageIds: ['typescript'] });
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'ai_language_disabled' });
      f.setPolicy({ enabled: false });
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'ai_disabled' });
      expect(f.requests).toHaveLength(1);
    } finally { await f.close(); }
  });

  it.each(['raw-fim-template', 'chat-fallback'] as const)('executes only the declared %s encoding', async mode => {
    const f = await fixture(mode);
    try {
      expect(await f.call()).toMatchObject({ status: 'ok', text: '🦊\r\nnext' });
      expect(f.requests).toHaveLength(1);
      if (mode === 'raw-fim-template') expect(f.requests[0]).toMatchObject({ prompt: '<prefix>const<suffix>\r\nnext()<middle>', raw: true });
      else expect(f.requests[0]).toMatchObject({ messages: [{ role: 'system', content: expect.any(String) }, { role: 'user', content: 'Prefix:\nconst\nSuffix:\n\r\nnext()' }] });
    } finally { await f.close(); }
  });

  it('withdraws on explicit cancellation and applies Account policy changes at the next admission', async () => {
    const f = await fixture();
    let response: ServerResponse | undefined;
    f.setResponder(next => { response = next; });
    try {
      const controller = new AbortController();
      const pending = f.call('a.ts', controller.signal);
      await vi.waitFor(() => expect(response).toBeDefined());
      controller.abort();
      expect(await pending).toEqual({ status: 'error', errorCode: 'cancelled' });
      response = undefined;
      const late = f.call();
      await vi.waitFor(() => expect(response).toBeDefined());
      f.setPolicy({ enabled: false });
      response!.end(JSON.stringify({ response: 'stale', done: true, done_reason: 'stop' }));
      expect(await late).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest', text: 'stale' });
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'ai_disabled' });
      expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('checks feature availability at admission and keeps the captured route through response completion', async () => {
    const f = await fixture();
    let response: ServerResponse | undefined;
    try {
      f.setProvidersEnabled(false);
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
      expect(f.requests).toHaveLength(0);
      f.setProvidersEnabled(true);
      f.setResponder(next => { response = next; });
      const pending = f.call();
      await vi.waitFor(() => expect(response).toBeDefined());
      await f.replaceOperationPath();
      response!.end(JSON.stringify({ response: 'old route', done: true, done_reason: 'stop' }));
      expect(await pending).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest', text: 'old route' });
      // Destination-only consent survives an operation declaration update.
      f.setResponder(next => next.end(JSON.stringify({ response: 'new route', done: true, done_reason: 'stop' })));
      expect(await f.call()).toMatchObject({ status: 'ok', kind: 'ai.inlineSuggest', text: 'new route' });
      expect(f.requestPaths).toEqual(['/generate', '/changed']);
      expect(f.requests).toHaveLength(2);
    } finally { await f.close(); }
  });

  it('borrows a real explicitly started managed Provider through registry custody without warming or restarting it', async () => {
    const f = await fixture('native-fim', { managed: true });
    try {
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
      expect(f.managedStarts()).toBe(0);
      await f.startManaged();
      expect(f.managedStarts()).toBe(1);
      const answer = await f.call();
      expect(f.requests).toHaveLength(1);
      expect(answer).toEqual({ status: 'ok', kind: 'ai.inlineSuggest', version: 2, text: '🦊\r\nnext', usage: { inputTokens: 9, outputTokens: 3 } });
      expect(f.managedStarts()).toBe(1);
      await f.stopManaged();
      expect(await f.call()).toEqual({ status: 'error', errorCode: 'model_unavailable' });
      expect(f.managedStarts()).toBe(1);
    } finally { await f.close(); }
  });

  it('refuses excluded content before missing credential admission and reports authentication and rate limits safely', async () => {
    const missing = await fixture('native-fim', { credentialRequired: true });
    try {
      expect(await missing.call('.env.production')).toEqual({ status: 'error', errorCode: 'ai_excluded' });
      expect(await missing.call()).toEqual({ status: 'error', errorCode: 'provider_error',
        error: createProviderErrorV1('provider_secret_missing', { connectionId: 'pc_local', machineId: 'machine' }) });
      expect(missing.requests).toHaveLength(0);
    } finally { await missing.close(); }
    const ready = await fixture();
    try {
      ready.setResponder(response => { response.writeHead(429); response.end('untrusted provider diagnostic'); });
      expect(await ready.call()).toEqual({ status: 'error', errorCode: 'rate_limited' });
      ready.setResponder(response => { response.writeHead(401); response.end('untrusted credential diagnostic'); });
      expect(await ready.call()).toEqual({ status: 'error', errorCode: 'signed_out' });
    } finally { await ready.close(); }
  });
});
