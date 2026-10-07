import { z } from 'zod';
import { InputFieldHintSchema, InputPathSchema } from '../inputs/inputFields.js';
import { StrictJsonValueSchema } from '../json/strictJsonValue.js';
import { SessionBoardItemPlacementV1Schema } from '../sessions/board/layoutOperations.js';
import { SessionBoardTabIdSchema } from '../sessions/board/ids.js';
import { SessionSystemRecordRevisionSchema } from '../sessions/system/records/sessionSystemRecordRevision.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteResult } from '../actions/actionExecutionResult.js';
import type { WidgetInstanceActionIdV1 } from './actionIdsV1.js';
import { WidgetExpectedPresentationV1Schema, WidgetSizeV1Schema, WidgetSizeDeclarationV1Schema, WidgetFrameStyleV1Schema, WidgetSurfacePresentationV1Schema, type WidgetExpectedPresentationV1, type WidgetSizeDeclarationV1 } from './widgetPresentationV1.js';
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

export { WIDGET_INSTANCE_ACTION_IDS_V1, WidgetInstanceActionIdV1Schema } from './actionIdsV1.js';
export type { WidgetInstanceActionIdV1 } from './actionIdsV1.js';
/** One nested-target reader for Action policy, approval custody and widget execution. */
export function readWidgetActionSurfaceV1(input: unknown): WidgetSurfaceRefV1 | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const outer = input as Readonly<Record<string, unknown>>;
  const ref = outer.ref && typeof outer.ref === 'object' && !Array.isArray(outer.ref)
    ? outer.ref as Readonly<Record<string, unknown>> : undefined;
  const parsed = WidgetSurfaceRefV1Schema.safeParse(outer.surface ?? ref?.surface);
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
export const WidgetMoveCaptureV1Schema = z.object({
  expectedInstance: WidgetInstanceV1Schema, expectedPresentation: WidgetExpectedPresentationV1Schema.optional(),
  boardRevisions: z.object({ itemRevision: SessionSystemRecordRevisionSchema, layoutRevision: SessionSystemRecordRevisionSchema }).strict().optional(),
}).strict().refine(value => value.expectedPresentation !== undefined || value.boardRevisions !== undefined, 'Native presentation or exact Board revisions required');
export type WidgetMoveCaptureV1 = z.infer<typeof WidgetMoveCaptureV1Schema>;
export const WidgetMoveDestinationV1Schema = z.object({ surface: WidgetSurfaceRefV1Schema, tabId: SessionBoardTabIdSchema.optional(), index: nativeIndex }).strict();
export const WidgetTransferFailureDetailsV1Schema = z.object({
  fromRef: WidgetInstanceRefV1Schema, toRef: WidgetInstanceRefV1Schema,
  phase: z.enum(['preflight', 'destination_add', 'source_remove', 'compensation']),
  source: z.enum(['present', 'absent', 'unknown']), destination: z.enum(['present', 'absent', 'unknown']),
  reasonCode: z.string().trim().min(1),
  instance: WidgetInstanceV1Schema.optional(),
}).strict().refine(value => value.instance === undefined || value.phase !== 'preflight' && value.source === 'absent' && value.destination === 'absent',
  'Recovery instance requires current absent facts from both owners after a write phase');
