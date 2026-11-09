import * as React from 'react';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { buildDeploymentNewDefinitionHref, type DeploymentNewDefinitionKind } from '@/components/projects/deployments/deploymentNavigation';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useAccountSettingsScope } from '@/sync/store/settingsWriters';
import { t } from '@/text';

/** Above this many Projects the menu offers search, as the Project field does. */
const SEARCH_FROM = 8;

/**
 * Store → Apps' secondary entries (S60-R09, lab `h:apps`): each picks the Project it will be listed in, then opens that
 * Project's own new-Environment draft on a compose or image definition. Nothing is created here.
 */
export function StoreAppDefinitionEntries(): React.ReactNode {
  const scope = useAccountSettingsScope();
  if (!scope) return null;
  return (
    <>
      <DefinitionEntry scope={scope} kind="compose" testID="store.kind.app.pasteCompose" title={t('capabilities.store.pasteCompose')} />
      <DefinitionEntry scope={scope} kind="image" testID="store.kind.app.runImage" title={t('capabilities.store.runImage')} />
    </>
  );
}

function DefinitionEntry(props: Readonly<{ scope: ServerAccountScope; kind: DeploymentNewDefinitionKind; testID: string; title: string }>) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  // Demand is sticky once opened, so reopening shows the held list instead of a fresh wait.
  const [demanded, setDemanded] = React.useState(false);
  const sources = useProjectSources(props.scope, { enabled: demanded }).state;
  const items = React.useMemo(() => sources.rows.map(row => ({ id: row.id, title: row.name })), [sources.rows]);
  return (
    <DropdownMenu
      testID={`${props.testID}.menu`}
      open={open}
      onOpenChange={next => {
        if (next) setDemanded(true);
        setOpen(next);
      }}
      items={items}
      emptyLabel={sources.status === 'loading' ? t('common.loading') : t('capabilities.store.definitionNoProjects')}
      matchTriggerWidth={false}
      search={items.length >= SEARCH_FROM}
      searchPlaceholder={t('capabilities.store.appPage.projectTitle')}
      onSelect={id => {
        setOpen(false);
        router.push(buildDeploymentNewDefinitionHref({ serverId: props.scope.serverId, projectSourceId: id, kind: props.kind }) as never);
      }}
      trigger={({ toggle }) => (
        <RoundButton testID={props.testID} size="small" display="secondary" title={props.title} onPress={toggle} />
      )}
    />
  );
}
