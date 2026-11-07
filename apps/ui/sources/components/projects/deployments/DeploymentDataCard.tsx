import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';

type Database = NonNullable<NonNullable<DeploymentEnvironmentReadDetailV1['content']['template']>['data']>;
const engineNames: Record<Database['engine'], string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', sqlite: 'SQLite', redis: 'Redis',
};

/** One presentation of the template's data and linked data targets, without inventing connection or health facts. */
export function DeploymentDataCard(props: Readonly<{
  detail: DeploymentEnvironmentReadDetailV1;
  onAdd: () => void;
  onVariables: () => void;
  onBackups: () => void;
}>) {
  const data = props.detail.content.template?.data;
  const targets = props.detail.targetLinks.filter(link => link.targetLink.role === 'data');
  const id = 'project-deployments.environment.data';
  return (
    <ItemGroup testID={id} title={t('projects.deployments.dataTitle')}
      description={t('projects.deployments.dataConnectionGuide')}
      action={<SectionActionButton testID={`${id}.add`} title={t('projects.deployments.dataAdd')}
        destination onPress={props.onAdd} />}>
      {data ? <Item title={`${engineNames[data.engine]}${data.version ? ` ${data.version}` : ''}`}
        subtitle={data.port === undefined ? data.service
          : t('projects.deployments.dataService', { service: data.service, port: data.port })} mode="info" /> : null}
      {targets.map(link => <Item key={link.targetLink.id} title={link.targetLink.targetKind} mode="info" />)}
      {!data && targets.length === 0 ? <Item title={t('projects.deployments.dataEmpty')} mode="info" /> : null}
      <Item testID={`${id}.variables`} title={t('projects.deployments.dataVariables')} onPress={props.onVariables} />
      {data && props.detail.content.backup ? <Item testID={`${id}.backups`}
        title={t('projects.deployments.dataBackups')} onPress={props.onBackups} /> : null}
    </ItemGroup>
  );
}
