import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useLocalServiceLiveFeeds } from '@/components/sessions/localServices/useLocalServiceLiveFeeds';
import { useServicesOpenInBrowser } from '@/components/sessions/localServices/useServicesOpenInBrowser';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { SurfaceAsOfLabel } from '@/components/ui/surfaces/SurfaceAsOfLabel';
import { Text } from '@/components/ui/text/Text';
import { WidgetFrame, type WidgetFrameBody, type WidgetFrameStyle } from '@/components/widgets/frame/WidgetFrame';
import { Typography } from '@/constants/Typography';
import { selectLocalServiceInventoryRows } from '@/sync/domains/local/services/inventory/store';
import { selectLocalServiceLaunchTargets, type LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import { buildLocalServiceRows, selectLocalServiceRunningCount } from '@/sync/domains/local/services/serviceRow';
import { t } from '@/text';

import { resolveLocalServicesGlanceRows, type LocalServicesGlanceRow } from './glanceModels';

const OPEN_TARGET_PX = resolveMinimumInteractiveTargetSize(Platform.OS);

const stylesheet = StyleSheet.create((theme) => ({
    row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 40, minWidth: 0 },
    dotCell: { width: 16, alignItems: 'center', justifyContent: 'center' },
    dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: theme.colors.state.success.foreground },
    dotOff: { backgroundColor: theme.colors.border.strong },
    labels: { flex: 1, minWidth: 0 },
    title: { ...Typography.default(), ...happierPageTextMetrics('rowDescription'), color: theme.colors.text.primary },
    detail: { color: theme.colors.text.tertiary },
    status: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    quiet: { ...Typography.default(), ...happierPageTextMetrics('meta'), color: theme.colors.text.secondary },
    meta: { ...Typography.default(), ...Typography.tabular(), ...happierPageTextMetrics('meta'), color: theme.colors.text.tertiary },
    open: { width: OPEN_TARGET_PX, height: OPEN_TARGET_PX, alignItems: 'center', justifyContent: 'center', marginRight: -8 },
}));

export type LocalServicesGlanceState =
    | Readonly<{ kind: 'loading' }>
    | Readonly<{ kind: 'noMachine' }>
    | Readonly<{ kind: 'error' }>
    | Readonly<{ kind: 'ready'; rows: readonly LocalServicesGlanceRow[]; runningCount: number; refreshFailed?: boolean }>;

/**
 * The Local services glance (lab WC, C1, round 2): what runs where, Open on a running service, and a
 * script that is not running listed without Start. Static props only; {@link LocalServicesGlance}
 * subscribes.
 */
export const LocalServicesGlanceView = React.memo(function LocalServicesGlanceView(props: Readonly<{
    state: LocalServicesGlanceState;
    machineName: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    menu?: React.ReactNode;
    /** Last-known while away or after a failed refresh; replaces the running count. */
    asOf?: number | null;
    onOpen?: (target: LocalServiceLaunchTarget) => void;
    onRetry?: () => void;
    testID: string;
}>) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const state = props.state;
    let body: WidgetFrameBody;
    if (state.kind === 'loading') {
        body = { kind: 'loading', accessibilityLabel: t('widgetGlances.servicesLoading') };
    } else if (state.kind === 'noMachine') {
        body = { kind: 'content', children: <Text style={styles.quiet}>{t('widgetGlances.noMachine')}</Text> };
    } else if (state.kind === 'error') {
        body = {
            kind: 'error', title: t('localServices.inventory.errorTitle'), reason: t('widgetGlances.servicesReadFailed'),
            ...(props.onRetry ? { action: { label: t('common.retry'), onPress: props.onRetry } } : {}),
        };
    } else if (state.rows.length === 0) {
        body = { kind: 'content', children: <Text style={styles.quiet}>{t('widgetGlances.nothingRunning')}</Text> };
    } else {
        body = {
            kind: 'content',
            children: state.rows.map((row) => {
                const onOpen = props.onOpen;
                const openTarget = row.openTarget;
                return (
                    <View key={row.id} style={styles.row} testID={`${props.testID}.row.${row.id}`}>
                        <View style={styles.dotCell} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                            <View style={[styles.dot, row.running ? null : styles.dotOff]} />
                        </View>
                        <View style={styles.labels}>
                            <Text style={styles.title} numberOfLines={1}>
                                {row.title}
                                {row.detail ? <Text style={styles.detail}>{` ${row.detail}`}</Text> : null}
                            </Text>
                            <Text style={styles.status} numberOfLines={1}>
                                {row.running ? t('widgetGlances.running') : t('widgetGlances.notRunning')}
                            </Text>
                        </View>
                        {openTarget && onOpen ? (
                            <Pressable
                                testID={`${props.testID}.row.${row.id}.open`}
                                accessibilityRole="button"
                                accessibilityLabel={t('widgetGlances.openInBrowser', { name: row.title })}
                                onPress={() => onOpen(openTarget)}
                                style={styles.open}
                            >
                                <Icon name="arrow-square-out" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
                            </Pressable>
                        ) : null}
                    </View>
                );
            }),
        };
    }
    const meta = props.asOf
        ? <SurfaceAsOfLabel at={props.asOf} testID={`${props.testID}.asOf`} />
        : state.kind === 'ready' && state.runningCount > 0
            ? <Text style={styles.meta}>{t('widgetGlances.runningCount', { count: state.runningCount })}</Text>
            : null;
    return (
        <WidgetFrame
            presentation={props.presentation}
            testID={props.testID}
            frameStyle={props.frameStyle}
            placement="companion"
            mark="hard-drives"
            title={t('widgetGlances.localServicesTitle')}
            {...(props.machineName ? { source: props.machineName } : {})}
            meta={meta}
            menu={props.menu}
            body={body}
            footer={state.kind === 'ready' && state.refreshFailed
                ? { kind: 'refreshFailed', reason: t('widgetGlances.servicesReadFailed'), onRetry: props.onRetry }
                : null}
        />
    );
});

