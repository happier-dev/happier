import type { EntityDragItemV1, EntityDropAdmissionV1 } from './actions/dtos/pluginActionDtoSupport.generated.js';
import type { JsonValue } from './identity.js';

export type {
  EntityDragItemV1,
  EntityDragScopeV1,
  EntityDragKindV1,
  EntityDropAdmissionV1,
  EntityDropEffectV1,
  EntityDropPreviewV1,
  EntityDropReasonV1,
  EntityDropOutcomeV1,
  PluginUiReadEntityDragItemRequestV1,
  PluginUiUpdateEntityDragDropRequestV1,
  PluginUiUpdateEntityDragDropResultV1,
  PluginUiWatchEntityDragDropRequestV1,
  PluginUiEntityDragDropStateV1,
  PluginUiEntityDropDestinationV1,
} from './actions/dtos/pluginActionDtoSupport.generated.js';

/** Synchronous client presentation; the host owns source identity and retirement. */
export interface PluginDragSourceRuntime {
  describe(reference: JsonValue): Readonly<{ title: string; subtitle?: string }> | null;
}

/** Hover admits an Action request; it cannot execute or grant the Action. */
export interface PluginDropTargetRuntime {
  resolve(context: Readonly<{
    item: EntityDragItemV1;
    destination: JsonValue | null;
    input: 'pointer' | 'keyboard' | 'chooser' | 'action';
    targetInput: JsonValue | null;
  }>): EntityDropAdmissionV1;
}
