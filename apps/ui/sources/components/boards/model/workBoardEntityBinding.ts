import * as React from 'react';
import type { EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useEntityDragDropRuntime, type EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { t } from '@/text';
import { workBoardWidgetSurface, type WorkBoardEntityContext } from './workBoardEntityDrop';
import { useDispatchWorkBoardIntent } from './useWorkBoards';
import { WorkBoardActionInputSchemasV1 } from '@happier-dev/protocol/boards/actionsV1';
import { useWidgetMovementAdmission } from '@/components/widgets/surface/useWidgetMovementAdmission';
import { executeWidgetEntityMovement } from '@/sync/ops/actions/widgetEntityMovement';

/** Mounted Board domain/Action port; the canvas only contributes current geometry. */
export type WorkBoardEntityBinding = Readonly<{
    runtime: EntityDragDropRuntime;
    scope: EntityDragScopeV1;
    isCurrent(): boolean;
    getContext(): WorkBoardEntityContext;
    admitWidgetMovement?: (effect: EntityDropEffectV1) => EntityDropAdmissionV1;
    execute(effect: EntityDropEffectV1): Promise<EntityDropOutcomeV1>;
}>;

export function useWorkBoardEntityBinding(context: Omit<WorkBoardEntityContext, 'scope'>, enabled = true): WorkBoardEntityBinding | null {
    const runtime = useEntityDragDropRuntime();
    const scope = useActiveServerAccountScope();
    const lifetime = captureActiveServerAccountScopeLifetime();
    const dispatch = useDispatchWorkBoardIntent(context);
    const widgetSurface = React.useMemo(() => scope && enabled ? workBoardWidgetSurface(scope, context.board.id) : null, [scope, enabled, context.board.id]);
    const movement = useWidgetMovementAdmission(widgetSurface, context.board);
    const latest = React.useRef({ scope, lifetime, context, enabled, movement }); latest.current = { scope, lifetime, context, enabled, movement };
    return React.useMemo(() => {
        if (!scope || !lifetime) return null;
        const isCurrent = () => latest.current.enabled && lifetime.isCurrent() && latest.current.lifetime === lifetime
            && latest.current.scope?.serverId === scope.serverId && latest.current.scope.accountId === scope.accountId
            && latest.current.context.board.id === context.board.id;
        const getContext = (): WorkBoardEntityContext => ({ ...latest.current.context, scope });
        return { runtime, scope, isCurrent, getContext, admitWidgetMovement: effect => latest.current.movement.admit(effect), async execute(effect) {
            if (!isCurrent()) return { status: 'refused', reason: { code: 'board_scope_retired', message: t('entityDragDrop.reasons.gone') } };
            if (effect.actionId === 'widgets.instance.move') return executeWidgetEntityMovement(effect, scope);
            if (effect.actionId !== 'boards.apply') return { status: 'refused', reason: { code: 'invalid-board-action', message: t('entityDragDrop.reasons.generic') } };
            try {
                const parsed = WorkBoardActionInputSchemasV1['boards.apply'].safeParse(effect.input);
                if (!parsed.success) return { status: 'refused', reason: { code: 'invalid_parameters', message: t('entityDragDrop.reasons.generic') } };
                const result = await dispatch(parsed.data.intent);
                if (result.status === 'applied') return { status: 'applied' };
                if (result.status === 'unknown') return { status: 'unknown', reason: {
                    code: 'board_write_unknown', message: t('entityDragDrop.preview.unknownDetail'),
                } };
                return { status: 'refused', reason: { code: result.code, message: t('entityDragDrop.reasons.generic') } };
            } catch {
                return { status: 'unknown', reason: { code: 'board_write_unknown', message: t('entityDragDrop.preview.unknownDetail') } };
            }
        } } satisfies WorkBoardEntityBinding;
    }, [runtime, scope?.serverId, scope?.accountId, lifetime, dispatch, context.board.id]);
}
