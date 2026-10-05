import { z } from 'zod';
export const WIDGET_DEFINITION_ACTION_IDS_V1 = [
    'widgets.definition.list', 'widgets.definition.get', 'widgets.definition.create',
    'widgets.definition.update', 'widgets.definition.duplicate', 'widgets.definition.delete',
    'widgets.definition.saveFromSession',
] as const;
export const WidgetDefinitionActionIdV1Schema = z.enum(WIDGET_DEFINITION_ACTION_IDS_V1);
export type WidgetDefinitionActionIdV1 = z.infer<typeof WidgetDefinitionActionIdV1Schema>;
