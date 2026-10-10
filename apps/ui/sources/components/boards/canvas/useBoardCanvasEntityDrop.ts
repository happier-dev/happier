import * as React from 'react';
import { Platform, type View } from 'react-native';
import { useEntityDropDomBinding, useEntityDropTarget, type WindowBounds, type WindowPointer } from '@/components/ui/treeDragDrop';
import { measureWindowBounds, readWindowBounds, toTreeDropMeasurableRef } from '@/components/ui/treeDragDrop/registry/measureWindowBounds';
import { BOARD_CANVAS_METRICS, moveBoardCardByKeyboard, resolveBoardCardDrop, type BoardCanvasPoint } from '../model/boardCanvasGeometry';
import { t } from '@/text';
import { resolveWorkBoardEntityDrop, workBoardCanvasKey } from '../model/workBoardEntityDrop';
import type { WorkBoardEntityBinding } from '../model/workBoardEntityBinding';
import { widgetEntitySourceRef, widgetMovementRefused } from '@/sync/ops/actions/widgetEntityMovement';

/** XY is a shape strategy over keys and points; it does not branch on the card's content kind. */
export function useBoardCanvasEntityDrop(binding: WorkBoardEntityBinding, measured: React.RefObject<Map<string, BoardCanvasPoint>>, snap: boolean) {
    const { runtime } = binding;
    const targetId = `work-board-canvas:${React.useId()}`;
    const content = React.useRef<View | null>(null);
    const viewport = React.useRef<unknown>(null);
    const nativeContent = React.useRef<WindowBounds | null>(null);
    const nativeViewport = React.useRef<WindowBounds | null>(null);
    const grab = React.useRef<Readonly<{ key: string; offset: BoardCanvasPoint }> | null>(null);
    const shift = React.useRef(false);
    const latest = React.useRef({ binding, snap }); latest.current = { binding, snap };
    const contentBounds = React.useCallback(() => readWindowBounds(toTreeDropMeasurableRef(content.current)) ?? nativeContent.current, []);
    const getBounds = React.useCallback(() => readWindowBounds(toTreeDropMeasurableRef(viewport.current)) ?? nativeViewport.current, []);
    const refresh = React.useCallback(() => {
        void Promise.all([measureWindowBounds(toTreeDropMeasurableRef(content.current)), measureWindowBounds(toTreeDropMeasurableRef(viewport.current))])
            .then(([inside, outside]) => { nativeContent.current = inside; nativeViewport.current = outside; runtime.refresh(); });
        runtime.refresh();
    }, [runtime]);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || typeof window === 'undefined') return;
        const modifier = (event: KeyboardEvent | DragEvent) => { shift.current = event.shiftKey; runtime.refresh(); };
        const blur = () => { shift.current = false; runtime.refresh(); };
        window.addEventListener('scroll', refresh, true); window.addEventListener('resize', refresh);
        window.addEventListener('keydown', modifier); window.addEventListener('keyup', modifier); window.addEventListener('blur', blur);
        window.addEventListener('dragover', modifier, true); window.addEventListener('drop', modifier, true);
        return () => {
            window.removeEventListener('scroll', refresh, true); window.removeEventListener('resize', refresh);
            window.removeEventListener('keydown', modifier); window.removeEventListener('keyup', modifier); window.removeEventListener('blur', blur);
            window.removeEventListener('dragover', modifier, true); window.removeEventListener('drop', modifier, true);
        };
    }, [refresh, runtime]);
    const setGrab = React.useCallback((key: string, pointer: WindowPointer) => {
        const bounds = contentBounds();
        const position = latest.current.binding.getContext().board.positionsByItemRef[key] ?? measured.current.get(key);
        grab.current = bounds && position ? { key, offset: {
            x: pointer.x - bounds.x - BOARD_CANVAS_METRICS.paddingPx - position.x,
            y: pointer.y - bounds.y - BOARD_CANVAS_METRICS.paddingPx - position.y,
        } } : null;
    }, [contentBounds, measured]);
    useEntityDropTarget(runtime, {
        id: targetId, scope: binding.scope, acceptedKinds: ['work-board-item', 'work-board-widget', 'home-section', 'session-board-item', 'companion-item', 'widget-area-instance'],
        isCurrent: () => latest.current.binding.isCurrent(), getBounds,
        listDestinations: item => {
            const context = latest.current.binding.getContext();
            if ((item.kind !== 'work-board-item' && item.kind !== 'work-board-widget') || item.boardId !== context.board.id) {
                return widgetEntitySourceRef(item) ? [{ destination: { kind: 'add' }, label: context.board.name, group: context.board.name }] : [];
            }
            return (['up', 'down', 'left', 'right'] as const).map(direction => ({ destination: { kind: 'grid-step', direction },
                label: t(`boards.card.moveActions.${direction}`), group: context.board.name }));
        },
        resolve: ({ item, pointer, destination }) => {
            const context = { ...latest.current.binding.getContext(), measuredPositions: measured.current };
            let point: unknown = destination;
            // A work card or a widget: the same XY shape over its Canvas key.
            const key = workBoardCanvasKey(item, context.board);
            if (key && destination && !Array.isArray(destination) && typeof destination === 'object'
                && 'kind' in destination && destination.kind === 'grid-step' && 'direction' in destination) {
                const origin = context.board.positionsByItemRef[key] ?? measured.current.get(key);
                const direction = destination.direction;
                if (origin && (direction === 'up' || direction === 'down' || direction === 'left' || direction === 'right')) {
                    point = moveBoardCardByKeyboard(origin, direction);
                }
            }
            if (key && pointer) {
                const bounds = contentBounds();
                const origin = context.board.positionsByItemRef[key] ?? measured.current.get(key);
                if (bounds && origin && grab.current?.key === key) point = resolveBoardCardDrop({
                    origin, translation: {
                        x: pointer.x - bounds.x - BOARD_CANVAS_METRICS.paddingPx - grab.current.offset.x - origin.x,
                        y: pointer.y - bounds.y - BOARD_CANVAS_METRICS.paddingPx - grab.current.offset.y - origin.y,
                    }, snap: latest.current.snap, snapOnce: shift.current,
                });
            }
            const admission = resolveWorkBoardEntityDrop({ item, context, destination: point, canvasAvailable: true });
            return admission.status === 'allowed' && admission.effect.actionId === 'widgets.item.move'
                ? latest.current.binding.admitWidgetMovement?.(admission.effect) ?? widgetMovementRefused('widget_admission_unavailable', admission.effect.preview)
                : admission;
        },
        execute: effect => latest.current.binding.execute(effect),
    });
    const dropDom = useEntityDropDomBinding(runtime);
    const contentRef = React.useCallback((node: View | null) => { content.current = node; }, []);
    const viewportRef = React.useCallback((node: unknown) => { viewport.current = node; dropDom(node); }, [dropDom]);
    return React.useMemo(() => ({ targetId, contentRef, viewportRef, refresh, setGrab }), [targetId, contentRef, viewportRef, refresh, setGrab]);
}
