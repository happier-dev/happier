import {
  defineProtocolArray,
  defineProtocolLiteral,
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
const optionalText = defineProtocolUnion([text, defineProtocolLiteral(null)]);
const pageInfo = defineProtocolObject({ endCursor: optionalText, hasNextPage: boolean }, open);
const connection = defineProtocolObject({
  edges: defineProtocolArray(defineProtocolObject({ node: choice }, open)),
  pageInfo,
}, open);
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
const grantedProjectWorkspaces = defineProtocolArray(defineProtocolObject({
  id: text, name: text, projects: defineProtocolArray(choice),
}, open));
const connectionFields = 'edges { node { id name } } pageInfo { hasNextPage endCursor }';

const deleteService = `mutation DeleteServiceInstance($id: String!, $environmentId: String!) {
  serviceDelete(id: $id, environmentId: $environmentId)
}`;

type Choice = ProtocolSchemaOutput<typeof choice>;
type Page = Readonly<{ choices: Choice[]; nextCursor: string | null }>;
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

function readChoicePage(value: unknown, after: string | null): Page {
  const parsed = connection.safeParse(value);
  if (!parsed.success) throw new NativeError('railway_invalid_response');
  return { choices: parsed.data.edges.map(edge => edge.node), nextCursor: readNextCursor(parsed.data.pageInfo, after) };
}

/** On-demand project inventory and non-replacing variable updates for Railway consumers. */
export function createRailwayProjectOperations(request: typeof fetch, signal?: AbortSignal) {
  const graphql = createRailwayGraphqlClient(request, signal);

  async function listPages(readPage: (after: string | null) => Promise<Page>): Promise<Choice[]> {
    const choices: Choice[] = [];
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
    const parsed = defineProtocolArray(choice).safeParse(child(data.me, 'workspaces'));
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data;
  }

  async function listGrantedProjectWorkspaces() {
    const data = await graphql('query { externalWorkspaces { id name projects { id name } } }', {});
    const parsed = grantedProjectWorkspaces.safeParse(data.externalWorkspaces);
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data;
  }

  async function readProjectPage(projectId: string, field: 'environments' | 'services', after: string | null): Promise<Page> {
    const data = await graphql(
      `query($projectId: String!, $after: String) { project(id: $projectId) { ${field}(after: $after) { ${connectionFields} } } }`,
      { projectId, after },
    );
    return readChoicePage(child(data.project, field), after);
  }

  async function readEnvironmentServicesPage(projectId: string, environmentId: string, after: string | null, templateCode?: string) {
    const templateInput = templateCode === undefined ? '' : ', $templateCode: String!';
    const templateQuery = templateCode === undefined ? '' : 'template(code: $templateCode) { id }';
    const provenance = templateCode === undefined ? '' : 'service { templateId }';
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
      return [{ id: node.serviceId, name: node.serviceName }];
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

  async function observeServiceAbsent({ projectId, environmentId, serviceId }: ServiceSelection): Promise<boolean> {
    let after: string | null = null;
    do {
      const page = await readEnvironmentServicesPage(projectId, environmentId, after);
      if (page.choices.some(choice => choice.id === serviceId)) return false;
      after = page.nextCursor;
    } while (after !== null);
    return true;
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
    deleteServiceInstance,
    listProjects: (workspaceId?: string) => listPages(after => readProjectsPage(after, workspaceId)),
    readProjectsPage,
    listGrantedWorkspaces,
    listGrantedProjectWorkspaces,
    listGrantedProjects: async () => (await listGrantedProjectWorkspaces()).flatMap(workspace => workspace.projects),
    listEnvironments: (projectId: string) => listPages(after => readProjectPage(projectId, 'environments', after)),
    listServices: (projectId: string) => listPages(after => readProjectPage(projectId, 'services', after)),
    readEnvironmentsPage: (projectId: string, after: string | null) => readProjectPage(projectId, 'environments', after),
    readEnvironmentServicesPage,
    readServiceInstance,
    readServiceVariable,
    observeServiceAbsent,
    upsertServiceVariables,
  };
}
