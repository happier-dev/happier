import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolNumber,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import { createRailwayGraphqlClient, NativeError } from './transport.js';

export const RAILWAY_PROJECT_KEY = 'RAILWAY_PROJECT_ID';

const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const choice = defineProtocolObject({ id: text, name: text }, open);
const choices = defineProtocolArray(choice);
const optionalText = defineProtocolUnion([text, defineProtocolLiteral(null)]);
const serviceChoice = defineProtocolObject({ id: text, name: text, templateId: optionalText.optional() }, open);
const scopeEnvironment = defineProtocolObject({ id: text, name: text, projectId: text }, open);
const pageInfo = defineProtocolObject({ endCursor: optionalText, hasNextPage: boolean }, open);
const createdProject = defineProtocolObject({
  id: text, name: text, workspaceId: text,
  environments: defineProtocolObject({ edges: defineProtocolArray(defineProtocolObject({ node: choice }, open)) }, open),
}, open);
const createdEnvironment = defineProtocolObject({ id: text, name: text, projectId: text }, open);
const connection = defineProtocolObject({
  edges: defineProtocolArray(defineProtocolObject({ node: serviceChoice }, open)),
  pageInfo,
}, open);
const accountProjectsCursor = defineProtocolObject({
  workspaceIds: defineProtocolArray(text, { minItems: 1 }),
  after: optionalText,
}, { policy: 'closed' });
const serviceInstance = defineProtocolObject({
  serviceId: text, serviceName: text, deletedAt: optionalText,
  service: defineProtocolObject({ templateId: optionalText }, open).optional(),
}, open);
const exactServiceInstance = defineProtocolObject({
  environmentId: text, serviceId: text, serviceName: text, deletedAt: optionalText,
  service: defineProtocolObject({
    projectId: text,
    templateId: optionalText.optional(),
    project: defineProtocolObject({ workspaceId: text }, open).optional(),
  }, open),
}, open);
const templateIdentity = defineProtocolObject({ id: text }, open);
const environmentServices = defineProtocolObject({
  id: text, projectId: text, serviceInstances: defineProtocolObject({
    edges: defineProtocolArray(defineProtocolObject({
      node: serviceInstance,
    }, open)), pageInfo,
  }, open),
}, open);
const volumeAttachment = defineProtocolObject({
  environmentId: text, serviceId: optionalText, volumeId: text,
  deletedAt: optionalText, isPendingDeletion: boolean, volume: choice.optional(),
}, open);
const volumeAttachments = defineProtocolObject({
  edges: defineProtocolArray(defineProtocolObject({ node: volumeAttachment }, open)), pageInfo,
}, open);
const volumeEnvironment = defineProtocolObject({ id: text, volumeInstances: volumeAttachments }, open);
const projectVolumeEnvironments = defineProtocolObject({
  id: text, environments: defineProtocolObject({
    edges: defineProtocolArray(defineProtocolObject({ node: volumeEnvironment }, open)), pageInfo,
  }, open),
}, open);
const grantedProjectWorkspaces = defineProtocolArray(defineProtocolObject({
  id: text, name: text, projects: defineProtocolArray(choice),
}, open));
const port = defineProtocolNumber({ integer: true, minimum: 1, maximum: 65535 });
const tcpProxies = defineProtocolArray(defineProtocolObject({ domain: text, proxyPort: port, applicationPort: port }, open));
const connectionFields = 'edges { node { id name } } pageInfo { hasNextPage endCursor }';
const volumeAttachmentFields = 'edges { node { environmentId serviceId volumeId deletedAt isPendingDeletion } } pageInfo { hasNextPage endCursor }';
const namedVolumeAttachmentFields = 'edges { node { environmentId serviceId volumeId deletedAt isPendingDeletion volume { id name } } } pageInfo { hasNextPage endCursor }';
const deleteService = `mutation DeleteServiceInstance($id: String!, $environmentId: String!) {
  serviceDelete(id: $id, environmentId: $environmentId)
}`;

