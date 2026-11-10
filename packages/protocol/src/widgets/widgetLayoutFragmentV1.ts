import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { InputHintsSchema } from '../inputs/inputFields.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { WidgetDefinitionProvenanceV1Schema } from './widgetDefinitionV1.js';
import { WidgetInstanceV1Schema } from './widgetInstanceV1.js';
import { WidgetLayoutGroupV1Schema, WidgetLayoutWidgetV1Schema, type WidgetLayoutGroupV1 } from './widgetLayoutItemV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
/** A fragment preserves a placement's content and options, never its physical identity. */
export const WidgetLayoutFragmentChildV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(WidgetLayoutWidgetV1Schema, { area: true }), {
    instance: z.omit(WidgetInstanceV1Schema, { id: true }),
})));
export const WidgetLayoutFragmentGroupV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(z.omit(WidgetLayoutGroupV1Schema, { kind: true, id: true, area: true }), {
    children: z.array(WidgetLayoutFragmentChildV1Schema).check(z.minLength(1)),
})));
export type WidgetLayoutFragmentGroupV1 = z.infer<typeof WidgetLayoutFragmentGroupV1Schema>;
/** Where the group was saved from, as the person saw it then: a fact about the save, never a live reference. */
export const WidgetLayoutFragmentOriginV1Schema = lazyZodSchema(() => z.strictObject({
    kind: z.enum(['home', 'project', 'pluginArea', 'corePage']), name: z.optional(id),
}));
export type WidgetLayoutFragmentOriginV1 = z.infer<typeof WidgetLayoutFragmentOriginV1Schema>;
const shape = { name: id, description: z.optional(z.string()), inputs: InputHintsSchema,
    inputSchema: PluginJsonSchemaV2Schema, group: WidgetLayoutFragmentGroupV1Schema,
    origin: z.optional(WidgetLayoutFragmentOriginV1Schema) };
export const WidgetLayoutFragmentDraftV1Schema = lazyZodSchema(() => z.strictObject(shape));
export type WidgetLayoutFragmentDraftV1 = z.infer<typeof WidgetLayoutFragmentDraftV1Schema>;
export const WidgetLayoutFragmentPatchV1Schema = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.partial(z.object({ ...shape,
    description: z.optional(z.nullable(z.string())),
}))));
export type WidgetLayoutFragmentPatchV1 = z.infer<typeof WidgetLayoutFragmentPatchV1Schema>;
export const WidgetLayoutFragmentV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1), id, ...shape,
    provenance: WidgetDefinitionProvenanceV1Schema,
}).check(z.superRefine((value, context) => {
    const paths = value.inputs.fields.map(field => field.path);
    if (new Set(paths).size !== paths.length) context.addIssue({ code: 'custom', path: ['inputs'], message: 'Duplicate group input path' });
})));
export type WidgetLayoutFragmentV1 = z.infer<typeof WidgetLayoutFragmentV1Schema>;
export const WidgetLayoutFragmentV1StoredSchema = createStoredReadSchema(WidgetLayoutFragmentV1Schema);

export function captureWidgetLayoutFragmentGroupV1(raw: WidgetLayoutGroupV1): WidgetLayoutFragmentGroupV1 {
    const { kind: _kind, id: _id, area: _area, children, ...options } = WidgetLayoutGroupV1Schema.parse(raw);
    return WidgetLayoutFragmentGroupV1Schema.parse({ ...options, children: children.map(child => {
        const { area: _childArea, instance, ...placement } = child;
        const { id: _instanceId, ...content } = instance;
        return { ...placement, instance: content };
    }) });
}

/** Callers allocate fresh ids once; the layout owner replays this complete group atomically. */
export function instantiateWidgetLayoutFragmentGroupV1(raw: WidgetLayoutFragmentGroupV1, identity: Readonly<{
    groupId: string; childIds: readonly string[];
}>): WidgetLayoutGroupV1 {
    const group = WidgetLayoutFragmentGroupV1Schema.parse(raw);
    if (identity.childIds.length !== group.children.length || new Set([identity.groupId, ...identity.childIds]).size !== group.children.length + 1) {
        throw new Error('widget_fragment_copy_identity_invalid');
    }
    return WidgetLayoutGroupV1Schema.parse({ ...group, kind: 'group', id: identity.groupId,
        children: group.children.map((child, index) => ({ ...child, instance: { ...child.instance, id: identity.childIds[index] } })) });
}

export function applyWidgetLayoutFragmentPatchV1(current: WidgetLayoutFragmentV1, raw: WidgetLayoutFragmentPatchV1): WidgetLayoutFragmentV1 {
    const next = { ...current, ...WidgetLayoutFragmentPatchV1Schema.parse(raw) };
    if (next.description === null) delete next.description;
    return WidgetLayoutFragmentV1Schema.parse(next);
}
