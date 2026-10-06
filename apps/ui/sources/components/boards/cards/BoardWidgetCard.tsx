import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import type { WorkBoardWidgetIntentV1, WorkBoardWidgetPlacementV1 } from '@happier-dev/protocol';
import type { WidgetInputBindingsV1 } from '@happier-dev/protocol/widgets';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import type { ItemAction } from '@/components/ui/lists/itemActions';
import { WidgetFrame } from '@/components/widgets/frame/WidgetFrame';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { useWidgetFrameSurfaceDefault } from '@/components/widgets/frame/useWidgetFrameStyle';
import { buildWidgetDefinitionActions, buildWidgetFrameStyleActions, buildWidgetInstanceActions, buildWidgetMoveActions, orderWidgetMenu } from '@/components/widgets/frame/widgetFrameMenu';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { readWidgetDescriptor, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import type { WorkBoardSaveOutcome } from '../model/workBoardSaveQueue';

/** Every edit is one WorkBoard widget intent through the Board's one writer; the target is filled in here. */
type WidgetEdit =
    | Readonly<{ kind: 'widget_inputs'; bindings: WidgetInputBindingsV1 }>
    | Readonly<{ kind: 'widget_rename'; displayName: string | null }>
    | Readonly<{ kind: 'widget_width'; width: 1 | 2 }>
    | Readonly<{ kind: 'widget_frame'; frameStyle: 'card' | 'plain' | null }>
    | Readonly<{ kind: 'widget_move'; toIndex: number }>
    | Readonly<{ kind: 'widget_remove' }>;

const NO_CONTEXT = Object.freeze({});
/** Every action sits in the overflow: the header shows one quiet "⋯". */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;

export type BoardWidgetCardProps = Readonly<{
    boardId: string;
    placement: WorkBoardWidgetPlacementV1;
    /** This copy's place among the Board's widgets, for Move earlier / later. */
    index: number;
    count: number;
    /** The Board's widget intent writer (the Account save queue). */
    dispatch: (intent: WorkBoardWidgetIntentV1) => Promise<WorkBoardSaveOutcome>;
    /** The Canvas grip, beside the ⋯ (By status has none: its order is the Board's). */
    grip?: React.ReactNode;
    /** Executable body only while the Board is the focused route and this layout shows. */
    active: boolean;
    /** It arrived while you were looking (an agent put it here): the frame's one-shot ring. */
    fresh?: boolean;
    testID: string;
}>;

/**
 * One configured widget on a WorkBoard (lab `dashboards` L1, dbind E): the shared widget frame and
 * instance body, named by its binding in the source slot, with the widget ⋯ — Edit inputs…, Rename,
 * Width (one or two cards), Move, the frame override and Remove. Each entry writes this copy only,
 * through the Board's one WorkBoard intent owner.
 */
export const BoardWidgetCard = React.memo(function BoardWidgetCard(props: BoardWidgetCardProps) {
    const { placement, boardId, dispatch } = props;
    const { instance } = placement;
    const appRuntime = useAppShellPluginUiProjection();
    const installedCandidate = React.useMemo(
        () => readWidgetDescriptor(appRuntime.pluginUiProjection, instance.definition),
        [appRuntime.pluginUiProjection, instance.definition],
    );
    const scope = placement.ref.surface;
    const candidate = useWidgetInstanceDescriptor(scope, instance, installedCandidate);
    const edit = React.useCallback((change: WidgetEdit) => dispatch({ ...change, boardId, ref: placement.ref }), [boardId, dispatch, placement.ref]);
    const setInputs = React.useCallback(async (bindings: WidgetInputBindingsV1) => {
        const outcome = await edit({ kind: 'widget_inputs', bindings });
        return outcome.status === 'applied' ? { ok: true as const } : { ok: false as const, message: t('widgetAdd.saveFailed') };
    }, [edit]);
    const inputs = useWidgetInputsEditor({
        instance, candidate, scope, context: NO_CONTEXT, audience: 'personal', setInputs, testID: props.testID,
    });
    const definition = useWidgetDefinitionFlows({ instance, scope, anchorRef: inputs.anchorRef, editInputs: inputs.editInputs, testID: props.testID });
    const title = describeBoardWidgetTitle(placement, candidate);
    const rename = useWidgetFrameRename({
        title,
        // An empty name gives the copy back its widget's name.
        onRename: async (next) => {
            if (next === (instance.displayName ?? '')) return;
            const outcome = await edit({ kind: 'widget_rename', displayName: next || null });
            if (outcome.status !== 'applied') throw new Error('widget_rename_refused');
        },
        testID: props.testID,
    });
    const bindingLabel = useWidgetInstanceBindingLabel(instance, candidate);
    const surfaceDefault = useWidgetFrameSurfaceDefault('board');
    const frameStyle = placement.frameStyle ?? surfaceDefault;

    const actions = React.useMemo((): ItemAction[] => {
        const width = { id: 'width', title: t('widgetAdd.width') } as const;
        return orderWidgetMenu({
            instance: buildWidgetInstanceActions({ editInputs: inputs.editInputs, onRename: rename.begin }),
            // One card column or two (lab Q8): the Canvas width step; By status and phones keep one column.
            width: ([1, 2] as const).map((span): ItemAction => ({
                id: `width-${span}`, title: span === 1 ? t('boards.widgets.widthOne') : t('boards.widgets.widthTwo'),
                icon: span === 1 ? 'square' : 'square-split-horizontal', selected: placement.width === span, group: width,
                onPress: () => { if (placement.width !== span) void edit({ kind: 'widget_width', width: span }); },
            })),
            frame: buildWidgetFrameStyleActions({
                placement: 'board', surfaceDefault, override: placement.frameStyle ?? null,
                onSet: (style) => { void edit({ kind: 'widget_frame', frameStyle: style }); },
            }),
            move: buildWidgetMoveActions({
                index: props.index,
                count: props.count,
                labels: { earlier: t('boards.widgets.moveEarlier'), later: t('boards.widgets.moveLater') },
                onMove: (delta) => { void edit({ kind: 'widget_move', toIndex: props.index + delta }); },
            }),
            definition: buildWidgetDefinitionActions({ onAbout: definition.about }),
            remove: [{ id: 'remove', title: t('boards.widgets.remove'), icon: 'trash', destructive: true,
                onPress: () => { void edit({ kind: 'widget_remove' }); } }],
        });
    }, [definition.about, edit, inputs.editInputs, placement.frameStyle, placement.width, props.count, props.index, rename.begin, surfaceDefault]);

    // Leaving the Board keeps each card's place: the body's last height stays while it holds no reads.
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setBodyHeight((current) => (current === height ? current : height));
    }, []);
    const body = React.useMemo(() => ({
        kind: 'content' as const,
        children: props.active ? (
            <View onLayout={onBodyLayout}><WidgetSurface
                scope={scope}
                instance={instance}
                descriptor={candidate}
                providedContext={NO_CONTEXT}
                recordRevision={stableJsonStringify(instance)}
                presentation="content"
                appRuntime={appRuntime}
                {...(inputs.onRepairInputs ? { onRepairInputs: inputs.onRepairInputs } : {})}
                testID={`${props.testID}.widget`}
            /></View>
        ) : <View testID={`${props.testID}.deferred`} style={{ minHeight: bodyHeight }} />,
    }), [appRuntime, bodyHeight, candidate, inputs.onRepairInputs, instance, onBodyLayout, props.active, props.testID, scope]);

    return (
        <>
            <WidgetFrame
                testID={props.testID}
                frameStyle={frameStyle}
                placement="board"
                mark={candidate?.icon ?? 'squares-four'}
                title={rename.field ?? title}
                source={bindingLabel ?? candidate?.pluginName}
                menu={(
                    <View style={styles.controls}>
                        <View ref={inputs.anchorRef} collapsable={false}>
                            <ItemRowActions
                                title={title}
                                compactThreshold={ALWAYS_OVERFLOW}
                                compactActionIds={[]}
                                overflowTriggerTestID={`${props.testID}.menu`}
                                overflowTriggerAccessibilityLabel={t('boards.widgets.menuA11y', { widget: title })}
                                actions={actions}
                            />
                        </View>
                        {props.grip}
                    </View>
                )}
                body={body}
                {...(props.fresh ? { fresh: true } : {})}
                accessibilityLabel={`${title}, ${t('boards.widgets.kind')}`}
            />
            {inputs.popover}
            {definition.panel}
        </>
    );
});

/** A copy's title: its own name, else its widget's (an inline definition carries one), else what it is. */
export function describeBoardWidgetTitle(placement: WorkBoardWidgetPlacementV1, candidate: Pick<WidgetCandidate, 'title'> | null): string {
    const { instance } = placement;
    const authoredName = instance.definition.kind === 'inline' ? instance.definition.definition.name : null;
    return instance.displayName ?? candidate?.title ?? authoredName ?? t('boards.widgets.kind');
}

const styles = {
    controls: { flexDirection: 'row', alignItems: 'center' },
} as const;
