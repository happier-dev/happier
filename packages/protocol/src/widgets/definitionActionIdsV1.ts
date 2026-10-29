import { WIDGET_DEFINITION_ACTION_IDS_V1 } from './definitionIdsV1.js';
export { WIDGET_DEFINITION_ACTION_IDS_V1 } from './definitionIdsV1.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
export const WidgetDefinitionActionIdV1Schema = lazyZodSchema(() => z.enum(WIDGET_DEFINITION_ACTION_IDS_V1));
export type WidgetDefinitionActionIdV1 = z.infer<typeof WidgetDefinitionActionIdV1Schema>;
