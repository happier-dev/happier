import { lookup } from 'node:dns/promises';
import { budgetInlineCompletionContext, fitsNextEditContext, projectProviderModelGenerationSettings, type ProviderModelDescriptorV1 } from '@happier-dev/protocol/models/descriptor';
import { resolveFilesEditorAiSuggestionPolicy, resolveFilesEditorAiSuggestionModelId } from '@happier-dev/protocol/account/settings/accountSettings';
import type { DaemonLspQueryRequest, DaemonLspQueryResponse } from '@happier-dev/protocol/machines/languageIntelligence';
import { encodeNextEditRewriteWindow, decodeNextEditRewriteWindow } from '@happier-dev/protocol/machines/languageIntelligence';
import type { ProviderInlineCompletionOperationV1 } from '@happier-dev/protocol/providers/contributions';
import type { ProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { normalizeProviderCredentialHeaderName, normalizeProviderQueryParameterName } from '@happier-dev/protocol/providers/credential-headers';
import { getActiveAccountSettingsSnapshot, type ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import { openPinnedHttpStream, type PinnedHttpStreamTransport } from '@/network/pinnedHttp';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';
import type { ResolveSharedManagedProviderGatewayBinding } from '@/plugins/runtime/invocation/services/managedServicesAdapter';
import { resolveProviderContributionRegistryView } from './registry/contributions';
import { collectProviderConnectionDnsEvidence } from './registry/dnsEvidence';
import { resolveProviderConnectionForMachineFromSettingsRead } from './registry/resolve';
import type { ProviderContributionRegistryView, ResolvedProviderConnectionRecord } from './registry/types';
import { readProviderSettingsForCli } from './settings/read';
import { prepareProviderConnectionsCatalogForCli } from './settings/hydrate';
import { createAccountBoundProviderSnapshotReader } from './lifecycle/currentAccountSettingsSnapshot';
import { resolveProviderCredentialReference } from './spawn/credentials';
import { admitRuntimeProviderSavedSecret, resolveRuntimeProviderCredential } from './spawn/runtimeCredential';
import { createSavedSecretMaterializerFromSnapshotV1 } from '@/settings/secrets/savedSecretCatalog';
import { resolveProviderSourceFacts } from './registry/sourceFacts';
import { isRemoteProviderGatewayPlacement } from './managed/gatewayPlacement';
import { awaitAbortableWithinProviderOperation, awaitWithinProviderOperation, createProviderOperationLifetime } from './operationLifetime';

type InlineResponse = Extract<DaemonLspQueryResponse, { status: 'ok'; kind: 'ai.inlineSuggest' }>;
type InlineError = 'ai_disabled' | 'ai_excluded' | 'ai_language_disabled' | 'model_unavailable' | 'signed_out' | 'rate_limited' | 'cancelled' | 'request_failed' | 'stale_query';
const failure = (errorCode: InlineError) => ({ status: 'error' as const, errorCode });
const providerFailure = (error: ProviderErrorV1) => ({ status: 'error' as const, errorCode: 'provider_error' as const, error });

/** Real boundaries only; the inference owner, policy and Provider admission stay real in composed tests. */
export type ProviderInlineSuggestionDependencies = Readonly<{
  secretSources?: import('@/plugins/runtime/lifecycle/contributions/targetSecretSources').TargetSecretSourcesV1;
  resolveRegistry?: () => Promise<ProviderContributionRegistryView>;
  acquireRegistryLease?: () => Promise<PluginRuntimeRegistryLease>;
  resolveSharedGateway?: ResolveSharedManagedProviderGatewayBinding;
  resolveAddresses?: (hostname: string) => Promise<readonly string[]>;
  openHttp?: PinnedHttpStreamTransport;
  getServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined>;
  serverUrl?: string;
}>;

function selectedModel(record: ResolvedProviderConnectionRecord, modelId: string, nextEdit = false): ProviderModelDescriptorV1 | null {
  const catalog = resolveProviderSourceFacts(record).catalog;
  const model = 'staticModels' in catalog ? catalog.staticModels.find(candidate => candidate.id === modelId) : undefined;
  if (!model || !(nextEdit ? model.nextEdit : model.inlineCompletion)) return null;
  return projectProviderModelGenerationSettings(model, record.connection.modelSettings?.[modelId]);
}

/**
 * Wire-format codec for the languageIntelligence RPC's admitted Provider request.
 * Protocol names below describe external request/response shapes; the selected
 * contribution supplies them, without selecting an Agent or service here.
 */
function encodeRequest(operation: ProviderInlineCompletionOperationV1, model: ProviderModelDescriptorV1,
  context: Readonly<{ prefix: string; suffix: string }> | Readonly<{ prompt: string; stop: readonly string[] }>) {
  if (operation.mode === 'next-edit-codec') {
    if (operation.codec !== 'rewrite-window-v1' || !('prompt' in context) || !model.nextEdit) throw new TypeError('Missing dedicated next-edit context');
    if (operation.wireFormat === 'ollama-generate') return { model: model.id, prompt: context.prompt, raw: true, stream: false,
      options: { num_predict: model.nextEdit.outputTokens, num_ctx: model.contextWindowTokens, stop: context.stop, temperature: 0 } };
    if (operation.wireFormat === 'openai-text-completions') return { model: model.id, prompt: context.prompt, stream: false,
      max_tokens: model.nextEdit.outputTokens, stop: context.stop, temperature: 0 };
    throw new TypeError('Unsupported dedicated next-edit transport');
  }
  if (!('prefix' in context)) throw new TypeError('Missing inline context');
  const spec = model.inlineCompletion!;
  const raw = spec.rawFimTemplate;
  if (operation.mode === 'raw-fim-template' && !raw) throw new TypeError('Missing exact FIM template');
  const prompt = raw && operation.mode === 'raw-fim-template'
    ? `${raw.prefix}${context.prefix}${raw.suffix}${context.suffix}${raw.middle}` : context.prefix;
  if (operation.wireFormat === 'ollama-generate') return {
    model: model.id, prompt, ...(operation.mode === 'native-fim' ? { suffix: context.suffix } : { raw: true }), stream: false,
    options: { num_predict: spec.outputTokens, num_ctx: model.contextWindowTokens },
  };
  if (operation.wireFormat === 'openai-text-completions') return {
    model: model.id, prompt, ...(operation.mode === 'native-fim' ? { suffix: context.suffix } : {}), max_tokens: spec.outputTokens, stream: false,
  };
  const instructions = 'Complete the code between prefix and suffix. Return only the insertion, without explanations or Markdown fences.';
  const content = `Prefix:\n${context.prefix}\nSuffix:\n${context.suffix}`;
  if (operation.wireFormat === 'openai-chat') return { model: model.id, max_tokens: spec.outputTokens, stream: false,
    messages: [{ role: 'system', content: instructions }, { role: 'user', content }] };
  if (operation.wireFormat === 'openai-responses') return { model: model.id, max_output_tokens: spec.outputTokens, stream: false,
    instructions, input: content };
  return { model: model.id, max_tokens: spec.outputTokens, stream: false, system: instructions,
    messages: [{ role: 'user', content }] };
}

function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function number(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined; }
async function readResponseBody(read: () => Promise<Uint8Array | null>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for (;;) { const chunk = await read(); if (chunk === null) break; chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function decodeResponse(operation: ProviderInlineCompletionOperationV1, body: string): (Pick<InlineResponse, 'text' | 'usage'> & { complete: boolean }) | null {
  const data = object(JSON.parse(body));
  if (!data) return null;
  let text: unknown;
  let complete = false;
  let usage = object(data.usage);
  if (operation.wireFormat === 'ollama-generate') {
    if (data.done !== true || data.done_reason !== 'stop' && data.done_reason !== 'length') return null;
    text = data.response;
    complete = data.done_reason === 'stop';
    usage = { prompt_tokens: data.prompt_eval_count, completion_tokens: data.eval_count };
  } else if (operation.wireFormat === 'openai-responses') {
    if (data.status !== 'completed' || !Array.isArray(data.output)) return null;
    complete = true;
    text = data.output.flatMap(item => {
      const entry = object(item);
      return entry?.type === 'message' && Array.isArray(entry.content) ? entry.content.flatMap(part => {
        const content = object(part); return content?.type === 'output_text' && typeof content.text === 'string' ? [content.text] : [];
      }) : [];
    }).join('');
  } else if (operation.wireFormat === 'anthropic') {
    if (!['end_turn', 'max_tokens', 'stop_sequence'].includes(String(data.stop_reason)) || !Array.isArray(data.content)) return null;
    complete = data.stop_reason !== 'max_tokens';
    text = data.content.flatMap(part => { const content = object(part); return content?.type === 'text' && typeof content.text === 'string' ? [content.text] : []; }).join('');
  } else {
    const first = Array.isArray(data.choices) ? object(data.choices[0]) : null;
    if (!first || !['stop', 'length'].includes(String(first.finish_reason))) return null;
    text = operation.wireFormat === 'openai-chat' ? object(first.message)?.content : first.text;
    complete = first.finish_reason === 'stop';
  }
  if (typeof text !== 'string') return null;
  const inputTokens = number(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = number(usage?.completion_tokens ?? usage?.output_tokens);
  return { text, complete, ...(inputTokens !== undefined || outputTokens !== undefined ? { usage: {
    ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
  } } : {}) };
}

/** Machine-side editor inference. No language-server session or Agent identity is created. */
export function createProviderInlineSuggestionQuery(dependencies: ProviderInlineSuggestionDependencies = {}) {
  return async (request: DaemonLspQueryRequest, machineId: string | undefined, signal?: AbortSignal): Promise<DaemonLspQueryResponse> => {
    const isNextEdit = request.kind === 'ai.nextEdit';
    if ((!isNextEdit && request.kind !== 'ai.inlineSuggest') || !request.languageId || !machineId) return failure('model_unavailable');
    const input = isNextEdit ? request.nextEdit : request.inlineSuggestion;
    if (!input) return failure('model_unavailable');
    const getSnapshot = createAccountBoundProviderSnapshotReader(getActiveAccountSettingsSnapshot);
    const policy = (snapshot: ActiveAccountSettingsSnapshot | null): InlineError | null => {
      if (!snapshot) return 'model_unavailable';
      const settings = snapshot.settings.filesEditorAiSuggestionsV1;
      const operation = isNextEdit ? 'nextEdit' : 'inline';
      const reason = resolveFilesEditorAiSuggestionPolicy(settings, { path: request.path, languageId: request.languageId!, operation });
      if (reason) return ({ off: 'ai_disabled', excluded: 'ai_excluded', language_disabled: 'ai_language_disabled', model_unavailable: 'model_unavailable' } as const)[reason];
      if (isNextEdit && !settings.nextEditEnabled) return 'ai_disabled';
      return settings.connectionId === input.connectionId && resolveFilesEditorAiSuggestionModelId(settings, operation) === input.modelId ? null : 'stale_query';
    };
    let snapshot = getSnapshot();
    const denied = policy(snapshot);
    if (denied) return failure(denied);
    if (!snapshot) return failure('model_unavailable');
    const lifetime = createProviderOperationLifetime({ signal });
    let registryLease: PluginRuntimeRegistryLease | undefined;
    const resolveRegistry = dependencies.resolveRegistry ?? (async () => {
      registryLease = await (dependencies.acquireRegistryLease?.() ?? acquireAuthoritativePluginRuntimeRegistryLease());
      return resolveProviderContributionRegistryView(registryLease.registry.contributes, registryLease.registry.generation, registryLease.registry.readPluginOccurrenceId);
    });
    const resolveAddresses = dependencies.resolveAddresses ?? (async (hostname: string) => (await lookup(hostname, { all: true, verbatim: true })).map(answer => answer.address));
    const providerEnabled = async () => resolveCliFeatureDecision({ featureId: 'providers', env: process.env,
      serverSnapshot: await (dependencies.getServerFeaturesSnapshot?.() ?? fetchServerFeaturesSnapshot({ serverUrl: dependencies.serverUrl ?? resolveServerHttpBaseUrl(), signal,
        ...(dependencies.serverUrl ? { fetchImpl: globalThis.fetch } : {}) })) }).state === 'enabled';
    try {
      if (!await awaitWithinProviderOperation(providerEnabled(), lifetime)) return failure('model_unavailable');
      if (snapshot.providerConnectionsCatalog?.status !== 'ready' && snapshot.scopeKey) {
        await awaitWithinProviderOperation(prepareProviderConnectionsCatalogForCli({ expectedScopeKey: snapshot.scopeKey, signal }), lifetime);
        snapshot = getSnapshot();
      }
      if (!snapshot) return failure('model_unavailable');
      const registry = await awaitWithinProviderOperation(resolveRegistry(), lifetime);
      const settingsRead = readProviderSettingsForCli(snapshot);
      const dns = await collectProviderConnectionDnsEvidence({ connectionId: input.connectionId, machineId, providerSettings: settingsRead.settings,
        registry, resolveAddresses, lifetime });
      const resolved = resolveProviderConnectionForMachineFromSettingsRead({
        connectionId: input.connectionId, machineId, registry, dnsEvidenceByEndpointUrl: dns,
      }, settingsRead);
      if (resolved.status !== 'resolved' || !resolved.record.authorization.authorized) return failure('model_unavailable');
      const record = resolved.record;
      if (record.source.kind !== 'contribution') return failure('model_unavailable');
      const model = selectedModel(record, input.modelId, isNextEdit);
      const spec = isNextEdit ? model?.nextEdit : model?.inlineCompletion;
      const operation = record.source.definition.inlineCompletion?.find(candidate => candidate.id === spec?.operationId);
      const context = model && (isNextEdit && request.nextEdit && request.version !== undefined
        ? encodeNextEditRewriteWindow(request.path, request.nextEdit, request.version)
        : request.inlineSuggestion ? budgetInlineCompletionContext(model, request.inlineSuggestion) : null);
      if (!model || !operation || !context) return failure('model_unavailable');
      if (isNextEdit !== (operation.mode === 'next-edit-codec') || isNextEdit && (!('prompt' in context) || !fitsNextEditContext(model, context.prompt))) return failure('model_unavailable');
      const finish = async (status: number, readBody: () => Promise<string>): Promise<DaemonLspQueryResponse> => {
        if (status === 429) return failure('rate_limited');
        if (status === 401) return failure('signed_out');
        if (status !== 200) return failure('model_unavailable');
        const decoded = decodeResponse(operation, await readBody());
        if (!decoded) return failure('request_failed');
        const { complete, ...result } = decoded;
        const edits = isNextEdit && request.nextEdit && request.version !== undefined
          ? decodeNextEditRewriteWindow(request.path, request.nextEdit, request.version, result.text, complete) : null;
        if (isNextEdit && !edits) return failure('request_failed');
        return isNextEdit && edits && request.version !== undefined
          ? { status: 'ok', kind: 'ai.nextEdit', version: request.version, edits: [...edits], ...(result.usage ? { usage: result.usage } : {}) }
          : { status: 'ok', kind: 'ai.inlineSuggest', version: request.version, ...result };
      };
      if (record.deployment.kind === 'managedLocal') {
        const placement = record.connection.gatewayPlacement;
        if (isRemoteProviderGatewayPlacement(placement, machineId)) return failure('model_unavailable');
        const lease = await (dependencies.acquireRegistryLease?.() ?? acquireAuthoritativePluginRuntimeRegistryLease());
        try {
          const acquire = lease.registry.runManagedProviderExplicitStart;
          if (!acquire) return failure('model_unavailable');
          const sharedGateway = record.deployment.managedRuntime.sharing === 'connectionMachine'
            ? await dependencies.resolveSharedGateway?.({ connectionId: record.connectionId, consumerId: `explicitStart:${record.connectionId}`, signal })
            : null;
          if (record.deployment.managedRuntime.sharing === 'connectionMachine' && !sharedGateway) return failure('model_unavailable');
          const opened = await acquire({ existingOnly: true, identity: record.deployment.implementationIdentity,
            purposeBindings: record.deployment.purposeBindingIntents, machineId, ...(sharedGateway ? { sharedGateway } : {}), signal,
            isCurrent: () => !signal?.aborted,
            establish: async () => { throw new Error('Existing Provider access cannot establish a runtime'); },
          });
          if (opened.status !== 'established') return failure(opened.status === 'not_current' ? 'stale_query' : 'model_unavailable');
          const projection = opened.value.projection;
          try {
            const endpointUrl = projection.access.endpointUrl(operation.endpointTemplateId);
            if (!endpointUrl || !projection.isCurrent()) return failure('model_unavailable');
            return await awaitAbortableWithinProviderOperation(async requestSignal => {
              const url = new URL(operation.path, endpointUrl);
              const response = await projection.access.request({ pathAndQuery: `${url.pathname}${url.search}`, method: 'POST',
                headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(encodeRequest(operation, model, context))), signal: requestSignal });
              try {
                return await finish(response.status, async () => {
                  const reader = response.body?.getReader();
                  if (!reader) return '';
                  try {
                    return await readResponseBody(async () => {
                      const chunk = await reader.read();
                      return chunk.done ? null : chunk.value;
                    });
                  } finally { reader.releaseLock(); }
                });
              } finally { await response.body?.cancel().catch(() => undefined); }
            }, lifetime);
          } finally { await projection.cleanup(); }
        } finally { await lease.release(); }
      }
      const endpoint = record.endpoints.find(candidate => candidate.endpointTemplateId === operation.endpointTemplateId);
      if (!endpoint) return failure('model_unavailable');
      const facts = resolveProviderSourceFacts(record);
      const transport = facts.credential?.transports.filter(candidate => candidate.protocols.includes(endpoint.protocol) && candidate.uses.includes('runtime')) ?? [];
      if (facts.credential && transport.length !== 1) return failure('model_unavailable');
      const admitted = await admitRuntimeProviderSavedSecret({ connection: record, providerSettings: settingsRead.settings, snapshot,
        getAccountSettingsSnapshot: getSnapshot, lifetime, additionalCredentials: transport[0]?.additionalCredentials });
      if (!admitted.ok) return providerFailure(admitted.error);
      snapshot = admitted.snapshot;
      const reference = facts.credential ? resolveProviderCredentialReference({ providerSettings: settingsRead.settings,
        accountSettings: snapshot.settings,
        savedSecretMaterializer: createSavedSecretMaterializerFromSnapshotV1(snapshot, { isCurrent: () => !signal?.aborted }),
        connectionId: input.connectionId, machineId,
        credentialSlotId: facts.credential.slotId, required: facts.credential.required, additionalCredentials: transport[0]?.additionalCredentials }) : { ok: true as const, reference: { kind: 'none' as const } };
      if (!reference.ok) return providerFailure(reference.error);
      const dispatchUrl = new URL(operation.path, endpoint.normalizedUrl).toString();
      // The grant and the socket consume the same DNS evidence. Looking up the
      // hostname again here could dial a private address under a public grant.
      const addresses = endpoint.resolvedAddresses;
      const credential = reference.reference.kind === 'apiKey' && transport[0] ? await resolveRuntimeProviderCredential({ getAccountSettingsSnapshot: getSnapshot,
        secretSources: dependencies.secretSources ?? registryLease?.registry.secretSources, signal,
        credentialRef: { connectionId: record.connectionId, machineId, reference: reference.reference, transport: transport[0], protocol: endpoint.protocol,
          admittedSnapshot: snapshot } }) : null;
      if (credential && !credential.ok) return providerFailure(credential.error);
      try {
        const headers: Record<string, string> = { ...endpoint.publicHeaders, 'content-type': 'application/json' };
        const url = new URL(dispatchUrl);
        if (credential?.ok) {
          const material = credential.lease.credential;
          for (const value of [material, ...(material.additionalCredentials ?? [])]) {
            if (value.kind === 'httpHeader') headers[normalizeProviderCredentialHeaderName(value.name)] = value.value;
            else url.searchParams.set(normalizeProviderQueryParameterName(value.name), value.value);
          }
        }
        const result = await awaitAbortableWithinProviderOperation(async requestSignal => {
          const response = await (dependencies.openHttp ?? openPinnedHttpStream)({ url: url.toString(), validatedAddresses: addresses, headers,
            method: 'POST', body: new TextEncoder().encode(JSON.stringify(encodeRequest(operation, model, context))), signal: requestSignal });
          try {
            return await finish(response.status, () => readResponseBody(response.read));
          } finally { response.cancel(); }
        }, lifetime);
        return result;
      } finally { if (credential?.ok) credential.lease.close(); }
    } catch { return failure(signal?.aborted ? 'cancelled' : 'request_failed'); }
    finally { await registryLease?.release(); }
  };
}
