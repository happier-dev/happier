import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

/** A current sibling anchor; null names the start/end of the current list. */
export const AnchoredListPositionV1Schema = lazyZodSchema(() => z.object({
  anchorId: z.string().trim().min(1).nullable(),
  placement: z.enum(['before', 'after']),
}).strict());
export type AnchoredListPositionV1 = Readonly<z.infer<typeof AnchoredListPositionV1Schema>>;

/** Never fabricates membership. Domain owners supply their current eligible order. */
export function resolveAnchoredListMoveV1(
  ids: readonly string[], itemId: string, position: AnchoredListPositionV1,
): string[] | null {
  if (!ids.includes(itemId) || (position.anchorId !== null && !ids.includes(position.anchorId))) return null;
  if (position.anchorId === itemId) return [...ids];
  const others = ids.filter(id => id !== itemId);
  const index = position.anchorId === null
    ? (position.placement === 'before' ? 0 : others.length)
    : others.indexOf(position.anchorId) + (position.placement === 'after' ? 1 : 0);
  return [...others.slice(0, index), itemId, ...others.slice(index)];
}
