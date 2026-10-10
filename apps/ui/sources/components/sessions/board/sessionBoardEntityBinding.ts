import { z } from 'zod';
import { SessionBoardLayoutUpdateInputV1Schema } from '@happier-dev/protocol/sessions/board';
import type { EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import type { SessionBoardController } from './useSessionBoardController';
import { t } from '@/text';
import { WidgetInstanceActionInputSchemasV1 } from '@happier-dev/protocol/widgets';
import { executeWidgetEntityMovement } from '@/sync/ops/actions/widgetEntityMovement';

export const SessionSurfaceAnchorSchema = z.object({ side: z.enum(['before', 'after']), itemId: z.string().min(1) }).strict();
export const SessionBoardDestinationSchema = SessionSurfaceAnchorSchema.extend({ viewId: z.string().min(1) });
export const SessionBoardViewDestinationSchema = z.object({ viewId: z.string().min(1) }).strict();
export const SessionCompanionDestinationSchema = z.object({ side: z.enum(['before', 'after']), itemKey: z.string().min(1) }).strict();

/** Await the existing controller's Action/approval/recovery owner, including unknown acknowledgements. */
export async function executeSessionBoardEntityDrop(controller: SessionBoardController, effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1> {
    if (effect.actionId === 'widgets.item.move') {
        const move = WidgetInstanceActionInputSchemasV1['widgets.item.move'].safeParse(effect.input);
        if (move.success) return executeWidgetEntityMovement(effect, move.data.ref.surface);
    }
    const parsed = SessionBoardLayoutUpdateInputV1Schema.safeParse(effect.input);
    if (effect.actionId !== 'session.board.layout.update' || !parsed.success || parsed.data.operation.op !== 'item.move') {
        return { status: 'refused', reason: { code: 'invalid-move', message: t('entityDragDrop.reasons.generic') } };
    }
    const operation = parsed.data.operation;
    const outcome = await controller.run({ kind: 'item.moveAnchored', itemId: operation.itemId,
        fromViewId: operation.fromTabId, toViewId: operation.toTabId, ...(operation.anchor ? { anchor: operation.anchor } : {}) });
    if (outcome?.kind === 'applied') return { status: 'applied' };
    if (outcome?.kind === 'outcomeUnknown' || outcome?.kind === 'approvalPending') return { status: 'unknown', reason: { code: outcome.kind, message: t('entityDragDrop.preview.unknownDetail') } };
    return { status: 'refused', reason: { code: outcome?.kind ?? 'board-unavailable', message: t('entityDragDrop.reasons.generic') } };
}
