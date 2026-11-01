import * as React from 'react';
import { applySessionCompanionHumanIntent } from './presentation/sessionCompanionHumanAction';
import { I18nManager, Platform, View, useWindowDimensions, type ViewProps } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import type { CallerHostedHtmlRuntime } from '@/components/ui/surfaces/hostedHtml/HostedHtmlSurfaceAdapter';
import { ItemRowActions } from '@/components/ui/lists/ItemRowActions';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import type { SessionBoardSourceAvailabilityResolver } from '@/components/sessions/board/sessionBoardItemPresentation';

import {
    SessionCompanionContent,
    type SessionCompanionBoardBinding,
} from './SessionCompanionContent';
import { useSessionCompanionPlacement } from './layout/useSessionCompanionPlacement';
import { buildSessionCompanionMenuActions } from './sessionCompanionMenu';
import { useSessionCompanionBoardAdd } from './picker/useSessionCompanionBoardAdd';
import { useMountedSessionBoardController } from '@/components/sessions/board/SessionBoardControllerProvider';
import { useSessionCompanionController } from './state/useSessionCompanionController';
import type { SessionSummaryDestinationHandlers } from './summary/SessionSummaryCard';
import { publishSessionCompanionCardBounds } from './layout/sessionCompanionCardMeasurement';

/**
 * The wide Session Companion host.
 *
 * It reserves a dedicated logical side inset beside Chat when the pane owner
 * proves the room exists, and otherwise collapses to a quiet control. It never
 * floats over the transcript or composer, never guesses geometry, and never
 * decides which placement runs an executable item — that one answer comes from
 * the shared Board host-visibility owner, which sees every candidate placement.
 */

const stylesheet = StyleSheet.create((theme) => ({
    rail: {
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
    },
    /**
     * The hairline always faces Chat, so it follows the LOGICAL edge the rail
     * sits at and needs no direction lookup: resolving a physical side first and
     * then applying a logical border property flips it twice in RTL and lands
     * the line on the outside of the window.
     */
    railAtTrailingEdge: { borderStartWidth: 1, borderStartColor: theme.colors.border.default },
    railAtLeadingEdge: { borderEndWidth: 1, borderEndColor: theme.colors.border.default },
    measurementRail: {
        position: 'absolute',
        opacity: 0,
        overflow: 'hidden',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s6,
        paddingStart: theme.space.s12,
        paddingEnd: theme.space.s4,
        paddingTop: theme.space.s10,
    },
    // A title, not an eyebrow (lab CA): the column names itself like any pane.
    heading: {
        ...Typography.variant('heading'),
        color: theme.colors.text.primary,
        flex: 1,
        minWidth: 0,
    },
}));

// Native accessibility props keep the measurement rail out of assistive
// technology on iOS/Android.  On web, the same hidden DOM subtree must also be
// inert so its real interactive descendants cannot receive focus while the
// rail is being measured.  Keep one wrapper and one DOM boundary for both
// platforms; this is presentation state, not a second measurement host.
const MeasurementRailView = View as React.ComponentType<ViewProps & Pick<React.HTMLAttributes<HTMLElement>, 'inert' | 'aria-hidden'>>;

type SessionCompanionHostProps = Readonly<{
    session: Session;
    address: SessionAddress;
    boardBinding: SessionCompanionBoardBinding | null;
    pluginRuntime?: SessionPluginRuntimeState;
    callerHostedHtmlRuntime?: CallerHostedHtmlRuntime;
    resolveSourceAvailability?: SessionBoardSourceAvailabilityResolver;
    openFullSurface: () => void;
    onRevealBoardItem?: (itemId: string) => void;
    onManageBoardItemPlugin?: (itemId: string) => void;
    summaryDestinations?: SessionSummaryDestinationHandlers;
    paneScopeId: string;
    resolvePrimaryHost: SessionBoardPrimaryMountResolver;
}>;

