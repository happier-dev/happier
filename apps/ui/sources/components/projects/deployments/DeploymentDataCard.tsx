import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

type Database = NonNullable<NonNullable<DeploymentEnvironmentReadDetailV1['content']['template']>['data']>;
export const engineNames: Record<Database['engine'], string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', sqlite: 'SQLite', redis: 'Redis',
};

/** One presentation of the template's data and linked data targets, without inventing connection or health facts. */
export function DeploymentDataCard(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  onAdd: () => void;
  onVariables: () => void;
  onBackups: () => void;
  /** Opens one database's page in place: the template's data service, or a linked data target's id. */
  onOpen?: (database: string) => void;
}>) {
  const data = props.detail.content.template?.data;
  const targets = props.detail.targetLinks.filter(link => link.targetLink.role === 'data');
  const id = 'project-deployments.environment.data';
  return (
    <ItemGroup testID={id} title={t('projects.deployments.dataTitle')}
      description={t('projects.deployments.dataConnectionGuide')}
      // An empty card's one next action is its empty state's; a filled card adds from the header.
      action={data || targets.length > 0 ? <SectionActionButton testID={`${id}.add`} title={t('projects.deployments.dataAdd')}
        destination onPress={props.onAdd} /> : undefined}>
      {data ? <Item title={`${engineNames[data.engine]}${data.version ? ` ${data.version}` : ''}`}
        subtitle={data.port === undefined ? data.service
          : t('projects.deployments.dataService', { service: data.service, port: data.port })}
        {...(props.onOpen ? { testID: `${id}.database.${data.service}`, onPress: () => props.onOpen?.(data.service) } : { mode: 'info' as const })} /> : null}
      {targets.map(link => <Item key={link.targetLink.id} title={link.targetLink.targetKind}
        {...(props.onOpen ? { testID: `${id}.database.${link.targetLink.id}`, onPress: () => props.onOpen?.(link.targetLink.id) } : { mode: 'info' as const })} />)}
      {!data && targets.length === 0 ? <SurfaceStateCard testID={`${id}.empty`} size="line" kind="empty"
        title={t('projects.deployments.dataEmptyShort')}
        action={{ label: t('projects.deployments.dataAdd'), onPress: props.onAdd }} /> : null}
      <Item testID={`${id}.variables`} title={t('projects.deployments.dataVariables')} onPress={props.onVariables} />
      {data && props.detail.content.backup ? <Item testID={`${id}.backups`}
        title={t('projects.deployments.dataBackups')} onPress={props.onBackups} /> : null}
    </ItemGroup>
  );
}
