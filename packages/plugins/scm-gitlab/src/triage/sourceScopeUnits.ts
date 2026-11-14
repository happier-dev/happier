import type { PluginAccountActionContext } from '@happier-dev/plugin-sdk/actions';
import { pluginJsonValuesEqual } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageSourceConnectedAccountInputsV1, TriageListScopeUnitsResultV1Schema, TriageSourceScopeUnitV1Schema,
  decodeTriagePagingTokenV1, encodeTriagePagingTokenV1, type TriageListScopeUnitsResultV1,
} from '@happier-dev/triage-protocol/v1';
import { decodeGitlabConfiguration } from './configuration.js';
import { resolveGitlabConfiguredInstance, authorizeGitlabConfiguredInstance } from './configuredInstance.js';
import { buildGitlabProjectCollisionScope } from './identity.js';
import { createGitlabHttpFetcher, readGitlabConnectedAccounts } from './invocation.js';
import { buildGitlabApiUrl, requestGitlabJson, GITLAB_REST_MAX_PAGE_SIZE } from './http/gitlabClient.js';
import { selectGitlabNextPageUrl } from './http/gitlabLink.js';
import { projectGitlabSourceFailure } from './sourceFailure.js';
import { boundGitlabText } from './mapping/bounded.js';

export async function listGitlabScopeUnitsAction(input: unknown, context: PluginAccountActionContext): Promise<TriageListScopeUnitsResultV1> {
  const parsed = TriageSourceConnectedAccountInputsV1.listScopeUnits.safeParse(input);
  const invalid = { kind: 'failed', failure: { class: 'unsupportedContract', code: 'gitlab_scope_directory_input_invalid' } } as const;
  if (!parsed.success) return invalid;
  const { draft, mode, cursor } = parsed.data;
  const resolved = resolveGitlabConfiguredInstance(draft);
  if (resolved.kind === 'failed') return { kind: 'failed', failure: projectGitlabSourceFailure(resolved.failure) };
  const configuration = decodeGitlabConfiguration(draft.configuration);
  if (configuration === null) return invalid;
  const { selection, units = [] } = configuration;
  if (mode === 'configured') return { kind: 'page', status: 'complete', selection,
    units: selection.kind === 'all' ? [] : selection.unitIds.map((id) => ({
      ...(units.find((unit) => unit.id === id) ?? { id, label: id }),
      collisionScope: buildGitlabProjectCollisionScope(resolved.origin, id),
    })) };
  const query = parsed.data.query?.trim() ?? '';
  const first = new URL(buildGitlabApiUrl(resolved.origin, '/projects', [
    ['per_page', String(GITLAB_REST_MAX_PAGE_SIZE)], ...(query === '' ? [] : [['search', query] as const]),
  ]));
  const admits = (candidate: unknown): candidate is string => {
    if (typeof candidate !== 'string') return false;
    try {
      const url = new URL(candidate);
      if (url.origin !== first.origin || url.pathname !== first.pathname || url.username !== '' || url.password !== '' || url.hash !== ''
        || !/^[1-9][0-9]*$/u.test(url.searchParams.get('page') ?? '')) return false;
      url.searchParams.delete('page'); url.searchParams.sort();
      const expected = new URL(first); expected.searchParams.sort();
      return url.search === expected.search;
    } catch { return false; }
  };
  let url = first.toString();
  if (cursor !== undefined) {
    const retained = decodeTriagePagingTokenV1(cursor.token);
    if (retained === null || retained.v !== 1 || retained.query !== query || retained.localInstanceKey !== draft.localInstanceKey
      || !pluginJsonValuesEqual(retained.binding, draft.binding) || !admits(retained.url)) return invalid;
    url = retained.url;
  }
  const authorized = await authorizeGitlabConfiguredInstance({ instance: draft,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    connectedAccounts: readGitlabConnectedAccounts(context), signal: context.signal });
  if (authorized.kind === 'failed') return { kind: 'failed', failure: projectGitlabSourceFailure(authorized.failure) };
  const result = await requestGitlabJson({ invocation: authorized.resolved.invocation, url,
    fetcher: createGitlabHttpFetcher(context), signal: context.signal, nowMs: Date.now() });
  if (result.kind === 'failed') return { kind: 'failed', failure: projectGitlabSourceFailure(result.failure) };
  if (!Array.isArray(result.response.body)) return invalid;
  const listed = result.response.body.flatMap((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
    const row = value as Readonly<Record<string, unknown>>;
    if (typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id < 1) return [];
    const id = String(row.id);
    const label = typeof row.path_with_namespace === 'string' ? boundGitlabText(row.path_with_namespace).text : '';
    const name = typeof row.name === 'string' ? boundGitlabText(row.name).text : '';
    const unit = TriageSourceScopeUnitV1Schema.safeParse({ id, label,
      ...(name !== '' && name !== label ? { secondaryText: name } : {}),
      collisionScope: buildGitlabProjectCollisionScope(resolved.origin, id) });
    return unit.success ? [unit.data] : [];
  });
  const next = selectGitlabNextPageUrl(result.response.headers, resolved.origin.normalized);
  const nextToken = next.kind === 'next' && next.url !== url && admits(next.url) ? encodeTriagePagingTokenV1({
    v: 1, binding: draft.binding, localInstanceKey: draft.localInstanceKey, query, url: next.url,
  }) : null;
  const incomplete = listed.length !== result.response.body.length || next.kind !== 'end';
  return TriageListScopeUnitsResultV1Schema.parse(incomplete
    ? { kind: 'page', status: 'partial', selection, units: listed, ...(nextToken === null ? {} : { nextCursor: { v: 1, token: nextToken } }) }
    : { kind: 'page', status: 'complete', selection, units: listed });
}
