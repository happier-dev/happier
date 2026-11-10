import { DeploymentTargetPreparationBaseV1ProtocolSchema as preparation, DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetRoleResultV1ProtocolSchema as output, PluginError, type DeploymentTargetPreparationBaseV1,
  type DeploymentTargetDeployInputV1, type DeploymentTargetUploadDeployInputV1, type DeploymentTargetObserveInputV1, type DeploymentTargetCancelInputV1,
  type DeploymentTargetRoleResultV1, type DeploymentTargetRoleFailureV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { ScmHostingRepositoryIdentityV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { targetProductSchema } from './targetOptions.js';
import { CLOUDFLARE_BUILD_IMAGE, CLOUDFLARE_WRANGLER_VERSION } from './cloudflareToolchain.js';
import { workerEnvironmentKey, prepareWorker, deployWorker, observeWorker, cancelWorker, observeUploadedWorker, isUploadedWorkerReference } from './workers.js';
import { inspectPreviewIdentity, preparePreview } from './preview.js';
import { deployPreview, observePreview, cancelPreview, observeUploadedPreview, isUploadedPreviewReference,
  uploadedPreviewSelection, type PreviewDeployment } from './previewDeploy.js';

const base = preparation.jsonSchema;
const uploadReviewNotice = `Uploads build on the controller using ${CLOUDFLARE_BUILD_IMAGE} and Wrangler ${CLOUDFLARE_WRANGLER_VERSION}.`;
const prepareProperties = { ...base.properties, product: targetProductSchema, repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema,
  triggerUuid: { type: 'string', minLength: 1 }, sourceMethod: { anyOf: [inputs.deploy.jsonSchema.properties!.sourceMethod!, inputs.uploadDeploy.jsonSchema.properties!.sourceMethod!] } } as const;
const prepareRequired = [...base.required ?? [], 'providerIdentity', 'repository'];
const prepareVariants: PluginJsonSchema[] = [
  { type: 'object', additionalProperties: false, required: [...prepareRequired, 'triggerUuid'], properties: { ...prepareProperties, sourceMethod: inputs.deploy.jsonSchema.properties!.sourceMethod!,
      providerEnvironment: { type: 'object', additionalProperties: false, properties: { kind: { const: 'script' }, scriptName: { type: 'string', minLength: 1 } }, required: ['kind', 'scriptName'] } } },
  { type: 'object', additionalProperties: false, properties: { ...prepareProperties, sourceMethod: inputs.uploadDeploy.jsonSchema.properties!.sourceMethod!,
    providerEnvironment: { type: 'object', additionalProperties: false, properties: { kind: { const: 'script' }, scriptName: { type: 'string', minLength: 1 } }, required: ['kind', 'scriptName'] } }, required: [...prepareRequired, 'sourceMethod'] },
  { type: 'object', additionalProperties: false, properties: { ...prepareProperties,
    providerEnvironment: { type: 'object', additionalProperties: false,
      properties: { kind: { const: 'preview' }, scriptName: { type: 'string', minLength: 1 }, previewName: { type: 'string', minLength: 1 } },
      required: ['kind', 'scriptName', 'previewName'] } }, required: prepareRequired },
];
export const workerPrepareInput = { type: 'object', additionalProperties: false,
  properties: prepareProperties, required: prepareRequired, oneOf: prepareVariants } satisfies PluginJsonSchema;
export const workerLinkSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { credentialPrincipal: base.properties!.credentialPrincipal!, providerIdentity: base.properties!.providerIdentity!,
    providerEnvironment: base.properties!.providerEnvironment!, repositoryAccess: base.properties!.repositoryAccess!, preparedNative: base.properties!.preparedNative! },
  required: ['credentialPrincipal', 'providerIdentity', 'providerEnvironment', 'preparedNative'] };
type PreparationAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['cloudflare-workers', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }] } as const;
function io(context: PluginAccountActionContext) {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  return { http: context.services.http, signal: context.signal, now: () => Date.now() };
}
function result(outcome: DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1) {
  if ('code' in outcome) throw new PluginError({ code: outcome.code, retryable: outcome.retryable, details: { phase: outcome.phase } });
  return outcome;
}
export { common as workersCommon, io as workersIo, result as workersResult };

