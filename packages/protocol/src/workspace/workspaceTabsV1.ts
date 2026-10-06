import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

const id = z.string().min(1);

/** V1 portable tab-set epoch: identity and persisted envelopes are closed.
 * Destination params stay an opaque string map owned by the destination catalog.
 * Unknown kinds survive to render the host's unavailable state.
 */
export const WorkspaceTabsV1Schema = z.object({
    v: z.literal(1),
    tabsById: z.record(id, z.object({
        id,
        target: z.object({ kind: id, params: z.record(z.string(), z.string()) }).strict(),
        pinned: z.boolean(),
    }).strict()),
    order: z.array(id),
    pairs: z.array(z.array(id).min(2)),
}).strict().superRefine((value, context) => {
    const liveIds = Object.keys(value.tabsById);
    for (const key of liveIds) {
        if (value.tabsById[key].id !== key) context.addIssue({ code: 'custom', path: ['tabsById', key, 'id'], message: 'Tab identity must match its record key' });
    }
    const ordered = new Set(value.order);
    if (ordered.size !== value.order.length || ordered.size !== liveIds.length || liveIds.some((key) => !ordered.has(key))) {
        context.addIssue({ code: 'custom', path: ['order'], message: 'Order must contain every live tab exactly once' });
    }
    const paired = new Set<string>();
    value.pairs.forEach((pair, pairIndex) => {
        pair.forEach((tabId, tabIndex) => {
            if (!Object.hasOwn(value.tabsById, tabId) || paired.has(tabId)) {
                context.addIssue({ code: 'custom', path: ['pairs', pairIndex, tabIndex], message: 'Split members must be live and belong to only one pair' });
            }
            paired.add(tabId);
        });
    });
});

export type WorkspaceTabsV1 = z.infer<typeof WorkspaceTabsV1Schema>;
export const WorkspaceTabsV1StoredSchema = createStoredReadSchema(WorkspaceTabsV1Schema);
