import { ActionExecuteFailureSchema } from '../actions/actionExecutionResult.js';
import type { ActionExecutorDeps } from '../actions/executor/types.js';
import { SessionBoardGetResultV1Schema } from '../sessions/board/actions.js';
import { isSessionSurfaceItemIdentityCorrespondingV1 } from '../sessions/board/item.js';
import { WidgetDefinitionDraftV1Schema, projectWidgetDefinitionForSharedPublicationV1 } from './widgetDefinitionV1.js';
import type { WidgetDefinitionActionDepsV1 } from './definitionActionsV1.js';
import type { WidgetInputDescriptorV1 } from './widgetInputAdmissionV1.js';
import type { WidgetDefinitionRefV1, WidgetInputBindingsV1 } from './widgetInstanceV1.js';
import { WIDGET_SIZE_ORDER_V1 } from './widgetPresentationV1.js';

/** The copy's Session read becomes configurable; UI disclosure consumes this same transformation. */
export function projectWidgetDefinitionPromotionBindingsV1(
    definition: Readonly<{ sessionInputPath?: string }>, bindings: WidgetInputBindingsV1,
): WidgetInputBindingsV1 {
    return { ...bindings, ...(definition.sessionInputPath ? { [definition.sessionInputPath]: { kind: 'context' as const, slot: 'session' } } : {}) };
}

/** Sealed Session content stays with its existing reader and is copied only on explicit promotion. */
export function createSessionWidgetDefinitionSourceReaderV1(input: Readonly<{
    sessionBoardAction: NonNullable<ActionExecutorDeps['sessionBoardAction']>;
    readInstalledDescriptor(definition: Extract<WidgetDefinitionRefV1, { kind: 'installed' }>,
        request: Parameters<NonNullable<WidgetDefinitionActionDepsV1['readSessionWidgetDefinitionSource']>>[0]): Promise<WidgetInputDescriptorV1 | null>;
}>): NonNullable<WidgetDefinitionActionDepsV1['readSessionWidgetDefinitionSource']> {
    const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    return async request => {
        const value = await input.sessionBoardAction({ actionId: 'session.board.get',
            input: { sessionId: request.session.sessionId, itemIds: [request.itemId] },
            context: { ...request.context, serverId: request.session.serverId }, signal: request.signal });
        const refused = ActionExecuteFailureSchema.safeParse(value);
        if (refused.success) return refused.data;
        const board = SessionBoardGetResultV1Schema.safeParse(value);
        if (!board.success || board.data.serverId !== request.session.serverId || board.data.sessionId !== request.session.sessionId) return fail('invalid_action_output');
        if (board.data.incomplete) return fail('widget_definition_source_incomplete');
        const row = board.data.items.find(item => item.itemId === request.itemId);
        const item = row?.item;
        if (!item || !isSessionSurfaceItemIdentityCorrespondingV1(request.itemId, item)) return fail('widget_definition_source_unavailable');
        if (item.source.kind === 'declarative') return {
            definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || request.itemId,
                sizeDeclaration: { sizes: [...WIDGET_SIZE_ORDER_V1], defaultSize: 'medium' },
                body: { kind: 'declarative', document: item.source.document }, inputs: { fields: [] }, inputSchema: { type: 'object', additionalProperties: false } }),
            bindings: {},
        };
        if (item.source.kind !== 'widget') return fail('widget_definition_source_unsupported');
        if (item.source.instance.definition.kind === 'inline') {
            const { v: _v, id: _id, provenance: _provenance, ...draft } = projectWidgetDefinitionForSharedPublicationV1(item.source.instance.definition.definition);
            return { definition: WidgetDefinitionDraftV1Schema.parse(draft), bindings: item.source.instance.bindings };
        }
        if (item.source.instance.definition.kind !== 'installed') return fail('widget_definition_source_unsupported');
        const descriptor = await input.readInstalledDescriptor(item.source.instance.definition, request);
        request.signal?.throwIfAborted();
        if (!descriptor?.inputSchema || !descriptor.sizeDeclaration) return fail('widget_definition_source_unavailable');
        return { definition: WidgetDefinitionDraftV1Schema.parse({ name: item.title || request.itemId,
            sizeDeclaration: descriptor.sizeDeclaration,
            body: item.source.instance.definition, inputs: descriptor.inputs ?? { fields: [] }, inputSchema: descriptor.inputSchema,
            ...(descriptor.sessionInputPath ? { sessionInputPath: descriptor.sessionInputPath } : {}),
            ...('connectedAccountPurposeBindings' in descriptor ? { connectedAccountPurposeBindings: descriptor.connectedAccountPurposeBindings } : {}),
        }), bindings: item.source.instance.bindings };
    };
}