/** Only the host-admitted link supplies lifecycle coordinates; Connect owns their discovery. */
function previewDeployment(input: Pick<DeploymentTargetPreparationBaseV1,
  'providerIdentity' | 'providerEnvironment' | 'repositoryAccess' | 'preparedNative'>): PreviewDeployment | null {
  if (input.providerEnvironment.kind !== 'preview' || !('scriptName' in input.providerEnvironment)) return null;
  const native = input.preparedNative;
  if (!input.providerIdentity || !input.repositoryAccess || !native?.previewId || !native.gitBranch || !native.workerTag || !native.scriptName) {
    throw new PluginError({ code: 'deployment_content_unavailable' });
  }
  return { accountId: input.providerIdentity.providerAccountId, previewName: input.providerEnvironment.previewName,
    previewId: native.previewId, gitBranch: native.gitBranch, workerTag: native.workerTag, scriptName: native.scriptName,
    repositoryAccess: input.repositoryAccess };
}

/** Connect / Check again is the only native trigger/repository inspection. */
export const workersPrepare: PreparationAction = { ...common, title: 'Prepare the selected Cloudflare Worker', dangerLevel: 'safe', readOnly: true,
  inputSchema: workerPrepareInput, resultSchema: workerLinkSchema,
  async run(value: JsonValue, context: PluginAccountActionContext) {
    const request = value as unknown as DeploymentTargetPreparationBaseV1 & {
      providerIdentity: NonNullable<DeploymentTargetPreparationBaseV1['providerIdentity']>;
      repository: ReturnType<typeof ScmHostingRepositoryIdentityV1ProtocolSchema.parse>; triggerUuid: string; sourceMethod?: DeploymentTargetDeployInputV1['sourceMethod'] | DeploymentTargetUploadDeployInputV1['sourceMethod'];
    };
    if (request.sourceMethod === 'upload') {
      if (request.providerEnvironment.kind !== 'script'
        && (request.providerEnvironment.kind !== 'preview' || !('scriptName' in request.providerEnvironment))) {
        throw new PluginError({ code: 'unsupported_action', details: { phase: 'source' } });
      }
      const environment = request.providerEnvironment;
      const preview = environment.kind === 'preview' ? await inspectPreviewIdentity({ accountId: request.providerIdentity.providerAccountId,
        scriptName: environment.scriptName, previewName: environment.previewName }, io(context)) : null;
      if (preview && 'code' in preview) throw new PluginError({ code: preview.code, retryable: preview.retryable, details: { phase: preview.phase } });
      return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal,
        providerIdentity: { ...request.providerIdentity, providerEnvironment: workerEnvironmentKey(environment.scriptName, preview?.previewName) },
        providerEnvironment: request.providerEnvironment, preparedNative: { projectName: environment.scriptName,
          ...(preview ? { previewId: preview.previewId, scriptName: environment.scriptName } : {}),
          reviewNotice: uploadReviewNotice } });
    }
    const contextIo = io(context);
    if (request.providerEnvironment.kind === 'preview' && 'scriptName' in request.providerEnvironment) {
      const environment = request.providerEnvironment;
      const prepared = await preparePreview({ accountId: request.providerIdentity.providerAccountId,
        workerTag: request.providerIdentity.providerResourceId, scriptName: environment.scriptName,
        previewName: environment.previewName, repository: request.repository }, contextIo);
      if ('code' in prepared) throw new PluginError({ code: prepared.code, retryable: prepared.retryable, details: { phase: prepared.phase } });
      return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal,
        providerIdentity: { ...request.providerIdentity, providerEnvironment: workerEnvironmentKey(environment.scriptName, prepared.previewName) },
        providerEnvironment: environment, repositoryAccess: prepared.repositoryAccess,
        preparedNative: { projectName: environment.scriptName, previewId: prepared.previewId, gitBranch: prepared.gitBranch,
          workerTag: request.providerIdentity.providerResourceId, scriptName: environment.scriptName, reviewNotice: uploadReviewNotice } });
    }
    if (request.providerEnvironment.kind !== 'script') throw new PluginError({ code: 'unsupported_action' });
    const prepared = await prepareWorker({ accountId: request.providerIdentity.providerAccountId,
      workerTag: request.providerIdentity.providerResourceId, scriptName: request.providerEnvironment.scriptName,
      triggerUuid: request.triggerUuid, repository: request.repository }, contextIo);
    if ('code' in prepared) throw new PluginError({ code: prepared.code, retryable: prepared.retryable, details: { phase: prepared.phase } });
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal, providerIdentity: prepared.providerIdentity,
      providerEnvironment: prepared.providerEnvironment, repositoryAccess: prepared.repositoryAccess,
      // The required human resource name is the actual script name, not a
      // fabricated Pages/Vercel project. Operational script scope remains above.
      preparedNative: { projectName: prepared.providerEnvironment.scriptName, triggerUuid: prepared.triggerUuid, reviewNotice: uploadReviewNotice } });
  },
};