type Choice = ProtocolSchemaOutput<typeof choice>;
type ServiceChoice = ProtocolSchemaOutput<typeof serviceChoice>;
type Page<T = Choice> = Readonly<{ choices: T[]; nextCursor: string | null }>;
type ScopeSelection = Readonly<{ projectId: string; environmentId?: string }>;
type ScopeInventory = Readonly<{
  scope: Choice;
  environments: Choice[];
  services: Choice[];
  databases: Choice[];
  volumes: Choice[];
}>;
const databaseTemplateCodes = ['postgres', 'mysql', 'redis', 'mongo'] as const;
const databaseTemplates = databaseTemplateCodes.map(code => `${code}: template(code: "${code}") { id }`).join(' ');
type ServiceSelection = Readonly<{
  projectId: string;
  environmentId: string;
  serviceId: string;
  workspaceId?: string;
}>;
type ServiceVariableUpdate = Readonly<{
  projectId: string;
  environmentId: string;
  serviceId: string;
  variables: Readonly<Record<string, string>>;
  skipDeploys?: boolean;
}>;

function child(value: unknown, field: string): unknown {
  return value !== null && typeof value === 'object' && field in value
    ? (value as Record<string, unknown>)[field]
    : undefined;
}

function requireTemplateIdentity(value: unknown) {
  const parsed = templateIdentity.safeParse(value);
  if (!parsed.success) throw new NativeError('railway_invalid_response');
  return parsed.data;
}

function readNextCursor({ hasNextPage, endCursor }: ProtocolSchemaOutput<typeof pageInfo>, after: string | null) {
  if (!hasNextPage) return null;
  if (endCursor === null || endCursor === after) throw new NativeError('railway_invalid_response');
  return endCursor;
}

function readChoicePage(value: unknown, after: string | null): Page<ServiceChoice> {
  const parsed = connection.safeParse(value);
  if (!parsed.success) throw new NativeError('railway_invalid_response');
  return { choices: parsed.data.edges.map(edge => edge.node), nextCursor: readNextCursor(parsed.data.pageInfo, after) };
}

function readAccountProjectsCursor(cursor: string) {
  let value: unknown;
  try {
    value = JSON.parse(cursor);
  } catch {
    throw new NativeError('invalid_parameters');
  }
  const parsed = accountProjectsCursor.safeParse(value);
  if (!parsed.success) throw new NativeError('invalid_parameters');
  return parsed.data;
}

