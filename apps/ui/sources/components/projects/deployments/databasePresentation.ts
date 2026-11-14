import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import type { DeploymentDatabaseSizeV1 } from '@happier-dev/protocol/deployments/deploymentReadsV1';
import { formatHappierDataBytesParts } from '@happier-dev/plugin-ui/presentation';

import { t } from '@/text';

type Database = NonNullable<NonNullable<DeploymentEnvironmentReadDetailV1['content']['template']>['data']>[number];
const engineNames: Record<Database['engine'], string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', sqlite: 'SQLite', redis: 'Redis',
};

/** Template and provider-produced database facts share one engine presentation. */
export function databaseEngineTitle(data: Readonly<{ engine: string; version?: string }>): string {
  const names: Readonly<Record<string, string>> = engineNames;
  return `${names[data.engine] ?? data.engine}${data.version ? ` ${data.version}` : ''}`;
}

/** The size the owner (DB-SIZE-1113) measured, or why it has none: never a guessed figure. */
export function describeDatabaseSize(size: DeploymentDatabaseSizeV1['size']): string {
  if (size.status === 'available') {
    const parts = formatHappierDataBytesParts(size.bytes, { kind: 'storage' });
    const text = `${parts.value} ${parts.unit}`;
    return size.measurement === 'table_bytes_estimate'
      ? t('projects.deployments.services.sizeAbout', { size: text })
      : text;
  }
  if (size.reason === 'unsupported_engine') return t('projects.deployments.services.sizeUnsupported');
  if (size.reason === 'active_deployment_required') return t('projects.deployments.services.sizeAfterDeploy');
  return t('projects.deployments.services.sizeUnavailable');
}
