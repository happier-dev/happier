import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import { createRailwayGraphqlClient, NativeError } from './railwayApi.js';

export { ACCOUNT_PURPOSE, RAILWAY_ORIGIN, nativeFetch, createRailwayGraphqlClient,
  NativeError as RailwayNativeError, RAILWAY_API } from './railwayApi.js';

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
const environmentServices = defineProtocolObject({
  id: text, projectId: text, serviceInstances: defineProtocolObject({
    edges: defineProtocolArray(defineProtocolObject({
      node: defineProtocolObject({ serviceId: text, serviceName: text, deletedAt: optionalText }, open),
    }, open)), pageInfo,
  }, open),
}, open);
const grantedProjectWorkspaces = defineProtocolArray(defineProtocolObject({
  id: text, name: text, projects: defineProtocolArray(choice),
}, open));
const connectionFields = 'edges { node { id name } } pageInfo { hasNextPage endCursor }';

type Choice = ProtocolSchemaOutput<typeof choice>;
type Page = Readonly<{ choices: Choice[]; nextCursor: string | null }>;
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

  function listProjects(workspaceId?: string) {
    return listPages(async after => readChoicePage((await graphql(
      `query($workspaceId: String, $after: String) { projects(workspaceId: $workspaceId, after: $after) { ${connectionFields} } }`,
      { workspaceId, after },
    )).projects, after));
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

  async function readEnvironmentServicesPage(projectId: string, environmentId: string, after: string | null) {
    const { environment } = await graphql(`query($projectId: String!, $environmentId: String!, $after: String) {
      environment(id: $environmentId, projectId: $projectId) { id projectId serviceInstances(after: $after) {
        edges { node { serviceId serviceName deletedAt } } pageInfo { hasNextPage endCursor }
      } }
    }`, { projectId, environmentId, after });
    const parsed = environmentServices.safeParse(environment);
    if (!parsed.success || parsed.data.id !== environmentId || parsed.data.projectId !== projectId) {
      throw new NativeError('railway_invalid_response');
    }
    const { edges, pageInfo } = parsed.data.serviceInstances;
    return { choices: edges.flatMap(({ node }) => node.deletedAt === null ? [{ id: node.serviceId, name: node.serviceName }] : []),
      nextCursor: readNextCursor(pageInfo, after) };
  }

  async function upsertServiceVariables({ projectId, environmentId, serviceId, variables, skipDeploys }: ServiceVariableUpdate): Promise<void> {
    const data = await graphql(
      'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }',
      { input: { projectId, environmentId, serviceId, variables, replace: false, skipDeploys } },
    );
    if (data.variableCollectionUpsert === false) throw new NativeError('railway_variable_upsert_unconfirmed');
    if (data.variableCollectionUpsert !== true) throw new NativeError('railway_invalid_response');
  }

  return {
    listProjects,
    listGrantedWorkspaces,
    listGrantedProjectWorkspaces,
    listGrantedProjects: async () => (await listGrantedProjectWorkspaces()).flatMap(workspace => workspace.projects),
    listEnvironments: (projectId: string) => listPages(after => readProjectPage(projectId, 'environments', after)),
    listServices: (projectId: string) => listPages(after => readProjectPage(projectId, 'services', after)),
    readEnvironmentsPage: (projectId: string, after: string | null) => readProjectPage(projectId, 'environments', after),
    readEnvironmentServicesPage,
    upsertServiceVariables,
  };
}
