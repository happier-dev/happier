import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { resolveProviderModelPickerVisibility } from './modelPickerVisibility.js';

import type {
  ProviderConnectionCatalog,
  ProviderConnectionCatalogRow,
  ProviderPickerCatalogProjection,
  ProviderPickerCatalogRow,
  ProviderPickerHiddenSource,
} from './pickerTypesV1.js';

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
  modelPickerVisibilityByConnectionId?: Readonly<Record<string, boolean>>;
  sourceConnectionId?: string;
  defaultSelection?: import('../selection/v1.js').ProviderBoundModelRef;
  favoriteSelections?: readonly import('../selection/v1.js').ProviderBoundModelRef[];
  currentSelection?: Readonly<{
    agentTargetKey: string;
    providerConnectionId: string | null;
    modelId: string;
  }>;
  mode?: 'picker' | 'management';
  /** Account declarations are manageable without asserting machine authorization. */
  observationScope?: 'machine' | 'account';
}>): ProviderPickerCatalogProjection {
  const catalogs = [...input.catalogs].sort((left, right) =>
    compareText(left.providerName, right.providerName)
    || compareText(left.connectionName, right.connectionName)
    || compareText(left.connectionId, right.connectionId));
  const hiddenSources: ProviderPickerHiddenSource[] = [];
  const groups = catalogs.flatMap((catalog) => {
      if (input.sourceConnectionId && input.sourceConnectionId !== catalog.connectionId) return [];
      const sourceShown = resolveProviderModelPickerVisibility({ connectionId: catalog.connectionId,
        kind: catalog.sourceKind, modelPickerVisibilityByConnectionId: input.modelPickerVisibilityByConnectionId }).shown;
      const rows: ProviderPickerCatalogRow[] = [];
      const exception = (row: ProviderConnectionCatalogRow) => sameRef(row.ref, input.currentSelection)
        || sameRef(row.ref, input.defaultSelection) || (input.favoriteSelections?.some(ref => sameRef(row.ref, ref)) ?? false);
      const candidates = [...catalog.rows, ...catalog.staleRows.filter(exception)];
      let withheld = 0;
      for (const row of candidates) {
        const hiddenScope = resolveHiddenScope(row, input.modelVisibilityByRef);
        const hidden = hiddenScope !== null;
        const current = sameRef(row.ref, input.currentSelection);
        const retained = exception(row);
        const compatible = row.presentation.compatibility !== null
          && row.presentation.compatibility.result.status !== 'incompatible';
        if (((input.observationScope !== 'account' && !catalog.authorization.authorized) || !compatible) && !retained) continue;
        if (hidden && !current && input.mode !== 'management') continue;
        if (!sourceShown && input.mode !== 'management' && !input.sourceConnectionId && !retained) {
          withheld += 1;
          continue;
        }
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
      // Source visibility is independent of exception rows retained for current/default/favorite models.
      if (!sourceShown && input.mode !== 'management' && !input.sourceConnectionId
          && (withheld > 0 || rows.length > 0)) {
        hiddenSources.push({ connectionId: catalog.connectionId, providerName: catalog.providerName,
          connectionName: catalog.connectionName, modelCount: withheld });
      }
      if (rows.length === 0) return [];
      return [{
        connectionId: catalog.connectionId,
        providerName: catalog.providerName,
        connectionName: catalog.connectionName,
        authorization: catalog.authorization,
        rows,
      }];
    });
  return { groups, hiddenSources };
}
