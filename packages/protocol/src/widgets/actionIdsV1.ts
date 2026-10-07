import { z } from 'zod';

export const WIDGET_INSTANCE_ACTION_IDS_V1 = [
  'widgets.catalog.list', 'widgets.instance.list', 'widgets.instance.add', 'widgets.instance.remove',
  'widgets.instance.move', 'widgets.instance.rename', 'widgets.instance.size.set', 'widgets.instance.frame.set',
  'widgets.instance.inputs.get', 'widgets.instance.inputs.validate', 'widgets.instance.inputs.set',
  'widgets.instance.inputs.reset', 'widgets.instance.refresh',
  'widgets.area.layout.get', 'widgets.area.layout.update',
] as const;
export type WidgetInstanceActionIdV1 = typeof WIDGET_INSTANCE_ACTION_IDS_V1[number];
export const WidgetInstanceActionIdV1Schema = z.enum(WIDGET_INSTANCE_ACTION_IDS_V1);
