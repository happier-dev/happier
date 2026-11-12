import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';
import { requestOpenExternalUrl } from '@/utils/url/requestOpenExternalUrl';

import { databaseEngineTitle } from './databasePresentation';

/** One presentation of the template's data and linked data targets, without inventing connection or health facts. */
export function DeploymentDataCard(props: Readonly<{
  scope: Readonly<{ serverId: string; accountId: string }>;
  detail: DeploymentEnvironmentReadDetailV1;
  onAdd: () => void;
  onBackups: () => void;
  /** Where the template's database runs (its Machine), named after its service; null when not known. */
  place?: string | null;
  /** Opens one database's page in place: the template's data service, or a linked data target's id. */
  onOpen?: (database: string) => void;
}>) {
  const databases = props.detail.content.template?.data;
  const hasData = (databases?.length ?? 0) > 0;
  const targets = props.detail.targetLinks.filter(link => link.targetLink.role === 'data');
  const id = 'project-deployments.environment.data';
  return (
    <ItemGroup testID={id} title={t('projects.deployments.dataTitle')}
      description={t('projects.deployments.overviewStatus.dataDescription')}
      // An empty card's one next action is its empty state's; a filled card adds from the header.
      action={hasData || targets.length > 0 ? <SectionActionButton testID={`${id}.add`} title={t('projects.deployments.dataAdd')}
        destination onPress={props.onAdd} /> : undefined}>
      {databases?.map(data => <Item key={data.service} title={databaseEngineTitle(data)}
        subtitle={[data.port === undefined ? data.service
          : t('projects.deployments.dataService', { service: data.service, port: data.port }),
          ...(props.place ? [props.place] : [])].join(' · ')}
        {...(props.onOpen ? { testID: `${id}.database.${data.service}`, onPress: () => props.onOpen?.(data.service) } : { mode: 'info' as const })} />)}
      {targets.map(link => {
        const providerConsole = link.content.data?.providerConsole;
        return <React.Fragment key={link.targetLink.id}>
          <Item title={link.content.data ? databaseEngineTitle(link.content.data) : link.targetLink.targetKind}
            {...(props.onOpen ? { testID: `${id}.database.${link.targetLink.id}`, onPress: () => props.onOpen?.(link.targetLink.id) } : { mode: 'info' as const })} />
          {providerConsole ? <Item testID={`${id}.providerConsole.${link.targetLink.id}`} title={providerConsole.label}
            onPress={() => requestOpenExternalUrl(providerConsole.url, { serverId: props.scope.serverId, expectedAccountId: props.scope.accountId })} /> : null}
        </React.Fragment>;
      })}
      {!hasData && targets.length === 0 ? <SurfaceStateCard testID={`${id}.empty`} size="line" kind="empty"
        title={t('projects.deployments.dataEmptyShort')}
        action={{ label: t('projects.deployments.dataAdd'), onPress: props.onAdd }} /> : null}
      {hasData && props.detail.content.backup ? <Item testID={`${id}.backups`}
        title={t('projects.deployments.dataBackups')} onPress={props.onBackups} /> : null}
    </ItemGroup>
  );
}
