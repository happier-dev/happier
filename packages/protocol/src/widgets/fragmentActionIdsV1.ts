import { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1 } from './fragmentIdsV1.js';
export { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1 } from './fragmentIdsV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
export const WidgetLayoutFragmentActionIdV1Schema = lazyZodSchema(() => z.enum(WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1));
export type WidgetLayoutFragmentActionIdV1 = z.infer<typeof WidgetLayoutFragmentActionIdV1Schema>;
