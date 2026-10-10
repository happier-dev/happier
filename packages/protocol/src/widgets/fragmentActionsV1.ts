import { z } from 'zod';
import { WidgetDefinitionAccountV1Schema } from './definitionActionsV1.js';
import { WidgetLayoutFragmentDraftV1Schema, WidgetLayoutFragmentPatchV1Schema, WidgetLayoutFragmentV1Schema } from './widgetLayoutFragmentV1.js';
import { WidgetLayoutFragmentSummaryV1Schema, type WidgetLayoutFragmentArtifactPortV1 } from './widgetLayoutFragmentArtifactV1.js';
export { WIDGET_LAYOUT_FRAGMENT_ACTION_IDS_V1, WidgetLayoutFragmentActionIdV1Schema } from './fragmentActionIdsV1.js';
export type { WidgetLayoutFragmentActionIdV1 } from './fragmentActionIdsV1.js';

const id = z.string().trim().min(1);
const account = z.object({ account: WidgetDefinitionAccountV1Schema }).strict();
const reference = account.extend({ artifactId: id }).strict();
export const WidgetLayoutFragmentActionInputSchemasV1 = {
    'widgets.fragment.list': account,
    'widgets.fragment.get': reference,
    'widgets.fragment.create': account.extend({ artifactId: id, fragment: WidgetLayoutFragmentDraftV1Schema }).strict(),
    'widgets.fragment.update': reference.extend({ patch: WidgetLayoutFragmentPatchV1Schema }).strict(),
    'widgets.fragment.duplicate': reference.extend({ newArtifactId: id, name: id.optional() }).strict(),
    'widgets.fragment.delete': reference,
} as const;
const result = z.object({ fragment: WidgetLayoutFragmentV1Schema }).strict();
export const WidgetLayoutFragmentActionOutputSchemasV1 = {
    'widgets.fragment.list': z.object({ fragments: z.array(WidgetLayoutFragmentSummaryV1Schema) }).strict(),
    'widgets.fragment.get': result, 'widgets.fragment.create': result, 'widgets.fragment.update': result, 'widgets.fragment.duplicate': result,
    'widgets.fragment.delete': z.object({ artifactId: id, status: z.literal('deleted') }).strict(),
} as const;
export type WidgetLayoutFragmentActionDepsV1 = Readonly<{
    widgetAccountScope?: () => Readonly<{ serverId: string; accountId: string }> | null;
    widgetLayoutFragmentArtifacts?: WidgetLayoutFragmentArtifactPortV1;
}>;
export function readWidgetLayoutFragmentActionAccountV1(input: unknown) {
    const value = input && typeof input === 'object' ? Reflect.get(input, 'account') : undefined;
    const parsed = WidgetDefinitionAccountV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
