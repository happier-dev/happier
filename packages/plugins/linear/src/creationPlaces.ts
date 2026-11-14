import { TriageTaskCreationPlacesInputV1Schema, TriageTaskCreationPlacesResultV1Schema, projectTriageDisplayTextV1, type TriageTaskCreationPlacesResultV1 } from '@happier-dev/triage-protocol/v1';
import type { LinearSourceContext } from './api.js';
import { connection, record, requestLinearGraphql, failureFrom, linearFailure, LINEAR_PAGE_SIZE, LINEAR_PAGE_INFO } from './api.js';
import { linearIncludesTeam } from './contracts.js';
import { admitLinearInstance, listLinearScopeUnits } from './source.js';

export async function listLinearCreationPlaces(raw: unknown, context: LinearSourceContext): Promise<TriageTaskCreationPlacesResultV1> {
  const input = TriageTaskCreationPlacesInputV1Schema.parse(raw);
  try {
    const { account, configuration } = admitLinearInstance(input.instance);
    if (input.scopeId === undefined) {
      const result = await listLinearScopeUnits({ v: 1, draft: { v: 1, binding: input.instance.binding, localInstanceKey: input.instance.localInstanceKey, configuration: input.instance.configuration }, ...(input.query === undefined ? {} : { query: input.query }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, context);
      if (result.kind === 'failed') return result;
      const { units, selection: _selection, ...page } = result;
      return TriageTaskCreationPlacesResultV1Schema.parse({ ...page,
        places: units.map(unit => ({ id: unit.id, label: unit.label, kindId: 'issue', fields: { scopeId: unit.id },
          ...(linearIncludesTeam(configuration, unit.id) ? { childScopeId: unit.id } : { refusal: { reason: 'linear/teamMismatch' } }),
        })) });
    }
    if (!linearIncludesTeam(configuration, input.scopeId)) throw linearFailure('teamMismatch');
    const after = input.cursor?.token;
    const data = await requestLinearGraphql({ context, account, operationName: 'LinearCreationProjects',
      query: `query LinearCreationProjects($id: String!, $after: String, $filter: ProjectFilter) { team(id: $id) { id projects(first: ${LINEAR_PAGE_SIZE}, after: $after, filter: $filter) { nodes { id name } ${LINEAR_PAGE_INFO} } } }`,
      variables: { id: input.scopeId, after, filter: input.query ? { name: { containsIgnoreCase: input.query } } : {} } });
    const team = record(data.team);
    if (team.id !== input.scopeId) throw linearFailure('teamMismatch');
    const page = connection(team.projects);
    if (page.after !== undefined && page.after === after) throw linearFailure('cursorNotAdvancing');
    return TriageTaskCreationPlacesResultV1Schema.parse({ kind: 'page', status: page.after === undefined ? 'complete' : 'partial',
      places: page.nodes.map(raw => { const project = record(raw);
        if (typeof project.id !== 'string' || typeof project.name !== 'string') throw linearFailure('responseInvalid');
        return { id: project.id, label: projectTriageDisplayTextV1(project.name).value || project.id, kindId: 'issue',
          fields: { scopeId: input.scopeId, projectId: project.id } }; }),
      ...(page.after === undefined ? {} : { nextCursor: { v: 1, token: page.after } }),
    });
  } catch (error) { return { kind: 'failed', failure: failureFrom(error, context.signal) }; }
}
