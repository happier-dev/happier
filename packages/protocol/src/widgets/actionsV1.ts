import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { InputFieldHintSchema, InputPathSchema } from '../inputs/inputFields.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { ArtifactRevisionV1Schema, type ArtifactRevisionV1 } from '../artifacts/artifactActionsV1.js';
import { ArtifactCallerAccessV1Schema } from '../artifacts/artifactAccessV1.js';
import { AnchoredListPositionV1Schema } from '../actions/anchoredListOrderV1.js';
import { WidgetAreaLayoutSummaryV1Schema as LayoutSummarySchema, type WidgetAreaLayoutSummaryV1 } from './widgetSurfaceArtifactV1.js';
import { WidgetAreaPresetUndoV1Schema as PresetUndoSchema, WidgetAreaPresetResultV1Schema as PresetResultSchema, WidgetAreaPresetStateV1Schema as PresetStateSchema } from './widgetSurfaceArtifactV1.js';
import { SessionBoardItemPlacementV1Schema } from '../sessions/board/layoutOperations.js';
import { SessionBoardTabIdSchema } from '../sessions/board/ids.js';
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
const index = z.number().int().nonnegative().safe().describe('Zero-based configured-widget ordinal in the destination view; omitted destination reorders only the current surface and view.');
const nativeIndex = z.number().int().nonnegative().safe().describe('Owner-native mixed-content insertion index in the destination view, with the moving item excluded. Session Board requires an existing explicit tab for cross-surface moves.');
export { WidgetSizeV1Schema, WidgetFrameStyleV1Schema, WidgetExpectedPresentationV1Schema } from './widgetPresentationV1.js';
export type { WidgetExpectedPresentationV1 } from './widgetPresentationV1.js';
/** Ephemeral native-owner facts, never a persisted receipt or a public Action result. */
export const WidgetMoveCaptureV1Schema = lazyZodSchema(() => z.object({
  expectedInstance: WidgetInstanceV1Schema, expectedPresentation: WidgetExpectedPresentationV1Schema.optional(),
  boardRevisions: z.object({ itemRevision: SessionSystemRecordRevisionSchema, layoutRevision: SessionSystemRecordRevisionSchema }).strict().optional(),
}).strict().refine(value => value.expectedPresentation !== undefined || value.boardRevisions !== undefined, 'Native presentation or exact Board revisions required'));
export type WidgetMoveCaptureV1 = z.infer<typeof WidgetMoveCaptureV1Schema>;
export const WidgetMoveDestinationV1Schema = lazyZodSchema(() => z.object({ surface: WidgetSurfaceRefV1Schema, tabId: SessionBoardTabIdSchema.optional(), area: WidgetProjectAreaV1Schema.optional(), index: nativeIndex, groupId: z.string().trim().min(1).nullable().optional() }).strict());
export const WidgetTransferFailureDetailsV1Schema = lazyZodSchema(() => z.object({
  fromRef: WidgetInstanceRefV1Schema, toRef: WidgetInstanceRefV1Schema,
  phase: z.enum(['preflight', 'destination_add', 'source_remove', 'compensation']),
  source: z.enum(['present', 'absent', 'unknown']), destination: z.enum(['present', 'absent', 'unknown']),
  reasonCode: z.string().trim().min(1),
  instance: WidgetInstanceV1Schema.optional(),
}).strict().refine(value => value.instance === undefined || value.phase !== 'preflight' && value.source === 'absent' && value.destination === 'absent',
  'Recovery instance requires current absent facts from both owners after a write phase'));
