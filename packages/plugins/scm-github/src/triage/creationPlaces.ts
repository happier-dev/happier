import { TriageSourceCredentialInputsV1, TriageTaskCreationPlacesResultV1Schema, type TriageTaskCreationPlacesResultV1 } from '@happier-dev/triage-protocol/v1';
import { listGithubTriageScopeUnits, openGithubTriageClient, resolveGithubTriageInstance } from './operations.js';
import { createGithubRepositoryReader } from './repositories.js';
import { parseGithubRoutingToken } from './locator.js';
import { toTriageFailure } from './mapping/protocol.js';
import type { GithubTriageInvocationContext } from './invocation.js';
import { projectGithubRepositoryWriteAvailability } from './capabilities.js';

export async function listGithubCreationPlaces(raw: unknown, context: GithubTriageInvocationContext): Promise<TriageTaskCreationPlacesResultV1> {
  const input = TriageSourceCredentialInputsV1.listCreationPlaces.parse(raw);
  const resolved = resolveGithubTriageInstance(input.instance);
  if (!resolved.ok) return { kind: 'failed', failure: resolved.failure };
  const selection = resolved.configuration.selection;
  const included = (id: string) => selection.kind === 'all' || selection.unitIds.includes(id);
  if (input.scopeId === undefined) {
    const result = await listGithubTriageScopeUnits({ v: 1,
      draft: { v: 1, binding: input.instance.binding, configuration: input.instance.configuration, localInstanceKey: input.instance.localInstanceKey },
      ...(input.query === undefined ? {} : { query: input.query }), ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, context);
    if (result.kind === 'failed') return result;
    const { units, selection: _selection, ...page } = result;
    return TriageTaskCreationPlacesResultV1Schema.parse({ ...page,
      places: units.map(unit => ({ id: unit.id, label: unit.label, kindId: 'issue', fields: { scopeId: unit.id },
        ...(included(unit.id) ? { childScopeId: unit.id } : { refusal: { reason: 'github_repository_not_included', message: 'Not part of this connection' } }),
      })) });
  }
  const route = parseGithubRoutingToken(input.scopeId);
  if (route === null || !included(input.scopeId)) return { kind: 'failed', failure: { class: 'unsupportedContract', code: 'github_repository_not_included' } };
  const opened = await openGithubTriageClient(input.instance, context);
  if (!opened.ok) return { kind: 'failed', failure: opened.failure };
  const repository = await createGithubRepositoryReader({ client: opened.client, now: () => context.invokedAtMs }).read(route);
  if (repository.kind === 'unreadable') return { kind: 'failed', failure: toTriageFailure(repository.failure) };
  const availability = projectGithubRepositoryWriteAvailability(repository, 'issue');
  return TriageTaskCreationPlacesResultV1Schema.parse({ kind: 'page', status: 'complete', places: [{
    id: input.scopeId, label: repository.repositoryKey ?? input.scopeId, kindId: 'issue', fields: { scopeId: input.scopeId },
    ...(availability.kind === 'available' ? {} : { refusal: { reason: availability.code,
      message: availability.code === 'repository_archived' ? 'This repository is archived' : 'Issues are turned off for this repository' } }),
  }] });
}
