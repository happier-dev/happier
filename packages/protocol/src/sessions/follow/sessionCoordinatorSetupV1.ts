import { resolveCoordinatorKeepDefault, type AccountSettings, type CoordinatorKeepDefault } from '../../account/settings/accountSettings.js';
import { QualifiedProjectKeyV1Schema, type QualifiedProjectKeyV1 } from '../../workspaces/workspaceRefV1.js';
import { normalizeSessionListFilterV1, type SessionListFilterV1 } from '../listFilter/sessionListFilterV1.js';
import { OpenedSessionFollowRuleV1Schema, type OpenedSessionFollowRuleV1, type SessionFollowActionOutputV1 } from './actions.js';
import { SessionCoordinatorRuleSuggestionV1Schema, type SessionCoordinatorEnableInputV1 } from './sessionCoordinatorActionsV1.js';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '../../json/strictJsonValue.js';

export type SessionCoordinatorCreationDefaultsV1 = Pick<AccountSettings,
  'coordinationCoordinatorRoleId' | 'coordinationCoordinatorKeep' | 'coordinationCoordinatorAnswersWorkerQuestions'
  | 'coordinationCoordinatorSuggestProjectRule' | 'coordinationCoordinatorSuggestHomeRule'>;

export type SessionCoordinatorRuleCensusV1 = Readonly<{
  serverId: string;
  coverage: SessionFollowActionOutputV1['follow.list']['coverage'];
  /** The captured Home's complete admitted private census, not a single receiver's Following page. */
  rules: readonly OpenedSessionFollowRuleV1[];
}>;
export type SessionCoordinatorSetupV1 = Readonly<{
  roleId: string;
  answersWorkerQuestions: boolean;
  keepPreference: CoordinatorKeepDefault;
  keep: SessionCoordinatorEnableInputV1['keep'];
  ruleSuggestions: SessionCoordinatorEnableInputV1['ruleSuggestions'];
  /** A suggestion only. The manager owner still supplies eligibility and the reviewed CAS value. */
  managedBySessionId: string | null;
}>;

function isHomeWide(filter: SessionListFilterV1, serverId: string): boolean {
  if (filter.show === 'runs') return false;
  const origins = new Set(filter.startedBy);
  if (!(origins.size === 1 && origins.has('you'))
    && !(origins.size === 3 && origins.has('you') && origins.has('triggers') && origins.has('agents'))) return false;
  // Compare complete canonical filters so a facet cannot silently broaden into
  // Home-wide when the shared filter owner gains another restriction.
  const baseline = normalizeSessionListFilterV1({ show: filter.show, startedBy: filter.startedBy,
    scope: 'all_accessible', homeServerIds: [serverId] });
  // The canonical matcher ignores empty Project/status selections. Preserve
  // every other field, including future restrictions, in the comparison.
  const effective = { ...filter,
    projects: filter.projects && (filter.projects.include.length > 0 || filter.projects.exclude.length > 0) ? filter.projects : undefined,
    statuses: filter.statuses?.length ? filter.statuses : undefined,
  };
  return sameStrictJsonValue(projectNativeJsonValueForTransport(effective), baseline);
}

function suggestManager(serverId: string, sessionId: string, census?: SessionCoordinatorRuleCensusV1 | null): string | null {
  if (!census || census.serverId.trim() !== serverId || census.coverage !== 'complete') return null;
  const receivers = new Set<string>();
  for (const row of census.rules) {
    const parsed = OpenedSessionFollowRuleV1Schema.safeParse(row);
    // A malformed row means the census is not fully known; do not guess uniqueness.
    if (!parsed.success) return null;
    const rule = parsed.data;
    if (rule.receiver.kind === 'session' && rule.receiver.sessionId !== sessionId
      && rule.definition.enabled === true && isHomeWide(rule.definition.filter, serverId)) receivers.add(rule.receiver.sessionId);
  }
  return receivers.size === 1 ? [...receivers][0]! : null;
}

/** Pure setup suggestions; existing Actions own every eventual mutation. */
export function prepareSessionCoordinatorSetupV1(input: Readonly<{
  serverId: string;
  sessionId: string;
  /** The user's actual selected scope, not an inference from available suggestions. */
  scope: 'project' | 'home';
  project?: QualifiedProjectKeyV1 | null;
  settings: SessionCoordinatorCreationDefaultsV1;
  /** The caller's existing identity owner allocates these exact new-rule identities. */
  ruleIds: Readonly<{ project: string; home: string }>;
  ruleCensus?: SessionCoordinatorRuleCensusV1 | null;
}>): SessionCoordinatorSetupV1 {
  const serverId = input.serverId.trim();
  const project = input.project ? QualifiedProjectKeyV1Schema.parse(input.project) : null;
  if (!serverId || project && project.serverId !== serverId || input.scope === 'project' && !project) {
    throw Object.assign(new Error('invalid_parameters'), { code: 'invalid_parameters' });
  }
  const ruleSuggestions: SessionCoordinatorEnableInputV1['ruleSuggestions'] = [];
  const suggest = (ruleId: string, projectScope: QualifiedProjectKeyV1 | null) => {
    ruleSuggestions.push(SessionCoordinatorRuleSuggestionV1Schema.parse({
      source: { kind: 'rule', ruleId }, expectedVersion: -1,
      ruleDefinition: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({
        show: 'sessions', startedBy: ['you'], scope: 'all_accessible', homeServerIds: [serverId],
        ...(projectScope ? { projects: { include: [projectScope], exclude: [] } } : {}),
      }) },
    }));
  };
  if (project && input.settings.coordinationCoordinatorSuggestProjectRule) suggest(input.ruleIds.project, project);
  if (input.settings.coordinationCoordinatorSuggestHomeRule) suggest(input.ruleIds.home, null);
  return {
    roleId: input.settings.coordinationCoordinatorRoleId,
    answersWorkerQuestions: input.settings.coordinationCoordinatorAnswersWorkerQuestions,
    keepPreference: input.settings.coordinationCoordinatorKeep,
    keep: resolveCoordinatorKeepDefault(input.settings.coordinationCoordinatorKeep),
    ruleSuggestions,
    managedBySessionId: suggestManager(serverId, input.sessionId, input.ruleCensus),
  };
}
