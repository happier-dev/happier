import type { SessionAudienceSelectionV1, SessionListQueryV1 } from '../listing/query.js';
import { normalizeSessionListFilterHomeIds, normalizeSessionListFilterV1, type QualifiedAudienceSelection, type SessionListFilterV1 } from './sessionListFilterV1.js';

function toHomeAudience(audience: QualifiedAudienceSelection): SessionAudienceSelectionV1 {
  if (audience.kind === 'outside_teams') return { kind: 'outside_teams' };
  if (audience.kind === 'team') return { kind: 'team', teamId: audience.teamId };
  return { kind: 'group', teamId: audience.teamId, groupId: audience.groupId };
}

/** Home query membership already proved these structural facets before paging. */
export function projectSessionListFilterAfterHomeQueryV1(filter: SessionListFilterV1, serverId: string,
  proof?: Pick<SessionListQueryV1, 'folderIds'>): SessionListFilterV1 {
  const includedSections = filter.sections?.include.filter(section => section.serverId === serverId).map(section => section.sectionId) ?? [];
  const provenSections = new Set(proof?.folderIds ?? []);
  const sectionIncludeProven = includedSections.length > 0 && provenSections.size === new Set(includedSections).size
    && includedSections.every(id => provenSections.has(id));
  return { ...filter, scope: 'all_accessible', attention: 'any', homeServerIds: filter.homeServerIds.length ? [serverId] : [],
    audiences: [], tagIds: [], underSessionId: undefined, coordinator: undefined,
    ...(sectionIncludeProven ? { sections: { include: [], exclude: filter.sections!.exclude } } : {}) };
}

/** Structural Home queries shared by the session list and authorized rule previews. */
export function projectSessionListFilterHomeQueriesV1(filters: SessionListFilterV1, options: Readonly<{
  storage: SessionListQueryV1['storage']; includeInactive: boolean; mountedHomeServerIds: readonly string[];
  limit?: number; tagFacet?: 'query' | 'local'; sectionFacet?: 'query' | 'local'; projectFacet?: 'query' | 'local'; includeAttention?: boolean;
}>): ReadonlyArray<Readonly<{ serverId: string; query: SessionListQueryV1 }>> {
  const normalized = normalizeSessionListFilterV1(filters);
  const mountedHomeServerIds = new Set(normalizeSessionListFilterHomeIds(options.mountedHomeServerIds));
  const tagFacetLocal = options.tagFacet === 'local';
  const audienceFacetActive = normalized.audiences.length > 0;
  const tagFacetActive = !tagFacetLocal && normalized.tagIds.length > 0;
  const sectionFacetActive = options.sectionFacet !== 'local' && Boolean(normalized.sections?.include.length);
  const projectFacetActive = options.projectFacet === 'query'
    && Boolean(normalized.projects?.include.length || normalized.projects?.exclude.length);
  return normalized.homeServerIds
    .filter(serverId => mountedHomeServerIds.has(serverId))
    // A globally active qualified facet with no value in this Home cannot match.
    .filter(serverId => (!audienceFacetActive || normalized.audiences.some(audience => audience.serverId === serverId))
      && (!tagFacetActive || normalized.tagIds.some(tag => tag.serverId === serverId))
      && (!sectionFacetActive || normalized.sections!.include.some(section => section.serverId === serverId))
      && (!projectFacetActive || !normalized.projects!.include.length
        || normalized.projects!.include.some(project => project.serverId === serverId)))
    .map(serverId => ({ serverId, query: {
      v: 1, storage: options.storage, includeInactive: options.storage === 'archived' ? true : normalized.includeInactive ?? options.includeInactive,
      scope: normalized.scope, attention: normalized.attention,
      ...(normalized.bot === undefined ? {} : { bot: normalized.bot }),
      ...(normalized.coordinator === undefined ? {} : { coordinator: normalized.coordinator }),
      ...(normalized.underSessionId === undefined ? {} : { underSessionId: normalized.underSessionId }),
      audiences: normalized.audiences.filter(audience => audience.serverId === serverId).map(toHomeAudience),
      tagIds: tagFacetLocal ? [] : normalized.tagIds.filter(tag => tag.serverId === serverId).map(tag => tag.tagId),
      ...(sectionFacetActive ? { folderIds: [...new Set(normalized.sections!.include.filter(section => section.serverId === serverId).map(section => section.sectionId))] } : {}),
      ...(projectFacetActive ? { projectKeys: {
        include: normalized.projects!.include.filter(project => project.serverId === serverId).map(project => project.projectKey),
        exclude: normalized.projects!.exclude.filter(project => project.serverId === serverId).map(project => project.projectKey),
      } } : {}),
      // Visible lists promote attention before ordinary paging completes. Exhaustive
      // readers already visit that same structural corpus and can omit the supplement.
      ...(options.storage === 'active' ? { includeAttention: options.includeAttention ?? true } : {}),
      ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    } }));
}