type LocalServicesGlanceProps = Readonly<{
    sessionId: string;
    serverId: string | null;
    frameStyle: WidgetFrameStyle;
    presentation?: 'frame' | 'body';
    onAfterDetailsOpen?: () => void;
    menu?: React.ReactNode;
    measurementOnly: boolean;
    testID: string;
}>;

/**
 * The Local services glance in the Companion. A measuring pass draws the frame at its loading size
 * and starts nothing; the visible glance mounts the Local services feeds (the inventory watch and the
 * launcher read — the same owner the pane uses, never a second poll).
 */
export function LocalServicesGlance(props: LocalServicesGlanceProps) {
    if (props.measurementOnly) {
        return (
            <LocalServicesGlanceView
                presentation={props.presentation}
                testID={props.testID}
                state={{ kind: 'loading' }}
                machineName={null}
                frameStyle={props.frameStyle}
                menu={props.menu}
            />
        );
    }
    return <LocalServicesLiveGlance {...props} />;
}

function LocalServicesLiveGlance(props: LocalServicesGlanceProps) {
    const machineId = useSessionMachineTarget(props.sessionId, props.serverId)?.machineId ?? null;
    const machine = useMachinePresenceSummary(props.serverId, machineId);
    const feeds = useLocalServiceLiveFeeds({
        machineId,
        serverId: props.serverId,
        sessionId: props.sessionId,
        scope: 'workspace',
    });
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(props.sessionId, props.serverId));
    const openInBrowser = useServicesOpenInBrowser({
        scopeId,
        scope: 'sessionDetails',
        machineId,
        serverId: props.serverId,
        sessionId: props.sessionId,
        onAfterDetailsOpen: props.onAfterDetailsOpen,
    });
    const state = React.useMemo<LocalServicesGlanceState>(() => {
        if (!machineId) return { kind: 'noMachine' };
        const rows = buildLocalServiceRows({
            inventoryRows: selectLocalServiceInventoryRows(feeds.inventoryState),
            launchTargets: feeds.launcherState ? selectLocalServiceLaunchTargets(feeds.launcherState) : [],
            sessionId: props.sessionId,
            scope: 'workspace',
        });
        const refreshFailed = feeds.inventoryState.refreshState === 'error' || feeds.launcherState?.refreshStatus === 'error';
        if (rows.length === 0) {
            if (refreshFailed) return { kind: 'error' };
            if (feeds.inventoryState.generatedAt === null || !feeds.launcherState || feeds.launcherState.updatedAt === null) {
                return { kind: 'loading' };
            }
        }
        return { kind: 'ready', rows: resolveLocalServicesGlanceRows(rows), runningCount: selectLocalServiceRunningCount(rows), refreshFailed };
    }, [feeds.inventoryState, feeds.launcherState, machineId, props.sessionId]);
    const open = React.useCallback((target: LocalServiceLaunchTarget) => {
        void openInBrowser(target);
    }, [openInBrowser]);
    const away = machine.reachability === 'unreachable';
    return (
        <View testID={`${props.testID}.live`}>
            <LocalServicesGlanceView
                presentation={props.presentation}
                testID={props.testID}
                state={state}
                machineName={machine.name}
                frameStyle={props.frameStyle}
                menu={props.menu}
                asOf={away || (state.kind === 'ready' && state.refreshFailed)
                    ? feeds.launcherState?.updatedAt ?? feeds.inventoryState.generatedAt
                    : null}
                onOpen={open}
                onRetry={feeds.refresh}
            />
        </View>
    );
}
