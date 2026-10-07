import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { EntityDropEffectV1 } from '@happier-dev/protocol/plugins/ui';
import { SessionBoardLayoutUpdateInputV1Schema } from '@happier-dev/protocol/sessions/board';
import { CurrentSessionPresentationActionInputV1Schema, type SessionCompanionPresentationItemRefV1 } from '@happier-dev/protocol/sessions';

import type { WindowBounds, WindowPointer } from '@/components/ui/treeDragDrop/treeDragDropTypes';
import { sessionCompanionItemKey } from '../companion/state/sessionCompanionPreference';
import { WidgetInstanceActionInputSchemasV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

/** Project semantic placement to its target edge, including keyboard carries without a pointer. */
export function resolveSessionSurfaceIndicatorEdge(input: Readonly<{
    effect: EntityDropEffectV1;
    bounds: WindowBounds | null;
    pointer: WindowPointer | null;
    companionTarget?: Readonly<{ itemKey: string; items: readonly SessionCompanionPresentationItemRefV1[] }>;
    boardTarget?: Readonly<{ surface: WidgetSurfaceRefV1; tabId: string; itemId: string; itemIds: readonly string[] }>;
    widgetAreaTarget?: Readonly<{ surface: WidgetSurfaceRefV1; itemId: string; itemIds: readonly string[] }>;
}>): 'top' | 'bottom' | null {
    if (input.effect.actionId === 'session.board.layout.update') {
        const parsed = SessionBoardLayoutUpdateInputV1Schema.safeParse(input.effect.input);
        if (!parsed.success || parsed.data.operation.op !== 'item.move' || !parsed.data.operation.anchor) return null;
        return parsed.data.operation.anchor.side === 'before' ? 'top' : 'bottom';
    }
    if (input.effect.actionId === 'session.presentation.apply') {
        const parsed = CurrentSessionPresentationActionInputV1Schema.safeParse(input.effect.input);
        if (!parsed.success || parsed.data.intent.kind !== 'companion.item.move' || !input.companionTarget) return null;
        const intent = parsed.data.intent;
        const movedKey = sessionCompanionItemKey(intent.item);
        const { items, itemKey } = input.companionTarget;
        if (!items.some(item => sessionCompanionItemKey(item) === movedKey)) return null;
        const remaining = items.filter(item => sessionCompanionItemKey(item) !== movedKey);
        const targetIndex = remaining.findIndex(item => sessionCompanionItemKey(item) === itemKey);
        if (targetIndex < 0) return null;
        return intent.toIndex <= targetIndex ? 'top' : 'bottom';
    }
    if (input.effect.actionId === 'widgets.instance.move' && input.companionTarget) {
        const move = WidgetInstanceActionInputSchemasV1['widgets.instance.move'].safeParse(input.effect.input);
        if (move.success && 'to' in move.data && move.data.to.surface.owner.kind === 'companion') {
            const { ref, to } = move.data;
            const { items, itemKey } = input.companionTarget;
            const remaining = sameStrictJsonValue(ref.surface, to.surface)
                ? items.filter(item => item.kind !== 'instance' || item.instance.id !== ref.instanceId) : items;
            const targetIndex = remaining.findIndex(item => sessionCompanionItemKey(item) === itemKey);
            return targetIndex < 0 ? null : to.index <= targetIndex ? 'top' : 'bottom';
        }
    }
    if (input.effect.actionId === 'widgets.instance.move' && input.boardTarget) {
        const move = WidgetInstanceActionInputSchemasV1['widgets.instance.move'].safeParse(input.effect.input);
        if (move.success && 'to' in move.data) {
            const { ref, to } = move.data;
            const target = input.boardTarget;
            if (!sameStrictJsonValue(to.surface, target.surface) || to.tabId !== target.tabId) return null;
            const remaining = sameStrictJsonValue(ref.surface, to.surface)
                ? target.itemIds.filter(id => id !== ref.instanceId) : target.itemIds;
            const index = remaining.indexOf(target.itemId);
            return index < 0 ? null : to.index <= index ? 'top' : 'bottom';
        }
    }
    if (input.effect.actionId === 'widgets.instance.move' && input.widgetAreaTarget) {
        const move = WidgetInstanceActionInputSchemasV1['widgets.instance.move'].safeParse(input.effect.input);
        if (move.success && 'to' in move.data) {
            const { ref, to } = move.data;
            const target = input.widgetAreaTarget;
            if (!sameStrictJsonValue(to.surface, target.surface)) return null;
            const remaining = sameStrictJsonValue(ref.surface, to.surface) ? target.itemIds.filter(id => id !== ref.instanceId) : target.itemIds;
            const index = remaining.indexOf(target.itemId);
            return index < 0 ? null : to.index <= index ? 'top' : 'bottom';
        }
    }
    // Other kinds may use current pointer geometry. Widget inventory ordinals
    // are deliberately not interpreted as mixed Companion placement indices.
    if (!input.bounds || !input.pointer) return null;
    return input.pointer.y < input.bounds.y + input.bounds.height / 2 ? 'top' : 'bottom';
}
