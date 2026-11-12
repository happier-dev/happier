import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildDeploymentNewDefinitionHref, type DeploymentNewDefinitionKind } from '@/components/projects/deployments/deploymentNavigation';
import { DEPLOYMENT_NEW_PROJECT_CHOICE_ID } from '@/components/projects/deployments/DeploymentProjectChoice';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { t } from '@/text';

/** Above this many Projects the menu offers search, as the Project field does. */
const SEARCH_FROM = 8;

/**
 * Store → Apps' secondary entries (S60-R09, lab `h:apps`): each picks the Project it will be listed in, then opens that
 * Project's own new-Environment draft on a compose or image definition. Nothing is created here.
 */
export function StoreAppDefinitionEntries(): React.ReactNode {
  // The same active Account scope the Project list reads, so the menu and its rows always agree.
  const scope = useActiveServerAccountScopeLifetime()?.scope ?? null;
  return scope ? <StoreAppDefinitionEntriesFor scope={scope} /> : null;
}

/** The entries for one Account scope; `onNavigate` lets a host that sits over the page (New app) step aside first. */
export function StoreAppDefinitionEntriesFor({ scope, onNavigate }: Readonly<{ scope: ServerAccountScope; onNavigate?: () => void }>): React.ReactNode {
  return (
    <>
      <DefinitionEntry scope={scope} kind="compose" testID="store.kind.app.pasteCompose" title={t('capabilities.store.pasteCompose')} onNavigate={onNavigate} />
      <DefinitionEntry scope={scope} kind="image" testID="store.kind.app.runImage" title={t('capabilities.store.runImage')} onNavigate={onNavigate} />
    </>
  );
}

function DefinitionEntry(props: Readonly<{ scope: ServerAccountScope; kind: DeploymentNewDefinitionKind; testID: string; title: string; onNavigate?: () => void }>) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // Demand is sticky once opened, so reopening shows the held list instead of a fresh wait.
  const [demanded, setDemanded] = React.useState(false);
  const { state: sources, controller } = useProjectSources(props.scope, { enabled: demanded });
  const items = React.useMemo(() => [
    ...(sources.status === 'ready' ? [{ id: DEPLOYMENT_NEW_PROJECT_CHOICE_ID, title: t('capabilities.store.appPage.projectNew') }] : []),
    ...sources.rows.map(row => ({ id: row.id, title: row.name })),
  ], [sources.rows, sources.status]);
  // The catalog owner's state, not "no Projects": an unread or refused list says what it is and what to do.
  const emptyLabel = sources.status === 'offline'
    ? <SurfaceStateCard testID={`${props.testID}.offline`} size="line" kind="unavailable"
        title={t('projects.sources.offline', { home: resolveHomeDisplayLabel(getServerProfileById(props.scope.serverId), props.scope.serverId) })}
        action={{ label: t('common.retry'), onPress: () => { void controller.load(); } }} />
    : sources.status === 'refused'
      ? <SurfaceStateCard testID={`${props.testID}.refused`} size="line" kind="unavailable"
          title={t('capabilities.store.definitionProjectsRefused')} diagnosticCode={sources.issue} />
      : sources.status === 'ready' ? t('capabilities.store.definitionNoProjects') : t('common.loading');
  return (
    <DropdownMenu
      testID={`${props.testID}.menu`}
      open={open}
      onOpenChange={next => {
        if (next) setDemanded(true);
        setOpen(next);
      }}
      items={items}
      emptyLabel={emptyLabel}
      matchTriggerWidth={false}
      search={items.length >= SEARCH_FROM}
      searchPlaceholder={t('capabilities.store.appPage.projectTitle')}
      onSelect={id => {
        setOpen(false);
        props.onNavigate?.();
        router.push(buildDeploymentNewDefinitionHref({ serverId: props.scope.serverId, ...(id === DEPLOYMENT_NEW_PROJECT_CHOICE_ID ? {} : { projectSourceId: id }), kind: props.kind }) as never);
      }}
      trigger={({ toggle }) => (
        <RoundButton testID={props.testID} size="small" display="secondary" title={props.title} onPress={toggle} />
      )}
    />
  );
}
