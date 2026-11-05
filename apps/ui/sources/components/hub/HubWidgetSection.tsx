import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';
import { useLayoutPresentationActive, usePresentedValue } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { WidgetSurface, type WidgetSurfaceProps } from '@/components/widgets/surface/WidgetSurface';
import { getWidgetSizeFootprintV1, resolveWidgetRowOwnerSizeV1, type WidgetInputBindingsV1, type WidgetSizeV1, type WidgetInstanceV1, type WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    useMeasuredNearViewport,
    type NearViewportTracker,
} from '@/components/widgets/nearViewport';
import { isBuiltinWidgetSwitchedOff, readWidgetSourcePluginName, type WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { useAtmosphereMoments } from '@/components/atmosphere/atmosphereMoments';
import { t } from '@/text';

import { useActivateAppDestination, useCompactAppDestinations, type CompactAppPluginDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WidgetFrame, type WidgetFrameFooter, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { useWidgetFrameTitle } from '@/components/widgets/frame/widgetFrameTitle';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { useWidgetCarriedIdentity } from '@/components/widgets/surface/widgetCarriedIdentity';
import { WidgetFrameBodyCaptionContext, WidgetFrameBodyMetaContext } from '@/components/widgets/frame/widgetFrameBodyCaption';
import { widgetGroupFollowSource } from '@/components/widgets/group/widgetGroupInputs';
import { useIsTablet } from '@/utils/platform/responsive';
import { EntityDropSettledFeedback, type EntityDropSettledMatch } from '@/components/ui/treeDragDrop/ui/EntityDropSettledFeedback';
import { useSessionSurfaceEntityDrag, useSessionSurfaceCarriedStyle, SessionSurfaceEntityDragHandle, SessionSurfaceEntityTargetFeedback, type SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';


/**
 * One plugin widget on Home, in the host widget frame: the widget's mark, title and plugin, the
 * section menu, the widget's `content` presentation as the body, and "Open <plugin>" when the plugin
 * has one page to open. The plugin's body draws its own rows and states (loading, empty, error,
 * stale); the frame keeps their room.
 *
 * Its body is built only while Home is visible and the section is near the viewport;
 * otherwise it keeps its place (the height it last had) and holds no plugin execution, Host API
 * binding or subscription. The widget's data lives inside that body, so a change there re-renders
 * this section alone — never the hub or its sibling sections.
 */
export const HubWidgetSection = React.memo(function HubWidgetSection(props: Readonly<{
    widget?: WidgetCandidate;
    instance: WidgetInstanceV1;
    size?: WidgetSizeV1;
    /** Alone in its row of a two-up grid: it presents at its full-row size (same height), the saved size untouched. */
    ownsRow?: boolean;
    menu: React.ReactNode;
    /** Card or plain: this section's override, else Home's Appearance default (resolved by the slot). */
    frameStyle: WidgetFrameStyle;
    /** The page's scroll host; without one the body is always built. */
    tracker: Pick<NearViewportTracker, 'subscribe' | 'getWindow' | 'measureSpan' | 'getLayoutRevision'> | null;
    testID: string;
    hoverProps?: Readonly<Record<string, unknown>>;
    /** While renaming, the field takes the title's place. */
    titleEditor?: React.ReactElement | null;
    /** The card's repair line opens this copy's Edit inputs (lab dagent ST). */
    onRepairInputs?: () => void;
    entityDrag?: SessionSurfaceEntityBinding;
    /** Inside a group: drawn plain with no hairline of its own; the group draws the dividers. */
    grouped?: boolean;
    /**
     * A page section hosts this widget (Settings › Overview): the section draws the title, the sheet
     * and any link row, so the frame draws no header, mark, source or footer of its own, sizes to its
     * body (a page is content height: no reserved empty rows) and keeps its content on the rows' edge.
     */
    sectionHost?: boolean;
    /** The move handle shows (Home is being customized); in view mode a hover pointer drags the card itself. */
    showGrip?: boolean;
    groupBindings?: WidgetInputBindingsV1;
    /** It follows its group's value: the source line says so instead of naming the plugin. */
    followSource?: Readonly<{ value: string; wide: boolean; /** The group's own header names the value: this widget does not repeat it. */ groupNamesValue: boolean }>;
}>) {
    const focused = useIsFocused();
    const presented = useLayoutPresentationActive();
    const phone = !useIsTablet();
    const descriptor = props.widget ?? null;
    const appRuntime = useAppShellPluginUiProjection();
    const pluginName = readWidgetSourcePluginName(appRuntime.pluginUiProjection, descriptor) ?? t('sessionBoard.item.pluginUnavailable.title');
    const { title: frameTitle, onDefinitionRead } = useWidgetFrameTitle(props.instance, descriptor);
    // Copies are named by what they are bound to, in the source slot (lab dbind H, N1).
    const bindingLabel = useWidgetInstanceBindingLabel(props.instance, descriptor);
    // The body may name what it shows ("Tokens by agent · last 7 days"), as it does in every area.
    const [bodyCaption, setBodyCaption] = React.useState<string | null>(null);
    // …and may say its one live fact in the header's meta slot ("1 needs you").
    const [bodyMeta, setBodyMeta] = React.useState<React.ReactNode>(null);
    // A built-in withdrawn by its own switch (Your Home's atmosphere moment) keeps its place in the layout, undrawn.
    const switchedOff = isBuiltinWidgetSwitchedOff(props.instance.definition, useAtmosphereMoments());
    const source = props.followSource
        ? props.followSource.groupNamesValue
            ? bodyCaption ?? undefined
            : widgetGroupFollowSource(props.followSource.value, props.followSource.wide || phone)
        // A widget whose plugin is not here says that once, in its body; the source slot does not repeat it.
        : bodyCaption ?? bindingLabel ?? (descriptor ? pluginName : undefined);
    const savedSize = props.size ?? 'medium';
    // Carried, the card keeps its mark and says its source and the size it keeps (lab wgdnd 1).
    const carried = useWidgetCarriedIdentity({ kind: 'widget', mark: descriptor?.icon ?? 'squares-four',
        source: typeof source === 'string' || source === undefined ? source : source.text, size: savedSize });
    const entityDrag = React.useMemo(() => props.entityDrag ? { ...props.entityDrag, ...carried } : null, [carried, props.entityDrag]);
    const drag = useSessionSurfaceEntityDrag(focused ? entityDrag : null);
    const carriedStyle = useSessionSurfaceCarriedStyle(drag);
    const sectionRef = React.useRef<View>(null);
    const { near, measure } = useMeasuredNearViewport(props.tracker, sectionRef, presented, props.instance.id);
    const [bodyHeight, setBodyHeight] = React.useState(0);
    // A retained hidden Home keeps its body; live demand still withdraws with presentation.
    const active = usePresentedValue(presented && near);
    const size = props.ownsRow ? resolveWidgetRowOwnerSizeV1('home', savedSize, descriptor?.sizeDeclaration) : savedSize;
    const widgetPresentation = React.useMemo(() => ({ size, footprint: getWidgetSizeFootprintV1('home', size)! }), [size]);

    const onBodyLayout = React.useCallback((event: LayoutChangeEvent) => {
        const height = event.nativeEvent.layout.height;
        setBodyHeight((current) => (current === height ? current : height));
    }, []);

    const destinations = useCompactAppDestinations();
    const activate = useActivateAppDestination();
    const page = React.useMemo(() => {
        const pages = destinations.filter((destination): destination is CompactAppPluginDestination =>
            destination.kind === 'plugin'
            && destination.container === 'appPage'
            && destination.destination.pluginId === props.widget?.surface?.pluginId
            && destination.availability === 'available');
        return pages.length === 1 ? pages[0]! : null;
    }, [destinations, props.widget?.surface?.pluginId]);
    const footer = React.useMemo<WidgetFrameFooter | null>(() => (page
        ? {
            kind: 'open',
            label: t('homeWidgets.open', { destination: pluginName }),
            onPress: () => { activate(page); },
        }
        : null), [activate, page, pluginName]);
    const body = React.useMemo(() => ({
        kind: 'content' as const,
        children: active ? (
            // Fills the frame's body room so a state replacing the body sits balanced in the card.
            <View testID={`${props.testID}.body`} onLayout={onBodyLayout} style={{ flexGrow: 1 }}>
                <WidgetFrameBodyCaptionContext.Provider value={setBodyCaption}>
                <WidgetFrameBodyMetaContext.Provider value={setBodyMeta}>
                    <HubWidgetBody widget={descriptor ?? undefined} instance={props.instance} groupBindings={props.groupBindings} size={size} onRepairInputs={props.onRepairInputs} onDefinitionRead={onDefinitionRead} testID={`${props.testID}.widget`} />
                </WidgetFrameBodyMetaContext.Provider>
                </WidgetFrameBodyCaptionContext.Provider>
            </View>
        ) : (
            // The body's last height, so leaving and returning never moves the page.
            <View testID={`${props.testID}.deferred`} style={{ minHeight: bodyHeight }} />
        ),
    }), [active, bodyHeight, onBodyLayout, onDefinitionRead, props.testID, descriptor, props.instance, props.onRepairInputs, size]);

    const settledMatch = React.useMemo<EntityDropSettledMatch>(() => ({
        item: item => item.kind === 'home-section' && item.sectionId === props.instance.id,
    }), [props.instance.id]);
    if (switchedOff) return null;
    return (
        <View ref={node => { sectionRef.current = node; drag.ref(node); }} collapsable={false} testID={props.testID} onLayout={() => { measure(); drag.onLayout(); }} style={[styles.cell, carriedStyle]} {...props.hoverProps}>
            {/* A released move that came back keeps its one line under this card, where it was let go. */}
            <EntityDropSettledFeedback runtime={drag.runtime} match={settledMatch} fill testID={`${props.testID}.drop-feedback`}>
            <WidgetFrame
                testID={`${props.testID}.frame`}
                frameStyle={props.frameStyle}
                placement="home"
                widgetPresentation={widgetPresentation}
                {...(props.sectionHost ? { title: null } : {
                    mark: descriptor?.icon ?? 'squares-four',
                    title: props.titleEditor ?? frameTitle,
                    source,
                    meta: bodyMeta,
                })}
                grouped={props.grouped === true || props.sectionHost === true}
                fill
                {...(props.sectionHost ? { bodyHeight: 'content' as const } : {})}
                {...(props.entityDrag && props.showGrip ? { leading: <SessionSurfaceEntityDragHandle drag={drag} title={props.entityDrag.title} testID={`${props.testID}.move`} /> } : {})}
                menu={props.menu}
                body={body}
                footer={props.sectionHost ? null : footer}
            />
            </EntityDropSettledFeedback>
            <SessionSurfaceEntityTargetFeedback drag={drag} testID={`${props.testID}.drop`} />
        </View>
    );
});

/** The mounted body: the one installed-widget arm, against the app shell's plugin projection. */
function HubWidgetBody(props: Readonly<{ widget?: WidgetCandidate; instance: WidgetInstanceV1; groupBindings?: WidgetInputBindingsV1; size: WidgetSizeV1; onRepairInputs?: (() => void) | undefined; onDefinitionRead?: WidgetSurfaceProps['onDefinitionRead']; testID: string }>) {
    const runtime = useAppShellPluginUiProjection();
    const accountScope = useActiveServerAccountScope();
    const scope = React.useMemo<WidgetSurfaceRefV1 | null>(() => accountScope
        ? { ...accountScope, owner: { kind: 'home' } } : null, [accountScope]);
    if (!scope) return null;
    return (
        <WidgetSurface
            scope={scope}
            instance={props.instance}
            descriptor={props.widget ?? null}
            providedContext={EMPTY_CONTEXT}
            groupBindings={props.groupBindings}
            recordRevision={stableJsonStringify(props.instance)}
            presentation="content"
            size={props.size}
            appRuntime={runtime}
            onDefinitionRead={props.onDefinitionRead}
            {...(props.onRepairInputs ? { onRepairInputs: props.onRepairInputs } : {})}
            testID={props.testID}
        />
    );
}

const EMPTY_CONTEXT = Object.freeze({});

const styles = {
    // The frame fills its grid cell, so cards in one row share a height.
    cell: { flexGrow: 1 },
} as const;
