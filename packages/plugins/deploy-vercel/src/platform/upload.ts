import { projectActionFailureCauseV1, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DeploymentTargetRoleInputProtocolSchemasV1, DeploymentTargetRoleResultV1ProtocolSchema,
  PluginError, type DeploymentTargetUploadDeployInputV1, type JsonValue, type PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { deployVercelFiles, observeVercelDeployment, uploadVercelSourceFile, type VercelUploadedFile } from './operations.js';

/**
 * Vercel REST v2/files + v13/deployments, characterized 2026-10-31.
 * Binary bytes/SHA1 use the documented upload API. Modes and symlink link-text
 * match vercel/vercel 84878e532142f0ac584953695658b324eb9e5b80
 * packages/client/src/utils/{hashes,index}.ts (the OpenAPI omits mode).
 * Only the invocation's admitted source root is read. Project builds run remotely.
 */
async function upload(input: DeploymentTargetUploadDeployInputV1, context: PluginInvocationContext) {
  const io = { http: context.services.http, signal: context.signal, now: () => Date.now() };
  if (input.providerDeploymentId) return observeVercelDeployment(input, io);
  if (input.sourceIntent.kind !== 'repository' || 'scriptName' in input.providerEnvironment) {
    throw new PluginError({ code: 'unsupported_action', details: { phase: 'source' } });
  }
  if (!input.preparedNative) throw new PluginError({ code: 'deployment_content_unavailable' });
  const source = await context.services.deploymentSource.materialize({ environmentId: input.environmentId,
    deploymentId: input.deploymentId }, { signal: context.signal });
  const files: VercelUploadedFile[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    context.signal.throwIfAborted();
    for (const name of await readdir(directory)) {
      context.signal.throwIfAborted();
      // Platform variables use provider env sync. Committed local credentials
      // must not become remote source; retain ordinary app/build configuration.
      if (name === '.env' || name.startsWith('.env.') || name === '.npmrc' || name === '.vercel') continue;
      const absolute = join(directory, name);
      const file = prefix ? `${prefix}/${name}` : name;
      const stat = await lstat(absolute);
      if (stat.isDirectory()) { await visit(absolute, file); continue; }
      if (!stat.isFile() && !stat.isSymbolicLink()) throw new PluginError({ code: 'deployment_content_unavailable' });
      // Do not dereference symlinks: the source owner already admitted their
      // targets, and Vercel's file mode recreates the same link remotely.
      const bytes = stat.isSymbolicLink() ? new TextEncoder().encode(await readlink(absolute))
        : new Uint8Array(await readFile(absolute, { signal: context.signal }));
      const sha = createHash('sha1').update(bytes).digest('hex');
      const failed = await uploadVercelSourceFile(bytes, sha, input.providerIdentity.providerAccountId, io);
      if (failed) throw withActionFailureDiagnostic(new PluginError({ code: failed.code, retryable: failed.retryable, details: { phase: failed.phase },
        failureCause: projectActionFailureCauseV1(failed, `deployment.vercel.${failed.phase}`) }),
        { phase: `deployment.vercel.${failed.phase}`, causeKind: 'native_failure', error: failed });
      files.push({ file, sha, size: bytes.byteLength, mode: stat.mode });
    }
  }
  await visit(source.rootPath, '');
  // Scratch custody stays uncommitted: invocation cleanup owns abort on every
  // outcome. commit() would retain an own-server serving release indefinitely.
  const result = await deployVercelFiles({ providerIdentity: input.providerIdentity, providerEnvironment: input.providerEnvironment,
    projectName: input.preparedNative.projectName, files, sha: input.sourceIntent.sha }, io);
  return 'code' in result ? result : { ...result, uploadProvenance: {
    sourceManifestFingerprint: source.manifestFingerprint, build: { location: 'provider' as const },
  } };
}

export const uploadAction: Extract<PluginActionDeclaration, { execution?: { target: 'daemon' } }> & {
  run(input: JsonValue, context: PluginInvocationContext): Promise<import('@happier-dev/plugin-sdk').DeploymentTargetRoleResultV1>;
} = {
  execution: { target: 'daemon' }, scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  title: 'Upload the reviewed Vercel source', dangerLevel: 'writesRemote', readOnly: false,
  confirmation: { title: 'Upload this reviewed commit to Vercel?' },
  inputSchema: DeploymentTargetRoleInputProtocolSchemasV1.uploadDeploy.jsonSchema,
  resultSchema: DeploymentTargetRoleResultV1ProtocolSchema.jsonSchema,
  async run(input: JsonValue, context: PluginInvocationContext) {
    const result = await upload(input as unknown as DeploymentTargetUploadDeployInputV1, context);
    if ('code' in result) throw withActionFailureDiagnostic(new PluginError({ code: result.code, retryable: result.retryable, details: { phase: result.phase },
      failureCause: projectActionFailureCauseV1(result, `deployment.vercel.${result.phase}`) }),
      { phase: `deployment.vercel.${result.phase}`, causeKind: 'native_failure', error: result });
    return result;
  },
};
