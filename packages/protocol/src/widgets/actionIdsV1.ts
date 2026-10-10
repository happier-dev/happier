import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

export const WIDGET_INSTANCE_ACTION_IDS_V1 = [
  'widgets.catalog.list', 'widgets.item.list', 'widgets.item.add', 'widgets.item.remove',
  'widgets.item.move', 'widgets.item.rename', 'widgets.item.size.set', 'widgets.item.frame.set',
  'widgets.item.inputs.get', 'widgets.item.inputs.validate', 'widgets.item.inputs.set',
  'widgets.item.inputs.reset', 'widgets.item.refresh',
  'widgets.group.create', 'widgets.group.add', 'widgets.group.ungroup', 'widgets.group.set', 'widgets.group.inputs.set',
  'widgets.area.layout.select',
  'widgets.area.layout.reset', 'widgets.area.layout.undo',
  'widgets.area.layout.list', 'widgets.area.layout.create', 'widgets.area.layout.rename',
  'widgets.area.layout.delete', 'widgets.area.layout.reorder',
] as const;
export type WidgetInstanceActionIdV1 = typeof WIDGET_INSTANCE_ACTION_IDS_V1[number];
export const WidgetInstanceActionIdV1Schema = lazyZodSchema(() => z.enum(WIDGET_INSTANCE_ACTION_IDS_V1));
