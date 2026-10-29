import { WIDGET_INSTANCE_ACTION_IDS_V1 } from './instanceIdsV1.js';
export { WIDGET_INSTANCE_ACTION_IDS_V1 } from './instanceIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
export type WidgetInstanceActionIdV1 = typeof WIDGET_INSTANCE_ACTION_IDS_V1[number];
export const WidgetInstanceActionIdV1Schema = lazyZodSchema(() => z.enum(WIDGET_INSTANCE_ACTION_IDS_V1));
