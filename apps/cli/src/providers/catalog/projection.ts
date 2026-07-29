import { serializeModelVisibilityRefV1 } from '@happier-dev/protocol';

import type {
  ProviderConnectionCatalog,
  ProviderConnectionCatalogRow,
  ProviderPickerCatalogProjection,
  ProviderPickerCatalogRow,
} from './types';

function compareText(left: string, right: string): number {
  const leftFolded = left.toLowerCase();
  const rightFolded = right.toLowerCase();
  if (leftFolded !== rightFolded) return leftFolded < rightFolded ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameRef(
  left: ProviderConnectionCatalogRow['ref'],
  right: Readonly<{ agentTargetKey: string; providerConnectionId: string | null; modelId: string }> | undefined,
): boolean {
  return right !== undefined
    && left.agentTargetKey === right.agentTargetKey
    && left.providerConnectionId === right.providerConnectionId
    && left.modelId === right.modelId;
}

function resolveHiddenScope(
  row: ProviderConnectionCatalogRow,
  visibility: Readonly<Record<string, 'hidden'>>,
): 'agent' | 'allAgents' | null {
  const agentKey = serializeModelVisibilityRefV1({
    scope: 'agent',
    agentTargetKey: row.ref.agentTargetKey,
    providerConnectionId: row.ref.providerConnectionId,
    modelId: row.ref.modelId,
  });
  const allAgentsKey = serializeModelVisibilityRefV1({
    scope: 'allAgents',
    providerConnectionId: row.ref.providerConnectionId,
    modelId: row.ref.modelId,
  });
  if (Object.prototype.hasOwnProperty.call(visibility, allAgentsKey)) return 'allAgents';
  if (Object.prototype.hasOwnProperty.call(visibility, agentKey)) return 'agent';
  return null;
}

export function projectProviderCatalogForPicker(input: Readonly<{
  catalogs: readonly ProviderConnectionCatalog[];
  modelVisibilityByRef: Readonly<Record<string, 'hidden'>>;
  currentSelection?: Readonly<{
    agentTargetKey: string;
    providerConnectionId: string | null;
    modelId: string;
  }>;
  mode?: 'picker' | 'management';
}>): ProviderPickerCatalogProjection {
  const catalogs = [...input.catalogs].sort((left, right) =>
    compareText(left.providerName, right.providerName)
    || compareText(left.connectionName, right.connectionName)
    || compareText(left.connectionId, right.connectionId));
  return {
    groups: catalogs.flatMap((catalog) => {
      const rows: ProviderPickerCatalogRow[] = [];
      const currentStaleRow = catalog.staleRows.find((row) => sameRef(row.ref, input.currentSelection));
      const candidates = currentStaleRow ? [...catalog.rows, currentStaleRow] : catalog.rows;
      for (const row of candidates) {
        const hiddenScope = resolveHiddenScope(row, input.modelVisibilityByRef);
        const hidden = hiddenScope !== null;
        const current = sameRef(row.ref, input.currentSelection);
        const compatible = row.presentation.compatibility !== null
          && row.presentation.compatibility.result.status !== 'incompatible';
        if ((!catalog.authorization.authorized || !compatible) && !current) continue;
        if (hidden && !current && input.mode !== 'management') continue;
        rows.push({
          ...row,
          visibility: hidden
            ? current && input.mode !== 'management'
              ? 'hidden_current_selection'
              : hiddenScope === 'allAgents'
                ? 'hidden_all_agents'
                : 'hidden_agent'
            : 'visible',
        });
      }
      if (rows.length === 0) return [];
      return [{
        connectionId: catalog.connectionId,
        providerName: catalog.providerName,
        connectionName: catalog.connectionName,
        authorization: catalog.authorization,
        rows,
      }];
    }),
  };
}
