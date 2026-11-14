import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetVariablesReadResultV1ProtocolSchema as readOutput,
  DeploymentTargetVariablesSyncResultV1ProtocolSchema as syncOutput, PluginError, isPluginError,
  type DeploymentTargetVariablesReadInputV1, type DeploymentTargetVariablesSyncInputV1,
  type DeploymentTargetVariablesSyncResultV1, type DeploymentTargetVariableMetadataV1,
  type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request } from './deploymentHttp.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';

type Product = 'pages' | 'workers';
type Read = DeploymentTargetVariablesReadInputV1;
type Sync = DeploymentTargetVariablesSyncInputV1;
type Metadata = DeploymentTargetVariableMetadataV1;
type SyncResult = DeploymentTargetVariablesSyncResultV1;
function refuse(code: string): never { throw new PluginError({ code }); }

function scope(product: Product, input: Read) {
  const environment = input.providerEnvironment;
  if (product === 'workers') {
    if (environment.kind === 'preview' && 'scriptName' in environment) {
      // Use the captured immutable Preview identity; a missing Preview must never
      // fall back to the parent Worker's production settings.
      if (!input.preparedNative?.previewId) refuse('deployment_content_unavailable');
      return { root: `/workers/workers/${encodeURIComponent(environment.scriptName)}/previews/${encodeURIComponent(input.preparedNative.previewId)}/deployments/latest`, arm: undefined };
    }
    if (environment.kind !== 'script') refuse('unsupported_action');
    return { root: `/workers/scripts/${encodeURIComponent(environment.scriptName)}/settings`, arm: undefined };
  }
  if (environment.kind !== 'production' && (environment.kind !== 'preview' || 'scriptName' in environment
    || environment.gitBranch !== undefined)) refuse('unsupported_action');
  if (!input.preparedNative?.projectName) refuse('deployment_content_unavailable');
  return { root: `/pages/projects/${encodeURIComponent(input.preparedNative.projectName)}`, arm: environment.kind };
}

/** Cloudflare's variable schemas expose no per-key revision. Never infer drift from project timestamps.
 * Value fields from settings/project responses are discarded at this adapter boundary.
 */
async function snapshot(product: Product, input: Read, context: PluginAccountActionContext) {
  const selected = scope(product, input);
  const reply = await request(pagesIo(context), input.providerIdentity.providerAccountId, selected.root, 'observe');
  if ('code' in reply) throw withActionFailureDiagnostic(new PluginError({ code: reply.code, details: { phase: reply.phase },
    failureCause: projectActionFailureCauseV1(reply, `deployment.cloudflare.${reply.phase}`) }),
    { phase: `deployment.cloudflare.${reply.phase}`, causeKind: 'native_failure', error: reply });
  const value = reply.value;
  if (!isObject(value)) refuse('provider_response_invalid');
  const variables = new Map<string, Metadata>();
  const bindingNames = new Set<string>();
  const ownedByKey = new Map(input.owned.map(owned => [owned.key, owned.providerId]));
  let wranglerConfigHash: string | undefined;
  function add(key: string, secret: boolean) {
    if (!key || variables.has(key)) refuse('provider_response_invalid');
    variables.set(key, { key, providerId: key, present: true, secret,
      owned: ownedByKey.get(key) === key, drift: 'unknown' });
  }
  if (product === 'pages') {
    if (value.id !== input.providerIdentity.providerResourceId || value.name !== input.preparedNative?.projectName
      || !isObject(value.deployment_configs)) refuse('provider_response_invalid');
    const config = value.deployment_configs[selected.arm!];
    if (!isObject(config) || config.env_vars !== undefined && !isObject(config.env_vars)) refuse('provider_response_invalid');
    if (typeof config.wrangler_config_hash === 'string') wranglerConfigHash = config.wrangler_config_hash;
    for (const [key, row] of Object.entries(config.env_vars ?? {})) {
      if (!isObject(row) || row.type !== 'plain_text' && row.type !== 'secret_text') refuse('provider_response_invalid');
      add(key, row.type === 'secret_text');
    }
  } else {
    if (value.bindings !== undefined && !Array.isArray(value.bindings)) refuse('provider_response_invalid');
    for (const row of value.bindings ?? []) {
      if (!isObject(row) || typeof row.name !== 'string' || !row.name || typeof row.type !== 'string'
        || bindingNames.has(row.name)) refuse('provider_response_invalid');
      bindingNames.add(row.name);
      if (row.type === 'plain_text' || row.type === 'json' || row.type === 'secret_text' || row.type === 'secret_key') {
        add(row.name, row.type === 'secret_text' || row.type === 'secret_key');
      }
    }
  }
  for (const owned of input.owned) if (!variables.has(owned.key)) {
    variables.set(owned.key, { key: owned.key, providerId: owned.providerId, present: false, secret: true, owned: true, drift: 'changed' });
  }
  const annotations = product === 'workers' && isObject(value.annotations)
    ? Object.fromEntries(Object.entries(value.annotations).filter(([key, value]) =>
      (key === 'workers/message' || key === 'workers/tag') && typeof value === 'string')) : undefined;
  return { ...selected, variables, bindingNames, annotations, wranglerConfigHash };
}

