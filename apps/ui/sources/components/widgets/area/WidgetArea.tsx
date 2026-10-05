import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';
import type { WidgetAreaLayoutV1, WidgetInstanceV1, WidgetPlacementV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';

import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { readCoarsePrimaryPointer, useRowActionHoverHost } from '@/components/sessions/transcript/messageActions/rowActionRevealHost';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { CardGrid, CardGridCell } from '@/components/ui/cardGrid/CardGrid';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { WidgetAddPopover } from '@/components/widgets/add/WidgetAddPopover';
import { useAccountWidgetAddSections, type AccountWidgetSurfaceLabels } from '@/components/widgets/add/accountWidgetAddSections';
import { WidgetFrame, type WidgetFramePlacement } from '@/components/widgets/frame/WidgetFrame';
import { buildWidgetFrameStyleActions, buildWidgetInstanceActions, buildWidgetWidthActions } from '@/components/widgets/frame/widgetFrameMenu';
import { WIDGET_FRAME_PLACEMENT_DEFAULTS, resolveWidgetFrameStyle } from '@/components/widgets/frame/widgetFrameStyle';
import { useWidgetFrameRename } from '@/components/widgets/frame/useWidgetFrameRename';
import { useWidgetDefinitionFlows } from '@/components/widgets/definitions/useWidgetDefinitionFlows';
import { useWidgetInputsEditor } from '@/components/widgets/surface/useWidgetInputsEditor';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import { runWidgetSetupCommand, widgetProvidedContext, type WidgetSurfaceContext } from '@/components/widgets/surface/widgetSurfaceSetup';
import { readWidgetDescriptor } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { useWidgetAreaLayout, type WidgetAreaLayout, type WidgetAreaPort, type WidgetAreaWriteOutcome } from './useWidgetAreaLayout';

type WidgetAreaWrite = WidgetAreaLayout<WidgetSurfaceContext>['write'];

/**
 * How an area lays its widgets out (lab `dashboards` dlayout Q8): a plugin page area is Home's
 * grid — half | full, cards by default; a Project aside is a column like the Companion — order
 * only, Plain by default.
 */
export type WidgetAreaGeometry = 'grid' | 'column';

const GEOMETRY_PLACEMENT: Readonly<Record<WidgetAreaGeometry, WidgetFramePlacement>> = { grid: 'home', column: 'companion' };
/** Every action sits in the ⋯ menu: the header shows one quiet "⋯". */
const ALWAYS_OVERFLOW = Number.POSITIVE_INFINITY;
const ADD_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

export type WidgetAreaProps = Readonly<{
    /**
     * The area's operations, bound by the host to its identity and the page's current context;
     * `null` where the host has no area to bind (then `unavailable` says why).
     */
    port: WidgetAreaPort | null;
    /** What the page fills on its own ("This page", "This project", "This checkout"). */
    context: WidgetSurfaceContext;
    geometry: WidgetAreaGeometry;
    title: string;
    /** One quiet fact beside the title ("your widgets on this page"). */
    meta?: string;
    /** The page's or project's name: "Add to PRs & Issues", "PRs & Issues uses Card". */
    surfaceName: string;
    /** Replaces the layout state with the host's own refusal (a Project without a known source). */
    unavailable?: Readonly<{ title: string; reason: string; reasonCode: string }>;
    testID: string;
}>;

/**
 * One personal widget area on a page (lab `dashboards` PG/PGp, P1/P1p/P1a): its header with the one
 * Add, then the widgets in the shared frame, each mounting the shared instance body. Add, Set up,
 * Edit inputs, Rename, Width, Frame and the card states are the same owners Home uses; every change
 * is one semantic operation through the area's port, which the host admits and persists. It owns no
 * catalog, layout store or input resolver.
 */
export function WidgetArea(props: WidgetAreaProps): React.ReactElement {
    if (props.unavailable || !props.port) {
        const unavailable = props.unavailable ?? {
            title: t('widgetAdd.areaUnavailableTitle'), reason: t('widgetAdd.areaUnavailableReason'), reasonCode: 'widget_area_unavailable',
        };
        return (
            <View testID={props.testID} style={styles.area}>
                <WidgetAreaHeader title={props.title} meta={props.meta} testID={props.testID} />
                <SurfaceStateCard
                    testID={`${props.testID}.unavailable`}
                    kind="unavailable"
                    size="line"
                    layout="inline"
                    title={unavailable.title}
                    reason={unavailable.reason}
                    diagnosticCode={unavailable.reasonCode}
                />
            </View>
        );
    }
    return <WidgetAreaWithLayout {...props} port={props.port} />;
}

function WidgetAreaWithLayout(props: WidgetAreaProps & Readonly<{ port: WidgetAreaPort }>): React.ReactElement {
    const layout = useWidgetAreaLayout(props.port, props.context);
    const addAnchorRef = React.useRef<View | null>(null);
    const [addOpen, setAddOpen] = React.useState(false);
    const [notice, setNotice] = React.useState<string | null>(null);
    const state = layout.state;
    const ready = state.status === 'ready' ? state : null;
    const canAdd = ready?.canEdit === true;
    const layoutWrite = layout.write;
    const write = React.useCallback(async (operation: Parameters<WidgetAreaWrite>[0]): Promise<WidgetAreaWriteOutcome> => {
        const outcome = await layoutWrite(operation);
        setNotice(outcome.kind === 'refused' ? t('widgetAdd.areaWriteFailed') : outcome.kind === 'approvalPending' ? t('widgetAdd.areaApprovalPending') : null);
        return outcome;
    }, [layoutWrite]);
    const closeAdd = React.useCallback(() => setAddOpen(false), []);

    return (
        <View testID={props.testID} style={styles.area}>
            <WidgetAreaHeader
                title={props.title}
                meta={props.meta}
                testID={props.testID}
                // The Add keeps its place while the layout first loads, so nothing moves on arrival.
                add={state.status === 'loading' || canAdd ? (
                    <View ref={addAnchorRef} collapsable={false}>
                        <IconButton
                            testID={`${props.testID}.add`}
                            iconName="plus"
                            variant="plain"
                            accessibilityLabel={t('widgetAdd.areaAdd', { surface: props.surfaceName })}
                            minimumInteractiveTargetSize={ADD_TARGET_PX}
                            disabled={!canAdd}
                            selected={addOpen}
                            expanded={addOpen}
                            hasPopup="dialog"
                            onPress={() => setAddOpen((open) => !open)}
                        />
                    </View>
                ) : null}
            />
            {notice ? <Text testID={`${props.testID}.notice`} style={styles.notice}>{notice}</Text> : null}
            {state.status === 'unavailable' ? (
                <SurfaceStateCard
                    testID={`${props.testID}.unavailable`}
                    kind="unavailable"
                    size="line"
                    layout="inline"
                    title={t('widgetAdd.areaUnavailableTitle')}
                    reason={t('widgetAdd.areaUnavailableReason')}
                    diagnosticCode={state.reasonCode}
                />
            ) : ready && ready.placements.length === 0 ? (
                <SurfaceStateCard
                    testID={`${props.testID}.empty`}
                    kind="empty"
                    size="line"
                    layout="inline"
                    title={t('widgetAdd.areaEmptyTitle')}
                    reason={t('widgetAdd.areaEmptyReason')}
                    {...(canAdd ? { action: { label: t('widgetAdd.areaEmptyAction'), onPress: () => setAddOpen(true), testID: `${props.testID}.emptyAdd` } } : {})}
                />
            ) : ready ? (
                <WidgetAreaPlacements {...props} context={ready.context} surface={ready.surface} placements={ready.placements} canEdit={ready.canEdit} write={write} />
            ) : null}
            {ready && addOpen ? (
                <WidgetAreaAddPopover
                    anchorRef={addAnchorRef}
                    surface={ready.surface}
                    placements={ready.placements}
                    context={ready.context}
                    surfaceName={props.surfaceName}
                    write={write}
                    onRequestClose={closeAdd}
                    testID={`${props.testID}.addPopover`}
                />
            ) : null}
        </View>
    );
}

function WidgetAreaHeader(props: Readonly<{ title: string; meta?: string | undefined; add?: React.ReactNode; testID: string }>): React.ReactElement {
    return (
        <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{props.title}</Text>
            {props.meta ? <Text style={styles.meta} numberOfLines={1}>{props.meta}</Text> : null}
            <View style={styles.grow} />
            {props.add ?? null}
        </View>
    );
}

type PlacementsProps = WidgetAreaProps & Readonly<{
    surface: WidgetSurfaceRefV1;
    placements: WidgetAreaLayoutV1['instances'];
    canEdit: boolean;
    write: WidgetAreaWrite;
}>;

function WidgetAreaPlacements(props: PlacementsProps): React.ReactElement {
    const items = props.placements.map((placement, index) => (
        <WidgetAreaItem
            key={placement.instance.id}
            {...props}
            placement={placement}
            index={index}
            count={props.placements.length}
        />
    ));
    if (props.geometry === 'column') return <View style={styles.column}>{items}</View>;
    return (
        <CardGrid testID={`${props.testID}.grid`} columns={2}>
            {props.placements.map((placement, index) => (placement.width === 'full'
                ? <CardGridCell key={placement.instance.id} span="row">{items[index]}</CardGridCell>
                : items[index]))}
        </CardGrid>
    );
}

const WidgetAreaItem = React.memo(function WidgetAreaItem(props: PlacementsProps & Readonly<{
    placement: WidgetAreaLayoutV1['instances'][number];
    index: number;
    count: number;
}>) {
    const { placement, surface, write, context, geometry } = props;
    const instance = placement.instance;
    const testID = `${props.testID}.widget.${instance.id}`;
    const runtime = useAppShellPluginUiProjection();
    const installed = React.useMemo(() => readWidgetDescriptor(runtime.pluginUiProjection, instance.definition), [runtime.pluginUiProjection, instance.definition]);
    const candidate = useWidgetInstanceDescriptor(surface, instance, installed);
    const frameStyle = resolveWidgetFrameStyle({ placement: GEOMETRY_PLACEMENT[geometry], override: placement.frameStyle ?? null });
    const providedContext = React.useMemo(() => widgetProvidedContext(context), [context]);
    const focused = useIsFocused();
    const hover = useRowActionHoverHost();
    const [menuFocused, setMenuFocused] = React.useState(false);
    const bindingLabel = useWidgetInstanceBindingLabel(instance, candidate, context);

    const saveInputs = React.useCallback((bindings: WidgetInstanceV1['bindings']) => runWidgetSetupCommand(async () => {
        const outcome = await write({ actionId: 'widgets.instance.inputs.set', instanceId: instance.id, bindings });
        if (outcome.kind === 'refused') throw new Error(outcome.errorCode);
    }, t('widgetAdd.saveFailed')), [instance.id, write]);
    const edit = useWidgetInputsEditor({
        instance, candidate, scope: surface, context, audience: 'personal',
        ...(props.canEdit ? { setInputs: saveInputs } : {}), testID,
    });
    const definition = useWidgetDefinitionFlows({ instance, scope: surface, anchorRef: edit.anchorRef, editInputs: edit.editInputs, testID });
    const title = instance.displayName ?? candidate?.title ?? t('sessionBoard.item.pluginUnavailable.title');
    const renaming = useWidgetFrameRename({
        title,
        testID,
        ...(props.canEdit ? { onRename: (next: string) => {
            // An empty name, or the widget's own, goes back to it.
            const displayName = next.length > 0 && next !== candidate?.title ? next : null;
            if ((displayName ?? undefined) !== instance.displayName) void write({ actionId: 'widgets.instance.rename', instanceId: instance.id, displayName });
        } } : {}),
    });

    const alwaysVisible = Platform.OS !== 'web' || readCoarsePrimaryPointer();
    const menu = props.canEdit ? (
        <View
            ref={edit.anchorRef}
            collapsable={false}
            testID={`${testID}.menu`}
            style={{ opacity: alwaysVisible || hover.isHovered || menuFocused ? 1 : 0 }}
            onFocus={() => setMenuFocused(true)}
            onBlur={() => setMenuFocused(false)}
        >
            <ItemRowActions
                title={title}
                compactThreshold={ALWAYS_OVERFLOW}
                compactActionIds={[]}
                overflowTriggerTestID={`${testID}.menuTrigger`}
                overflowTriggerAccessibilityLabel={`${t('settingsOverview.homeSectionOptions')}: ${title}`}
                actions={[
                    ...buildWidgetInstanceActions({ editInputs: edit.editInputs, onRename: renaming.begin, onAbout: definition.about }),
                    { id: 'moveUp', title: t('common.moveUp'), icon: 'caret-up', disabled: props.index === 0,
                        onPress: () => { void write({ actionId: 'widgets.instance.move', instanceId: instance.id, toIndex: props.index - 1 }); } },
                    { id: 'moveDown', title: t('common.moveDown'), icon: 'caret-down', disabled: props.index === props.count - 1,
                        onPress: () => { void write({ actionId: 'widgets.instance.move', instanceId: instance.id, toIndex: props.index + 1 }); } },
                    ...(geometry === 'grid' ? buildWidgetWidthActions({
                        width: placement.width ?? 'half',
                        onSet: (width) => { void write({ actionId: 'widgets.instance.width.set', instanceId: instance.id, width }); },
                    }) : []),
                    ...buildWidgetFrameStyleActions({
                        placement: GEOMETRY_PLACEMENT[geometry],
                        surfaceDefault: WIDGET_FRAME_PLACEMENT_DEFAULTS[GEOMETRY_PLACEMENT[geometry]],
                        override: placement.frameStyle ?? null,
                        surfaceLabel: props.surfaceName,
                        onSet: (style) => { void write({ actionId: 'widgets.instance.frame.set', instanceId: instance.id, frameStyle: style }); },
                    }),
                    { id: 'remove', title: t('common.remove'), icon: 'trash', destructive: true,
                        onPress: () => { void write({ actionId: 'widgets.instance.remove', instanceId: instance.id }); } },
                ]}
            />
        </View>
    ) : null;

    const body = React.useMemo(() => ({
        kind: 'content' as const,
        // Its body exists only while the page is the focused route; leaving holds no plugin work.
        children: focused ? (
            <WidgetSurface
                scope={surface}
                instance={instance}
                descriptor={candidate}
                providedContext={providedContext}
                recordRevision={stableJsonStringify(instance)}
                presentation="content"
                appRuntime={runtime}
                {...(edit.onRepairInputs ? { onRepairInputs: edit.onRepairInputs } : {})}
                testID={`${testID}.body`}
            />
        ) : null,
    }), [candidate, edit.onRepairInputs, focused, instance, providedContext, runtime, surface, testID]);

    return (
        <View testID={testID} style={styles.cell} {...hover.hoverProps}>
            <WidgetFrame
                testID={`${testID}.frame`}
                frameStyle={frameStyle}
                placement={GEOMETRY_PLACEMENT[geometry]}
                fill={geometry === 'grid'}
                mark={candidate?.icon ?? 'squares-four'}
                title={renaming.field ?? title}
                source={bindingLabel ?? candidate?.pluginName ?? undefined}
                menu={menu}
                body={body}
            />
            {edit.popover}
            {definition.panel}
        </View>
    );
});

const AREA_LABELS = (surfaceName: string): AccountWidgetSurfaceLabels => ({
    count: (count) => t('widgetAdd.countHere', { count }),
    submit: t('widgetAdd.areaAddTo', { surface: surfaceName }),
    fromPluginsHint: t('widgetAdd.homeFromPluginsHint'),
});

/** The shared Gallery | List and Set up, counted "N here"; every add is the area's `widgets.instance.add`. */
function WidgetAreaAddPopover(props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    surface: WidgetSurfaceRefV1;
    placements: readonly WidgetPlacementV1[];
    context: WidgetSurfaceContext;
    surfaceName: string;
    write: WidgetAreaWrite;
    onRequestClose: () => void;
    testID: string;
}>): React.ReactElement {
    const { write } = props;
    const instances = React.useMemo(() => props.placements.map((placement) => placement.instance), [props.placements]);
    const labels = React.useMemo(() => AREA_LABELS(props.surfaceName), [props.surfaceName]);
    const addInstance = React.useCallback(async (instance: WidgetInstanceV1) => {
        const outcome = await write({ actionId: 'widgets.instance.add', instance });
        if (outcome.kind === 'refused') throw new Error(outcome.errorCode);
        return outcome;
    }, [write]);
    const sections = useAccountWidgetAddSections({ scope: props.surface, instances, addInstance, labels, context: props.context, testID: props.testID });
    return (
        <WidgetAddPopover
            open
            anchorRef={props.anchorRef}
            onRequestClose={props.onRequestClose}
            title={labels.submit}
            hint={t('widgetAdd.areaHint')}
            searchPlaceholder={t('widgetAdd.searchWidgets')}
            sections={sections}
            serverId={props.surface.serverId}
            testID={props.testID}
        />
    );
}

const styles = StyleSheet.create((theme) => ({
    area: { gap: 8 },
    header: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: ADD_TARGET_PX },
    title: { ...Typography.default('semiBold'), ...happierPageTextMetrics('sectionTitle'), color: theme.colors.text.primary, flexShrink: 1 },
    meta: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary, flexShrink: 1 },
    grow: { flex: 1 },
    notice: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.secondary },
    column: { gap: 12 },
    // The frame fills its grid cell, so cards in one row share a height.
    cell: { flexGrow: 1 },
}));
