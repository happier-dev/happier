import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetVariablesReadResultV1ProtocolSchema as readOutput,
  DeploymentTargetVariablesSyncResultV1ProtocolSchema as syncOutput, PluginError, isPluginError,
  type DeploymentTargetVariablesReadInputV1, type DeploymentTargetVariablesSyncInputV1,
  type DeploymentTargetVariablesSyncResultV1,
  type JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request } from './deploymentHttp.js';
import { pagesCommon, pagesIo } from './pagesPrepare.js';
import { createDeploymentTargetVariableSyncV1, projectDeploymentTargetVariablesV1,
  type DeploymentTargetObservedVariableV1 } from '@happier-dev/deployment-protocol/v1';

type Product = 'pages' | 'workers';
type Read = DeploymentTargetVariablesReadInputV1;
type Sync = DeploymentTargetVariablesSyncInputV1;
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
  const variables = new Map<string, DeploymentTargetObservedVariableV1>();
  const bindingNames = new Set<string>();
  let wranglerConfigHash: string | undefined;
  function add(key: string, secret: boolean) {
    if (!key || variables.has(key)) refuse('provider_response_invalid');
    variables.set(key, { key, providerId: key, secret });
  }
  if (product === 'pages') {
    if (value.id !== input.providerIdentity.providerResourceId || value.name !== input.preparedNative?.projectName
      || !isObject(value.deployment_configs)) refuse('provider_response_invalid');
    const config = value.deployment_configs[selected.arm!];
    if (!isObject(config) || config.env_vars != null && !isObject(config.env_vars)) refuse('provider_response_invalid');
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
  // Worker Builds uses a separate trigger-scoped API. Runtime settings cannot
  // satisfy any build row, even when a same-name runtime row follows it.
  const planned = createDeploymentTargetVariableSyncV1(input, [...observed.variables.values()], product === 'workers' ? {
    opaqueKeys: observed.bindingNames,
    unsupportedSetKeys: new Set(input.set.filter(binding => binding.phase !== 'runtime').map(binding => binding.name)),
  } : {});
  let workerOutcomeUnknown = false;
  async function write(key: string, value: string | null, secret = false): Promise<boolean> {
    // A full Worker binding replacement cannot follow an unacknowledged replacement:
    // its inherited-name snapshot may omit a key that the first write actually created.
    if (workerOutcomeUnknown) { planned.fail(key, 'deployment_content_unavailable'); return false; }
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
      planned.fail(key, code); return false;
    }
    if (value === null) observed.bindingNames.delete(key);
    else observed.bindingNames.add(key);
    return true;
  }
  for (const binding of planned.set) {
    const materialized = await planned.materialize(binding, context);
    if (!materialized || !await write(binding.name, materialized.value, materialized.secret)) continue;
    planned.acknowledgeSet({ key: binding.name, providerId: binding.name, secret: materialized.secret });
  }
  for (const { key } of planned.remove) {
    if (await write(key, null)) planned.acknowledgeRemove(key);
  }
  return planned.result();
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
      const input = raw as unknown as Read;
      const observed = await snapshot(product, input, context);
      return { v: 1, variables: projectDeploymentTargetVariablesV1([...observed.variables.values()], input.owned) };
    } };
}
export const variableActions = {
  'pages-variables-read': action('pages', 'read'), 'pages-variables-sync': action('pages', 'sync'),
  'workers-variables-read': action('workers', 'read'), 'workers-variables-sync': action('workers', 'sync'),
} as const;
