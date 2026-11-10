import { DeploymentTargetRoleInputProtocolSchemasV1 as inputs, type DeploymentTargetDeployInputV1, type DeploymentTargetUploadDeployInputV1, type DeploymentTargetPreparationBaseV1, type JsonValue } from '@happier-dev/plugin-sdk';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { DeploymentTargetPreparationBaseV1ProtocolSchema, ScmHostingRepositoryIdentityV1ProtocolSchema, projectNativeJsonValueForTransport, type PluginJsonSchema } from '@happier-dev/plugin-sdk/protocol';
import type { PluginAccountActionContext, PluginActionDeclaration } from '@happier-dev/plugin-sdk/actions';
import { prepareVercelProject, readVercelProjectCoordinates } from './operations.js';
import { targetInputHints } from './options.js';

const base = DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema;
const repositorySchema = ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema;
export const projectPrepareInputSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { ...base.properties, repository: repositorySchema, projectId: { type: 'string', minLength: 1 },
    sourceMethod: { anyOf: [inputs.deploy.jsonSchema.properties!.sourceMethod!, inputs.uploadDeploy.jsonSchema.properties!.sourceMethod!] } },
  required: [...base.required ?? []],
  // Preparation selects native coordinates; only Inspect produces the comparison identity.
  // Complete identities remain accepted for existing CLI and reinspection callers.
  oneOf: [{ required: ['providerAccountId', 'projectId'] }, { required: ['providerIdentity'] }] };
export const projectPrepareResultSchema: PluginJsonSchema = { type: 'object', additionalProperties: false,
  properties: { credentialPrincipal: base.properties!.credentialPrincipal!,
    providerIdentity: base.properties!.providerIdentity!, providerEnvironment: base.properties!.providerEnvironment!,
    repositoryAccess: base.properties!.repositoryAccess!, preparedNative: base.properties!.preparedNative! },
  required: ['credentialPrincipal', 'providerIdentity', 'providerEnvironment', 'preparedNative'] };

type ProjectAccountAction = Extract<PluginActionDeclaration, { execution: { target: 'account' } }> & {
  run(input: JsonValue, context: PluginAccountActionContext): Promise<JsonValue>;
};

/** Connect and Check again consume this same finite provider preparation. */
export const projectPrepareAction: ProjectAccountAction = {
  title: 'Prepare the selected Vercel project',
  execution: { target: 'account', account: { artifactId: 'account-runtime', exportName: 'activateAccount' } },
  scopes: ['global'], surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'], placementBindings: [],
  hostAccess: ['vercel-api', 'deploy.manage'],
  connectedAccountPurposeBindings: [{ path: 'credentialRef', purpose: 'deploy.manage' }],
  dangerLevel: 'safe', readOnly: true, inputSchema: projectPrepareInputSchema, resultSchema: projectPrepareResultSchema,
  inputHints: targetInputHints,
  async run(input: JsonValue, context: PluginAccountActionContext) {
    // Canonical shared custody and product input were validated by Action admission.
    const request = input as unknown as Omit<DeploymentTargetPreparationBaseV1, 'providerIdentity' | 'providerAccountId'> & {
      repository?: ReturnType<typeof ScmHostingRepositoryIdentityV1ProtocolSchema.parse>;
      sourceMethod?: (DeploymentTargetDeployInputV1 | DeploymentTargetUploadDeployInputV1)['sourceMethod'];
    } & ({ providerIdentity: NonNullable<DeploymentTargetPreparationBaseV1['providerIdentity']> }
      | { providerAccountId: string; projectId: string });
    // Both native Git and upload deploys consume a reviewed repository commit.
    // Missing Source configuration is a prerequisite, not malformed Action input.
    if (!request.repository) throw new PluginError({ code: 'repository_required', retryable: false,
      details: { phase: 'link' } });
    if (!context.services.http) throw new PluginError({ code: 'client_required' });
    const providerIdentity = readVercelProjectCoordinates(request);
    const prepared = await prepareVercelProject({ providerIdentity,
      providerEnvironment: request.providerEnvironment, repository: request.repository, sourceMethod: request.sourceMethod },
    { http: context.services.http, signal: context.signal, now: () => Date.now() });
    if ('code' in prepared) throw new PluginError({ code: prepared.code, retryable: prepared.retryable,
      details: { phase: prepared.phase } });
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal,
      providerIdentity: prepared.providerIdentity, providerEnvironment: prepared.providerEnvironment,
      ...(prepared.repositoryAccess ? { repositoryAccess: prepared.repositoryAccess } : {}),
      preparedNative: { projectName: prepared.projectName, ...(prepared.gitSource ? { gitSource: prepared.gitSource } : {}),
        ...(prepared.reviewNotice ? { reviewNotice: prepared.reviewNotice } : {}) } });
  },
};

/** Linking consumes the existing Connect observation; only the host writes the association. */
const { inputHints: _inspectHints, ...preparedLinkBase } = projectPrepareAction;
export const projectLinkAction: ProjectAccountAction = {
  ...preparedLinkBase, surfaces: ['cli', 'plugin'], title: 'Link the prepared Vercel project', dangerLevel: 'writesLocal', readOnly: false,
  confirmation: { title: 'Link this Vercel project?' },
  inputSchema: DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema,
  async run(input: JsonValue) {
    // Ordinary Action admission validated the shared custody input once.
    const request = input as unknown as DeploymentTargetPreparationBaseV1;
    if (!request.providerIdentity || !request.preparedNative) {
      throw new PluginError({ code: 'deployment_content_unavailable' });
    }
    return projectNativeJsonValueForTransport({ credentialPrincipal: request.credentialPrincipal, providerIdentity: request.providerIdentity,
      providerEnvironment: request.providerEnvironment, ...(request.repositoryAccess ? { repositoryAccess: request.repositoryAccess } : {}),
      preparedNative: request.preparedNative });
  },
};
