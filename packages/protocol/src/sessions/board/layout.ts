import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { SessionBoardTabIdSchema, SessionSurfaceItemIdSchema } from './ids.js';
import { WidgetSessionBoardWidthV1Schema } from '../../widgets/widgetPresentationV1.js';

export const SessionBoardItemWidthSchema = WidgetSessionBoardWidthV1Schema;
export const SessionBoardItemFrameStyleSchema = lazyZodSchema(() => z.enum(['card', 'plain']));
export const SessionBoardLayoutV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  tabs: z.array(z.object({
    id: SessionBoardTabIdSchema,
    title: z.string().trim(),
    items: z.array(z.object({
      itemId: SessionSurfaceItemIdSchema,
      width: SessionBoardItemWidthSchema,
      frameStyle: SessionBoardItemFrameStyleSchema.optional(),
    }).strict()),
  }).strict()),
}).strict().superRefine((layout, context) => {
  const tabs = new Set<string>();
  layout.tabs.forEach((tab, tabIndex) => {
    if (tabs.has(tab.id)) context.addIssue({ code: 'custom', path: ['tabs', tabIndex, 'id'], message: 'Duplicate Board view identity' });
    tabs.add(tab.id);
    const items = new Set<string>();
    tab.items.forEach((item, itemIndex) => {
      if (items.has(item.itemId)) context.addIssue({ code: 'custom', path: ['tabs', tabIndex, 'items', itemIndex, 'itemId'], message: 'Duplicate placement in Board view' });
      items.add(item.itemId);
    });
  });
}));
export type SessionBoardItemWidth = z.infer<typeof SessionBoardItemWidthSchema>;
/** Persisted layout normalizes additive fields; mutations still use the closed schema. */
export const SessionBoardLayoutV1StoredSchema = createStoredReadSchema(SessionBoardLayoutV1Schema);
export type SessionBoardItemFrameStyle = z.infer<typeof SessionBoardItemFrameStyleSchema>;
export type SessionBoardLayoutV1 = Readonly<{
  v: 1;
  tabs: readonly Readonly<{
    id: z.infer<typeof SessionBoardTabIdSchema>;
    title: string;
    items: readonly Readonly<{
      itemId: z.infer<typeof SessionSurfaceItemIdSchema>;
      width: SessionBoardItemWidth;
      frameStyle?: SessionBoardItemFrameStyle;
    }>[];
  }>[];
}>;