export type WidgetTransferFailureDetailsV1 = z.infer<typeof WidgetTransferFailureDetailsV1Schema>;
const surfaceInput = z.object({ surface: WidgetSurfaceRefV1Schema }).strict();
const refInput = z.object({ ref: WidgetInstanceRefV1Schema }).strict();
const bindingsInput = z.object({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema }).strict();
const areaSurface = WidgetSurfaceRefV1Schema.refine(surface => surface.owner.kind === 'project' || surface.owner.kind === 'pluginArea', 'Area surface required');
export const WidgetAreaPresentationIntentV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('move'), instanceId: z.string().trim().min(1), toIndex: index }).strict(),
  z.object({ kind: z.literal('size'), instanceId: z.string().trim().min(1), size: WidgetSizeV1Schema }).strict(),
  z.object({ kind: z.literal('frame'), instanceId: z.string().trim().min(1), frameStyle: WidgetFrameStyleV1Schema.nullable() }).strict(),
]);
export const WidgetInstanceActionInputSchemasV1 = {
  'widgets.area.layout.get': z.object({ surface: areaSurface }).strict(),
  'widgets.area.layout.update': z.object({ surface: areaSurface, intent: WidgetAreaPresentationIntentV1Schema }).strict(),
  'widgets.catalog.list': surfaceInput.extend({ boundSession: VoiceTrackedSessionAddressV1Schema.optional() }).strict(),
  'widgets.instance.list': surfaceInput,
  'widgets.instance.add': z.object({ surface: WidgetSurfaceRefV1Schema, instance: WidgetInstanceV1Schema, size: WidgetSizeV1Schema.optional(), toIndex: index.optional(), placement: SessionBoardItemPlacementV1Schema.optional() }).strict(),
  'widgets.instance.remove': refInput,
  'widgets.instance.move': z.union([
    z.object({ ref: WidgetInstanceRefV1Schema, toIndex: index }).strict(),
    z.object({ ref: WidgetInstanceRefV1Schema, to: WidgetMoveDestinationV1Schema }).strict(),
  ]),
  'widgets.instance.rename': z.object({ ref: WidgetInstanceRefV1Schema, displayName: z.string().trim().min(1).nullable() }).strict(),
  'widgets.instance.size.set': z.object({ ref: WidgetInstanceRefV1Schema, size: WidgetSizeV1Schema }).strict(),
  'widgets.instance.frame.set': z.object({ ref: WidgetInstanceRefV1Schema, frameStyle: WidgetFrameStyleV1Schema.nullable() }).strict(),
  'widgets.instance.inputs.get': refInput,
  'widgets.instance.inputs.validate': bindingsInput,
  'widgets.instance.inputs.set': bindingsInput,
  'widgets.instance.inputs.reset': refInput,
  'widgets.instance.refresh': refInput,
} as const;

export const WidgetPlacementV1Schema = z.object({
  instance: WidgetInstanceV1Schema, size: WidgetSizeV1Schema.optional(), frameStyle: WidgetFrameStyleV1Schema.optional(),
}).strict();
export type WidgetPlacementV1 = z.infer<typeof WidgetPlacementV1Schema>;
export const WidgetSurfaceReadV1Schema = z.object({
  surface: WidgetSurfaceRefV1Schema, instances: z.array(WidgetPlacementV1Schema), canEdit: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.instances.map(entry => entry.instance.id)).size !== value.instances.length) context.addIssue({ code: 'custom', path: ['instances'], message: 'Duplicate widget instance identity' });
});
export type WidgetSurfaceReadV1 = z.infer<typeof WidgetSurfaceReadV1Schema>;
export const WidgetCatalogEntryV1Schema = z.object({
  sizeDeclaration: WidgetSizeDeclarationV1Schema, presentation: WidgetSurfacePresentationV1Schema,
  definition: WidgetDefinitionRefV1Schema, title: z.string().trim().min(1),
  fields: z.array(InputFieldHintSchema), availability: z.enum(['available', 'unavailable', 'denied']),
  instanceCount: z.number().int().nonnegative().safe(),
}).strict();
export type WidgetCatalogEntryV1 = z.infer<typeof WidgetCatalogEntryV1Schema>;
export type WidgetCatalogSourceEntryV1 = Omit<WidgetCatalogEntryV1, 'presentation'>;
export const WidgetBindingResolutionV1Schema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), input: z.record(z.string(), StrictJsonValueSchema) }).strict(),
  ...(['selection_required', 'invalid', 'unavailable', 'denied'] as const).map(status => z.object({
    status: z.literal(status), fields: z.array(z.object({
      path: InputPathSchema, status: z.enum(['selection_required', 'invalid', 'unavailable', 'denied']), reasonCode: z.string().trim().min(1),
    }).strict()),
  }).strict()),
]);
const mutationResult = z.object({ ref: WidgetInstanceRefV1Schema, instance: WidgetInstanceV1Schema.nullable() }).strict();
const inputsResult = z.object({ ref: WidgetInstanceRefV1Schema, bindings: WidgetInputBindingsV1Schema }).strict();
export const WidgetInstanceActionOutputSchemasV1 = {
  'widgets.area.layout.get': WidgetSurfaceReadV1Schema,
  'widgets.area.layout.update': mutationResult,
  'widgets.catalog.list': z.object({ surface: WidgetSurfaceRefV1Schema, entries: z.array(WidgetCatalogEntryV1Schema), presentation: WidgetSurfacePresentationV1Schema }).strict(),
  'widgets.instance.list': WidgetSurfaceReadV1Schema,
  'widgets.instance.add': mutationResult, 'widgets.instance.remove': mutationResult,
  'widgets.instance.move': mutationResult.extend({ fromRef: WidgetInstanceRefV1Schema.optional(), status: z.literal('moved').optional() }).strict(), 'widgets.instance.rename': mutationResult,
  'widgets.instance.size.set': mutationResult, 'widgets.instance.frame.set': mutationResult,
  'widgets.instance.inputs.get': inputsResult, 'widgets.instance.inputs.validate': WidgetBindingResolutionV1Schema,
  'widgets.instance.inputs.set': mutationResult, 'widgets.instance.inputs.reset': mutationResult,
  'widgets.instance.refresh': z.object({ ref: WidgetInstanceRefV1Schema, status: z.literal('refreshed') }).strict(),
} as const;

