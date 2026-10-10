import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { SessionBoardTabIdSchema } from '../sessions/board/ids.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';

export const WidgetWidthV1Schema = lazyZodSchema(() => z.enum(['half', 'compact', 'medium', 'wide', 'full']));
export type WidgetWidthV1 = z.infer<typeof WidgetWidthV1Schema>;
export const WIDGET_SIZE_ORDER_V1 = ['small', 'medium', 'wide', 'full', 'tall', 'large'] as const;
export const WidgetSizeV1Schema = lazyZodSchema(() => z.enum(WIDGET_SIZE_ORDER_V1));
export type WidgetSizeV1 = z.infer<typeof WidgetSizeV1Schema>;
export const WidgetGroupWidthV1Schema = lazyZodSchema(() => z.enum(['half', 'full']));
export type WidgetGroupWidthV1 = z.infer<typeof WidgetGroupWidthV1Schema>;
/** Group hosting follows the shared layout corridor, not Board/Companion layouts. */
export function supportsWidgetGroupsV1(kind: WidgetSurfaceRefV1['owner']['kind']): boolean {
  return kind === 'home' || kind === 'project' || kind === 'pluginArea' || kind === 'corePage';
}
export const WidgetGridSizeV1Schema = WidgetSizeV1Schema;
export const WidgetSessionBoardSizeV1Schema = WidgetSizeV1Schema;
export const WidgetSizeDeclarationV1Schema = lazyZodSchema(() => z.object({
  sizes: z.array(WidgetSizeV1Schema).min(1), defaultSize: WidgetSizeV1Schema,
}).strict().superRefine((declaration, context) => {
  if (new Set(declaration.sizes).size !== declaration.sizes.length) context.addIssue({ code: 'custom', path: ['sizes'], message: 'Duplicate widget size' });
  if (!declaration.sizes.includes(declaration.defaultSize)) context.addIssue({ code: 'custom', path: ['defaultSize'], message: 'Default widget size must be declared' });
}));
export type WidgetSizeDeclarationV1 = z.infer<typeof WidgetSizeDeclarationV1Schema>;
export const WidgetSizeFootprintV1Schema = lazyZodSchema(() => z.object({
  columns: z.number().int().positive(), columnSpan: z.number().int().positive(), rowSpan: z.number().int().positive(),
  height: z.enum(['compact', 'regular', 'tall']), width: WidgetWidthV1Schema,
}).strict());
export type WidgetSizeFootprintV1 = Readonly<z.infer<typeof WidgetSizeFootprintV1Schema>>;
const gridFootprints = {
  small: { columns: 2, columnSpan: 1, rowSpan: 1, height: 'compact', width: 'half' },
  medium: { columns: 2, columnSpan: 1, rowSpan: 2, height: 'regular', width: 'half' },
  wide: { columns: 2, columnSpan: 2, rowSpan: 1, height: 'compact', width: 'full' },
  full: { columns: 2, columnSpan: 2, rowSpan: 2, height: 'regular', width: 'full' },
  tall: { columns: 2, columnSpan: 1, rowSpan: 4, height: 'tall', width: 'half' },
  large: { columns: 2, columnSpan: 2, rowSpan: 4, height: 'tall', width: 'full' },
} as const satisfies Record<WidgetSizeV1, WidgetSizeFootprintV1>;
/** Group columns use the portable A3 grid, including content-height hosts. */
export function resolveWidgetGroupWidthFitV1(children: readonly Readonly<{ instance: Readonly<{ id: string }>; size?: WidgetSizeV1 }>[]) {
  const widths = (['half', 'full'] as const).map(width => {
    const columns = width === 'half' ? 1 : 2;
    const blocker = children.find(child => gridFootprints[child.size ?? 'medium'].columnSpan > columns);
    return { width, available: !blocker, ...(blocker ? { blockingChildId: blocker.instance.id } : {}) };
  });
  return { widths, availableWidths: widths.filter(choice => choice.available).map(choice => choice.width) };
}
const boardFootprints = {
  small: { columns: 12, columnSpan: 4, rowSpan: 1, height: 'compact', width: 'compact' },
  medium: { columns: 12, columnSpan: 6, rowSpan: 2, height: 'regular', width: 'medium' },
  wide: { columns: 12, columnSpan: 8, rowSpan: 1, height: 'compact', width: 'wide' },
  full: { columns: 12, columnSpan: 12, rowSpan: 2, height: 'regular', width: 'full' },
  tall: { columns: 12, columnSpan: 6, rowSpan: 4, height: 'tall', width: 'medium' },
  large: { columns: 12, columnSpan: 12, rowSpan: 4, height: 'tall', width: 'full' },
} as const satisfies Record<WidgetSizeV1, WidgetSizeFootprintV1>;
/** Native Board width remains its layout field, derived from the portable footprints. */
export const WidgetSessionBoardWidthV1Schema = lazyZodSchema(() => z.enum([
  boardFootprints.small.width, boardFootprints.medium.width, boardFootprints.wide.width, boardFootprints.full.width,
]));
const gridPolicy = { sizes: WIDGET_SIZE_ORDER_V1, defaultSize: 'medium', footprints: gridFootprints } as const;
const linearPolicy = { sizes: [], defaultSize: undefined, footprints: {} } as const;
/** Semantic footprints only. Native layout owners keep pixels, measurement and responsive reflow. */
export const WIDGET_SIZE_POLICY_V1 = {
  home: gridPolicy, workBoard: gridPolicy, pluginArea: gridPolicy, corePage: gridPolicy,
  sessionBoard: { sizes: WIDGET_SIZE_ORDER_V1, defaultSize: 'medium', footprints: boardFootprints },
  project: linearPolicy, companion: linearPolicy,
} as const;
export const WidgetSurfacePresentationV1Schema = lazyZodSchema(() => z.object({
  sizes: z.array(WidgetSizeV1Schema), defaultSize: WidgetSizeV1Schema.optional(),
}).strict());
export type WidgetSurfacePresentationV1 = z.infer<typeof WidgetSurfacePresentationV1Schema>;
export function getWidgetSupportedSizesV1(kind: WidgetSurfaceRefV1['owner']['kind']): readonly WidgetSizeV1[] {
  return WIDGET_SIZE_POLICY_V1[kind].sizes;
}
export function getWidgetSizeFootprintV1(kind: WidgetSurfaceRefV1['owner']['kind'], size: WidgetSizeV1): WidgetSizeFootprintV1 | undefined {
  const footprints: Partial<Record<WidgetSizeV1, WidgetSizeFootprintV1>> = WIDGET_SIZE_POLICY_V1[kind].footprints;
  return footprints[size];
}
/** One ordered definition∩surface projection used by agents, controls and rendering. */
export function resolveWidgetSizeChoicesV1(kind: WidgetSurfaceRefV1['owner']['kind'], declaration?: WidgetSizeDeclarationV1): WidgetSurfacePresentationV1 {
  const supported = getWidgetSupportedSizesV1(kind);
  const sizes = WIDGET_SIZE_ORDER_V1.filter(size => supported.includes(size) && (!declaration || declaration.sizes.includes(size)));
  const preferred = declaration?.defaultSize ?? WIDGET_SIZE_POLICY_V1[kind].defaultSize;
  const defaultSize = preferred && sizes.includes(preferred) ? preferred : sizes[0];
  return { sizes, ...(defaultSize ? { defaultSize } : {}) };
}
export function normalizeWidgetSizeForSurfaceV1(kind: WidgetSurfaceRefV1['owner']['kind'], size?: WidgetSizeV1, declaration?: WidgetSizeDeclarationV1): WidgetSizeV1 | undefined {
  const choices = resolveWidgetSizeChoicesV1(kind, declaration);
  return size && choices.sizes.includes(size) ? size : choices.defaultSize;
}
export function stepWidgetSizeV1(sizes: readonly WidgetSizeV1[], current: WidgetSizeV1 | undefined, step: -1 | 1): WidgetSizeV1 | undefined {
  const ordered = WIDGET_SIZE_ORDER_V1.filter(size => sizes.includes(size));
  if (!ordered.length) return undefined;
  const index = current ? ordered.indexOf(current) : -1;
  return ordered[Math.max(0, Math.min(ordered.length - 1, index < 0 ? 0 : index + step))];
}
/** Board item height stays authoritative, including the existing Auto fallback. */
export function resolveSessionBoardWidgetSizeV1(width: 'compact' | 'medium' | 'wide' | 'full', height: Readonly<{ mode: 'auto'; fallback: 'compact' | 'regular' | 'tall' }> | Readonly<{ mode: 'fixed'; size: 'compact' | 'regular' | 'tall' }>): WidgetSizeV1 | undefined {
  const heightSize = height.mode === 'auto' ? height.fallback : height.size;
  return WIDGET_SIZE_ORDER_V1.find(size => boardFootprints[size].width === width && boardFootprints[size].height === heightSize);
}
/** Existing Board height edits remain visible even when their rectangle has no named variant. */
export function getSessionBoardWidgetFootprintV1(width: 'compact' | 'medium' | 'wide' | 'full', height: Parameters<typeof resolveSessionBoardWidgetSizeV1>[1]): WidgetSizeFootprintV1 {
  const heightSize = height.mode === 'auto' ? height.fallback : height.size;
  const widthFootprint = Object.values(boardFootprints).find(footprint => footprint.width === width)!;
  const heightFootprint = Object.values(boardFootprints).find(footprint => footprint.height === heightSize)!;
  return { ...widthFootprint, height: heightSize, rowSpan: heightFootprint.rowSpan };
}
export const WidgetFrameStyleV1Schema = lazyZodSchema(() => z.enum(['card', 'plain']));
export const WidgetProjectAreaV1Schema = lazyZodSchema(() => z.enum(['main', 'aside']));
export type WidgetProjectAreaV1 = z.infer<typeof WidgetProjectAreaV1Schema>;
/** Ephemeral native-owner facts used to refuse removal after a captured placement changes. */
export const WidgetExpectedPresentationV1Schema = lazyZodSchema(() => z.object({
  area: WidgetProjectAreaV1Schema.optional(),
  groupId: z.string().trim().min(1).nullable().optional(),
  size: WidgetSizeV1Schema.optional(), frameStyle: WidgetFrameStyleV1Schema.nullable(),
  nativeIndex: z.number().int().nonnegative().safe(), tabId: SessionBoardTabIdSchema.optional(), hidden: z.boolean().optional(),
  /** WorkBoard's existing saved XY, captured only for conditional transfer removal. */
  canvasPosition: z.tuple([z.number().finite(), z.number().finite()]).nullable().optional(),
}).strict());
export type WidgetExpectedPresentationV1 = z.infer<typeof WidgetExpectedPresentationV1Schema>;
