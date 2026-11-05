import { lazyZodSchema } from '../lazyZodSchema.js';
import { WidgetPublicSnapshotPresentationV1Schema } from './widgetPublicSnapshotV1.js';
import { z } from 'zod/mini';
import { InputFieldHintSchema, InputPathSchema } from '../inputs/inputFields.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { PluginJsonSchemaV2Schema } from '../plugins/contributions/jsonSchema.js';
import { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from '../artifacts/artifactActionsV1.js';
import { ArtifactCallerAccessV1Schema } from '../artifacts/artifactAccessV1.js';
import { AnchoredListPositionV1Schema } from '../actions/anchoredListOrderV1.js';
import { WidgetAreaLayoutSummaryV1Schema as LayoutSummarySchema, type WidgetAreaLayoutSummaryV1 } from './widgetSurfaceArtifactV1.js';
import { WidgetAreaPresetUndoV1Schema as PresetUndoSchema, WidgetAreaPresetResultV1Schema as PresetResultSchema, WidgetAreaPresetStateV1Schema as PresetStateSchema } from './widgetSurfaceArtifactV1.js';
import { SessionBoardItemPlacementV1Schema } from '../sessions/board/layoutOperations.js';
import { SessionBoardTabIdSchema } from '../sessions/board/ids.js';
import { UiSurfaceNetworkRequestV1Schema } from '../plugins/contributions/ui/hostedHtmlCapabilitiesV1.js';
import { SessionSystemRecordRevisionSchema } from '../sessions/system/records/sessionSystemRecordRevision.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { WidgetInstanceActionIdV1 } from './actionIdsV1.js';
import { WidgetLayoutGroupV1Schema, WidgetLayoutItemV1Schema, WidgetLayoutItemsV1Schema, type WidgetLayoutItemIntentV1 } from './widgetLayoutItemV1.js';
import { WidgetGroupWidthV1Schema, supportsWidgetGroupsV1, type WidgetGroupWidthV1 } from './widgetPresentationV1.js';
import { WidgetProjectAreaV1Schema, WidgetExpectedPresentationV1Schema, WidgetSizeV1Schema, WidgetSizeDeclarationV1Schema, WidgetFrameStyleV1Schema, WidgetSurfacePresentationV1Schema, type WidgetProjectAreaV1, type WidgetExpectedPresentationV1, type WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';
import {
  WidgetDefinitionRefV1Schema as DefinitionRefSchema, WidgetInputBindingsV1Schema as BindingsSchema, WidgetInstanceRefV1Schema as InstanceRefSchema,
  WidgetInstanceV1Schema as InstanceSchema, WidgetSurfaceRefV1Schema as SurfaceRefSchema,
  type WidgetBindingResolutionV1, type WidgetInstanceRefV1, type WidgetInstanceV1, type WidgetSurfaceRefV1,
} from './widgetInstanceV1.js';

// Inline definitions contain declarative host Actions. Defer the schema graph's
// reverse edge while the one canonical Action vocabulary initializes.
const WidgetDefinitionRefV1Schema = z.lazy(() => DefinitionRefSchema);
const WidgetInputBindingsV1Schema = z.lazy(() => BindingsSchema);
const WidgetInstanceRefV1Schema = z.lazy(() => InstanceRefSchema);
const WidgetInstanceV1Schema = z.lazy(() => InstanceSchema);
const WidgetSurfaceRefV1Schema = z.lazy(() => SurfaceRefSchema);
const WidgetAreaLayoutSummaryV1Schema = z.lazy(() => LayoutSummarySchema);
const WidgetAreaPresetUndoV1Schema = z.lazy(() => PresetUndoSchema);
const WidgetAreaPresetResultV1Schema = z.lazy(() => PresetResultSchema);
const WidgetAreaPresetStateV1Schema = z.lazy(() => PresetStateSchema);
export { WidgetProjectAreaV1Schema } from './widgetPresentationV1.js';
export type { WidgetProjectAreaV1 } from './widgetPresentationV1.js';

export { WIDGET_INSTANCE_ACTION_IDS_V1, WidgetInstanceActionIdV1Schema } from './actionIdsV1.js';
export type { WidgetInstanceActionIdV1 } from './actionIdsV1.js';
/** Metadata, types and options use the selected Session, or the hosting Session. */
export function readWidgetActionSessionTargetV1(surface: WidgetSurfaceRefV1,
  selected?: Readonly<{ serverId: string; sessionId: string }>): Readonly<{ serverId: string; sessionId: string }> | undefined {
  const owner = surface.owner;
  return selected ?? (owner.kind === 'sessionBoard' || owner.kind === 'companion'
    ? { serverId: surface.serverId, sessionId: owner.sessionId } : undefined);
}
/** One nested-target reader for Action policy, approval custody and widget execution. */
export function readWidgetActionSurfaceV1(input: unknown): WidgetSurfaceRefV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const outer = input as Readonly<Record<string, unknown>>;
  const ref = outer.ref && typeof outer.ref === 'object' && !Array.isArray(outer.ref)
    ? outer.ref as Readonly<Record<string, unknown>> : undefined;
  const capture = outer.capture && typeof outer.capture === 'object' && !Array.isArray(outer.capture)
    ? outer.capture as Readonly<Record<string, unknown>> : undefined;
  const parsed = WidgetSurfaceRefV1Schema.safeParse(outer.surface ?? ref?.surface ?? capture?.surface);
  return parsed.success ? parsed.data : null;
}
export function readWidgetCatalogBoundSessionV1(input: unknown): ReturnType<typeof VoiceTrackedSessionAddressV1Schema.parse> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const parsed = VoiceTrackedSessionAddressV1Schema.safeParse(Reflect.get(input, 'boundSession'));
  return parsed.success ? parsed.data : null;
}
/** Both principals are admitted at the Action choke point before any transfer write. */
export function readWidgetActionDestinationV1(input: unknown): WidgetSurfaceRefV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const to = Reflect.get(input, 'to');
  if (!to || typeof to !== 'object' || Array.isArray(to)) return null;
  const parsed = WidgetSurfaceRefV1Schema.safeParse(Reflect.get(to, 'surface'));
  return parsed.success ? parsed.data : null;
}
const index = z.number().check(z.int(), z.nonnegative(), z.int(), z.describe('Zero-based configured-widget ordinal in the destination view; omitted destination reorders only the current surface and view.'));
const nativeIndex = z.number().check(z.int(), z.nonnegative(), z.int(), z.describe('Owner-native mixed-content insertion index in the destination view, with the moving item excluded. Session Board requires an existing explicit tab for cross-surface moves.'));
export { WidgetSizeV1Schema, WidgetFrameStyleV1Schema, WidgetExpectedPresentationV1Schema } from './widgetPresentationV1.js';
export type { WidgetExpectedPresentationV1 } from './widgetPresentationV1.js';
/** Ephemeral native-owner facts, never a persisted receipt or a public Action result. */
export const WidgetMoveCaptureV1Schema = lazyZodSchema(() => z.strictObject({
  expectedInstance: WidgetInstanceV1Schema, expectedPresentation: z.optional(WidgetExpectedPresentationV1Schema),
  boardRevisions: z.optional(z.strictObject({ itemRevision: SessionSystemRecordRevisionSchema, layoutRevision: SessionSystemRecordRevisionSchema })),
}).check(z.refine(value => value.expectedPresentation !== undefined || value.boardRevisions !== undefined, 'Native presentation or exact Board revisions required')));
export type WidgetMoveCaptureV1 = z.infer<typeof WidgetMoveCaptureV1Schema>;
export const WidgetMoveDestinationV1Schema = lazyZodSchema(() => z.strictObject({ surface: WidgetSurfaceRefV1Schema, tabId: z.optional(SessionBoardTabIdSchema), area: z.optional(WidgetProjectAreaV1Schema), index: nativeIndex, groupId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))) }));
export const WidgetTransferFailureDetailsV1Schema = lazyZodSchema(() => z.strictObject({
  fromRef: WidgetInstanceRefV1Schema, toRef: WidgetInstanceRefV1Schema,
  phase: z.enum(['preflight', 'destination_add', 'source_remove', 'compensation']),
  source: z.enum(['present', 'absent', 'unknown']), destination: z.enum(['present', 'absent', 'unknown']),
  reasonCode: z.string().check(z.trim(), z.minLength(1)),
  instance: z.optional(WidgetInstanceV1Schema),
}).check(z.refine(value => value.instance === undefined || value.phase !== 'preflight' && value.source === 'absent' && value.destination === 'absent', 'Recovery instance requires current absent facts from both owners after a write phase')));
export type WidgetTransferFailureDetailsV1 = z.infer<typeof WidgetTransferFailureDetailsV1Schema>;
const surfaceInput = z.strictObject({ surface: WidgetSurfaceRefV1Schema });
const refInput = z.strictObject({ ref: WidgetInstanceRefV1Schema });
const groupSurface = WidgetSurfaceRefV1Schema.check(z.refine(surface => supportsWidgetGroupsV1(surface.owner.kind), 'Group-capable surface required'));
const groupRef = lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(InstanceRefSchema, { surface: groupSurface })));
const groupRefInput = z.strictObject({ ref: groupRef });
const bindingsInput = z.strictObject({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema });
const areaSurface = WidgetSurfaceRefV1Schema.check(z.refine(surface => surface.owner.kind === 'project' || surface.owner.kind === 'pluginArea' || surface.owner.kind === 'corePage', 'Area surface required'));
const layoutSurface = areaSurface;
const layoutInput = z.strictObject({ surface: layoutSurface });
const layoutMutationInput = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(layoutInput, { expectedRevision: z.nullable(ArtifactRevisionV1Schema) }));
const layoutName = z.string().check(z.trim(), z.minLength(1));
export const WidgetInstanceActionInputSchemasV1 = {
  'widgets.area.layout.reset': z.strictObject({ surface: areaSurface, expectedRevision: z.nullable(ArtifactRevisionV1Schema) }),
  'widgets.area.layout.undo': z.strictObject({ capture: WidgetAreaPresetUndoV1Schema }),
  'widgets.group.add': z.strictObject({ surface: groupSurface, group: WidgetLayoutGroupV1Schema, toIndex: z.optional(index) }),
  'widgets.group.create': z.strictObject({ surface: groupSurface, groupId: z.string().check(z.trim(), z.minLength(1)), instanceIds: z.array(z.string().check(z.trim(), z.minLength(1))).check(z.minLength(1)), width: z.optional(WidgetGroupWidthV1Schema), title: z.optional(z.string().check(z.trim(), z.minLength(1))), context: z.optional(WidgetInputBindingsV1Schema) }),
  'widgets.group.ungroup': groupRefInput,
  'widgets.group.set': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(groupRefInput, { width: z.optional(WidgetGroupWidthV1Schema), dividers: z.optional(z.enum(['hairline', 'none'])) })),
  'widgets.group.inputs.set': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(groupRefInput, { bindings: WidgetInputBindingsV1Schema })),
  'widgets.area.layout.list': layoutInput,
  'widgets.area.layout.create': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(layoutInput, { layoutId: z.string().check(z.trim(), z.minLength(1)), name: layoutName, fromSurface: z.optional(areaSurface) })),
  'widgets.area.layout.rename': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(layoutMutationInput, { name: layoutName })),
  'widgets.area.layout.delete': layoutMutationInput,
  'widgets.area.layout.reorder': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(layoutMutationInput, { position: AnchoredListPositionV1Schema })),
  'widgets.area.layout.select': z.strictObject({ surface: areaSurface }),
  'widgets.catalog.list': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(surfaceInput, { boundSession: z.optional(VoiceTrackedSessionAddressV1Schema) })),
  'widgets.item.list': surfaceInput,
  // `groupId` places the new widget into that group of the layout (a group's empty slot).
  'widgets.item.add': z.strictObject({ surface: WidgetSurfaceRefV1Schema, instance: WidgetInstanceV1Schema, area: z.optional(WidgetProjectAreaV1Schema), size: z.optional(WidgetSizeV1Schema), toIndex: z.optional(index), placement: z.optional(SessionBoardItemPlacementV1Schema), groupId: z.optional(z.string().check(z.trim(), z.minLength(1))) }),
  'widgets.item.remove': refInput,
  'widgets.item.move': z.union([
    z.strictObject({ ref: WidgetInstanceRefV1Schema, toIndex: index, area: z.optional(WidgetProjectAreaV1Schema), groupId: z.optional(z.nullable(z.string().check(z.trim(), z.minLength(1)))) }),
    z.strictObject({ ref: WidgetInstanceRefV1Schema, to: WidgetMoveDestinationV1Schema }),
  ]),
  'widgets.item.rename': z.strictObject({ ref: WidgetInstanceRefV1Schema, displayName: z.nullable(z.string().check(z.trim(), z.minLength(1))) }),
  'widgets.item.size.set': z.union([
    z.strictObject({ ref: WidgetInstanceRefV1Schema, size: WidgetSizeV1Schema }),
    z.strictObject({ ref: groupRef, width: WidgetGroupWidthV1Schema }),
  ]),
  'widgets.item.frame.set': z.strictObject({ ref: WidgetInstanceRefV1Schema, frameStyle: z.nullable(WidgetFrameStyleV1Schema) }),
  'widgets.item.network.set': z.strictObject({ ref: WidgetInstanceRefV1Schema, network: UiSurfaceNetworkRequestV1Schema }),
  'widgets.item.inputs.get': refInput,
  'widgets.item.inputs.validate': bindingsInput,
  'widgets.item.inputs.set': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(bindingsInput, { paths: z.optional(z.array(InputPathSchema)) })),
  'widgets.item.inputs.reset': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(refInput, { paths: z.optional(z.array(InputPathSchema)) })),
  'widgets.item.refresh': refInput,
} as const;

