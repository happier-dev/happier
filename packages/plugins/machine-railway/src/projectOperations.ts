import {
  defineProtocolArray,
  defineProtocolLiteral,
  defineProtocolObject,
  defineProtocolString,
  defineProtocolUnion,
  type ProtocolSchemaOutput,
} from '@happier-dev/plugin-sdk/protocol';
import { createRailwayGraphqlClient, NativeError } from './railwayApi.js';

export { nativeFetch } from './account.js';
export { createRailwayGraphqlClient, NativeError as RailwayNativeError, RAILWAY_API } from './railwayApi.js';

const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const boolean = defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]);
const choice = defineProtocolObject({ id: text, name: text }, open);
const connection = defineProtocolObject({
  edges: defineProtocolArray(defineProtocolObject({ node: choice }, open)),
  pageInfo: defineProtocolObject({
    endCursor: defineProtocolUnion([text, defineProtocolLiteral(null)]),
    hasNextPage: boolean,
  }, open),
}, open);
const grantedWorkspaces = defineProtocolArray(defineProtocolObject({ projects: defineProtocolArray(choice) }, open));
const connectionFields = 'edges { node { id name } } pageInfo { hasNextPage endCursor }';

type Choice = ProtocolSchemaOutput<typeof choice>;
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

/** On-demand project inventory and non-replacing variable updates for Railway consumers. */
export function createRailwayProjectOperations(request: typeof fetch, signal?: AbortSignal) {
  const graphql = createRailwayGraphqlClient(request, signal);

  async function listPages(readPage: (after: string | null) => Promise<unknown>): Promise<Choice[]> {
    const choices: Choice[] = [];
    let after: string | null = null;
    for (;;) {
      const parsed = connection.safeParse(await readPage(after));
      if (!parsed.success) throw new NativeError('railway_invalid_response');
      for (const { node } of parsed.data.edges) choices.push(node);
      const { hasNextPage, endCursor } = parsed.data.pageInfo;
      if (!hasNextPage) return choices;
      if (endCursor === null || endCursor === after) throw new NativeError('railway_invalid_response');
      after = endCursor;
    }
  }

  function listProjects(workspaceId?: string) {
    return listPages(async after => (await graphql(
      `query($workspaceId: String, $after: String) { projects(workspaceId: $workspaceId, after: $after) { ${connectionFields} } }`,
      { workspaceId, after },
    )).projects);
  }

  async function listGrantedProjects(): Promise<Choice[]> {
    const data = await graphql('query { externalWorkspaces { projects { id name } } }', {});
    const parsed = grantedWorkspaces.safeParse(data.externalWorkspaces);
    if (!parsed.success) throw new NativeError('railway_invalid_response');
    return parsed.data.flatMap(workspace => workspace.projects);
  }

  function listProjectChoices(projectId: string, field: 'environments' | 'services') {
    return listPages(async after => {
      const data = await graphql(
        `query($projectId: String!, $after: String) { project(id: $projectId) { ${field}(after: $after) { ${connectionFields} } } }`,
        { projectId, after },
      );
      return child(data.project, field);
    });
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
    listGrantedProjects,
    listEnvironments: (projectId: string) => listProjectChoices(projectId, 'environments'),
    listServices: (projectId: string) => listProjectChoices(projectId, 'services'),
    upsertServiceVariables,
  };
}
