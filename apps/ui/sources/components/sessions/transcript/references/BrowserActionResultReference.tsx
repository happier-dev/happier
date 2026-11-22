import * as React from 'react';
import { useWindowDimensions, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { useOptionalAppPaneScopeLayout } from '@/components/appShell/panes/hooks/useAppPaneScopeLayout';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { resolveBrowserViewTargetReplacementTab } from '@/components/browser/surfaces/openBrowserTargetInWorkspace';
import { SessionMediaInlineImages } from '@/components/sessions/media/SessionMediaInlineImages';
import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { createSessionPaneScopeId } from '@/components/sessions/panes/sessionPaneScopeId';
import { useDestinationPaneScopeId } from '@/components/appShell/workspace/DestinationInstanceHost';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { shouldRedirectDetailsRouteToPanes } from '@/components/ui/panels/shouldRedirectDetailsRouteToPanes';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ToolCall } from '@happier-dev/session-core/messages';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { listBrowserDaemonViewsViaMachineRpc } from '@/sync/domains/browser/control/machineRpc';
import { resolveBrowserDaemonStreamTarget } from '@/sync/domains/browser/store';
import { readRegisteredBrowserRuntimeControlAdapter } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { isDaemonAuthoritativeBrowserView } from '@/sync/domains/browser/control/commands';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';

import { describeBrowserAction, readBrowserCallOutcome, type BrowserCallOutcome } from './browserActionPhrase';
import {
    resolveTranscriptBrowserActionReference,
    type TranscriptBrowserActionReference,
} from './transcriptBrowserActionReference';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        paddingTop: theme.space.s4,
        gap: theme.space.s4,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    action: {
        ...Typography.variant('meta'),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    page: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
        flexShrink: 2,
    },
    shot: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: theme.space.s8,
    },
}));

function iconForVerb(verb: TranscriptBrowserActionReference['verb']): IconName {
    switch (verb) {
        case 'open':
        case 'reload':
        case 'back':
        case 'forward':
        case 'look':
        case 'other':
            return 'globe';
        case 'screenshot':
            return 'image';
        case 'recordingStarted':
        case 'recordingStopped':
            return 'circle';
        default:
            return 'hand';
    }
}

/**
 * What the agent did in the browser, shown with the tool call it came from (lab `browser` T): the
 * action in words, the page, the screenshot when the call produced one, and Watch to open the page
 * in the browser. It is the call's OUTCOME, so it sits at row level beside the other Action result
 * references rather than inside the collapsible diagnostic body.
 *
 * Nothing here is guessed: a thumbnail appears only for a session screenshot the result names, and
 * Watch resolves the exact named view through its owner, never by reopening the input URL.
 */
export const BrowserActionResultReference = React.memo(function BrowserActionResultReference(props: Readonly<{
    tool: ToolCall;
    sessionId?: string;
    serverId?: string | null;
    mediaPreviewEnabled?: boolean;
}>): React.ReactElement | null {
    const reference = React.useMemo(() => resolveTranscriptBrowserActionReference({
        toolName: props.tool.name,
        state: props.tool.state,
        input: props.tool.input,
        result: props.tool.result,
    }), [props.tool.input, props.tool.name, props.tool.result, props.tool.state]);
    const outcome = readBrowserCallOutcome(props.tool);
    if (!reference) return null;
    return (
        <MountedBrowserActionReference
            reference={reference}
            outcome={outcome}
            sessionId={props.sessionId ?? null}
            serverId={props.serverId ?? null}
            mediaPreviewEnabled={props.mediaPreviewEnabled === true}
        />
    );
});