export const WidgetPlacementV1Schema = lazyZodSchema(() => z.strictObject({
  instance: WidgetInstanceV1Schema, area: z.optional(WidgetProjectAreaV1Schema), size: z.optional(WidgetSizeV1Schema), frameStyle: z.optional(WidgetFrameStyleV1Schema),
}));
export type WidgetPlacementV1 = z.infer<typeof WidgetPlacementV1Schema>;
export const WidgetSurfaceReadV1Schema = lazyZodSchema(() => z.strictObject({
  surface: WidgetSurfaceRefV1Schema, instances: z.array(WidgetPlacementV1Schema), canEdit: z.boolean(),
  items: z.optional(WidgetLayoutItemsV1Schema),
  preset: z.optional(WidgetAreaPresetStateV1Schema),
  state: z.optional(z.enum(['missing', 'present'])), isShared: z.optional(z.boolean()),
  revision: z.optional(z.nullable(ArtifactRevisionV1Schema)),
  /** Admitted selected-document facts, independent of Source membership and acting viewer. */
  dashboard: z.optional(z.strictObject({ name: z.string().check(z.trim(), z.minLength(1)), ownerAccountId: z.string().check(z.minLength(1)), access: ArtifactCallerAccessV1Schema })),
}).check(z.superRefine((value, context) => {
  if (new Set(value.instances.map(entry => entry.instance.id)).size !== value.instances.length) context.addIssue({ code: 'custom', path: ['instances'], message: 'Duplicate widget instance identity' });
})));
export type WidgetSurfaceReadV1 = z.infer<typeof WidgetSurfaceReadV1Schema>;
export const WidgetCatalogEntryV1Schema = lazyZodSchema(() => z.strictObject({
  publicPresentation: z.optional(WidgetPublicSnapshotPresentationV1Schema),
  sizeDeclaration: WidgetSizeDeclarationV1Schema, presentation: WidgetSurfacePresentationV1Schema,
  definition: WidgetDefinitionRefV1Schema, title: z.string().check(z.trim(), z.minLength(1)),
  fields: z.array(InputFieldHintSchema),
  /** The exact schema a configured instance's resolved inputs must satisfy; the admission owner compiles this same object. */
  inputSchema: z.optional(PluginJsonSchemaV2Schema),
  availability: z.enum(['available', 'unavailable', 'denied']),
  instanceCount: z.number().check(z.int(), z.nonnegative(), z.int()),
}));
export type WidgetCatalogEntryV1 = z.infer<typeof WidgetCatalogEntryV1Schema>;
export type WidgetCatalogSourceEntryV1 = Omit<WidgetCatalogEntryV1, 'presentation'>;
export const WidgetBindingResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready'), input: z.record(z.string(), StrictJsonValueSchema) }),
  ...(['selection_required', 'invalid', 'unavailable', 'denied'] as const).map(status => z.strictObject({
    status: z.literal(status), fields: z.array(z.strictObject({
      path: InputPathSchema, status: z.enum(['selection_required', 'invalid', 'unavailable', 'denied']), reasonCode: z.string().check(z.trim(), z.minLength(1)),
    })),
  })),
]));
const mutationResult = z.strictObject({ ref: WidgetInstanceRefV1Schema, instance: z.nullable(WidgetInstanceV1Schema), item: z.optional(z.nullable(WidgetLayoutItemV1Schema)), area: z.optional(WidgetProjectAreaV1Schema) });
const inputsResult = z.strictObject({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema });
export const WidgetInstanceActionOutputSchemasV1 = {
  'widgets.area.layout.reset': WidgetAreaPresetResultV1Schema,
  'widgets.area.layout.undo': WidgetAreaPresetResultV1Schema,
  'widgets.group.add': mutationResult,
  'widgets.group.create': mutationResult, 'widgets.group.ungroup': mutationResult,
  'widgets.group.set': mutationResult, 'widgets.group.inputs.set': mutationResult,
  'widgets.area.layout.list': z.strictObject({ surface: layoutSurface, layouts: z.array(WidgetAreaLayoutSummaryV1Schema) }),
  'widgets.area.layout.create': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.rename': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.delete': z.strictObject({ surface: layoutSurface, artifactId: z.string().check(z.minLength(1)) }),
  'widgets.area.layout.reorder': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.select': z.strictObject({ surface: areaSurface }),
  'widgets.catalog.list': z.strictObject({ surface: WidgetSurfaceRefV1Schema, entries: z.array(WidgetCatalogEntryV1Schema), presentation: WidgetSurfacePresentationV1Schema }),
  'widgets.item.list': WidgetSurfaceReadV1Schema,
  'widgets.item.add': mutationResult, 'widgets.item.remove': mutationResult,
  'widgets.item.move': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(mutationResult, { fromRef: z.optional(WidgetInstanceRefV1Schema), status: z.optional(z.literal('moved')) })), 'widgets.item.rename': mutationResult,
  'widgets.item.size.set': mutationResult, 'widgets.item.frame.set': mutationResult,
  'widgets.item.network.set': mutationResult,
  'widgets.item.inputs.get': inputsResult, 'widgets.item.inputs.validate': WidgetBindingResolutionV1Schema,
  'widgets.item.inputs.set': mutationResult, 'widgets.item.inputs.reset': mutationResult,
  'widgets.item.refresh': z.strictObject({ ref: WidgetInstanceRefV1Schema, status: z.literal('refreshed') }),
} as const;