export type WidgetTransferFailureDetailsV1 = z.infer<typeof WidgetTransferFailureDetailsV1Schema>;
const surfaceInput = z.object({ surface: WidgetSurfaceRefV1Schema }).strict();
const refInput = z.object({ ref: WidgetInstanceRefV1Schema }).strict();
const groupSurface = WidgetSurfaceRefV1Schema.refine(surface => supportsWidgetGroupsV1(surface.owner.kind), 'Group-capable surface required');
const groupRef = lazyZodSchema(() => InstanceRefSchema.extend({ surface: groupSurface }).strict());
const groupRefInput = z.object({ ref: groupRef }).strict();
const bindingsInput = z.object({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema }).strict();
const areaSurface = WidgetSurfaceRefV1Schema.refine(surface => surface.owner.kind === 'project' || surface.owner.kind === 'pluginArea' || surface.owner.kind === 'corePage', 'Area surface required');
const layoutSurface = areaSurface;
const layoutInput = z.object({ surface: layoutSurface }).strict();
const layoutMutationInput = layoutInput.extend({ expectedRevision: ArtifactRevisionV1Schema.nullable() }).strict();
const layoutName = z.string().trim().min(1);
export const WidgetInstanceActionInputSchemasV1 = {
  'widgets.area.layout.reset': z.object({ surface: areaSurface, expectedRevision: ArtifactRevisionV1Schema.nullable() }).strict(),
  'widgets.area.layout.undo': z.object({ capture: WidgetAreaPresetUndoV1Schema }).strict(),
  'widgets.group.add': z.object({ surface: groupSurface, group: WidgetLayoutGroupV1Schema, toIndex: index.optional() }).strict(),
  'widgets.group.create': z.object({ surface: groupSurface, groupId: z.string().trim().min(1), instanceIds: z.array(z.string().trim().min(1)).min(1), width: WidgetGroupWidthV1Schema.optional(), title: z.string().trim().min(1).optional(), context: WidgetInputBindingsV1Schema.optional() }).strict(),
  'widgets.group.ungroup': groupRefInput,
  'widgets.group.set': groupRefInput.extend({ width: WidgetGroupWidthV1Schema.optional(), dividers: z.enum(['hairline', 'none']).optional() }).strict(),
  'widgets.group.inputs.set': groupRefInput.extend({ bindings: WidgetInputBindingsV1Schema }).strict(),
  'widgets.area.layout.list': layoutInput,
  'widgets.area.layout.create': layoutInput.extend({ layoutId: z.string().trim().min(1), name: layoutName, fromSurface: areaSurface.optional() }).strict(),
  'widgets.area.layout.rename': layoutMutationInput.extend({ name: layoutName }).strict(),
  'widgets.area.layout.delete': layoutMutationInput,
  'widgets.area.layout.reorder': layoutMutationInput.extend({ position: AnchoredListPositionV1Schema }).strict(),
  'widgets.area.layout.select': z.object({ surface: areaSurface }).strict(),
  'widgets.catalog.list': surfaceInput.extend({ boundSession: VoiceTrackedSessionAddressV1Schema.optional() }).strict(),
  'widgets.item.list': surfaceInput,
  // `groupId` places the new widget into that group of the layout (a group's empty slot).
  'widgets.item.add': z.object({ surface: WidgetSurfaceRefV1Schema, instance: WidgetInstanceV1Schema, area: WidgetProjectAreaV1Schema.optional(), size: WidgetSizeV1Schema.optional(), toIndex: index.optional(), placement: SessionBoardItemPlacementV1Schema.optional(), groupId: z.string().trim().min(1).optional() }).strict(),
  'widgets.item.remove': refInput,
  'widgets.item.move': z.union([
    z.object({ ref: WidgetInstanceRefV1Schema, toIndex: index, area: WidgetProjectAreaV1Schema.optional(), groupId: z.string().trim().min(1).nullable().optional() }).strict(),
    z.object({ ref: WidgetInstanceRefV1Schema, to: WidgetMoveDestinationV1Schema }).strict(),
  ]),
  'widgets.item.rename': z.object({ ref: WidgetInstanceRefV1Schema, displayName: z.string().trim().min(1).nullable() }).strict(),
  'widgets.item.size.set': z.union([
    z.object({ ref: WidgetInstanceRefV1Schema, size: WidgetSizeV1Schema }).strict(),
    z.object({ ref: groupRef, width: WidgetGroupWidthV1Schema }).strict(),
  ]),
  'widgets.item.frame.set': z.object({ ref: WidgetInstanceRefV1Schema, frameStyle: WidgetFrameStyleV1Schema.nullable() }).strict(),
  'widgets.item.inputs.get': refInput,
  'widgets.item.inputs.validate': bindingsInput,
  'widgets.item.inputs.set': bindingsInput.extend({ paths: z.array(InputPathSchema).optional() }).strict(),
  'widgets.item.inputs.reset': refInput.extend({ paths: z.array(InputPathSchema).optional() }).strict(),
  'widgets.item.refresh': refInput,
} as const;