/** Adapters translate into existing domain intents; they do not persist or reduce a parallel layout. */
export type WidgetSurfaceMutationV1 =
  | Readonly<{ kind: 'add'; instance: WidgetInstanceV1; toIndex?: number; placement?: z.infer<typeof SessionBoardItemPlacementV1Schema>;
      position?: Readonly<{ tabId?: string; index: number }>; presentation?: Readonly<{ size?: z.infer<typeof WidgetSizeV1Schema>; frameStyle?: 'card' | 'plain' }>; captureForMove?: true }>
  | Readonly<{ kind: 'remove'; instanceId: string; expectedInstance?: WidgetInstanceV1; expectedPresentation?: WidgetExpectedPresentationV1; boardRevisions?: WidgetMoveCaptureV1['boardRevisions'] }>
  | Readonly<{ kind: 'move'; instanceId: string; toIndex: number }>
  | Readonly<{ kind: 'move'; instanceId: string; nativeIndex: number; tabId?: string }>
  | Readonly<{ kind: 'rename'; instanceId: string; displayName: string | null }>
  | Readonly<{ kind: 'size'; instanceId: string; size: z.infer<typeof WidgetSizeV1Schema> }>
  | Readonly<{ kind: 'frame'; instanceId: string; frameStyle: 'card' | 'plain' | null }>
  | Readonly<{ kind: 'inputs'; instanceId: string; bindings: WidgetInstanceV1['bindings'] }>;
export type WidgetActionSurfacePortV1 = Readonly<{
  read(surface: WidgetSurfaceRefV1, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetSurfaceReadV1 | Extract<ActionExecuteResult, { ok: false }>>;
  apply(surface: WidgetSurfaceRefV1, intent: WidgetSurfaceMutationV1, context: ActionExecutorContext, signal?: AbortSignal): Promise<ActionExecuteResult>;
  captureMove?(surface: WidgetSurfaceRefV1, instanceId: string, context: ActionExecutorContext, signal?: AbortSignal): Promise<WidgetMoveCaptureV1 | Extract<ActionExecuteResult, { ok: false }>>;
}>;
export type WidgetActionInputResolverV1 = Readonly<{
  resolve(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; admission?: 'configuration' | 'execution'; signal?: AbortSignal }>): Promise<WidgetBindingResolutionV1>;
  readSizeDeclaration(args: Readonly<{ ref: WidgetInstanceRefV1; instance: WidgetInstanceV1; context: ActionExecutorContext; signal?: AbortSignal }>): Promise<WidgetSizeDeclarationV1 | null>;
}>;
