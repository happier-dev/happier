import { withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetPreparationBaseV1ProtocolSchema as preparation, DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetRoleResultV1ProtocolSchema as output, PluginError, type DeploymentTargetPreparationBaseV1,
  type DeploymentTargetDeployInputV1, type DeploymentTargetUploadDeployInputV1, type DeploymentTargetObserveInputV1, type DeploymentTargetCancelInputV1,
  type DeploymentTargetRoleResultV1, type DeploymentTargetRoleFailureV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { ScmHostingRepositoryIdentityV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { targetProductSchema } from './targetOptions.js';
import { cloudflareReviewNotice } from './reviewNotice.js';
import { workerEnvironmentKey, prepareWorker, deployWorker, observeWorker, cancelWorker, observeUploadedWorker,
  isUploadedWorkerReference, resolveWorkerTag, workersAddressAccessId } from './workers.js';
import { inspectPreviewIdentity, preparePreview } from './preview.js';
import { teardownWorker } from './workersTeardown.js';
import { deployPreview, observePreview, cancelPreview, observeUploadedPreview, isUploadedPreviewReference,
  uploadedPreviewSelection, type PreviewDeployment } from './previewDeploy.js';
import { cloudflareRoleSchema, type CloudflareRoleInput, type WorkerSelection } from './targetSelection.js';

const base = cloudflareRoleSchema(preparation.jsonSchema, 'workers');
const scriptScope = cloudflareRoleSchema(preparation.jsonSchema, 'script').properties!.providerEnvironment!;
const previewScope = cloudflareRoleSchema(preparation.jsonSchema, 'preview').properties!.providerEnvironment!;
const prepareProperties = { ...base.properties, product: targetProductSchema, repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema,
  triggerUuid: { type: 'string', minLength: 1 } } satisfies NonNullable<PluginJsonSchema['properties']>;
const prepareRequired = [...base.required ?? [], 'repository'];
const prepareVariants: PluginJsonSchema[] = [
  { type: 'object', additionalProperties: false, required: [...prepareRequired, 'triggerUuid'], properties: { ...prepareProperties, sourceMethod: inputs.deploy.jsonSchema.properties!.sourceMethod!,
      providerEnvironment: scriptScope } },
  { type: 'object', additionalProperties: false, properties: { ...prepareProperties, sourceMethod: inputs.uploadDeploy.jsonSchema.properties!.sourceMethod!,
    providerEnvironment: scriptScope }, required: [...prepareRequired, 'sourceMethod'] },
  { type: 'object', additionalProperties: false, properties: { ...prepareProperties,
    providerEnvironment: previewScope }, required: prepareRequired },
];
export const workerPrepareInput = { type: 'object', additionalProperties: false,
  properties: prepareProperties, required: prepareRequired, oneOf: prepareVariants,
  allOf: [{ oneOf: [{ required: ['providerAccountId'] }, { required: ['providerIdentity'] }] }] } satisfies PluginJsonSchema;
export const workerLinkSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { credentialPrincipal: base.properties!.credentialPrincipal!, providerIdentity: base.properties!.providerIdentity!,
    sourceMethod: base.properties!.sourceMethod!,
    providerEnvironment: base.properties!.providerEnvironment!, repositoryAccess: base.properties!.repositoryAccess!, preparedNative: base.properties!.preparedNative! },
  required: ['credentialPrincipal', 'providerIdentity', 'providerEnvironment', 'preparedNative'] };
type PreparationAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};

const common = { execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin'], placementBindings: [],
  hostAccess: ['cloudflare-workers', 'deploy.manage'], connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }] } as const;
export const workersAddressCommon = { ...common, hostAccess: [...common.hostAccess, workersAddressAccessId] } as const;
function io(context: PluginAccountActionContext) {
  if (!context.services.http) throw new PluginError({ code: 'client_required' });
  return { http: context.services.http, signal: context.signal, now: () => Date.now() };
}
function refuse(outcome: DeploymentTargetRoleFailureV1): never {
  throw withActionFailureDiagnostic(new PluginError({ code: outcome.code, retryable: outcome.retryable, details: { phase: outcome.phase } }), {
    phase: `deployment.cloudflare.${outcome.phase}`, causeKind: 'native_failure', error: outcome });
}
function result(outcome: DeploymentTargetRoleResultV1 | DeploymentTargetRoleFailureV1) {
  if ('code' in outcome) refuse(outcome);
  return outcome;
}
export { common as workersCommon, io as workersIo, result as workersResult };