/** Adapters translate into existing domain intents; they do not persist or reduce a parallel layout. */
export type WidgetSurfaceMutationV1 =
  | Exclude<WidgetLayoutItemIntentV1, { kind: 'add' | 'move' | 'remove' | 'inputs' | 'inputs_reset' }>
  | Readonly<{ kind: 'width'; instanceId: string; width: WidgetGroupWidthV1 }>
  | Readonly<{ kind: 'add'; instance: WidgetInstanceV1; toIndex?: number; groupId?: string; area?: WidgetProjectAreaV1; placement?: z.infer<typeof SessionBoardItemPlacementV1Schema>;
      position?: Readonly<{ tabId?: string; area?: WidgetProjectAreaV1; groupId?: string; index: number }>; presentation?: Readonly<{ size?: z.infer<typeof WidgetSizeV1Schema>; frameStyle?: 'card' | 'plain' }>; captureForMove?: true }>
  | Readonly<{ kind: 'remove'; instanceId: string; expectedInstance?: WidgetInstanceV1; expectedPresentation?: WidgetExpectedPresentationV1; boardRevisions?: WidgetMoveCaptureV1['boardRevisions'] }>
  | Readonly<{ kind: 'move'; instanceId: string; toIndex: number; groupId?: string | null; area?: WidgetProjectAreaV1; expectedInstance?: WidgetInstanceV1; expectedPresentation?: WidgetExpectedPresentationV1 }>
  | Readonly<{ kind: 'move'; instanceId: string; nativeIndex: number; groupId?: string | null; tabId?: string; area?: WidgetProjectAreaV1; expectedInstance?: WidgetInstanceV1; expectedPresentation?: WidgetExpectedPresentationV1 }>
  | Readonly<{ kind: 'rename'; instanceId: string; displayName: string | null }>
  | Readonly<{ kind: 'size'; instanceId: string; size: z.infer<typeof WidgetSizeV1Schema> }>
  | Readonly<{ kind: 'frame'; instanceId: string; frameStyle: 'card' | 'plain' | null }>
  | Readonly<{ kind: 'inputs'; instanceId: string; bindings: WidgetInstanceV1['bindings']; paths?: readonly string[] }>
  | Readonly<{ kind: 'inputs_reset'; instanceId: string; paths?: readonly string[] }>;