/** On-demand project inventory and non-replacing variable updates for Railway consumers. */
export function createRailwayProjectOperations(request: typeof fetch, signal?: AbortSignal) {
  const graphql = createRailwayGraphqlClient(request, signal);

  async function createProject(input: Readonly<{ name: string; workspaceId: string }>) {
    const data = await graphql(`mutation($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id name workspaceId environments { edges { node { id name } } } }
    }`, { input });
    const parsed = createdProject.safeParse(data.projectCreate);
    if (!parsed.success || parsed.data.workspaceId !== input.workspaceId) throw new NativeError('railway_invalid_response');
    const { id, name, environments } = parsed.data;
    const environment = environments.edges.find(({ node }) => node.name === 'production')?.node;
    if (!environment) throw new NativeError('railway_invalid_response');
    return { project: { id, name }, environment };
  }

  async function createEnvironment(input: Readonly<{ name: string; projectId: string }>) {
    const data = await graphql(`mutation($input: EnvironmentCreateInput!) {
      environmentCreate(input: $input) { id name projectId }
    }`, { input });
    const parsed = createdEnvironment.safeParse(data.environmentCreate);
    if (!parsed.success || parsed.data.projectId !== input.projectId) throw new NativeError('railway_invalid_response');
    const { id, name } = parsed.data;
    return { id, name };
  }

  async function listPages<T>(readPage: (after: string | null) => Promise<Page<T>>): Promise<T[]> {
    const choices: T[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await readPage(after);
      choices.push(...page.choices);
      if (page.nextCursor === null) return choices;
      after = page.nextCursor;
    }
  }

  async function readProjectsPage(after: string | null, workspaceId?: string) {
    return readChoicePage((await graphql(
      `query($workspaceId: String, $after: String) { projects(workspaceId: $workspaceId, after: $after) { ${connectionFields} } }`,
      { workspaceId, after },
    )).projects, after);
  }

  async function listGrantedWorkspaces() {
    const data = await graphql('query { me { workspaces { id name } } }', {});
    const parsed = choices.safeParse(child(data.me, 'workspaces'));
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data;
  }

  async function readWorkspaceChoices() {
    const data = await graphql('query { me { workspaces { id name } } externalWorkspaces { id name } }', {});
    const memberWorkspaces = choices.safeParse(child(data.me, 'workspaces'));
    const sharedWorkspaces = choices.safeParse(data.externalWorkspaces);
    if (!memberWorkspaces.success || !sharedWorkspaces.success) throw new NativeError('railway_invalid_response');
    const byId = new Map([...sharedWorkspaces.data, ...memberWorkspaces.data].map(workspace => [workspace.id, workspace]));
    return [...byId.values()];
  }

  /** Continue through the remaining workspaces in the order established by the first page. */
  async function readAccountProjectsPage(cursor: string | null): Promise<Page & Readonly<{ workspaceId: string | null }>> {
    const position = cursor === null ? null : readAccountProjectsCursor(cursor);
    const workspaceIds = position?.workspaceIds ?? (await readWorkspaceChoices()).map(workspace => workspace.id);
    for (const [index, workspaceId] of workspaceIds.entries()) {
      const after = index === 0 ? position?.after ?? null : null;
      const page = await readProjectsPage(after, workspaceId);
      if (page.nextCursor !== null || page.choices.length > 0) {
        const remaining = workspaceIds.slice(page.nextCursor === null ? index + 1 : index);
        return { choices: page.choices, workspaceId,
          nextCursor: remaining.length ? JSON.stringify({ workspaceIds: remaining, after: page.nextCursor }) : null };
      }
    }
    return { choices: [], workspaceId: null, nextCursor: null };
  }

  async function listGrantedProjectWorkspaces() {
    const data = await graphql('query { externalWorkspaces { id name projects { id name } } }', {});
    const parsed = grantedProjectWorkspaces.safeParse(data.externalWorkspaces);
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data;
  }

  async function readProjectPage(projectId: string, field: 'environments' | 'services' | 'volumes', after: string | null,
    includeServiceTemplate = false): Promise<Page<ServiceChoice>> {
    const fields = includeServiceTemplate ? 'edges { node { id name templateId } } pageInfo { hasNextPage endCursor }' : connectionFields;
    const data = await graphql(
      `query($projectId: String!, $after: String) { project(id: $projectId) { ${field}(after: $after) { ${fields} } } }`,
      { projectId, after },
    );
    return readChoicePage(child(data.project, field), after);
  }

  async function readEnvironmentServicesPage(projectId: string, environmentId: string, after: string | null, templateCode?: string,
    includeServiceTemplate = false): Promise<Page<ServiceChoice>> {
    const templateInput = templateCode === undefined ? '' : ', $templateCode: String!';
    const templateQuery = templateCode === undefined ? '' : 'template(code: $templateCode) { id }';
    const provenance = templateCode !== undefined || includeServiceTemplate ? 'service { templateId }' : '';
    const data = await graphql(`query($projectId: String!, $environmentId: String!, $after: String${templateInput}) {
      ${templateQuery}
      environment(id: $environmentId, projectId: $projectId) { id projectId serviceInstances(after: $after) {
        edges { node { serviceId serviceName deletedAt ${provenance} } } pageInfo { hasNextPage endCursor }
      } }
    }`, { projectId, environmentId, after, templateCode });
    const parsed = environmentServices.safeParse(data.environment);
    if (!parsed.success || parsed.data.id !== environmentId || parsed.data.projectId !== projectId) {
      throw new NativeError('railway_invalid_response');
    }
    const template = templateCode === undefined ? undefined : requireTemplateIdentity(data.template);
    const { edges, pageInfo } = parsed.data.serviceInstances;
    const choices = edges.flatMap(({ node }) => {
      if (node.deletedAt !== null || template && node.service?.templateId !== template.id) return [];
      return [{ id: node.serviceId, name: node.serviceName, ...(includeServiceTemplate && node.service ? { templateId: node.service.templateId } : {}) }];
    });
    return { choices, nextCursor: readNextCursor(pageInfo, after) };
  }

  async function readServiceInstance({ projectId, environmentId, serviceId, workspaceId }: ServiceSelection, templateCode?: string) {
    const templateInput = templateCode === undefined ? '' : ', $templateCode: String!';
    const templateQuery = templateCode === undefined ? '' : 'template(code: $templateCode) { id }';
    const data = await graphql(`query($environmentId: String!, $serviceId: String!${templateInput}) {
      ${templateQuery}
      serviceInstance(environmentId: $environmentId, serviceId: $serviceId) {
        environmentId serviceId serviceName deletedAt service { projectId ${templateCode === undefined ? '' : 'templateId'} ${workspaceId === undefined ? '' : 'project { workspaceId }'} }
      }
    }`, { environmentId, serviceId, templateCode });
    const instance = exactServiceInstance.safeParse(data.serviceInstance);
    if (!instance.success) throw new NativeError('railway_invalid_response');
    const row = instance.data;
    if (row.environmentId !== environmentId || row.serviceId !== serviceId || row.service.projectId !== projectId
      || workspaceId !== undefined && row.service.project?.workspaceId !== workspaceId) return null;
    if (row.deletedAt !== null || templateCode !== undefined && row.service.templateId !== requireTemplateIdentity(data.template).id) return null;
    return { id: row.serviceId, name: row.serviceName };
  }

  async function readServiceVariable({ projectId, environmentId, serviceId }: ServiceSelection, key: string): Promise<string | null> {
    const data = await graphql(`query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      variablesForServiceDeployment(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId)
    }`, { projectId, environmentId, serviceId });
    const variables = data.variablesForServiceDeployment;
    if (!variables || typeof variables !== 'object' || Array.isArray(variables)) throw new NativeError('railway_invalid_response');
    const value = child(variables, key);
    if (value === undefined) return null;
    if (typeof value !== 'string') throw new NativeError('railway_invalid_response');
    return value;
  }

  /** Credential-free public TCP proxies of one service instance; empty while Public Networking is off. */
  async function listTcpProxies({ environmentId, serviceId }: ServiceSelection) {
    const data = await graphql(`query($serviceId: String!, $environmentId: String!) {
      tcpProxies(serviceId: $serviceId, environmentId: $environmentId) { domain proxyPort applicationPort }
    }`, { serviceId, environmentId });
    const parsed = tcpProxies.safeParse(data.tcpProxies);
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data;
  }

  async function observeServiceAbsent({ projectId, environmentId, serviceId }: ServiceSelection): Promise<boolean> {
    let after: string | null = null;
    do {
      const page = await readEnvironmentServicesPage(projectId, environmentId, after);
      if (page.choices.some(choice => choice.id === serviceId)) return false;
      after = page.nextCursor;
    } while (after !== null);
    return true;
  }

  async function readEnvironmentVolumeAttachments(
    projectId: string,
    { id, volumeInstances }: ProtocolSchemaOutput<typeof volumeEnvironment>,
    includeNames = false,
  ) {
    const attachments: ProtocolSchemaOutput<typeof volumeAttachment>[] = [];
    let instances = volumeInstances;
    const fields = includeNames ? namedVolumeAttachmentFields : volumeAttachmentFields;
    let after: string | null = null;
    for (;;) {
      for (const { node } of instances.edges) {
        if (node.environmentId !== id) throw new NativeError('railway_invalid_response');
        if (node.deletedAt === null || node.isPendingDeletion) attachments.push(node);
      }
      after = readNextCursor(instances.pageInfo, after);
      if (after === null) return attachments;
      const response = await graphql(`query($projectId: String!, $environmentId: String!, $after: String!) {
        environment(id: $environmentId, projectId: $projectId) { id projectId volumeInstances(after: $after) { ${fields} } }
      }`, { projectId, environmentId: id, after });
      const next = volumeEnvironment.safeParse(response.environment);
      if (!next.success || next.data.id !== id || child(response.environment, 'projectId') !== projectId) {
        throw new NativeError('railway_invalid_response');
      }
      instances = next.data.volumeInstances;
    }
  }

  /** Railway lists attachments by environment. Only an attachment of the selected service can nominate a volume. */
  async function readServiceVolume({ projectId, environmentId, serviceId }: ServiceSelection) {
    const environments: ProtocolSchemaOutput<typeof volumeEnvironment>[] = [];
    let after: string | null = null;
    do {
      const { project } = await graphql(`query($projectId: String!, $after: String) {
        project(id: $projectId) { id environments(after: $after) {
          edges { node { id volumeInstances { ${volumeAttachmentFields} } } } pageInfo { hasNextPage endCursor }
        } }
      }`, { projectId, after });
      const parsed = projectVolumeEnvironments.safeParse(project);
      if (!parsed.success || parsed.data.id !== projectId) throw new NativeError('railway_invalid_response');
      for (const { node } of parsed.data.environments.edges) {
        environments.push(node);
      }
      after = readNextCursor(parsed.data.environments.pageInfo, after);
    } while (after !== null);
    if (!environments.some(environment => environment.id === environmentId)) throw new NativeError('railway_invalid_response');
    const attachments = (await Promise.all(environments.map(environment => readEnvironmentVolumeAttachments(projectId, environment)))).flat();

    const selected = attachments.filter(instance => instance.environmentId === environmentId
      && instance.serviceId === serviceId);
    if (!selected.length) return null;
    const [own] = selected;
    if (!own || selected.length !== 1) throw new NativeError('railway_invalid_response');
    const siblings = attachments.filter(instance => instance.volumeId === own.volumeId && instance !== own);
    const otherEnvironments = new Set(siblings.filter(instance => instance.environmentId !== environmentId)
      .map(instance => instance.environmentId));
    if (siblings.some(instance => instance.environmentId === environmentId) && !otherEnvironments.size) {
      throw new NativeError('railway_invalid_response');
    }
    const linkedEnvironment = otherEnvironments.values().next().value ?? environmentId;
    return { id: own.volumeId, otherEnvironments: otherEnvironments.size,
      url: `https://railway.com/project/${encodeURIComponent(projectId)}/volume/${encodeURIComponent(own.volumeId)}?environmentId=${encodeURIComponent(linkedEnvironment)}` };
  }

  async function readScope(selection: ScopeSelection, includeInventory: boolean) {
    const { projectId, environmentId } = selection;
    const templates = includeInventory ? databaseTemplates : '';
    if (environmentId === undefined) {
      const response = await graphql(`query($projectId: String!) {
        project(id: $projectId) { id name } ${templates}
      }`, { projectId });
      if (response.project === null) return null;
      const scope = choice.safeParse(response.project);
      if (!scope.success || scope.data.id !== projectId) throw new NativeError('railway_invalid_response');
      return { scope: scope.data, response };
    }
    const volumes = includeInventory ? `volumeInstances { ${namedVolumeAttachmentFields} }` : '';
    const response = await graphql(`query($projectId: String!, $environmentId: String!) {
      environment(id: $environmentId, projectId: $projectId) { id name projectId ${volumes} } ${templates}
    }`, { projectId, environmentId });
    if (response.environment === null) return null;
    const scope = scopeEnvironment.safeParse(response.environment);
    if (!scope.success || scope.data.id !== environmentId || scope.data.projectId !== projectId) {
      throw new NativeError('railway_invalid_response');
    }
    return { scope: { id: scope.data.id, name: scope.data.name }, response };
  }

  async function readScopeInventory(selection: ScopeSelection): Promise<ScopeInventory | null> {
    const exact = await readScope(selection, true);
    if (!exact) return null;
    const { scope, response } = exact;
    const { projectId, environmentId } = selection;
    const templates = new Set(databaseTemplateCodes.flatMap(code => response[code] == null ? [] : [requireTemplateIdentity(response[code]).id]));
    const [environments, services, volumes] = environmentId === undefined
      ? await Promise.all([
        listPages(after => readProjectPage(projectId, 'environments', after)),
        listPages(after => readProjectPage(projectId, 'services', after, true)),
        listPages(after => readProjectPage(projectId, 'volumes', after)),
      ])
      : await Promise.all([
        [],
        listPages(after => readEnvironmentServicesPage(projectId, environmentId, after, undefined, true)),
        (async () => {
          const initial = volumeEnvironment.safeParse(response.environment);
          if (!initial.success) throw new NativeError('railway_invalid_response');
          const attachments = await readEnvironmentVolumeAttachments(projectId, initial.data, true);
          return attachments.map(({ volume, volumeId }) => {
            if (!volume || volume.id !== volumeId) throw new NativeError('railway_invalid_response');
            return volume;
          });
        })(),
      ]);
    const namedService = ({ id, name }: Choice) => ({ id, name });
    return {
      scope, environments, volumes,
      services: services.map(namedService),
      databases: services.filter(service => service.templateId != null && templates.has(service.templateId)).map(namedService),
    };
  }

  async function deleteScope({ projectId, environmentId }: ScopeSelection): Promise<boolean> {
    if (environmentId === undefined) {
      const result = await graphql('mutation($id: String!) { projectDelete(id: $id) }', { id: projectId });
      return result.projectDelete === true;
    }
    const result = await graphql('mutation($id: String!) { environmentDelete(id: $id) }', { id: environmentId });
    return result.environmentDelete === true;
  }

  async function deleteVolume(volumeId: string): Promise<void> {
    const data = await graphql('mutation($volumeId: String!) { volumeDelete(volumeId: $volumeId) }', { volumeId });
    if (data.volumeDelete !== true) throw new NativeError('railway_volume_delete_unconfirmed');
  }

  async function upsertServiceVariables({ projectId, environmentId, serviceId, variables, skipDeploys }: ServiceVariableUpdate): Promise<void> {
    const data = await graphql(
      'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
      { input: { projectId, environmentId, serviceId, variables, replace: false, skipDeploys } },
    );
    if (data.variableCollectionUpsert === false) throw new NativeError('railway_variable_upsert_unconfirmed');
    if (data.variableCollectionUpsert !== true) throw new NativeError('railway_invalid_response');
  }

  async function deleteServiceInstance({ serviceId, environmentId }: Readonly<{
    serviceId: string;
    environmentId: string;
  }>): Promise<boolean> {
    const { serviceDelete } = await graphql(deleteService, { id: serviceId, environmentId });
    if (typeof serviceDelete !== 'boolean') throw new NativeError('railway_invalid_response');
    return serviceDelete;
  }

  return {
    createProject,
    createEnvironment,
    deleteServiceInstance,
    readScopeInventory,
    deleteScope,
    observeScopeAbsent: async (selection: ScopeSelection) => await readScope(selection, false) === null,
    readServiceVolume,
    deleteVolume,
    listProjects: (workspaceId?: string) => listPages(after => readProjectsPage(after, workspaceId)),
    readProjectsPage,
    readAccountProjectsPage,
    listGrantedWorkspaces,
    readWorkspaceChoices,
    listGrantedProjectWorkspaces,
    listGrantedProjects: async () => (await listGrantedProjectWorkspaces()).flatMap(workspace => workspace.projects),
    listEnvironments: (projectId: string) => listPages(after => readProjectPage(projectId, 'environments', after)),
    listServices: (projectId: string) => listPages(after => readProjectPage(projectId, 'services', after)),
    readEnvironmentsPage: (projectId: string, after: string | null) => readProjectPage(projectId, 'environments', after),
    readEnvironmentServicesPage,
    readServiceInstance,
    readServiceVariable,
    listTcpProxies,
    observeServiceAbsent,
    upsertServiceVariables,
  };
}
