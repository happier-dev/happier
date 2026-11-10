import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { ArtifactCreateIdV1Schema } from '../artifacts/artifactIdV1.js';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedSessionAddressV1.js';
import { WidgetDefinitionDraftV1Schema, WidgetDefinitionPatchV1Schema, WidgetDefinitionV1Schema, type WidgetDefinitionDraftV1 } from './widgetDefinitionV1.js';
import { WidgetInstanceRefV1Schema, WidgetInputBindingsV1Schema } from './widgetInstanceV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { WidgetDefinitionArtifactPortV1 } from './widgetDefinitionArtifactV1.js';
import { WidgetDefinitionSummaryV1Schema } from './widgetDefinitionArtifactV1.js';
export { WIDGET_DEFINITION_ACTION_IDS_V1, WidgetDefinitionActionIdV1Schema } from './definitionActionIdsV1.js';
export type { WidgetDefinitionActionIdV1 } from './definitionActionIdsV1.js';

const id = z.string().check(z.trim(), z.minLength(1));
export const WidgetDefinitionAccountV1Schema = lazyZodSchema(() => z.strictObject({ serverId: id, accountId: id }));
const account = z.strictObject({ account: WidgetDefinitionAccountV1Schema });
const reference = (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(account, { artifactId: id }));
export const WidgetDefinitionActionInputSchemasV1 = {
    'widgets.definition.list': account,
    'widgets.definition.get': reference,
    'widgets.definition.create': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(account, { artifactId: ArtifactCreateIdV1Schema, definition: WidgetDefinitionDraftV1Schema })),
    'widgets.definition.update': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { patch: WidgetDefinitionPatchV1Schema })),
    'widgets.definition.duplicate': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(reference, { newArtifactId: ArtifactCreateIdV1Schema, name: z.optional(id) })),
    'widgets.definition.delete': reference,
    'widgets.definition.saveFromSession': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(account, { session: VoiceTrackedSessionAddressV1Schema, itemId: id, artifactId: ArtifactCreateIdV1Schema, name: z.optional(id) })),
} as const;
export const WidgetDefinitionPlacementSummaryV1Schema = lazyZodSchema(() => z.strictObject({ placements: z.array(WidgetInstanceRefV1Schema), unavailableScopes: z.array(id) }));
const result = z.strictObject({ definition: WidgetDefinitionV1Schema });
export const WidgetDefinitionActionOutputSchemasV1 = {
    'widgets.definition.list': z.strictObject({ definitions: z.array(WidgetDefinitionSummaryV1Schema) }),
    'widgets.definition.get': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(result, { placementSummary: z.optional(WidgetDefinitionPlacementSummaryV1Schema) })),
    'widgets.definition.create': result, 'widgets.definition.update': result, 'widgets.definition.duplicate': result,
    'widgets.definition.delete': z.strictObject({ artifactId: id, status: z.literal('deleted') }),
    'widgets.definition.saveFromSession': (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(result, { suggestedBindings: WidgetInputBindingsV1Schema })),
} as const;
/** Current sealed Session item plus admitted descriptor; this reader never removes or rewrites it. */
export type SessionWidgetDefinitionSourceV1 = Readonly<{ definition: WidgetDefinitionDraftV1; bindings: z.infer<typeof WidgetInputBindingsV1Schema> }>;
export type WidgetDefinitionActionDepsV1 = Readonly<{
    widgetAccountScope?: () => import('./widgetActionScopeV1.js').WidgetActionAccountScopeV1 | null;
    widgetDefinitionArtifacts?: WidgetDefinitionArtifactPortV1;
    readSessionWidgetDefinitionSource?: (input: Readonly<{ session: z.infer<typeof VoiceTrackedSessionAddressV1Schema>; itemId: string; context: ActionExecutorContext; signal?: AbortSignal }>) => Promise<SessionWidgetDefinitionSourceV1 | ActionExecuteFailure>;
    describeWidgetDefinitionPlacements?: (artifactId: string, context: ActionExecutorContext) => Promise<z.infer<typeof WidgetDefinitionPlacementSummaryV1Schema>>;
}>;
export function readWidgetDefinitionActionSessionV1(input: unknown) {
    const session = input && typeof input === 'object' ? Reflect.get(input, 'session') : undefined;
    const parsed = VoiceTrackedSessionAddressV1Schema.safeParse(session);
    return parsed.success ? parsed.data : null;
}
export function readWidgetDefinitionActionAccountV1(input: unknown) {
    const value = input && typeof input === 'object' ? Reflect.get(input, 'account') : undefined;
    const parsed = WidgetDefinitionAccountV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
