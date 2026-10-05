import * as React from 'react';
import type { EntityDragScopeV1, EntityDropAdmissionV1, EntityDropEffectV1, EntityDropOutcomeV1 } from '@happier-dev/protocol/plugins/ui';
import { useEntityDragDropRuntime, type EntityDragDropRuntime } from '@/components/ui/treeDragDrop';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import { createWorkBoardUiActionPort, WorkBoardUiAdmissionError, workBoardWidgetSurface, type WorkBoardEntityContext } from './workBoardEntityDrop';
import { useWorkBoardSaveQueue } from './useWorkBoards';
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
    const queue = useWorkBoardSaveQueue();
    const widgetSurface = React.useMemo(() => scope && enabled ? workBoardWidgetSurface(scope, context.board.id) : null, [scope, enabled, context.board.id]);
    const movement = useWidgetMovementAdmission(widgetSurface, context.board);
    const latest = React.useRef({ scope, lifetime, context, enabled, movement }); latest.current = { scope, lifetime, context, enabled, movement };
    return React.useMemo(() => {
        if (!scope || !lifetime) return null;
        const isCurrent = () => latest.current.enabled && lifetime.isCurrent() && latest.current.lifetime === lifetime
            && latest.current.scope?.serverId === scope.serverId && latest.current.scope.accountId === scope.accountId
            && latest.current.context.board.id === context.board.id;
        const getContext = (): WorkBoardEntityContext => ({ ...latest.current.context, scope });
        const executor = createDefaultActionExecutor({ workBoardArtifacts: createWorkBoardUiActionPort(() => isCurrent() ? getContext() : null, queue) });
        return { runtime, scope, isCurrent, getContext, admitWidgetMovement: effect => latest.current.movement.admit(effect), async execute(effect) {
            if (!isCurrent()) return { status: 'refused', reason: { code: 'board_scope_retired', message: t('entityDragDrop.reasons.gone') } };
            if (effect.actionId === 'widgets.instance.move') return executeWidgetEntityMovement(effect, scope);
            if (effect.actionId !== 'boards.apply') return { status: 'refused', reason: { code: 'invalid-board-action', message: t('entityDragDrop.reasons.generic') } };
            try {
                const result = await executor.execute('boards.apply', effect.input, { serverId: scope.serverId,
                    expectedAccountId: scope.accountId, surface: 'ui', bypassApprovals: true });
                if (result.ok) return { status: 'applied' };
                if (result.errorCode === 'outcome_unknown') return { status: 'unknown', reason: {
                    code: 'board_write_unknown', message: t('entityDragDrop.preview.unknownDetail'),
                } };
                return { status: 'refused', reason: { code: result.errorCode ?? 'board-action-refused', message: t('entityDragDrop.reasons.generic') } };
            } catch (error) {
                if (error instanceof WorkBoardUiAdmissionError) return { status: 'refused', reason: { code: error.code, message: t('entityDragDrop.reasons.gone') } };
                return { status: 'unknown', reason: { code: 'board_write_unknown', message: t('entityDragDrop.preview.unknownDetail') } };
            }
        } } satisfies WorkBoardEntityBinding;
    }, [runtime, scope?.serverId, scope?.accountId, lifetime, queue, context.board.id]);
}
