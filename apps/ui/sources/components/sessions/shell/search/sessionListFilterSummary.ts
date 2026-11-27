import type { SessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildQualifiedTagAddressKey } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import {
  listSessionPresentationStatesForWorkStatusFilterV1,
  SESSION_WORK_STATUS_FILTERS_V1,
} from '@happier-dev/protocol/sessions/awareness/presentationV1';

import { t } from '@/text';

import {
  buildSessionListFilterEditorLabels,
  buildSessionListConditionLabels,
  readSessionListScopeLabel,
} from './SessionListFilterControl';
import {
  readSessionListFilterStatusLabel,
  type SessionListFilterProjectOption,
} from './sessionListFilterEditorModel';

/**
 * A stored filter in words, using the editor's own facet names ("Project: payments · Failed"), for a place that
 * shows the selection without the editor (a rule row in Following). Facets left at their defaults say nothing;
 * a project this Home no longer lists keeps its key so the line never hides a narrowing.
 */
export function describeSessionListFilterFacts(
  filter: SessionListFilterV1,
  projects: readonly SessionListFilterProjectOption[],
): readonly string[] {
  const labels = buildSessionListFilterEditorLabels();
  const projectName = (
    project: Readonly<{ serverId: string; projectKey: string }>,
  ) =>
    projects.find(
      (candidate) =>
        candidate.projectKey === project.projectKey &&
        candidate.serverId === project.serverId,
    )?.label ?? project.projectKey;
  const facts: string[] = [];
  if (filter.scope !== 'all_accessible')
    facts.push(readSessionListScopeLabel(filter.scope));
  const starters = (
    [
      ['you', labels.startedByYou],
      ['triggers', labels.startedByTriggers],
      ['agents', labels.startedByAgents],
    ] as const
  ).filter(([starter]) => filter.startedBy.includes(starter));
  if (starters.length < 3)
    facts.push(
      `${labels.startedBy}: ${starters.map(([, label]) => label).join(', ')}`,
    );
  if (filter.projects?.include.length)
    facts.push(
      `${labels.project}: ${filter.projects.include.map(projectName).join(', ')}`,
    );
  if (filter.projects?.exclude.length)
    facts.push(
      t('sessionsList.filtersProjectNot', {
        names: filter.projects.exclude.map(projectName).join(', '),
      }),
    );
  const conditions = buildSessionListConditionLabels();
  for (const [operator, values] of [['is', filter.statuses?.include], ['is_not', filter.statuses?.exclude]] as const) {
    const statuses = new Set(values ?? []);
    const statusChoices = SESSION_WORK_STATUS_FILTERS_V1.filter((choice) =>
      listSessionPresentationStatesForWorkStatusFilterV1(choice).every(state => statuses.has(state)));
    if (statusChoices.length > 0) {
      const names = statusChoices.map(choice => readSessionListFilterStatusLabel(choice, labels)).join(', ');
      facts.push(operator === 'is' ? names : `${labels.status} ${conditions.operators[operator]} ${names}`);
    }
  }
  if (filter.attention === 'needs_my_attention') facts.push(labels.needsMeOnly);
  if (filter.coordinator === 'coordinator') facts.push(labels.onlyCoordinators);
  for (const [operator, values] of [['is', filter.tagIds.include], ['is_not', filter.tagIds.exclude]] as const) {
    if (values.length) facts.push(`${labels.tags}${operator === 'is_not' ? ` ${conditions.operators[operator]}` : ''}: ${new Set(values.map(buildQualifiedTagAddressKey)).size}`);
  }
  return facts;
}
