import { z } from '../zodRuntimePolicy.js';
import { WidgetDefinitionAccountV1Schema } from './definitionActionsV1.js';
import { WidgetLayoutFragmentDraftV1Schema, WidgetLayoutFragmentPatchV1Schema, WidgetLayoutFragmentV1Schema } from './widgetLayoutFragmentV1.js';
import { WidgetLayoutFragmentSummaryV1Schema, type WidgetLayoutFragmentArtifactPortV1 } from './widgetLayoutFragmentArtifactV1.js';
export { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1, WidgetLayoutFragmentActionIdV1Schema } from './fragmentActionIdsV1.js';
export type { WidgetLayoutFragmentActionIdV1 } from './fragmentActionIdsV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
const account = z.strictObject({ account: WidgetDefinitionAccountV1Schema });
const reference = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(account, { artifactId: id }));
export const WidgetLayoutFragmentActionInputSchemasV1 = {
    'widgets.fragment.list': account,
    'widgets.fragment.get': reference,
    'widgets.fragment.create': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(account, { artifactId: id, fragment: WidgetLayoutFragmentDraftV1Schema })),
    'widgets.fragment.update': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { patch: WidgetLayoutFragmentPatchV1Schema })),
    'widgets.fragment.duplicate': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { newArtifactId: id, name: z.optional(id) })),
    'widgets.fragment.delete': reference,
} as const;
const result = z.strictObject({ fragment: WidgetLayoutFragmentV1Schema });
export const WidgetLayoutFragmentActionOutputSchemasV1 = {
    'widgets.fragment.list': z.strictObject({ fragments: z.array(WidgetLayoutFragmentSummaryV1Schema) }),
    'widgets.fragment.get': result, 'widgets.fragment.create': result, 'widgets.fragment.update': result, 'widgets.fragment.duplicate': result,
    'widgets.fragment.delete': z.strictObject({ artifactId: id, status: z.literal('deleted') }),
} as const;
export type WidgetLayoutFragmentActionDepsV1 = Readonly<{
    widgetAccountScope?: () => import('./widgetActionScopeV1.js').WidgetActionAccountScopeV1 | null;
    widgetLayoutFragmentArtifacts?: WidgetLayoutFragmentArtifactPortV1;
}>;
export function readWidgetLayoutFragmentActionAccountV1(input: unknown) {
    const value = input && typeof input === 'object' ? Reflect.get(input, 'account') : undefined;
    const parsed = WidgetDefinitionAccountV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** Presentation only: captured target identity wins over a proposed rename. Never enters mutation input. */
export function readWidgetLayoutFragmentApprovalNameV1(input: unknown, preview?: unknown): string | null {
    const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {};
    const value = record(input);
    for (const candidate of [record(preview).widgetLibraryName, record(value.fragment).name, record(value.patch).name, value.name]) {
        if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
    }
    return null;
}
