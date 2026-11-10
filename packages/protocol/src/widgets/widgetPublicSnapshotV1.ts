import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema, defineStoredReadProjection } from '../json/storedReadSchema.js';
import { PluginDeclarativeDocumentStructureV1Schema } from '../plugins/contributions/ui/declarativeDocumentAuthoringV1.js';
import { preflightPluginDeclarativeDocumentV1 } from '../plugins/contributions/ui/declarativeDocumentPreflightV1.js';
import { WidgetGridSizeV1Schema, WidgetGroupWidthV1Schema, resolveWidgetGroupWidthFitV1 } from './widgetPresentationV1.js';
import { validatePublicProfileDocumentBindings } from '../account/projectPublicProfile.js';
import { BuiltinUsagePublicPresentationV1Schema, readBuiltinWidgetDescriptorV1 } from './builtinWidgetDescriptorV1.js';

const symbolicSource = z.strictObject({ kind: z.literal('value'), value: z.strictObject({ kind: z.literal('public_profile') }) });
const inertKinds = new Set(['text', 'status', 'stack', 'group', 'list', 'section', 'item', 'metadata', 'state']);
const dataKinds = new Set(['metric', 'table', 'rows', 'chart']);

/** Specialize the incumbent recursive grammar, including its generated schema. */
function specializePublicDocument<T extends z.core.$ZodType>(source: T, cache = new WeakMap<z.core.$ZodType, z.core.$ZodType>()): T {
  const cached = cache.get(source);
  if (cached) return cached as T;
  const specialized = z.lazy(() => {
    const def = (source as unknown as z.core.$ZodTypes)._zod.def;
    const child = (schema: z.core.$ZodType) => specializePublicDocument(schema, cache);
    const clone = (overrides: Record<string, unknown>) => z.core.clone(source, { ...def, ...overrides });
    switch (def.type) {
      case 'object': {
        const kindSchema = def.shape.kind as z.core.$ZodLiteral | undefined;
        const kind = kindSchema?._zod.def.type === 'literal' ? kindSchema._zod.def.values[0] : undefined;
        if (typeof kind === 'string' && !inertKinds.has(kind) && !dataKinds.has(kind)) return z.never();
        const shape = Object.fromEntries(Object.entries(def.shape).filter(([key]) => kind !== 'item' || key !== 'action' && key !== 'input')
          .map(([key, schema]) => [key, key === 'data' && typeof kind === 'string' && dataKinds.has(kind) ? symbolicSource : child(schema)]));
        return clone({ shape });
      }
      // A filtered discriminated union becomes an ordinary union: rejected arms
      // intentionally have no discriminator value to cache.
      case 'union': return z.union(def.options.map(child));
      case 'array': return clone({ element: child(def.element) });
      case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'readonly':
        return clone({ innerType: child(def.innerType) });
      case 'lazy': return child((source as unknown as z.core.$ZodLazy)._zod.innerType);
      default: return source;
    }
  });
  cache.set(source, specialized);
  // Core cloning narrows the existing vocabulary; it adds no new output shape.
  return specialized as unknown as T;
}
/** Existing inert document grammar with a symbolic source, never a frozen private number. */
export const WidgetPublicSnapshotDocumentV1Schema = lazyZodSchema(() => {
  const structure = specializePublicDocument(PluginDeclarativeDocumentStructureV1Schema);
  const schema = z.pipe(z.unknown().check(z.superRefine((input, ctx) => {
    const preflight = preflightPluginDeclarativeDocumentV1(input);
    if (!preflight.ok) ctx.addIssue({ code: 'custom', message: preflight.message });
  })), structure);
  schema._zod.processJSONSchema = (context, _json, params) => {
    z.core.process(structure, context, params);
    context.seen.get(schema)!.ref = structure;
  };
  return schema;
});
export type WidgetPublicSnapshotDocumentV1 = z.infer<typeof WidgetPublicSnapshotDocumentV1Schema>;
export const WidgetPublicSnapshotPresentationV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('declarative'), document: WidgetPublicSnapshotDocumentV1Schema,
}).check(z.superRefine((presentation, ctx) => {
  try { validatePublicProfileDocumentBindings(presentation.document); }
  catch { ctx.addIssue({ code: 'custom', message: 'Public-profile field binding is invalid' }); }
})));
export type WidgetPublicSnapshotPresentationV1 = z.infer<typeof WidgetPublicSnapshotPresentationV1Schema>;
const id = z.string().check(z.trim(), z.minLength(1));
const frameStyle = z.enum(['card', 'plain']);
export const PublicProfileLayoutWidgetV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('widget'), id, size: WidgetGridSizeV1Schema, frameStyle,
  title: z.optional(id),
  presentation: z.union([WidgetPublicSnapshotPresentationV1Schema, BuiltinUsagePublicPresentationV1Schema]),
}));
export const PublicProfileLayoutGroupV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal('group'), id, width: WidgetGroupWidthV1Schema, frameStyle,
  title: z.optional(id), dividers: z.enum(['hairline', 'none']),
  children: z.array(PublicProfileLayoutWidgetV1Schema).check(z.minLength(1)),
}));
export const PublicProfileLayoutV1Schema = lazyZodSchema(() => z.strictObject({ v: z.literal(1),
  items: z.array(z.discriminatedUnion('kind', [PublicProfileLayoutWidgetV1Schema, PublicProfileLayoutGroupV1Schema])),
}).check(z.superRefine((layout, ctx) => {
  const ids = new Set<string>();
  for (const item of layout.items) {
    for (const widget of item.kind === 'widget' ? [item] : item.children) {
      if (widget.presentation.kind === 'usage') {
        const declaration = readBuiltinWidgetDescriptorV1({ kind: 'builtin', id: widget.presentation.widgetId });
        if (!declaration?.sizeDeclaration.sizes.includes(widget.size)) {
          ctx.addIssue({ code: 'custom', message: 'Public-profile widget size is unsupported' });
        }
      }
    }
    for (const value of item.kind === 'group' ? [item.id, ...item.children.map(child => child.id)] : [item.id]) {
      if (ids.has(value)) ctx.addIssue({ code: 'custom', message: 'Duplicate public layout item identity' });
      ids.add(value);
    }
    if (item.kind === 'group' && !resolveWidgetGroupWidthFitV1(item.children.map(child => ({ instance: { id: child.id }, size: child.size }))).availableWidths.includes(item.width)) {
      ctx.addIssue({ code: 'custom', message: 'Group width cannot fit child' });
    }
  }
})));
export type PublicProfileLayoutV1 = z.infer<typeof PublicProfileLayoutV1Schema>;
function storedRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function dropUnknownStoredPresentations(input: unknown): unknown {
  const layout = storedRecord(input);
  if (!layout || !Array.isArray(layout.items)) return input;
  const keep = (item: unknown): boolean => {
    const widget = storedRecord(item);
    const presentation = storedRecord(widget?.presentation);
    return !(widget?.kind === 'widget' && typeof presentation?.kind === 'string' && presentation.kind !== 'declarative' && presentation.kind !== 'usage');
  };
  return { ...layout, items: layout.items.filter(keep).flatMap(item => {
    const group = storedRecord(item);
    if (group?.kind !== 'group' || !Array.isArray(group.children)) return [item];
    const children = group.children.filter(keep);
    return children.length ? [{ ...group, children }] : [];
  }) };
}
defineStoredReadProjection(PublicProfileLayoutV1Schema, () => {
  const storedLayout = createStoredReadSchema(z.core.clone(PublicProfileLayoutV1Schema));
  return z.pipe(z.unknown(), z.pipe(z.transform(dropUnknownStoredPresentations), storedLayout));
});
export const PublicProfileLayoutV1StoredSchema = createStoredReadSchema(PublicProfileLayoutV1Schema);
