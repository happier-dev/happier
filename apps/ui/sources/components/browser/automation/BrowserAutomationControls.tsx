import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Text } from '@/components/ui/text/Text';
import type { BrowserControlViewState } from '@/sync/domains/browser/control';
import type {
    BrowserAutomationControlService,
    BrowserAutomationTimelineEntry,
} from '@/sync/domains/browser/automation';
import { t } from '@/text';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
    },
    statusPill: {
        minHeight: 34,
        maxWidth: 220,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        paddingHorizontal: 10,
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusPillActive: {
        borderColor: theme.colors.state.warning.foreground,
    },
    statusText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
    },
    statusTextActive: {
        color: theme.colors.state.warning.foreground,
    },
    timeline: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
    },
    timelineEntry: {
        minHeight: 26,
        maxWidth: 160,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.inset,
        paddingHorizontal: 8,
        alignItems: 'center',
        justifyContent: 'center',
    },
    timelineText: {
        color: theme.colors.text.secondary,
        fontSize: 11,
    },
}));

type AutomationSnapshotController = Readonly<{
    controller?: unknown;
    activeAutomationRequestId?: unknown;
    controlEpoch?: unknown;
}>;

type AutomationSnapshotOwner = Readonly<{
    authority?: unknown;
    navigationGeneration?: unknown;
}>;

type AutomationSnapshot = Readonly<{
    ownersByViewId?: unknown;
    controllerByViewId?: unknown;
}>;

function readSnapshotRecord<T>(
    snapshot: AutomationSnapshot,
    key: 'ownersByViewId' | 'controllerByViewId',
    viewId: string,
): T | null {
    const value = snapshot[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = (value as Readonly<Record<string, unknown>>)[viewId];
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
    return record as T;
}

function readSnapshot(service: BrowserAutomationControlService): AutomationSnapshot {
    return service.getSnapshot() as AutomationSnapshot;
}

function resolveStatusId(input: Readonly<{
    view: BrowserControlViewState | null;
    owner: AutomationSnapshotOwner | null;
    controller: AutomationSnapshotController | null;
}>): 'active' | 'no-view' | 'ready' | 'unavailable' {
    if (!input.view) return 'no-view';
    if (typeof input.controller?.activeAutomationRequestId === 'string') return 'active';
    if (input.owner) return 'ready';
    return 'unavailable';
}

function resolveStatusLabel(input: Readonly<{
    statusId: 'active' | 'no-view' | 'ready' | 'unavailable';
}>): string {
    switch (input.statusId) {
        case 'active':
            return t('browserAutomation.status.running');
        case 'ready':
            return t('browserAutomation.status.readyForActions');
        case 'no-view':
            return t('browserAutomation.status.noView');
        case 'unavailable':
            return t('browserAutomation.status.unavailable');
    }
}

function automationActionLabel(actionKind: string): string {
    switch (actionKind) {
        case 'snapshot':
        case 'semanticSnapshot':
            return t('browserAutomation.timeline.action.inspect');
        case 'click':
        case 'tap':
        case 'type':
        case 'setValue':
        case 'scroll':
        case 'waitFor':
            return t('browserAutomation.timeline.action.interact');
        case 'navigate':
        case 'reload':
        case 'goBack':
        case 'goForward':
            return t('browserAutomation.timeline.action.navigate');
        default:
            return t('browserAutomation.timeline.action.browserAction');
    }
}

function automationResultLabel(status: BrowserAutomationTimelineEntry['status']): string {
    switch (status) {
        case 'succeeded':
            return t('browserAutomation.timeline.status.succeeded');
        case 'failed':
            return t('browserAutomation.timeline.status.failed');
        case 'interrupted':
        case 'canceled':
            return t('browserAutomation.timeline.status.canceled');
        case 'timed_out':
            return t('browserAutomation.timeline.status.timedOut');
        case 'stale':
            return t('browserAutomation.timeline.status.stale');
        case 'policy_denied':
            return t('browserAutomation.timeline.status.blocked');
        case 'unsupported':
            return t('browserAutomation.timeline.status.unsupported');
    }
}

function formatTimelineLabel(entry: BrowserAutomationTimelineEntry): string {
    return t('browserAutomation.timeline.entry', {
        action: automationActionLabel(entry.actionKind),
        status: automationResultLabel(entry.status),
    });
}

export function BrowserAutomationControls(props: Readonly<{
    view: BrowserControlViewState | null;
    controlService: BrowserAutomationControlService;
    enabled?: boolean;
    timelineLimit?: number;
    testID?: string;
}>): React.ReactElement | null {
    const testID = props.testID ?? 'browser-automation-controls';
    const [version, setVersion] = React.useState(0);

    React.useEffect(() => props.controlService.subscribe(() => {
        setVersion((current) => current + 1);
    }), [props.controlService]);

    const snapshot = React.useMemo(
        () => readSnapshot(props.controlService),
        [props.controlService, version],
    );
    const owner = props.view
        ? readSnapshotRecord<AutomationSnapshotOwner>(snapshot, 'ownersByViewId', props.view.viewId)
        : null;
    const controller = props.view
        ? readSnapshotRecord<AutomationSnapshotController>(snapshot, 'controllerByViewId', props.view.viewId)
        : null;
    const timeline = React.useMemo(() => {
        if (!props.view) return [];
        return props.controlService.getActionTimeline({
            browserSessionId: props.view.browserSessionId,
            viewId: props.view.viewId,
        }).slice(-(props.timelineLimit ?? 3)).reverse();
    }, [props.controlService, props.timelineLimit, props.view, version]);
    const statusId = resolveStatusId({
        view: props.view,
        owner,
        controller,
    });
    const activeRequestId = typeof controller?.activeAutomationRequestId === 'string'
        ? controller.activeAutomationRequestId
        : null;
    const cancelDisabled = props.enabled === false || !props.view || !activeRequestId;

    if (props.enabled === false) {
        return null;
    }

    return (
        <View testID={testID} style={stylesheet.root}>
            <View
                testID={`${testID}-status-${statusId}`}
                style={[stylesheet.statusPill, statusId === 'active' ? stylesheet.statusPillActive : null]}
            >
                <Text
                    numberOfLines={1}
                    style={[stylesheet.statusText, statusId === 'active' ? stylesheet.statusTextActive : null]}
                >
                    {resolveStatusLabel({ statusId })}
                </Text>
            </View>
            <IconButton
                testID={`${testID}-cancel`}
                iconName="close-circle-outline"
                accessibilityLabel={t('browserAutomation.actions.cancel')}
                tooltip={t('browserAutomation.actions.cancel')}
                size={34}
                disabled={cancelDisabled}
                onPress={() => {
                    if (!props.view || !activeRequestId) return;
                    props.controlService.cancelActiveAction({
                        browserSessionId: props.view.browserSessionId,
                        viewId: props.view.viewId,
                        reasonCode: 'user_canceled',
                    });
                }}
            />
            {timeline.length > 0 ? (
                <View testID={`${testID}-timeline`} style={stylesheet.timeline}>
                    {timeline.map((entry) => (
                        <View
                            key={entry.timelineEntryId}
                            testID={`${testID}-timeline-entry-${entry.automationRequestId}`}
                            style={stylesheet.timelineEntry}
                        >
                            <Text
                                numberOfLines={1}
                                testID={`${testID}-timeline-status-${entry.status}`}
                                style={stylesheet.timelineText}
                            >
                                {formatTimelineLabel(entry)}
                            </Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
}
