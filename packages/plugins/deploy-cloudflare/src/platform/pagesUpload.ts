import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, DeploymentTargetRoleResultV1ProtocolSchema as output,
  PluginError, type DeploymentTargetUploadDeployInputV1, type JsonValue, type PluginInvocationContext,
  type DeploymentTargetRoleResultV1 } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { isObject } from '../connectedAccounts/probe.js';
import { request, requestPagesAssets } from './deploymentHttp.js';
import { observePagesDeployment } from './pages.js';
import { createPagesDeployment, pagesBranch, pagesResult } from './pagesDeploy.js';
import { preparePagesBuild } from './pagesBuild.js';

async function upload(input: DeploymentTargetUploadDeployInputV1, context: PluginInvocationContext): Promise<DeploymentTargetRoleResultV1> {
  const io = { http: context.services.http, signal: context.signal, now: () => Date.now() };
  if (input.providerDeploymentId) return pagesResult(await observePagesDeployment(input, io));
  if (input.sourceIntent.kind !== 'repository' || !pagesBranch(input)) throw new PluginError({ code: 'unsupported_action', details: { phase: 'source' } });
  const native = input.preparedNative;
  if (!native?.pages) throw new PluginError({ code: 'deployment_content_unavailable', details: { phase: 'source' } });
  const source = await context.services.deploymentSource.materialize({ environmentId: input.environmentId,
    deploymentId: input.deploymentId }, { signal: context.signal });
  const prepared = await preparePagesBuild({ rootPath: source.rootPath, rootDirectory: native.pages.rootDirectory,
    actionOperationId: input.actionOperationId,
    buildCommand: native.pages.buildCommand,
    ...(native.pages.buildOutputDirectory !== undefined ? { outputDirectory: native.pages.buildOutputDirectory || '.' } : {}),
  }, { exec: context.services.exec, signal: context.signal });
  context.signal.throwIfAborted();
  const token = await request(io, input.providerIdentity.providerAccountId,
    `/pages/projects/${encodeURIComponent(native.projectName)}/upload-token`, 'send');
  if ('code' in token) return pagesResult(token);
  if (!isObject(token.value) || typeof token.value.jwt !== 'string' || !token.value.jwt) {
    throw new PluginError({ code: 'provider_response_invalid', details: { phase: 'send' } });
  }
  const jwt = token.value.jwt;
  const acceptedHashes = new Set(prepared.assets.map(asset => asset.hash));
  const hashes = [...acceptedHashes];
  const missing = await requestPagesAssets(io, 'check-missing', jwt, { hashes });
  if ('code' in missing) return pagesResult(missing);
  if (!Array.isArray(missing.value) || missing.value.some(hash => typeof hash !== 'string' || !acceptedHashes.has(hash))) {
    throw new PluginError({ code: 'provider_response_invalid', details: { phase: 'send' } });
  }
  const needed = new Set(missing.value as string[]);
  // One reconstructible hashed asset per request keeps memory proportional to the
  // actual file, rather than buffering the complete build in an upload batch.
  for (const asset of prepared.assets) {
    if (!needed.delete(asset.hash)) continue;
    const bytes = await readFile(join(prepared.outputPath, asset.path), { signal: context.signal });
    const uploaded = await requestPagesAssets(io, 'upload', jwt, [{ key: asset.hash, value: bytes.toString('base64'),
      base64: true, metadata: { contentType: asset.contentType } }]);
    if ('code' in uploaded) return pagesResult(uploaded);
  }
  const registered = await requestPagesAssets(io, 'upsert-hashes', jwt, { hashes });
  if ('code' in registered) return pagesResult(registered);
  const form = new FormData();
  form.set('manifest', JSON.stringify(Object.fromEntries(prepared.assets.map(asset => [`/${asset.path}`, asset.hash]))));
  for (const [name, value] of Object.entries(prepared.multipartFields ?? {})) form.set(name, value);
  const files: { name: string; contentType: string; sha256: string }[] = [];
  for (const file of prepared.multipartFiles) {
    const bytes = await readFile(file.path, { signal: context.signal });
    const contentType = file.contentType ?? 'application/octet-stream';
    form.set(file.name, new Blob([Uint8Array.from(bytes).buffer], { type: contentType }), file.name);
    files.push({ name: file.name, contentType, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  // The source stays uncommitted: the existing invocation cleanup owns scratch.
  const result = pagesResult(await createPagesDeployment(input, form, io));
  return { ...result, uploadProvenance: { sourceManifestFingerprint: source.manifestFingerprint,
    build: { location: 'controller', image: prepared.provenance.image,
      toolchain: { name: 'wrangler', version: prepared.provenance.wranglerVersion },
      outputManifestFingerprint: `sha256:${createHash('sha256').update(JSON.stringify({
        assets: [...prepared.assets].sort((a, b) => a.path.localeCompare(b.path)),
        fields: Object.entries(prepared.multipartFields ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        files: files.sort((a, b) => a.name.localeCompare(b.name)),
      })).digest('hex')}` } } };
}

export const pagesUpload: Extract<PluginActionDeclaration, { execution?: { target: 'daemon' } }> & {
  run(value: JsonValue, context: PluginInvocationContext): Promise<DeploymentTargetRoleResultV1>;
} = { execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['cloudflare-pages', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  title: 'Upload the reviewed prepared Cloudflare Pages output', dangerLevel: 'writesRemote', readOnly: false,
  confirmation: { title: 'Build and upload this reviewed commit to Cloudflare Pages?' },
  inputSchema: inputs.uploadDeploy.jsonSchema, resultSchema: output.jsonSchema,
  run: (value: JsonValue, context: PluginInvocationContext) => upload(value as unknown as DeploymentTargetUploadDeployInputV1, context),
};
