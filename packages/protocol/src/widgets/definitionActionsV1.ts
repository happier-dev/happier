import { z } from 'zod';
import { VoiceTrackedSessionAddressV1Schema } from '../sessions/follow/voiceTrackedTargetsCompatibilityV1.js';
import { WidgetDefinitionDraftV1Schema, WidgetDefinitionPatchV1Schema, WidgetDefinitionV1Schema, type WidgetDefinitionDraftV1 } from './widgetDefinitionV1.js';
import { WidgetInstanceRefV1Schema, WidgetInputBindingsV1Schema } from './widgetInstanceV1.js';
import type { ActionExecutorContext } from '../actions/executor/types.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import type { WidgetDefinitionArtifactPortV1 } from './widgetDefinitionArtifactV1.js';
import { WidgetDefinitionSummaryV1Schema } from './widgetDefinitionArtifactV1.js';
export { WIDGET_DEFINITION_ACTION_IDS_V1, WidgetDefinitionActionIdV1Schema } from './definitionActionIdsV1.js';
export type { WidgetDefinitionActionIdV1 } from './definitionActionIdsV1.js';

const id = z.string().trim().min(1);
export const WidgetDefinitionAccountV1Schema = z.object({ serverId: id, accountId: id }).strict();
const account = z.object({ account: WidgetDefinitionAccountV1Schema }).strict();
const reference = account.extend({ artifactId: id }).strict();
export const WidgetDefinitionActionInputSchemasV1 = {
    'widgets.definition.list': account,
    'widgets.definition.get': reference,
    'widgets.definition.create': account.extend({ artifactId: id, definition: WidgetDefinitionDraftV1Schema }).strict(),
    'widgets.definition.update': reference.extend({ patch: WidgetDefinitionPatchV1Schema }).strict(),
    'widgets.definition.duplicate': reference.extend({ newArtifactId: id, name: id.optional() }).strict(),
    'widgets.definition.delete': reference,
    'widgets.definition.saveFromSession': account.extend({ session: VoiceTrackedSessionAddressV1Schema, itemId: id, artifactId: id, name: id.optional() }).strict(),
} as const;
export const WidgetDefinitionPlacementSummaryV1Schema = z.object({ placements: z.array(WidgetInstanceRefV1Schema), unavailableScopes: z.array(id) }).strict();
const result = z.object({ definition: WidgetDefinitionV1Schema }).strict();
export const WidgetDefinitionActionOutputSchemasV1 = {
    'widgets.definition.list': z.object({ definitions: z.array(WidgetDefinitionSummaryV1Schema) }).strict(),
    'widgets.definition.get': result.extend({ placementSummary: WidgetDefinitionPlacementSummaryV1Schema.optional() }).strict(),
    'widgets.definition.create': result, 'widgets.definition.update': result, 'widgets.definition.duplicate': result,
    'widgets.definition.delete': z.object({ artifactId: id, status: z.literal('deleted') }).strict(),
    'widgets.definition.saveFromSession': result.extend({ suggestedBindings: WidgetInputBindingsV1Schema }).strict(),
} as const;
/** Current sealed Session item plus admitted descriptor; this reader never removes or rewrites it. */
export type SessionWidgetDefinitionSourceV1 = Readonly<{ definition: WidgetDefinitionDraftV1; bindings: z.infer<typeof WidgetInputBindingsV1Schema> }>;
export type WidgetDefinitionActionDepsV1 = Readonly<{
    widgetAccountScope?: () => Readonly<{ serverId: string; accountId: string }> | null;
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
