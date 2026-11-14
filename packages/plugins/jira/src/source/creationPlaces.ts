import { TriageTaskCreationPlacesInputV1Schema, TriageTaskCreationPlacesResultV1Schema, projectTriageDisplayTextV1, type TriageTaskCreationPlacesResultV1 } from '@happier-dev/triage-protocol/v1';
import { jiraFailure, numericId, string, invalidJira, type JiraSourceContext } from '../api.js';
import { listJiraScopeUnits, openJiraInstance } from './operations.js';
import { jiraProjectIncluded } from './configurationContract.js';
import { readJiraConfiguration } from './model.js';
import { readJiraCreateDirectoryPage } from './metadata.js';

export async function listJiraCreationPlaces(raw: unknown, context: JiraSourceContext): Promise<TriageTaskCreationPlacesResultV1> {
  const input = TriageTaskCreationPlacesInputV1Schema.parse(raw);
  try {
    const configuration = readJiraConfiguration(input.instance.configuration.token);
    if (input.scopeId === undefined) {
      const result = await listJiraScopeUnits({ v: 1, draft: { v: 1, binding: input.instance.binding, localInstanceKey: input.instance.localInstanceKey, configuration: input.instance.configuration }, ...(input.query === undefined ? {} : { query: input.query }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, context);
      if (result.kind === 'failed') return result;
      const { units, selection: _selection, ...page } = result;
      return TriageTaskCreationPlacesResultV1Schema.parse({ ...page,
        places: units.map(unit => ({ id: unit.id, label: unit.label, kindId: 'issue', fields: {},
          ...(jiraProjectIncluded(configuration, unit.id)
            ? { childScopeId: unit.id, ...(configuration.projectId === unit.id && configuration.issueTypeId !== undefined
              ? { placeId: `${unit.id}/${configuration.issueTypeId}` }
              : { refusal: { reason: 'jira/issueTypeRequired' } }) }
            : { refusal: { reason: 'jira/projectMismatch' } }),
        })) });
    }
    if (!numericId(input.scopeId) || !jiraProjectIncluded(configuration, input.scopeId)) throw invalidJira('jira/projectMismatch');
    const startAt = input.cursor === undefined ? 0 : numericId(input.cursor.token) ? Number(input.cursor.token) : NaN;
    if (!Number.isSafeInteger(startAt)) throw invalidJira('jira/createMetadataPageInvalid');
    const { client } = await openJiraInstance(input.instance, context);
    const page = await readJiraCreateDirectoryPage(client, `/rest/api/3/issue/createmeta/${input.scopeId}/issuetypes`, 'issueTypes', startAt);
    const places = page.rows.map(type => {
      if (!numericId(type.id) || !string(type.name)) throw invalidJira('jira/issueTypeInvalid');
      return { id: `${input.scopeId}/${type.id}`, placeId: `${input.scopeId}/${type.id}`, label: projectTriageDisplayTextV1(String(type.name)).value || String(type.id),
        kindId: 'issue', fields: {} };
    });
    return TriageTaskCreationPlacesResultV1Schema.parse({ kind: 'page', status: page.nextStartAt === undefined ? 'complete' : 'partial', places,
      ...(page.nextStartAt === undefined ? {} : { nextCursor: { v: 1, token: String(page.nextStartAt) } }),
    });
  } catch (error) { return { kind: 'failed', failure: jiraFailure(error) }; }
}
