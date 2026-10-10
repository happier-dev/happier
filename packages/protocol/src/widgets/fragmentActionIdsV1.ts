import { z } from 'zod';
import { lazyZodSchema } from '../lazyZodSchema.js';

export const WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1 = [
    'widgets.fragment.list', 'widgets.fragment.get', 'widgets.fragment.create',
    'widgets.fragment.update', 'widgets.fragment.duplicate', 'widgets.fragment.delete',
] as const;
export const WidgetLayoutFragmentActionIdV1Schema = lazyZodSchema(() => z.enum(WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1));
export type WidgetLayoutFragmentActionIdV1 = z.infer<typeof WidgetLayoutFragmentActionIdV1Schema>;