/** Captured adapters delegate document identity, inventory and CAS to the Artifact owner. */
export type WidgetAreaLayoutActionPortV1 = Readonly<{
  list(args: Readonly<{ surface: WidgetSurfaceRefV1 }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<readonly WidgetAreaLayoutSummaryV1[] | Extract<ActionExecuteResult, { ok: false }>>;
  create(args: Readonly<{ surface: WidgetSurfaceRefV1; layoutId: string; name: string; fromSurface?: WidgetSurfaceRefV1 }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetAreaLayoutSummaryV1 | Extract<ActionExecuteResult, { ok: false }>>;
  reset(args: Readonly<{ surface: WidgetSurfaceRefV1; expectedRevision: ArtifactRevisionV1 | null }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<z.infer<typeof WidgetAreaPresetResultV1Schema> | Extract<ActionExecuteResult, { ok: false }>>;
  undo(capture: z.infer<typeof WidgetAreaPresetUndoV1Schema>, context: ActionExecutorContext, signal?: AbortSignal): Promise<z.infer<typeof WidgetAreaPresetResultV1Schema> | Extract<ActionExecuteResult, { ok: false }>>;
  rename(args: Readonly<{ surface: WidgetSurfaceRefV1; name: string; expectedRevision: ArtifactRevisionV1 | null }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetAreaLayoutSummaryV1 | Extract<ActionExecuteResult, { ok: false }>>;
  delete(args: Readonly<{ surface: WidgetSurfaceRefV1; expectedRevision: ArtifactRevisionV1 | null }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<Readonly<{ surface: WidgetSurfaceRefV1; artifactId: string }> | Extract<ActionExecuteResult, { ok: false }>>;
  reorder(args: Readonly<{ surface: WidgetSurfaceRefV1; position: z.infer<typeof AnchoredListPositionV1Schema>; expectedRevision: ArtifactRevisionV1 | null }>, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetAreaLayoutSummaryV1 | Extract<ActionExecuteResult, { ok: false }>>;
}>;
export type WidgetActionSurfacePortV1 = Readonly<{
  read(surface: WidgetSurfaceRefV1, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetSurfaceReadV1 | Extract<ActionExecuteResult, { ok: false }>>;
  apply(surface: WidgetSurfaceRefV1, intent: WidgetSurfaceMutationV1, context: ActionExecutorContext, signal?: AbortSignal): Promise<ActionExecuteResult>;
  captureMove?(surface: WidgetSurfaceRefV1, instanceId: string, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetMoveCaptureV1 | Extract<ActionExecuteResult, { ok: false }>>;
}>;
export type WidgetActionInputResolverV1 = Readonly<{
  resolve(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; groupBindings?: WidgetInstanceV1['bindings']; admission?: 'configuration' | 'execution';
    /** Owner-read bindings before an exact-path edit; absent mounted slots may retain only unchanged references. */
    configurationPatch?: Readonly<{ paths: readonly string[]; previousBindings: WidgetInstanceV1['bindings'] }>; signal?: AbortSignal }>): Promise<WidgetBindingResolutionV1>;
  readSizeDeclaration(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; groupBindings?: WidgetInstanceV1['bindings']; signal?: AbortSignal }>): Promise<WidgetSizeDeclarationV1 | null>;
}>;