/** Only the host-admitted link supplies lifecycle coordinates; Connect owns their discovery. */
function previewDeployment(input: Pick<CloudflareRoleInput<DeploymentTargetPreparationBaseV1, WorkerSelection>,
  'providerIdentity' | 'providerEnvironment' | 'repositoryAccess' | 'preparedNative'>): PreviewDeployment | null {
  if (input.providerEnvironment.selection.kind !== 'preview') return null;
  const native = input.preparedNative;
  if (!input.providerIdentity || !input.repositoryAccess || !native?.previewId || !native.gitBranch || !native.workerTag || !native.scriptName) {
    throw new PluginError({ code: 'deployment_content_unavailable' });
  }
  return { accountId: input.providerIdentity.providerAccountId, previewName: input.providerEnvironment.selection.previewName,
    previewId: native.previewId, gitBranch: native.gitBranch, workerTag: native.workerTag, scriptName: native.scriptName,
    repositoryAccess: input.repositoryAccess };
}

/** Connect / Check again is the only native trigger/repository inspection. */
export const workersPrepare: PreparationAction = { ...common, title: 'Prepare the selected Cloudflare Worker', dangerLevel: 'safe', readOnly: true,
  inputSchema: workerPrepareInput, resultSchema: workerLinkSchema,
  async run(value: JsonValue, context: PluginAccountActionContext) {
    const request = value as unknown as CloudflareRoleInput<DeploymentTargetPreparationBaseV1, WorkerSelection> & {
      repository: ReturnType<typeof ScmHostingRepositoryIdentityV1ProtocolSchema.parse>; triggerUuid: string;
    } & ({ providerIdentity: NonNullable<DeploymentTargetPreparationBaseV1['providerIdentity']> }
      | { providerIdentity?: never; providerAccountId: string });
    const environment = request.providerEnvironment.selection;
    const accountId = request.providerIdentity ? request.providerIdentity.providerAccountId : request.providerAccountId;
    const workerTag = await resolveWorkerTag(accountId, environment.scriptName, io(context));
    if (typeof workerTag !== 'string') refuse(workerTag);
    if (request.providerIdentity && request.providerIdentity.providerResourceId !== workerTag) {
      throw new PluginError({ code: 'deployment_unavailable', details: { phase: 'link' } });
    }
    if (request.sourceMethod === 'upload') {
      const preview = environment.kind === 'preview' ? await inspectPreviewIdentity({ accountId,
        scriptName: environment.scriptName, previewName: environment.previewName }, io(context)) : null;
      if (preview && 'code' in preview) refuse(preview);
      return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal,
        providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag,
          providerEnvironment: workerEnvironmentKey(environment.scriptName, preview?.previewName) },
        sourceMethod: request.sourceMethod,
        providerEnvironment: request.providerEnvironment, preparedNative: { projectName: environment.scriptName,
          ...(preview ? { previewId: preview.previewId, scriptName: environment.scriptName } : {}),
          reviewNotice: cloudflareReviewNotice('workers', 'upload') } });
    }
    const contextIo = io(context);
    if (environment.kind === 'preview') {
      const prepared = await preparePreview({ accountId, workerTag, scriptName: environment.scriptName,
        previewName: environment.previewName, repository: request.repository }, contextIo);
      if ('code' in prepared) refuse(prepared);
      return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal,
        providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag,
          providerEnvironment: workerEnvironmentKey(environment.scriptName, prepared.previewName) },
        ...(request.sourceMethod !== undefined ? { sourceMethod: request.sourceMethod } : {}),
        providerEnvironment: request.providerEnvironment, repositoryAccess: prepared.repositoryAccess,
        preparedNative: { projectName: environment.scriptName, previewId: prepared.previewId, gitBranch: prepared.gitBranch,
          workerTag, scriptName: environment.scriptName, reviewNotice: cloudflareReviewNotice('workers', 'gitIntegration') } });
    }
    const prepared = await prepareWorker({ accountId, workerTag, scriptName: environment.scriptName,
      triggerUuid: request.triggerUuid, repository: request.repository }, contextIo);
    if ('code' in prepared) refuse(prepared);
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal, providerIdentity: prepared.providerIdentity,
      ...(request.sourceMethod !== undefined ? { sourceMethod: request.sourceMethod } : {}),
      providerEnvironment: prepared.providerEnvironment, repositoryAccess: prepared.repositoryAccess,
      // The required human resource name is the actual script name, not a
      // fabricated Pages/Vercel project. Operational script scope remains above.
      preparedNative: { projectName: prepared.providerEnvironment.selection.scriptName, triggerUuid: prepared.triggerUuid, reviewNotice: cloudflareReviewNotice('workers', 'gitIntegration') } });
  },
};