export const SessionCompanionHost = React.memo(function SessionCompanionHost(
    props: SessionCompanionHostProps,
) {
    const styles = stylesheet;
    const { fontScale } = useWindowDimensions();
    const controller = useSessionCompanionController({
        sessionId: props.session.id,
        serverId: props.address.serverId,
        openFullSurface: props.openFullSurface,
    });
    // Every geometry fact comes from its incumbent owner; nothing is assumed.
    const placement = useSessionCompanionPlacement({
        sessionId: props.session.id,
        serverId: props.address.serverId,
        paneScopeId: props.paneScopeId,
    });
    const mutateCompanion = React.useCallback((intent: Parameters<typeof applySessionCompanionHumanIntent>[0]['intent']) =>
        applySessionCompanionHumanIntent({ address: props.address, intent }), [props.address]);
    const publishCardBounds = React.useCallback((bounds: Readonly<{ widthPx: number; heightPx: number }>) => {
        publishSessionCompanionCardBounds({
            sessionId: props.session.id,
            serverId: props.address.serverId,
            paneScopeId: props.paneScopeId,
            density: controller.preference.density,
            fontScale,
        }, bounds);
    }, [controller.preference.density, fontScale, props.address.serverId, props.paneScopeId, props.session.id]);

    // Adding reads the ONE mounted Board controller for this exact Session.
    const addBinding = useSessionCompanionBoardAdd(useMountedSessionBoardController(props.address));

    const menuActions = React.useMemo(() => buildSessionCompanionMenuActions({
        preference: controller.preference,
        layoutDirection: I18nManager.isRTL ? 'rtl' : 'ltr',
        setEdge: (edge) => { mutateCompanion({
            kind: 'companion.edge.set',
            edge,
        }); },
        setDensity: (density) => { mutateCompanion({
            kind: 'companion.density.set',
            density,
        }); },
        setCollapsed: (collapsed) => { mutateCompanion({
            kind: 'companion.collapse.set',
            collapsed,
        }); },
        hide: () => { mutateCompanion({
            kind: 'companion.hide',
        }); },
        openFullSurface: props.openFullSurface,
    }), [controller.preference, mutateCompanion, props.openFullSurface]);

    if (controller.availability !== 'ready') return null;

    if (placement.kind === 'measuring_rail') {
        return (
            <MeasurementRailView
                style={[
                    styles.measurementRail,
                    { width: placement.widthPx, height: placement.heightPx },
                ]}
                testID="session-companion-measurement-rail"
                pointerEvents="none"
                focusable={false}
                accessibilityElementsHidden
                importantForAccessibility="no-hide-descendants"
                inert={Platform.OS === 'web' ? true : undefined}
                aria-hidden={Platform.OS === 'web' ? true : undefined}
                collapsable={false}
            >
                <SessionCompanionContent
                    session={props.session}
                    serverId={props.address.serverId}
                    controller={controller}
                    boardBinding={props.boardBinding}
                    resolvePrimaryHost={props.resolvePrimaryHost}
                    {...(props.pluginRuntime ? { pluginRuntime: props.pluginRuntime } : {})}
                    {...(props.resolveSourceAvailability
                        ? { resolveSourceAvailability: props.resolveSourceAvailability }
                        : {})}
                    // The live rail's Summary inputs, so the measured card has the live
                    // card's shape; Content makes every handler inert while measuring.
                    {...(props.summaryDestinations ? { summaryDestinations: props.summaryDestinations } : {})}
                    onOpenFullSurface={props.openFullSurface}
                    presentation="rail"
                    measurementOnly
                    testID="session-companion-measurement-content"
                    onMeasuredCardBounds={publishCardBounds}
                />
            </MeasurementRailView>
        );
    }

    if (
        placement.kind === 'hidden'
        || placement.kind === 'mobile_control'
        || placement.kind === 'collapsed_control'
    ) return null;

    // The rail's own edge is logical all the way down: the hairline faces Chat,
    // and the Session layout — not a web-only `order` style — seats the rail on
    // the chosen side by reversing the one row it shares with Chat.
    const borderStyle = placement.edge === 'trailing'
        ? styles.railAtTrailingEdge
        : styles.railAtLeadingEdge;
    return (
        <View
            style={[styles.rail, borderStyle, { width: placement.widthPx }]}
            testID="session-companion-reserved-rail"
            accessibilityLabel={t('sessionBoard.companion.title')}
        >
            <View style={styles.header}>
                {/*
                  * A real heading, so a screen-reader user can jump into the rail
                  * the same way they reach Chat and Details instead of arrowing
                  * through it from wherever they happen to be.
                  */}
                <Text
                    numberOfLines={1}
                    style={styles.heading}
                    accessibilityRole="header"
                    testID="session-companion-reserved-rail-heading"
                >
                    {t('sessionBoard.companion.title')}
                </Text>
                <ItemRowActions
                    title={t('sessionBoard.companion.title')}
                    actions={menuActions}
                    compactThreshold={Number.POSITIVE_INFINITY}
                    overflowTriggerTestID="session-companion-menu"
                    overflowTriggerAccessibilityLabel={t('sessionBoard.companion.actions.menuA11y')}
                    iconSize={16}
                    gap={6}
                />
            </View>
            <SessionCompanionContent
                session={props.session}
                serverId={props.address.serverId}
                controller={controller}
                boardBinding={props.boardBinding}
                resolvePrimaryHost={props.resolvePrimaryHost}
                {...(props.pluginRuntime ? { pluginRuntime: props.pluginRuntime } : {})}
                {...(props.resolveSourceAvailability
                    ? { resolveSourceAvailability: props.resolveSourceAvailability }
                    : {})}
                {...(props.callerHostedHtmlRuntime ? { callerHostedHtmlRuntime: props.callerHostedHtmlRuntime } : {})}
                {...(props.summaryDestinations ? { summaryDestinations: props.summaryDestinations } : {})}
                {...(props.onRevealBoardItem ? { onRevealBoardItem: props.onRevealBoardItem } : {})}
                {...(props.onManageBoardItemPlugin
                    ? { onManageBoardItemPlugin: props.onManageBoardItemPlugin }
                    : {})}
                addBinding={addBinding}
                onOpenFullSurface={props.openFullSurface}
                presentation="rail"
                onMeasuredCardBounds={publishCardBounds}
            />
        </View>
    );
});
