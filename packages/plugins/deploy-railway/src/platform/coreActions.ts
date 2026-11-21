import {
  DeploymentTargetLinkProviderContentV1ProtocolSchema,
  DeploymentTargetPreparationBaseV1ProtocolSchema,
  DeploymentTargetRoleInputProtocolSchemasV1 as inputs,
  DeploymentTargetRoleResultV1ProtocolSchema as output,
  settleDeploymentTargetResourceRemovalV1,
  type DeploymentTargetCancelInputV1,
  type DeploymentTargetCreateInputV1,
  type DeploymentTargetDeployInputV1,
  type DeploymentTargetObserveInputV1,
  type DeploymentTargetPreparationBaseV1,
  type DeploymentTargetRepositoryAccessV1,
  type DeploymentTargetRoleResultV1,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { ScmHostingRepositoryIdentityV1ProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { createRailwayProjectOperations, RailwayNativeError } from '@happier-dev/railway-api';
import { projectRailwayFailure, railwayAccountAction, railwayGraphql, railwayRequest } from './account.js';
import { railwayRoleInput, readRailwayCoordinates, type RailwayEnvironment } from './coordinates.js';
import { createOptionsInputHints, optionsInputHints, railwayEnvironmentOptionSchema } from './options.js';

type Preparation = Omit<DeploymentTargetPreparationBaseV1, 'providerEnvironment'> & {
  providerEnvironment: RailwayEnvironment;
  repository?: DeploymentTargetRepositoryAccessV1['repository'];
};
type Coordinates = ReturnType<typeof readRailwayCoordinates>;
const createInput = inputs.create;
type CreateInput = Omit<DeploymentTargetCreateInputV1, 'providerEnvironment'> & { providerEnvironment: RailwayEnvironment };
const createService = `mutation CreateGitService($input: ServiceCreateInput!) {
  serviceCreate(input: $input) { id projectId name }
}`;

const serviceFields = 'environmentId serviceId service { projectId }';
const deploymentFields = 'id projectId serviceId environmentId status meta';
const inspectService = `query InspectRepository($environmentId: String!, $serviceId: String!, $repo: String!) {
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) { ${serviceFields} serviceName source { repo } }
  gitHubRepoAccessAvailable(fullRepoName: $repo) { hasAccess isPublic }
}`;
const submitDeploy = `mutation DeployReviewedCommit($environmentId: String!, $serviceId: String!, $commitSha: String!) {
  serviceInstanceDeployV2(environmentId: $environmentId, serviceId: $serviceId, commitSha: $commitSha)
}`;
const observeDeployment = `query ObserveDeployment($id: String!, $environmentId: String!, $serviceId: String!) {
  deployment(id: $id) { ${deploymentFields} }
  serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
    ${serviceFields} activeDeployments { id } domains { serviceDomains { domain syncStatus } }
  }
}`;
const readDeployment = `query ReadDeployment($id: String!) { deployment(id: $id) { ${deploymentFields} } }`;
const cancelDeployment = `mutation CancelDeployment($id: String!) { deploymentCancel(id: $id) }`;

const preparation = railwayRoleInput(DeploymentTargetPreparationBaseV1ProtocolSchema.jsonSchema);
export const railwayLinkContentSchema = railwayRoleInput(DeploymentTargetLinkProviderContentV1ProtocolSchema.jsonSchema);

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

function exactService(value: unknown, scope: Coordinates) {
  const service = object(value);
  if (!service || service.environmentId !== scope.environmentId || service.serviceId !== scope.serviceId
    || object(service.service)?.projectId !== scope.projectId) throw new PluginError({ code: 'target_mismatch' });
  return service;
}

function exactDeployment(value: unknown, scope: Coordinates, deploymentId: string) {
  const deployment = object(value);
  if (!deployment || deployment.id !== deploymentId || deployment.projectId !== scope.projectId
    || deployment.environmentId !== scope.environmentId || deployment.serviceId !== scope.serviceId) {
    throw new PluginError({ code: 'target_mismatch' });
  }
  return deployment;
}

function linkedContent(input: Preparation, facts: Pick<Preparation, 'repositoryAccess' | 'preparedNative'>) {
  if (!facts.preparedNative || !input.providerIdentity) throw new PluginError({ code: 'deployment_content_unavailable' });
  return {
    credentialPrincipal: input.credentialPrincipal, providerIdentity: input.providerIdentity,
    providerEnvironment: input.providerEnvironment, sourceMethod: 'gitIntegration',
    ...(facts.repositoryAccess ? { repositoryAccess: facts.repositoryAccess } : {}),
    preparedNative: facts.preparedNative,
  };
}

function selectedScope(input: Preparation) {
  const { providerEnvironment } = input;
  // The closed Action schema owns operand shape. Only compare the supplied custody identities here.
  const { projectId, environmentId, serviceId } = providerEnvironment.selection;
  if (!serviceId) throw new PluginError({ code: 'target_mismatch' });
  const providerIdentity = input.providerIdentity
    ?? { providerAccountId: projectId, providerResourceId: serviceId, providerEnvironment: environmentId };
  if (input.providerAccountId !== undefined && input.providerAccountId !== projectId) {
    throw new PluginError({ code: 'target_mismatch' });
  }
  return { providerIdentity, coordinates: readRailwayCoordinates({ providerIdentity, providerEnvironment }) };
}

async function create(input: CreateInput, context: PluginAccountActionContext) {
  const { repository, productionBranch, resourceName, providerAccountId } = input;
  if (!repository) throw new PluginError({ code: 'repository_required' });
  if (repository.kind !== 'github' || repository.deployment !== 'https://github.com') {
    throw new PluginError({ code: 'deployment_source_forge_unsupported' });
  }
  const { projectId, environmentId, serviceId } = input.providerEnvironment.selection;
  if (providerAccountId !== projectId || serviceId !== undefined) throw new PluginError({ code: 'target_mismatch' });
  if (!productionBranch || (input.sourceMethod !== undefined && input.sourceMethod !== 'gitIntegration')) {
    throw new PluginError({ code: 'invalid_parameters' });
  }
  try {
    const result = await railwayGraphql(context)(createService, { input: {
      projectId, environmentId, name: resourceName, source: { repo: repository.repository }, branch: productionBranch,
    } });
    const service = object(result.serviceCreate);
    if (!service || service.projectId !== projectId || typeof service.id !== 'string' || !service.id
      || typeof service.name !== 'string' || !service.name) throw new RailwayNativeError('railway_invalid_response');
    return linkedContent({ ...input,
      providerIdentity: { providerAccountId: projectId, providerEnvironment: environmentId, providerResourceId: service.id },
      providerEnvironment: { kind: 'native', selection: { projectId, environmentId, serviceId: service.id } },
    }, { repositoryAccess: { status: 'ready', repository }, preparedNative: { projectName: service.name } });
  } catch (error) {
    return projectRailwayFailure(error, context, 'create', true);
  }
}

async function inspect(value: JsonValue, context: PluginAccountActionContext) {
  const input = value as unknown as Preparation;
  const { repository } = input;
  if (!repository) throw new PluginError({ code: 'repository_required' });
  if (repository.kind !== 'github' || repository.deployment !== 'https://github.com') {
    throw new PluginError({ code: 'deployment_source_forge_unsupported' });
  }
  const { providerIdentity, coordinates } = selectedScope(input);
  try {
    const { serviceInstance, gitHubRepoAccessAvailable } = await railwayGraphql(context)(inspectService, {
      environmentId: coordinates.environmentId, serviceId: coordinates.serviceId, repo: repository.repository,
    });
    const service = exactService(serviceInstance, coordinates);
    const grant = object(gitHubRepoAccessAvailable)?.hasAccess;
    if (typeof grant !== 'boolean' || typeof service.serviceName !== 'string' || !service.serviceName) {
      throw new PluginError({ code: 'provider_response_invalid' });
    }
    const repo = object(service.source)?.repo;
    const ready = grant && typeof repo === 'string' && repo.toLowerCase() === repository.repository.toLowerCase();
    return linkedContent({ ...input, providerIdentity }, {
      preparedNative: { projectName: service.serviceName },
      repositoryAccess: ready ? { status: 'ready', repository } : {
        status: 'needsGitAccess', repository,
        grantUrl: grant ? 'https://docs.railway.com/services#deploying-from-a-github-repo' : 'https://github.com/apps/railway-app',
      },
    });
  } catch (error) {
    return projectRailwayFailure(error, context, 'inspect');
  }
}

function statusOf(status: unknown, cancelling: boolean): DeploymentTargetRoleResultV1['state'] {
  // Railway marks aborted attempts REMOVED. Normal deployments also move to REMOVED when superseded.
  if (cancelling && status === 'REMOVED') return 'cancelled';
  switch (status) {
    case 'INITIALIZING': case 'QUEUED': case 'WAITING': case 'NEEDS_APPROVAL': return 'queued';
    case 'BUILDING': case 'DEPLOYING': case 'REMOVING': return 'running';
    case 'SLEEPING': case 'SUCCESS': return 'succeeded';
    case 'CRASHED': case 'FAILED': case 'SKIPPED': return 'failed';
    default: return 'outcome_unknown';
  }
}

function projectDeployment(deployment: Record<string, unknown>, deploymentId: string,
  options: Readonly<{ cancelling?: boolean; urls?: string[] }> = {}): DeploymentTargetRoleResultV1 {
  const builtSha = object(deployment.meta)?.commitHash;
  return {
    v: 1, state: statusOf(deployment.status, options.cancelling === true),
    providerDeploymentId: deploymentId, observedAtMs: Date.now(),
    ...(typeof builtSha === 'string' && /^[0-9a-f]{40}$/i.test(builtSha) ? { builtSha } : {}),
    ...(options.urls?.length ? { urls: options.urls, builtInUrls: options.urls } : {}),
  };
}

function deploymentId(input: DeploymentTargetObserveInputV1): string {
  if (!input.providerDeploymentId) throw new PluginError({ code: 'deployment_content_unavailable' });
  return input.providerDeploymentId;
}

async function observe(input: DeploymentTargetObserveInputV1, context: PluginAccountActionContext) {
  if (input.operation === 'teardown') return removeServiceInstance(input, context, true);
  const { environmentId, serviceId, ...project } = readRailwayCoordinates(input);
  const scope = { ...project, environmentId, serviceId };
  const id = deploymentId(input);
  try {
    const result = await railwayGraphql(context)(observeDeployment, { id, environmentId, serviceId });
    const deployment = exactDeployment(result.deployment, scope, id);
    const service = exactService(result.serviceInstance, scope);
    const activeDeployments = service.activeDeployments;
    if (!Array.isArray(activeDeployments)) throw new PluginError({ code: 'provider_response_invalid' });
    const serviceDomains = object(service.domains)?.serviceDomains;
    const urls = activeDeployments.some(entry => object(entry)?.id === id) && Array.isArray(serviceDomains)
      ? serviceDomains.flatMap(entry => {
        const domain = object(entry);
        return domain?.syncStatus === 'ACTIVE' && typeof domain.domain === 'string' && domain.domain.includes('.')
          ? ['https://' + domain.domain] : [];
      })
      : [];
    return projectDeployment(deployment, id, { urls });
  } catch (error) {
    return projectRailwayFailure(error, context, 'observe');
  }
}

function removeServiceInstance(input: DeploymentTargetObserveInputV1, context: PluginAccountActionContext, observeOnly: boolean) {
  const { projectId, environmentId, serviceId } = readRailwayCoordinates(input);
  const { deleteServiceInstance, observeServiceAbsent } = createRailwayProjectOperations(railwayRequest(context), context.signal);
  return settleDeploymentTargetResourceRemovalV1({
    ...(observeOnly ? {} : { remove: async () => {
      try {
        return await deleteServiceInstance({ serviceId, environmentId });
      } catch (error) {
        return projectRailwayFailure(error, context, 'teardown.send', true);
      }
    } }),
    observeAbsent: () => observeServiceAbsent({ projectId, environmentId, serviceId }),
    now: Date.now,
    providerDeploymentId: input.providerDeploymentId,
  });
}

async function deploy(input: DeploymentTargetDeployInputV1, context: PluginAccountActionContext): Promise<DeploymentTargetRoleResultV1> {
  if (input.providerDeploymentId) return observe(input, context);
  if (input.sourceIntent.kind !== 'repository') throw new PluginError({ code: 'repository_required' });
  const { environmentId, serviceId } = readRailwayCoordinates(input);
  const graphql = railwayGraphql(context);
  try {
    // The source owner already reconciled the retained link with the reviewed repository.
    const result = await graphql(submitDeploy, { environmentId, serviceId, commitSha: input.sourceIntent.sha });
    if (typeof result.serviceInstanceDeployV2 !== 'string' || !result.serviceInstanceDeployV2) {
      throw new PluginError({ code: 'outcome_unknown', retryable: false });
    }
    return { v: 1, state: 'queued', providerDeploymentId: result.serviceInstanceDeployV2, observedAtMs: Date.now() };
  } catch (error) {
    return projectRailwayFailure(error, context, 'send', true);
  }
}

async function cancel(input: DeploymentTargetCancelInputV1, context: PluginAccountActionContext) {
  const id = deploymentId(input);
  const scope = readRailwayCoordinates(input);
  const graphql = railwayGraphql(context);
  try {
    await graphql(cancelDeployment, { id });
    const { deployment } = await graphql(readDeployment, { id });
    return projectDeployment(exactDeployment(deployment, scope, id), id, { cancelling: true });
  } catch (error) {
    return projectRailwayFailure(error, context, 'cancel', true);
  }
}

/** Annotated with the public declaration type so declaration emit names only SDK exports. */
export const coreActions: Readonly<Record<
  'service-create' | 'targets-inspect-v1' | 'service-link' | 'deploy' | 'observe' | 'cancel' | 'teardown',
  PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>
>> = {
  'service-create': { ...railwayAccountAction, title: 'Create a Railway service', surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'],
    dangerLevel: 'writesRemote', readOnly: false, confirmation: {
      title: 'Create this Git-connected Railway service?',
      body: 'Railway creates this service in every non-fork environment if the selected environment is a non-fork. Selecting a fork keeps the service in that fork.',
    },
    inputSchema: railwayRoleInput(createInput.jsonSchema), resultSchema: railwayLinkContentSchema,
    inputHints: createOptionsInputHints,
    run: (value: JsonValue, context: PluginAccountActionContext) => create(value as unknown as CreateInput, context) },
  'targets-inspect-v1': { ...railwayAccountAction, title: 'Check the selected Railway service',
    surfaces: ['cli', 'plugin', 'ui', 'agent', 'mcp'],
    dangerLevel: 'safe', readOnly: true, inputSchema: { ...preparation, properties: {
      ...preparation.properties, repository: ScmHostingRepositoryIdentityV1ProtocolSchema.jsonSchema,
      railwayEnvironmentId: railwayEnvironmentOptionSchema,
    } }, inputHints: optionsInputHints, resultSchema: railwayLinkContentSchema, run: inspect },
  'service-link': { ...railwayAccountAction, title: 'Link the prepared Railway service', dangerLevel: 'writesLocal', readOnly: false,
    confirmation: { title: 'Link this Railway service?' }, inputSchema: preparation, resultSchema: railwayLinkContentSchema,
    async run(value: JsonValue) {
      const input = value as unknown as Preparation;
      return linkedContent({ ...input, providerIdentity: selectedScope(input).providerIdentity }, input);
    } },
  deploy: { ...railwayAccountAction, title: 'Deploy the reviewed commit to Railway', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Deploy this reviewed commit to Railway?' },
    inputSchema: railwayRoleInput(inputs.deploy.jsonSchema), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => deploy(value as unknown as DeploymentTargetDeployInputV1, context) },
  observe: { ...railwayAccountAction, title: 'Observe the selected Railway deployment', dangerLevel: 'safe', readOnly: true,
    inputSchema: railwayRoleInput(inputs.observe.jsonSchema), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => observe(value as unknown as DeploymentTargetObserveInputV1, context) },
  cancel: { ...railwayAccountAction, title: 'Cancel the selected Railway deployment', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Cancel this Railway deployment?' },
    inputSchema: railwayRoleInput(inputs.cancel.jsonSchema), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => cancel(value as unknown as DeploymentTargetCancelInputV1, context) },
  teardown: { ...railwayAccountAction, title: 'Remove the selected Railway service', dangerLevel: 'writesRemote', readOnly: false,
    confirmation: { title: 'Remove this Railway service from the selected environment?' },
    inputSchema: railwayRoleInput(inputs.teardown.jsonSchema), resultSchema: output.jsonSchema,
    run: (value: JsonValue, context: PluginAccountActionContext) => removeServiceInstance(value as unknown as DeploymentTargetObserveInputV1, context, false) },
};