/** The host alone writes the association. This role consumes Connect's facts. */
const link: PreparationAction = { ...common, title: 'Link the prepared Cloudflare Worker', dangerLevel: 'writesLocal', readOnly: false,
  confirmation: { title: 'Link this Cloudflare Worker?' }, inputSchema: preparation.jsonSchema, resultSchema: workerLinkSchema,
  async run(value: JsonValue) {
    const request = value as unknown as DeploymentTargetPreparationBaseV1;
    if (request.providerEnvironment.kind === 'script') {
      if (!request.providerIdentity || !request.preparedNative?.projectName
        || (request.preparedNative.triggerUuid !== undefined && !request.repositoryAccess)) {
        throw new PluginError({ code: 'deployment_content_unavailable' });
      }
    } else if (!uploadedPreviewSelection(request)) {
      throw new PluginError({ code: 'unsupported_action' });
    }
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal, providerIdentity: request.providerIdentity,
      providerEnvironment: request.providerEnvironment, repositoryAccess: request.repositoryAccess, preparedNative: request.preparedNative });
  },
};

async function deploy(input: DeploymentTargetDeployInputV1, context: PluginAccountActionContext) {
  const contextIo = io(context);
  const preview = previewDeployment(input);
  if (preview) return result(await deployPreview(input, preview, contextIo));
  if (input.providerDeploymentId) return result(await observeWorker(input, contextIo));
  if (input.providerEnvironment.kind !== 'script') throw new PluginError({ code: 'unsupported_action' });
  if (!input.preparedNative?.triggerUuid || !input.repositoryAccess) throw new PluginError({ code: 'deployment_content_unavailable' });
  return result(await deployWorker({ sourceIntent: input.sourceIntent }, { providerIdentity: input.providerIdentity,
    providerEnvironment: input.providerEnvironment, repositoryAccess: input.repositoryAccess, triggerUuid: input.preparedNative.triggerUuid }, contextIo));
}

export const workerActions = {
  'workers-link': link,
  'workers-deploy': { ...common, title: 'Deploy the reviewed commit to Cloudflare Workers', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Deploy this reviewed commit to Cloudflare Workers?' }, inputSchema: inputs.deploy.jsonSchema, resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => deploy(value as unknown as DeploymentTargetDeployInputV1, context) },
  'workers-observe': { ...common, title: 'Observe the selected Cloudflare Worker deployment', dangerLevel: 'safe', readOnly: true,
    inputSchema: inputs.observe.jsonSchema, resultSchema: output.jsonSchema,
    run: async (value: JsonValue, context: PluginAccountActionContext) => {
      const input = value as unknown as DeploymentTargetObserveInputV1;
      const contextIo = io(context);
      if (isUploadedWorkerReference(input.providerDeploymentId)) return result(await observeUploadedWorker(input, contextIo));
      if (isUploadedPreviewReference(input.providerDeploymentId)) {
        const uploaded = uploadedPreviewSelection(input);
        return uploaded ? result(await observeUploadedPreview(input, uploaded, contextIo)) : result({ v: 1, code: 'unsupported_action', phase: 'admission', retryable: false });
      }
      const preview = previewDeployment(input);
      return result(await (preview ? observePreview(input, preview, contextIo) : observeWorker(input, contextIo)));
    } },
  'workers-cancel': { ...common, title: 'Cancel the selected Cloudflare Worker build', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Cancel this Cloudflare Worker build?' }, inputSchema: inputs.cancel.jsonSchema, resultSchema: output.jsonSchema,
    run: async (value: JsonValue, context: PluginAccountActionContext) => {
      const input = value as unknown as DeploymentTargetCancelInputV1;
      if (isUploadedWorkerReference(input.providerDeploymentId) || isUploadedPreviewReference(input.providerDeploymentId)) {
        throw new PluginError({ code: 'unsupported_action', details: { phase: 'cancel' } });
      }
      const preview = previewDeployment(input), contextIo = io(context);
      return result(await (preview ? cancelPreview(input, preview, contextIo) : cancelWorker(input, contextIo)));
    } },
} as const;
