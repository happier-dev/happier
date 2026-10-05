import { z } from 'zod';
import { SessionBoardTabIdSchema } from '../sessions/board/ids.js';

export const WidgetWidthV1Schema = z.enum(['half', 'compact', 'medium', 'wide', 'full']);
export const WidgetFrameStyleV1Schema = z.enum(['card', 'plain']);
/** Ephemeral native-owner facts used to refuse removal after a captured placement changes. */
export const WidgetExpectedPresentationV1Schema = z.object({
  width: WidgetWidthV1Schema.optional(), frameStyle: WidgetFrameStyleV1Schema.nullable(),
  nativeIndex: z.number().int().nonnegative().safe(), tabId: SessionBoardTabIdSchema.optional(), hidden: z.boolean().optional(),
  /** WorkBoard's existing saved XY, captured only for conditional transfer removal. */
  canvasPosition: z.tuple([z.number().finite(), z.number().finite()]).nullable().optional(),
}).strict();
export type WidgetExpectedPresentationV1 = z.infer<typeof WidgetExpectedPresentationV1Schema>;