/** The host alone writes the association. This role consumes Connect's facts. */
const link: PreparationAction = { ...common, title: 'Link the prepared Cloudflare Worker', dangerLevel: 'writesLocal', readOnly: false,
  confirmation: { title: 'Link this Cloudflare Worker?' }, inputSchema: base, resultSchema: workerLinkSchema,
  async run(value: JsonValue) {
    const request = value as unknown as CloudflareRoleInput<DeploymentTargetPreparationBaseV1, WorkerSelection>;
    if (request.providerEnvironment.selection.kind === 'script') {
      if (!request.providerIdentity || !request.preparedNative?.projectName
        || (request.preparedNative.triggerUuid !== undefined && !request.repositoryAccess)) {
        throw new PluginError({ code: 'deployment_content_unavailable' });
      }
    } else if (!uploadedPreviewSelection(request)) {
      throw new PluginError({ code: 'unsupported_action' });
    }
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal, providerIdentity: request.providerIdentity,
      ...(request.sourceMethod !== undefined ? { sourceMethod: request.sourceMethod } : {}),
      providerEnvironment: request.providerEnvironment, repositoryAccess: request.repositoryAccess, preparedNative: request.preparedNative });
  },
};

async function deploy(input: CloudflareRoleInput<DeploymentTargetDeployInputV1, WorkerSelection>, context: PluginAccountActionContext) {
  const contextIo = io(context);
  const preview = previewDeployment(input);
  if (preview) return result(await deployPreview(input, preview, contextIo));
  if (input.providerDeploymentId) return result(await observeWorker(input, contextIo));
  if (input.providerEnvironment.selection.kind !== 'script') throw new PluginError({ code: 'unsupported_action' });
  if (!input.preparedNative?.triggerUuid || !input.repositoryAccess) throw new PluginError({ code: 'deployment_content_unavailable' });
  return result(await deployWorker({ sourceIntent: input.sourceIntent }, { providerIdentity: input.providerIdentity,
    providerEnvironment: { kind: 'native', selection: input.providerEnvironment.selection },
    repositoryAccess: input.repositoryAccess, triggerUuid: input.preparedNative.triggerUuid }, contextIo));
}

export const workerActions = {
  'workers-link': link,
  'workers-deploy': { ...workersAddressCommon, title: 'Deploy the reviewed commit to Cloudflare Workers', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Deploy this reviewed commit to Cloudflare Workers?' }, inputSchema: cloudflareRoleSchema(inputs.deploy.jsonSchema, 'workers'), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => deploy(value as unknown as CloudflareRoleInput<DeploymentTargetDeployInputV1, WorkerSelection>, context) },
  'workers-observe': { ...workersAddressCommon, title: 'Observe the selected Cloudflare Worker deployment', dangerLevel: 'safe', readOnly: true,
    inputSchema: cloudflareRoleSchema(inputs.observe.jsonSchema, 'workers'), resultSchema: output.jsonSchema,
    run: async (value: JsonValue, context: PluginAccountActionContext) => {
      const input = value as unknown as CloudflareRoleInput<DeploymentTargetObserveInputV1, WorkerSelection>;
      const contextIo = io(context);
      if (input.operation === 'teardown') return teardownWorker(input, contextIo, true);
      if (isUploadedWorkerReference(input.providerDeploymentId)) return result(await observeUploadedWorker(input, contextIo));
      if (isUploadedPreviewReference(input.providerDeploymentId)) {
        const uploaded = uploadedPreviewSelection(input);
        return uploaded ? result(await observeUploadedPreview(input, uploaded, contextIo)) : result({ v: 1, code: 'unsupported_action', phase: 'admission', retryable: false });
      }
      const preview = previewDeployment(input);
      return result(await (preview ? observePreview(input, preview, contextIo) : observeWorker(input, contextIo)));
    } },
  'workers-teardown': { ...common, title: 'Delete the linked Cloudflare Worker or Preview', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Delete this Cloudflare Worker or Preview and its associated resources?' },
    inputSchema: cloudflareRoleSchema(inputs.teardown.jsonSchema, 'workers'), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => teardownWorker(value as unknown as CloudflareRoleInput<DeploymentTargetObserveInputV1, WorkerSelection>, io(context)) },
  'workers-cancel': { ...workersAddressCommon, title: 'Cancel the selected Cloudflare Worker build', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Cancel this Cloudflare Worker build?' }, inputSchema: cloudflareRoleSchema(inputs.cancel.jsonSchema, 'workers'), resultSchema: output.jsonSchema,
    run: async (value: JsonValue, context: PluginAccountActionContext) => {
      const input = value as unknown as CloudflareRoleInput<DeploymentTargetCancelInputV1, WorkerSelection>;
      if (isUploadedWorkerReference(input.providerDeploymentId) || isUploadedPreviewReference(input.providerDeploymentId)) {
        throw new PluginError({ code: 'unsupported_action', details: { phase: 'cancel' } });
      }
      const preview = previewDeployment(input), contextIo = io(context);
      return result(await (preview ? cancelPreview(input, preview, contextIo) : cancelWorker(input, contextIo)));
    } },
} as const;