function MountedBrowserActionReference(props: Readonly<{
    reference: TranscriptBrowserActionReference;
    outcome: BrowserCallOutcome;
    sessionId: string | null;
    serverId: string | null;
    mediaPreviewEnabled: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { reference } = props;
    const showPage = reference.pageLabel !== null && reference.verb !== 'open';
    // A screenshot belongs to the Session that stored it; one from another Session is not this
    // row's to show.
    const screenshot = reference.screenshot && reference.screenshot.sessionId === props.sessionId
        ? reference.screenshot
        : null;
    const media = React.useMemo(() => (screenshot ? [{
        id: screenshot.mediaId,
        name: t('browserTool.screenshot'),
        path: screenshot.path,
        mimeType: 'image/png',
        sizeBytes: screenshot.sizeBytes,
        sha256: screenshot.sha256,
        width: screenshot.width,
        height: screenshot.height,
        category: 'tool-artifact' as const,
        role: 'output' as const,
    }] : []), [screenshot]);
    const testID = `transcript-browser-action-${reference.actionId}`;
    // A call that failed opened nothing, so there is nothing to watch.
    const watch = props.outcome === 'failed' ? null : reference.watch;

    return (
        <View style={stylesheet.root} testID={testID}>
            <View style={stylesheet.line}>
                <Icon name={iconForVerb(reference.verb)} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                <Text style={stylesheet.action} numberOfLines={1} testID={`${testID}-label`}>{describeBrowserAction(reference, props.outcome)}</Text>
                {showPage ? <Text style={stylesheet.page} numberOfLines={1}>{`· ${reference.pageLabel}`}</Text> : null}
            </View>
            {screenshot || (watch && props.sessionId) ? (
                <View style={stylesheet.shot}>
                    {screenshot && props.sessionId ? (
                        <BrowserScreenshotThumbnail
                            sessionId={props.sessionId}
                            serverId={props.serverId}
                            storage={screenshot.storage}
                            media={media}
                            mediaPreviewEnabled={props.mediaPreviewEnabled}
                            testID={testID}
                        />
                    ) : null}
                    {watch && props.sessionId ? (
                        <BrowserActionWatchButton
                            watch={watch}
                            sessionId={props.sessionId}
                            serverId={props.serverId}
                            testID={`${testID}-watch`}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

/**
 * The call's screenshot, read from whichever store holds it: the Session's working directory, or —
 * for the managed browser's captures — the daemon's Session media store under its home directory
 * (W2B writes those with `storage: 'daemon'`, relative to that home, as the CLI's own trusted image
 * reader resolves them).
 */
function BrowserScreenshotThumbnail(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    storage: 'session' | 'daemon';
    media: React.ComponentProps<typeof SessionMediaInlineImages>['media'];
    mediaPreviewEnabled: boolean;
    testID: string;
}>): React.ReactElement | null {
    const daemonStored = props.storage === 'daemon';
    const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
    // The managed browser's daemon is the Session's own machine.
    const machine = useSessionMachineTarget(daemonStored ? props.sessionId : null, serverId);
    return (
        <SessionStoredImageThumbnail
            sessionId={props.sessionId}
            serverId={props.serverId}
            machineId={machine?.machineId ?? null}
            storage={props.storage}
            media={props.media}
            mediaPreviewEnabled={props.mediaPreviewEnabled}
            testID={props.testID}
        />
    );
}

/**
 * Opens the call's view in the Session's Details browser tab, through the canonical browser-view tab
 * builder. Only where Details panes exist; a phone has no Details column to open it in.
 */
function BrowserActionWatchButton(props: Readonly<{
    watch: NonNullable<TranscriptBrowserActionReference['watch']>;
    sessionId: string;
    serverId: string | null;
    testID: string;
}>): React.ReactElement | null {
    const { width: windowWidth } = useWindowDimensions();
    const deviceType = useDeviceType();
    const multiPaneEnabled = useLocalSetting('uiMultiPanePanelsEnabled') !== false;
    const serverId = usePreferredServerIdForSession({ sessionId: props.sessionId, serverId: props.serverId });
    const machine = useSessionMachineTarget(props.sessionId, serverId);
    const [opening, setOpening] = React.useState(false);
    const paneScopeLayout = useOptionalAppPaneScopeLayout();
    const scopeId = useDestinationPaneScopeId(createSessionPaneScopeId(props.sessionId, serverId ?? undefined));
    const pane = useAppPaneScope(scopeId);
    const detailsAvailable = shouldRedirectDetailsRouteToPanes({
        detailsAvailable: paneScopeLayout?.detailsAvailable,
        containerWidthPx: paneScopeLayout?.containerWidthPx ?? windowWidth,
        deviceType,
        multiPaneEnabled,
    });
    const { watch } = props;
    const lifetime = React.useMemo(() => ({ current: true, controller: null as AbortController | null }),
        [detailsAvailable, machine?.machineId, serverId, watch.browserSessionId, watch.viewId]);
    React.useEffect(() => {
        lifetime.current = true;
        setOpening(false);
        return () => {
            lifetime.current = false;
            lifetime.controller?.abort();
        };
    }, [lifetime]);
    const open = React.useCallback(async () => {
        if (!lifetime.current || !detailsAvailable) return;
        lifetime.controller?.abort();
        const controller = new AbortController();
        lifetime.controller = controller;
        setOpening(true);
        try {
            const localView = readRegisteredBrowserRuntimeControlAdapter(watch.browserSessionId)?.readState()?.viewsById[watch.viewId];
            let target = localView?.browserSessionId === watch.browserSessionId && !isDaemonAuthoritativeBrowserView(localView)
                ? localView.target : null;
            if (!target && machine && serverId) {
                const result = await listBrowserDaemonViewsViaMachineRpc({
                    machineId: machine.machineId, serverId, browserSessionId: watch.browserSessionId,
                    signal: controller.signal,
                });
                if (controller.signal.aborted || !lifetime.current) return;
                const view = result.ok ? result.views.find(candidate => candidate.browserSessionId === watch.browserSessionId
                    && candidate.viewId === watch.viewId) : null;
                target = view ? resolveBrowserDaemonStreamTarget(view) : null;
            }
            if (!target) {
                Modal.alert(t('common.error'), t('browserLaunchpad.status.unavailableGeneric'));
                return;
            }
            pane.openDetailsTab(resolveBrowserViewTargetReplacementTab({
                target, browserSessionId: watch.browserSessionId, viewId: watch.viewId,
            }), { intent: 'default' });
        } finally {
            if (lifetime.current && lifetime.controller === controller) setOpening(false);
        }
    }, [detailsAvailable, lifetime, machine, pane, serverId, watch]);
    if (!detailsAvailable) return null;
    return (
        <RoundButton
            size="small"
            display="secondary"
            title={t('browserTool.watch')}
            accessibilityHint={t('browserTool.watchA11y')}
            onPress={open}
            loading={opening}
            disabled={opening}
            testID={props.testID}
        />
    );
}