/** Primary API schemas checked 2026-11-12:
 * Pages documents null deletion; official Wrangler mutates only the supplied
 * env_vars key (pages/secret/index.ts put/delete), preserving other keys.
 * Workers script settings PATCH accepts multipart settings and inherited bindings.
 * https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/edit/
 * https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/
 */
async function sync(product: Product, input: Sync, context: PluginAccountActionContext): Promise<SyncResult> {
  // The documented Preview env PATCH creates a deployment. P43's variable-sync
  // contract forbids automatic deployments, so only its metadata read is supported.
  // https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json
  // /workers/workers/{worker_id}/previews/{preview_id}/deployments/latest
  if (product === 'workers' && input.providerEnvironment.kind !== 'script') refuse('unsupported_action');
  const observed = await snapshot(product, input, context);
  const owned = new Map(input.owned.map(value => [value.key, value]));
  const failures: SyncResult['failures'] = [];
  const keep = new Set(input.keepTheirs);
  const useOurs = new Set(input.useOurs);
  for (const key of keep) {
    owned.delete(key);
    const current = observed.variables.get(key);
    if (current) observed.variables.set(key, { ...current, owned: false, drift: 'unknown' });
  }
  const desired = new Map<string, Sync['set'][number]>();
  const conflicts = new Set<string>();
  const unsupportedWorkerKeys = new Set<string>();
  let workerOutcomeUnknown = false;
  for (const binding of input.set) {
    const previous = desired.get(binding.name);
    if (previous && JSON.stringify(previous.source) !== JSON.stringify(binding.source)) conflicts.add(binding.name);
    if (product === 'workers' && binding.phase !== 'runtime') unsupportedWorkerKeys.add(binding.name);
    desired.set(binding.name, binding);
  }
  async function write(key: string, value: string | null, secret = false): Promise<boolean> {
    // A full Worker binding replacement cannot follow an unacknowledged replacement:
    // its inherited-name snapshot may omit a key that the first write actually created.
    if (workerOutcomeUnknown) { failures.push({ key, code: 'deployment_content_unavailable' }); return false; }
    let payload: unknown;
    let contentType = 'application/json';
    let path = observed.root;
    let method: 'PATCH' | 'PUT' | 'DELETE' = 'PATCH';
    if (product === 'pages') {
      payload = { deployment_configs: { [observed.arm!]: { env_vars: {
        [key]: value === null ? null : { type: secret ? 'secret_text' : 'plain_text', value },
      }, ...(observed.wranglerConfigHash === undefined ? {} : { wrangler_config_hash: observed.wranglerConfigHash }) } } };
    } else if (value === null && observed.variables.get(key)?.secret) {
      path = observed.root.replace(/\/settings$/u, `/secrets/${encodeURIComponent(key)}`);
      method = 'DELETE';
    } else if (secret && value !== null) {
      path = observed.root.replace(/\/settings$/u, '/secrets');
      method = 'PUT';
      payload = { name: key, text: value, type: 'secret_text' };
    } else {
      // Inherit every untouched binding, including secret/opaque bindings whose GET shape
      // cannot safely be re-submitted. Only this explicitly reviewed key is replaced/removed.
      const bindings: { name: string; type: string; text?: string }[] = [...observed.bindingNames]
        .filter(name => name !== key).map(name => ({ name, type: 'inherit' }));
      if (value !== null) bindings.push({ name: key, type: 'plain_text', text: value });
      const form = new FormData();
      form.set('settings', JSON.stringify({ bindings, ...(observed.annotations ? { annotations: observed.annotations } : {}) }));
      const encoded = new Response(form);
      contentType = encoded.headers.get('content-type')!;
      payload = new Uint8Array(await encoded.arrayBuffer());
    }
    const reply = await request(pagesIo(context), input.providerIdentity.providerAccountId, path, 'send', method, payload, contentType)
      .catch((error: unknown) => {
        // A received vendor refusal must not discard earlier successful ownership.
        // Host admission/custody errors retain their invocation-level semantics.
        if (isPluginError(error) && error.data.failureCause?.phase === 'deployment.provider.send'
          && typeof error.data.failureCause.httpStatus === 'number') return { code: 'provider_request_failed' as const };
        throw error;
      });
    if ('code' in reply) {
      const code = reply.code === 'provider_response_invalid' || reply.code === 'outcome_unknown' ? reply.code : 'provider_request_failed';
      if (product === 'workers' && code === 'outcome_unknown') workerOutcomeUnknown = true;
      failures.push({ key, code }); return false;
    }
    if (value === null) observed.bindingNames.delete(key);
    else observed.bindingNames.add(key);
    return true;
  }
  for (const [key, binding] of desired) {
    if (keep.has(key)) continue;
    if (conflicts.has(key)) { failures.push({ key, code: 'deployment_conflict' }); continue; }
    // Workers Builds uses a separate trigger-scoped API. Runtime settings cannot
    // satisfy any build row, even when a same-name runtime row follows it.
    // Pages env_vars serve both builds and Functions.
    if (unsupportedWorkerKeys.has(key)) {
      failures.push({ key, code: 'deployment_content_unavailable' }); continue;
    }
    const current = observed.variables.get(key);
    if (current?.present && !current.owned && !useOurs.has(key)
      || product === 'workers' && observed.bindingNames.has(key) && !current?.present) {
      failures.push({ key, code: 'deployment_conflict' }); continue;
    }
    if (binding.source.kind !== 'secret' && binding.source.kind !== 'value') {
      failures.push({ key, code: 'deployment_content_unavailable' }); continue;
    }
    let value: string;
    const secret = binding.source.kind === 'secret';
    if (binding.source.kind === 'secret') {
      if (!context.services.secrets) { failures.push({ key, code: 'secret_use_client_required' }); continue; }
      try {
        // P42-C15's invocation-bound owner admits the exact revision and registers
        // raw/JSON redaction before returning material to trusted plugin code.
        value = await context.services.secrets.readSavedSecret(binding.source.ref,
          { resourceRevision: binding.source.resourceRevision, signal: context.signal });
      } catch (error) {
        if (isPluginError(error) && (error.code === 'secret_use_client_required' || error.code === 'secret_missing'
          || error.code === 'plugin_secret_custody_unavailable')) {
          failures.push({ key, code: error.code }); continue;
        }
        // Acquisition failure sends no secret HTTP request, while the caller still
        // needs provenance for keys already acknowledged during this invocation.
        failures.push({ key, code: 'outcome_unknown' }); continue;
      }
    } else value = binding.source.value;
    if (!await write(key, value, secret)) continue;
    owned.set(key, { key, providerId: key, desiredRevision: input.desiredRevision });
    observed.variables.set(key, { key, providerId: key, present: true, secret, owned: true, drift: 'unknown' });
  }
  for (const key of new Set(input.remove)) {
    const provenance = owned.get(key);
    if (!provenance || provenance.providerId !== key || keep.has(key) || desired.has(key)) continue;
    const current = observed.variables.get(key);
    if (current?.present && !await write(key, null)) continue;
    owned.delete(key);
    observed.variables.delete(key);
  }
  return { v: 1, owned: [...owned.values()], variables: [...observed.variables.values()], failures };
}

function action(product: Product, operation: 'read' | 'sync') {
  const write = operation === 'sync';
  return { ...pagesCommon, hostAccess: [`cloudflare-${product}`, 'deploy.manage'],
    title: `${write ? 'Synchronize' : 'List'} Cloudflare ${product} variables`,
    dangerLevel: write ? 'writesRemote' as const : 'safe' as const, readOnly: !write,
    ...(write ? { confirmation: { title: 'Synchronize these Cloudflare variables?' } } : {}),
    inputSchema: inputs[`variables.${operation}`].jsonSchema,
    resultSchema: (write ? syncOutput : readOutput).jsonSchema,
    async run(raw: JsonValue, context: PluginAccountActionContext): Promise<JsonValue> {
      if (operation === 'sync') return sync(product, raw as unknown as Sync, context);
      return { v: 1, variables: [...(await snapshot(product, raw as unknown as Read, context)).variables.values()] };
    } };
}
export const variableActions = {
  'pages-variables-read': action('pages', 'read'), 'pages-variables-sync': action('pages', 'sync'),
  'workers-variables-read': action('workers', 'read'), 'workers-variables-sync': action('workers', 'sync'),
} as const;
