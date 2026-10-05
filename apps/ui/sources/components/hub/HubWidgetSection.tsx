import * as React from 'react';
import { View, type LayoutChangeEvent } from 'react-native';
import { useIsFocused } from '@/components/appShell/workspace/destinationRoute';

import { useAppShellPluginUiProjection } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { WidgetSurface } from '@/components/widgets/surface/WidgetSurface';
import type { WidgetInstanceV1, WidgetSurfaceRefV1 } from '@happier-dev/protocol/widgets';
import { useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';
import {
    useIsNearViewport,
    type NearViewportSpan,
    type NearViewportTracker,
} from '@/components/widgets/nearViewport';
import type { WidgetCandidate } from '@/components/widgets/widgetCatalog';
import { t } from '@/text';

import { useActivateAppDestination, useCompactAppDestinations, type CompactAppPluginDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { WidgetFrame, type WidgetFrameFooter, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { useWidgetInstanceBindingLabel } from '@/components/widgets/surface/useWidgetInstanceBindingLabel';
import { useWidgetInstanceDescriptor } from '@/components/widgets/surface/useWidgetInstanceDescriptor';
import { useSessionSurfaceEntityDrag, SessionSurfaceEntityDragHandle, type SessionSurfaceEntityBinding } from '@/components/sessions/board/SessionSurfaceEntityDrag';


/**
 * One plugin widget on Home, in the host widget frame: the widget's mark, title and plugin, the
 * section menu, the widget's `content` presentation as the body, and "Open <plugin>" when the plugin
 * has one page to open. The plugin's body draws its own rows and states (loading, empty, error,
 * stale); the frame keeps their room.
 *
 * Its body is built only while Home is the focused route and the section is near the viewport;
 * otherwise it keeps its place (the height it last had) and holds no plugin execution, Host API
 * binding or subscription. The widget's data lives inside that body, so a change there re-renders
 * this section alone — never the hub or its sibling sections.
 */
export const HubWidgetSection = React.memo(function HubWidgetSection(props: Readonly<{
    widget?: WidgetCandidate;
    instance: WidgetInstanceV1;
    menu: React.ReactNode;
    /** Card or plain: this section's override, else Home's Appearance default (resolved by the slot). */
    frameStyle: WidgetFrameStyle;
    tracker: NearViewportTracker;
    testID: string;
    hoverProps?: Readonly<Record<string, unknown>>;
    /** While renaming, the field takes the title's place. */
    titleEditor?: React.ReactElement | null;
    /** The card's repair line opens this copy's Edit inputs (lab dagent ST). */
    onRepairInputs?: () => void;
    entityDrag?: SessionSurfaceEntityBinding;
}>) {
    const focused = useIsFocused();
    const drag = useSessionSurfaceEntityDrag(focused ? props.entityDrag ?? null : null);
    const sectionRef = React.useRef<View>(null);
    const latestMeasurement = React.useRef<Promise<NearViewportSpan | null> | null>(null);
    const [span, setSpan] = React.useState<NearViewportSpan | null>(null);
    const near = useIsNearViewport(props.tracker, span);
    const [bodyHeight, setBodyHeight] = React.useState(0);
    const active = focused && near;
    const accountScope = useActiveServerAccountScope();
    const descriptor = useWidgetInstanceDescriptor(accountScope, props.instance, props.widget);

    const measure = React.useCallback(() => {
        const node = sectionRef.current;
        const measurement = props.tracker.measureSpan(node);
        latestMeasurement.current = measurement;
        void measurement.then(next => {
            if (latestMeasurement.current !== measurement || sectionRef.current !== node) return;
            setSpan(current => current?.top === next?.top && current?.height === next?.height ? current : next);
        });
    }, [props.tracker]);
    React.useEffect(() => {
        let revision = props.tracker.getLayoutRevision();
        measure();
        const unsubscribe = props.tracker.subscribe(() => {
            const next = props.tracker.getLayoutRevision();
            if (next === revision) return;
            revision = next;
            measure();
        });
        return () => { unsubscribe(); latestMeasurement.current = null; };
    }, [measure, props.tracker, focused, props.instance.id]);
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
    const pluginName = descriptor?.pluginName ?? t('sessionBoard.item.pluginUnavailable.title');
    // Copies are named by what they are bound to, in the source slot (lab dbind H, N1).
    const bindingLabel = useWidgetInstanceBindingLabel(props.instance, descriptor);
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
            <View testID={`${props.testID}.body`} onLayout={onBodyLayout}>
                <HubWidgetBody widget={descriptor ?? undefined} instance={props.instance} onRepairInputs={props.onRepairInputs} testID={`${props.testID}.widget`} />
            </View>
        ) : (
            // The body's last height, so leaving and returning never moves the page.
            <View testID={`${props.testID}.deferred`} style={{ minHeight: bodyHeight }} />
        ),
    }), [active, bodyHeight, onBodyLayout, props.testID, descriptor, props.instance, props.onRepairInputs]);

    return (
        <View ref={node => { sectionRef.current = node; drag.ref(node); }} collapsable={false} testID={props.testID} onLayout={() => { measure(); drag.onLayout(); }} style={styles.cell} {...props.hoverProps}>
            <WidgetFrame
                testID={`${props.testID}.frame`}
                frameStyle={props.frameStyle}
                placement="home"
                fill
                mark={descriptor?.icon ?? 'squares-four'}
                title={props.titleEditor ?? props.instance.displayName ?? descriptor?.title ?? t('boards.widgets.kind')}
                source={bindingLabel ?? pluginName}
                menu={props.entityDrag ? <>{props.menu}<SessionSurfaceEntityDragHandle drag={drag} title={props.entityDrag.title} testID={`${props.testID}.move`} /></> : props.menu}
                body={body}
                footer={footer}
            />
        </View>
    );
});

/** The mounted body: the one installed-widget arm, against the app shell's plugin projection. */
function HubWidgetBody(props: Readonly<{ widget?: WidgetCandidate; instance: WidgetInstanceV1; onRepairInputs?: (() => void) | undefined; testID: string }>) {
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
            recordRevision={stableJsonStringify(props.instance)}
            presentation="content"
            appRuntime={runtime}
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
