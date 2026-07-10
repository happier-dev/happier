import type { SessionWorkStateItemV1, SessionWorkStateTruncationV1 } from './sessionWorkStateV1.js';

export function boundSessionWorkStateItemsV1(params: Readonly<{
  items: readonly SessionWorkStateItemV1[];
  maxItems?: number | null;
}>): Readonly<{
  items: SessionWorkStateItemV1[];
  truncated?: SessionWorkStateTruncationV1;
}> {
  const maxItems = params.maxItems;
  if (typeof maxItems !== 'number' || !Number.isInteger(maxItems) || maxItems < 0 || maxItems >= params.items.length) {
    return {
      items: [...params.items],
    };
  }

  return {
    items: params.items.slice(0, maxItems),
    truncated: {
      reason: 'item_limit',
      omittedCount: params.items.length - maxItems,
    },
  };
}
