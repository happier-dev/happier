import { joinHappierFacts, resolveHappierRoleRunsAsPresentation } from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import type { RoleRunsAsV1 } from '@happier-dev/protocol';
import type { RoleCatalogEntry } from '@/sync/domains/roles/roleCatalog';
import { t } from '@/text';
import { useRoleEnginePresentation } from './useRoleEnginePresentation';

export function describeRoleRunsAs(kind: RoleRunsAsV1['kind']) {
  return resolveHappierRoleRunsAsPresentation(kind, {
    session: t('roles.settings.runsAsSession'), background_run: t('roles.settings.runsAsBackgroundRun'),
  }).label;
}

export function describeRoleSource(entry: Pick<RoleCatalogEntry, 'source' | 'pluginDisplayName'>): string {
  switch (entry.source) {
    case 'built_in': return t('roles.settings.sourceBuiltIn');
    case 'user': return t('roles.settings.sourceYours');
    case 'shared': return t('roles.settings.sourceShared');
    case 'plugin': return entry.pluginDisplayName
      ? t('roles.settings.sourcePlugin', { plugin: entry.pluginDisplayName }) : t('roles.settings.groupPlugins');
  }
}

export function describeRoleFacts(engineLabel: string | null, runsAs: RoleRunsAsV1['kind']): string {
  return joinHappierFacts(engineLabel, describeRoleRunsAs(runsAs));
}

/**
 * A role row's one line (lab `settings-R`): its engine, then how it runs. An engine this Account has
 * not enabled says "choose an engine" after its name; the Orchestrator runs as the session it is
 * turned on in, so it says "this session" instead of a runs-as it cannot change.
 */
export function describeRoleRowFacts(
  entry: Pick<RoleCatalogEntry, 'roleId'> & Readonly<{ role: Pick<RoleCatalogEntry['role'], 'engine' | 'runsAs'> }>,
  engine: Readonly<{ label: string | null; unavailable: boolean }>,
): string {
  const engineLabel = engine.unavailable && entry.role.engine
    ? joinHappierFacts(engine.label, t('roles.rail.chooseEngine')) : engine.label;
  return entry.roleId === 'orchestrator'
    ? joinHappierFacts(engineLabel, t('roles.session.thisSession'))
    : describeRoleFacts(engineLabel, entry.role.runsAs.kind);
}

export function useDescribeRoleRow(): (entry: RoleCatalogEntry) => string {
  const presentEngine = useRoleEnginePresentation();
  return React.useCallback((entry) => describeRoleRowFacts(entry, presentEngine(entry.role.engine)), [presentEngine]);
}