export const WidgetPlacementV1Schema = lazyZodSchema(() => z.object({
  instance: WidgetInstanceV1Schema, area: WidgetProjectAreaV1Schema.optional(), size: WidgetSizeV1Schema.optional(), frameStyle: WidgetFrameStyleV1Schema.optional(),
}).strict());
export type WidgetPlacementV1 = z.infer<typeof WidgetPlacementV1Schema>;
export const WidgetSurfaceReadV1Schema = lazyZodSchema(() => z.object({
  surface: WidgetSurfaceRefV1Schema, instances: z.array(WidgetPlacementV1Schema), canEdit: z.boolean(),
  items: WidgetLayoutItemsV1Schema.optional(),
  preset: WidgetAreaPresetStateV1Schema.optional(),
  state: z.enum(['missing', 'present']).optional(), isShared: z.boolean().optional(),
  revision: ArtifactRevisionV1Schema.nullable().optional(),
  /** Admitted selected-document facts, independent of Source membership and acting viewer. */
  dashboard: z.object({ name: z.string().trim().min(1), ownerAccountId: z.string().min(1), access: ArtifactCallerAccessV1Schema }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (new Set(value.instances.map(entry => entry.instance.id)).size !== value.instances.length) context.addIssue({ code: 'custom', path: ['instances'], message: 'Duplicate widget instance identity' });
}));
export type WidgetSurfaceReadV1 = z.infer<typeof WidgetSurfaceReadV1Schema>;
export const WidgetCatalogEntryV1Schema = lazyZodSchema(() => z.object({
  sizeDeclaration: WidgetSizeDeclarationV1Schema, presentation: WidgetSurfacePresentationV1Schema,
  definition: WidgetDefinitionRefV1Schema, title: z.string().trim().min(1),
  fields: z.array(InputFieldHintSchema), availability: z.enum(['available', 'unavailable', 'denied']),
  instanceCount: z.number().int().nonnegative().safe(),
}).strict());
export type WidgetCatalogEntryV1 = z.infer<typeof WidgetCatalogEntryV1Schema>;
export type WidgetCatalogSourceEntryV1 = Omit<WidgetCatalogEntryV1, 'presentation'>;
export const WidgetBindingResolutionV1Schema = lazyZodSchema(() => z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), input: z.record(z.string(), StrictJsonValueSchema) }).strict(),
  ...(['selection_required', 'invalid', 'unavailable', 'denied'] as const).map(status => z.object({
    status: z.literal(status), fields: z.array(z.object({
      path: InputPathSchema, status: z.enum(['selection_required', 'invalid', 'unavailable', 'denied']), reasonCode: z.string().trim().min(1),
    }).strict()),
  }).strict()),
]));
const mutationResult = z.object({ ref: WidgetInstanceRefV1Schema, instance: WidgetInstanceV1Schema.nullable(), item: WidgetLayoutItemV1Schema.nullable().optional(), area: WidgetProjectAreaV1Schema.optional() }).strict();
const inputsResult = z.object({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema }).strict();
export const WidgetInstanceActionOutputSchemasV1 = {
  'widgets.area.layout.reset': WidgetAreaPresetResultV1Schema,
  'widgets.area.layout.undo': WidgetAreaPresetResultV1Schema,
  'widgets.group.add': mutationResult,
  'widgets.group.create': mutationResult, 'widgets.group.ungroup': mutationResult,
  'widgets.group.set': mutationResult, 'widgets.group.inputs.set': mutationResult,
  'widgets.area.layout.list': z.object({ surface: layoutSurface, layouts: z.array(WidgetAreaLayoutSummaryV1Schema) }).strict(),
  'widgets.area.layout.create': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.rename': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.delete': z.object({ surface: layoutSurface, artifactId: z.string().min(1) }).strict(),
  'widgets.area.layout.reorder': WidgetAreaLayoutSummaryV1Schema,
  'widgets.area.layout.select': WidgetSurfaceReadV1Schema,
  'widgets.catalog.list': z.object({ surface: WidgetSurfaceRefV1Schema, entries: z.array(WidgetCatalogEntryV1Schema), presentation: WidgetSurfacePresentationV1Schema }).strict(),
  'widgets.item.list': WidgetSurfaceReadV1Schema,
  'widgets.item.add': mutationResult, 'widgets.item.remove': mutationResult,
  'widgets.item.move': mutationResult.extend({ fromRef: WidgetInstanceRefV1Schema.optional(), status: z.literal('moved').optional() }).strict(), 'widgets.item.rename': mutationResult,
  'widgets.item.size.set': mutationResult, 'widgets.item.frame.set': mutationResult,
  'widgets.item.inputs.get': inputsResult, 'widgets.item.inputs.validate': WidgetBindingResolutionV1Schema,
  'widgets.item.inputs.set': mutationResult, 'widgets.item.inputs.reset': mutationResult,
  'widgets.item.refresh': z.object({ ref: WidgetInstanceRefV1Schema, status: z.literal('refreshed') }).strict(),
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
  resolve(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; groupBindings?: WidgetInstanceV1['bindings']; admission?: 'configuration' | 'execution'; signal?: AbortSignal }>): Promise<WidgetBindingResolutionV1>;
  readSizeDeclaration(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; groupBindings?: WidgetInstanceV1['bindings']; signal?: AbortSignal }>): Promise<WidgetSizeDeclarationV1 | null>;
}>;
