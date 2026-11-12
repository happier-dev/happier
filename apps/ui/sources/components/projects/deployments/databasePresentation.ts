import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';

type Database = NonNullable<NonNullable<DeploymentEnvironmentReadDetailV1['content']['template']>['data']>[number];
const engineNames: Record<Database['engine'], string> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', mongo: 'MongoDB', sqlite: 'SQLite', redis: 'Redis',
};

/** Template and provider-produced database facts share one engine presentation. */
export function databaseEngineTitle(data: Readonly<{ engine: string; version?: string }>): string {
  const names: Readonly<Record<string, string>> = engineNames;
  return `${names[data.engine] ?? data.engine}${data.version ? ` ${data.version}` : ''}`;
}
