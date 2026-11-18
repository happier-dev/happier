import { t } from '@/text';
import { admitPluginListFilterFieldV1, type AdmittedPluginListFilterFieldV1 } from '@happier-dev/plugin-sdk/ui';
import { resolvePluginLocalizedStringV2Text } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';

export type DeploymentEnvironmentBuiltinColumn = Readonly<{
  key: 'lastDeploy' | 'runsOn' | 'state';
  title: string;
  subtitle?: string;
  description: string;
  minWidth: number;
  priority: number;
  align?: 'end';
  listColumn: true;
}>;

export type DeploymentEnvironmentResourceColumn = Readonly<{
  key: string;
  title: string;
  description: string;
  source: string;
  minWidth?: number;
  maxWidth?: number;
  priority?: number;
  align?: 'start' | 'end';
  defaultHidden?: boolean;
  listColumn: true;
  pluginId: string;
  field: AdmittedPluginListFilterFieldV1;
}>;
export type DeploymentEnvironmentColumn = DeploymentEnvironmentBuiltinColumn | DeploymentEnvironmentResourceColumn;

/**
 * An Environment row's columns, as the rows draw them and the Columns menu names them: one declaration, so the menu
 * and the table never disagree. A Machine's own page leaves out the Machine they all run on.
 */
export function deploymentEnvironmentColumns(hereMachine: boolean, projection?: PluginUiProjectionModel | null,
  localize: PluginLocalizedTextResolver = (_pluginId, value) => resolvePluginLocalizedStringV2Text(value)):
  readonly DeploymentEnvironmentColumn[] {
  const pluginColumns = Object.values(projection?.listExtensionsById ?? {}).flatMap(extension => extension.listExtension.entity !== 'service' ? []
    : (extension.listExtension.filterFields ?? []).flatMap(field => {
      const admitted = admitPluginListFilterFieldV1({ pluginId: extension.pluginId, field, factKeys: NO_FACT_KEYS });
      if (admitted.kind !== 'admitted' || !admitted.field.declaration.column) return [];
      const { column } = admitted.field.declaration;
      const subtitle = column.qualifier === undefined ? undefined : localize(extension.pluginId, column.qualifier);
      return [{ key: admitted.field.id, title: localize(extension.pluginId, column.title ?? field.title),
        ...(subtitle === undefined ? {} : { subtitle }),
        description: subtitle ?? localize(extension.pluginId, field.title),
        source: projection?.installedPackagesById[extension.pluginId]?.displayName ?? extension.pluginId,
        ...(column.width === undefined ? {} : { minWidth: column.width, maxWidth: column.width }),
        ...(column.align === undefined ? {} : { align: column.align }),
        ...(column.priority === undefined ? {} : { priority: column.priority }),
        ...(column.defaultHidden === undefined ? {} : { defaultHidden: column.defaultHidden }),
        listColumn: true as const, pluginId: extension.pluginId, field: admitted.field }];
    }));
  return [
    // "469b2bb · 10m ago": the version and its age whole at a desktop width (lab envRow "ver · age").
    { key: 'lastDeploy', title: t('projects.deployments.services.columnLastDeploy'),
      description: t('projects.deployments.services.columnLastDeployDescription'), minWidth: 152, priority: 4, listColumn: true },
    ...(hereMachine ? [] : [{ key: 'runsOn' as const, title: t('projects.deployments.services.columnRunsOn'),
      description: t('projects.deployments.services.columnRunsOnDescription'), minWidth: 184, priority: 3, listColumn: true as const }]),
    ...pluginColumns,
    { key: 'state', title: t('projects.deployments.services.columnState'),
      description: t('projects.deployments.services.columnStateDescription'), minWidth: 136, priority: 5, align: 'end', listColumn: true },
  ];
}

const NO_FACT_KEYS: ReadonlySet<string> = new Set();
