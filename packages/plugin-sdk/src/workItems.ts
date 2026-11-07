import type { PluginWorkItemsResolveRequestV1, PluginWorkItemsResolveResultV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsFindLinkedResultV1, PluginWorkItemsWatchRequestV1 } from '@happier-dev/protocol/plugins/contributions/workItems';
import { PluginWorkItemTransitionInputV1Schema as canonicalPluginWorkItemTransitionInputV1Schema } from '@happier-dev/protocol/plugins/contributions/workItems';
import type { ProtocolComposableSchema } from './protocol/protocolFacade.js';
import type { PluginAccountActionContext } from './actions/contracts.js';

export type { PluginWorkItemV1, PluginWorkItemCategoryV1, PluginWorkItemsContributionV1, PluginWorkItemsResolveRequestV1, PluginWorkItemsResolveResultV1, PluginWorkItemsFindLinkedRequestV1, PluginWorkItemsFindLinkedResultV1, PluginWorkItemsWatchRequestV1 } from '@happier-dev/protocol/plugins/contributions/workItems';

export type PluginWorkItemTransitionInputV1 = Readonly<{ serverId: string; itemId: string; transitionId: string }>;

/** The host and named transition Action consume Protocol's same closed operands. */
export const PluginWorkItemTransitionInputV1Schema: ProtocolComposableSchema<
  PluginWorkItemTransitionInputV1,
  PluginWorkItemTransitionInputV1
> = canonicalPluginWorkItemTransitionInputV1Schema;

/** Live read callbacks reuse the source's item/link owners; the host stores no mirror. */
export interface PluginWorkItemsRuntime {
  resolve(request: PluginWorkItemsResolveRequestV1, context: PluginAccountActionContext): Promise<PluginWorkItemsResolveResultV1>;
  findLinked?(request: PluginWorkItemsFindLinkedRequestV1, context: PluginAccountActionContext): Promise<PluginWorkItemsFindLinkedResultV1>;
  /** Invalidation only. The host re-reads and owns subscription retirement. */
  watch?(request: PluginWorkItemsWatchRequestV1, onChange: () => void, context: PluginAccountActionContext): () => void;
}
