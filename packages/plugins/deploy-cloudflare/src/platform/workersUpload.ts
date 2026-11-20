import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { readFile } from 'node:fs/promises';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  PluginError, type DeploymentTargetUploadDeployInputV1, type DeploymentTargetRoleResultV1,
  type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request, requestWorkerAssets } from './deploymentHttp.js';
import { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';
import { prepareWorkerBuild } from './workersBuild.js';
import { observeUploadedWorker, uploadedWorkerReference } from './workers.js';
import { isUploadedPreviewReference, observeUploadedPreview, uploadedPreviewReference, uploadedPreviewSelection } from './previewDeploy.js';

async function encode(form: FormData) {
  const response = new Response(form);
  return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get('content-type')! };
}

async function upload(input: DeploymentTargetUploadDeployInputV1, context: PluginInvocationContext): Promise<DeploymentTargetRoleResultV1> {
  if (input.sourceIntent.kind !== 'repository' || input.providerEnvironment.kind !== 'script'
    && (input.providerEnvironment.kind !== 'preview' || !('scriptName' in input.providerEnvironment))) {
    throw new PluginError({ code: 'unsupported_action', details: { phase: 'source' } });
  }
  const io = { http: context.services.http, signal: context.signal, now: () => Date.now() };
  const preview = uploadedPreviewSelection(input);
  if (input.providerDeploymentId) {
    const observed = preview && isUploadedPreviewReference(input.providerDeploymentId)
      ? await observeUploadedPreview(input, preview, io) : await observeUploadedWorker(input, io);
    if ('code' in observed) throw withActionFailureDiagnostic(new PluginError({ code: observed.code, retryable: observed.retryable, details: { phase: observed.phase },
      failureCause: projectActionFailureCauseV1(observed, `deployment.cloudflare.${observed.phase}`) }),
      { phase: `deployment.cloudflare.${observed.phase}`, causeKind: 'native_failure', error: observed });
    return observed;
  }
  const source = await context.services.deploymentSource.materialize({ environmentId: input.environmentId,
    deploymentId: input.deploymentId }, { signal: context.signal });
  const prepared = await prepareWorkerBuild({ rootPath: source.rootPath, actionOperationId: input.actionOperationId,
    scriptName: input.providerEnvironment.scriptName, preview: preview !== null }, { exec: context.services.exec, signal: context.signal });
  const accountId = input.providerIdentity.providerAccountId;
  const scriptName = input.providerEnvironment.scriptName;
  const previewRoot = preview ? `/workers/workers/${encodeURIComponent(scriptName)}/previews/${encodeURIComponent(preview.previewId)}` : null;
  let metadata: Record<string, unknown> = { ...prepared.metadata };
  if (previewRoot) {
    const latest = await request(io, accountId, `${previewRoot}/deployments/latest`, 'observe');
    if ('code' in latest && latest.code !== 'deployment_unavailable') {
      throw withActionFailureDiagnostic(new PluginError({ code: latest.code, retryable: latest.retryable, details: { phase: latest.phase },
        failureCause: projectActionFailureCauseV1(latest, `deployment.cloudflare.${latest.phase}`) }),
        { phase: `deployment.cloudflare.${latest.phase}`, causeKind: 'native_failure', error: latest });
    }
    const latestEnv = !('code' in latest) && isObject(latest.value) && isObject(latest.value.env) ? latest.value.env : {};
    const configuredEnv = isObject(prepared.preview?.env) ? prepared.preview.env : {};
    const { main_module, compatibility_date, compatibility_flags, exports, migrations } = prepared.metadata;
    metadata = { ...prepared.preview, main_module, compatibility_date, compatibility_flags, exports, migrations,
      env: { ...Object.fromEntries(Object.keys(latestEnv).map(name => [name, { type: 'inherit' }])), ...configuredEnv } };
  }
  if (prepared.assets) {
    const manifest = Object.fromEntries(prepared.assets.files.map(asset => [asset.url, { hash: asset.hash, size: asset.size }]));
    const session = await request(io, accountId, `/workers/scripts/${encodeURIComponent(scriptName)}/assets-upload-session`, 'send', ['write', 'POST'], { manifest });
    if ('code' in session) throw withActionFailureDiagnostic(new PluginError({ code: session.code, retryable: session.retryable, details: { phase: session.phase },
      failureCause: projectActionFailureCauseV1(session, `deployment.cloudflare.${session.phase}`) }),
      { phase: `deployment.cloudflare.${session.phase}`, causeKind: 'native_failure', error: session });
    const value = session.value;
    const available = new Map(prepared.assets.files.map(asset => [asset.hash, asset]));
    if (!isObject(value) || typeof value.jwt !== 'string' || !value.jwt || !Array.isArray(value.buckets)
      || value.buckets.some(bucket => !Array.isArray(bucket) || bucket.some(hash => typeof hash !== 'string' || !available.has(hash)))) {
      throw new PluginError({ code: 'provider_response_invalid', details: { phase: 'send' } });
    }
    let completionJwt = value.buckets.length === 0 ? value.jwt : null;
    for (const bucket of value.buckets as string[][]) {
      const form = new FormData();
      for (const hash of bucket) {
        const asset = available.get(hash)!;
        const bytes = await readFile(asset.path, { signal: context.signal });
        form.set(hash, new Blob([bytes.toString('base64')], { type: asset.contentType }), hash);
      }
      const encoded = await encode(form);
      const uploaded = await requestWorkerAssets(io, accountId, value.jwt, encoded.body, encoded.contentType);
      if ('code' in uploaded) throw withActionFailureDiagnostic(new PluginError({ code: uploaded.code, retryable: uploaded.retryable, details: { phase: uploaded.phase },
        failureCause: projectActionFailureCauseV1(uploaded, `deployment.cloudflare.${uploaded.phase}`) }),
        { phase: `deployment.cloudflare.${uploaded.phase}`, causeKind: 'native_failure', error: uploaded });
      if (isObject(uploaded.value) && typeof uploaded.value.jwt === 'string' && uploaded.value.jwt) completionJwt = uploaded.value.jwt;
    }
    if (!completionJwt) throw new PluginError({ code: 'outcome_unknown', details: { phase: 'send' } });
    // Wrangler's asset helper also carries build compatibility settings. The
    // upload API owns those at the top level; Preview carries rule files as modules.
    const config = { ...prepared.assets.config };
    delete config.compatibility_date;
    delete config.compatibility_flags;
    if (previewRoot) { delete config._headers; delete config._redirects; }
    metadata.assets = { jwt: completionJwt, config };
  }
  let encoded = { body: prepared.body, contentType: prepared.contentType };
  if (previewRoot || prepared.assets) {
    const form = previewRoot ? new FormData() : prepared.form;
    form.set('metadata', JSON.stringify(metadata));
    if (previewRoot) {
      for (const [, value] of prepared.form) if (value instanceof File) form.append('files', value, value.name);
      for (const name of ['_headers', '_redirects']) {
        const value = prepared.assets?.config[name];
        if (typeof value === 'string') form.append('files', new Blob([value], { type: 'text/plain' }), name);
      }
    }
    encoded = await encode(form);
  }
  const reply = await request(io, accountId,
    previewRoot ? `${previewRoot}/deployments` : `/workers/scripts/${encodeURIComponent(scriptName)}?excludeScript=true&bindings_inherit=strict`,
    'send', ['write', previewRoot ? 'POST' : 'PUT'], encoded.body, encoded.contentType);
  if ('code' in reply) throw withActionFailureDiagnostic(new PluginError({ code: reply.code, retryable: reply.retryable, details: { phase: reply.phase },
    failureCause: projectActionFailureCauseV1(reply, `deployment.cloudflare.${reply.phase}`) }),
    { phase: `deployment.cloudflare.${reply.phase}`, causeKind: 'native_failure', error: reply });
  // The pinned Wrangler deploy adapter reads deployment_id as the uploaded
  // version id for this endpoint. Acceptance is not serving confirmation: the
  // existing deployment operation observes this id before terminal success.
  const nativeId = isObject(reply.value) ? previewRoot ? reply.value.id : reply.value.deployment_id : undefined;
  if (typeof nativeId !== 'string' || !nativeId) {
    throw new PluginError({ code: 'outcome_unknown', retryable: false, details: { phase: 'send' } });
  }
  return { v: 1, state: 'running', providerDeploymentId: previewRoot ? uploadedPreviewReference(nativeId) : uploadedWorkerReference(nativeId),
    observedAtMs: io.now(), uploadProvenance: { sourceManifestFingerprint: source.manifestFingerprint,
      build: { location: 'controller', image: CLOUDFLARE_BUILD_IMAGE, toolchain: { name: 'wrangler', version: CLOUDFLARE_WRANGLER_VERSION },
        outputManifestFingerprint: prepared.outputManifestFingerprint } } };
}

export const workersUpload: Extract<PluginActionDeclaration, { execution?: { target: 'daemon' } }> & {
  run(value: JsonValue, context: PluginInvocationContext): Promise<DeploymentTargetRoleResultV1>;
} = { execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['cloudflare-workers', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  title: 'Upload the reviewed compiled Cloudflare Worker', dangerLevel: 'writesRemote', readOnly: false,
  confirmation: { title: 'Build and upload this reviewed commit to Cloudflare Workers?' },
  inputSchema: inputs.uploadDeploy.jsonSchema, resultSchema: output.jsonSchema,
  run: (value: JsonValue, context: PluginInvocationContext) => upload(value as unknown as DeploymentTargetUploadDeployInputV1, context),
};
