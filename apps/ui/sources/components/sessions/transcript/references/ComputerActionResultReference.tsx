import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerApprovalDisplayV1 } from '@happier-dev/protocol';
import type { ToolCall } from '@happier-dev/session-core/messages';

import { openComputerTargetPickerForSession } from '@/components/computer/openComputerTargetPickerForSession';
import { useOpenSessionComputerScreen } from '@/components/computer/useOpenSessionComputerScreen';
import { noteSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { SessionStoredImageThumbnail } from '@/components/sessions/media/SessionStoredImageThumbnail';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';
import { resolveTranscriptComputerActionReference, type TranscriptComputerActionReference, type TranscriptComputerVerb } from './transcriptComputerActionReference';

const stylesheet = StyleSheet.create((theme) => ({
    ask: {
        marginTop: theme.margins.xs,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        padding: 12,
        borderRadius: 12,
        borderCurve: 'continuous',
        backgroundColor: theme.colors.surface.inset,
    },
    askText: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    askTitle: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    askBody: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    askActions: {
        flexDirection: 'row',
        gap: 8,
        marginTop: 8,
    },
    watch: {
        paddingTop: theme.margins.xs,
        flexDirection: 'row',
    },
    // The browser reference's row anatomy (`BrowserActionResultReference`): one line, then the picture.
    actionRoot: {
        paddingTop: theme.margins.xs,
        gap: theme.margins.xs,
    },
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.sm,
        minWidth: 0,
    },
    action: {
        ...Typography.rowMeta(),
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
    actionRunning: {
        color: theme.colors.text.secondary,
    },
    outcome: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
        flexShrink: 2,
    },
    outcomeWarning: {
        color: theme.colors.state.warning.foreground,
    },
    shot: {
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: theme.margins.sm,
    },
}));

const VERB_ICON = {
    capture: 'camera',
    query: 'text-aa',
    click: 'hand',
    type: 'text-aa',
    press: 'text-aa',
} as const satisfies Record<TranscriptComputerVerb, IconName>;

function describeComputerAction(reference: Extract<TranscriptComputerActionReference, { kind: 'action' }>): string {
    const running = reference.running;
    switch (reference.verb) {
        case 'capture': return t(running ? 'computerUse.tool.captureRunning' : 'computerUse.tool.capture');
        case 'query': return t(running ? 'computerUse.tool.queryRunning' : 'computerUse.tool.query');
        case 'click': return !running && reference.targetLabel
            ? t('computerUse.tool.clickTarget', { target: reference.targetLabel })
            : t(running ? 'computerUse.tool.clickRunning' : 'computerUse.tool.click');
        case 'type': return !running && reference.targetLabel
            ? t('computerUse.tool.typeTarget', { target: reference.targetLabel })
            : t(running ? 'computerUse.tool.typeRunning' : 'computerUse.tool.type');
        case 'press': return running
            ? t('computerUse.tool.pressRunning')
            : reference.key ? t('computerUse.tool.pressKey', { key: reference.key }) : t('computerUse.tool.press');
    }
}

/** Opens the Session's shared window: Details where it exists, the cockpit's Tabs surface on a phone. */
function ComputerWatchButton(props: Readonly<{ sessionId: string; serverId: string | null; machineId: string; testID: string }>): React.ReactElement | null {
    const open = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: props.serverId, machineId: props.machineId });
    if (!open) return null;
    return <RoundButton size="small" display="secondary" title={t('computerUse.request.watch')} onPress={open} testID={props.testID} />;
}

/** What the agent did on the shared window: the act in words, its screenshot, and Watch. */
function ComputerActionLine(props: Readonly<{
    reference: Extract<TranscriptComputerActionReference, { kind: 'action' }>;
    sessionId: string;
    serverId: string | null;
    mediaPreviewEnabled: boolean;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { reference } = props;
    // A screenshot belongs to the Session that stored it; one from another Session is not this row's.
    const shot = reference.media && reference.media.file.sessionId === props.sessionId ? reference.media : null;
    const media = React.useMemo(() => (shot ? [{
        id: shot.mediaId,
        name: t('computerUse.tool.capture'),
        path: shot.file.path,
        mimeType: shot.file.mimeType,
        sizeBytes: shot.sizeBytes,
        sha256: shot.file.sha256,
        width: shot.width,
        height: shot.height,
        category: 'tool-artifact' as const,
        role: 'output' as const,
    }] : []), [shot]);
    return (
        <View style={stylesheet.actionRoot} testID={props.testID}>
            <View style={stylesheet.line}>
                {reference.running
                    ? <ActivitySpinner size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                    : <Icon name={VERB_ICON[reference.verb]} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />}
                <Text style={[stylesheet.action, reference.running ? stylesheet.actionRunning : null]} numberOfLines={1} testID={`${props.testID}-label`}>
                    {describeComputerAction(reference)}
                </Text>
                {reference.outcome === 'mayHaveLanded' || reference.outcome === 'failed' ? (
                    <Text style={[stylesheet.outcome, reference.outcome === 'mayHaveLanded' ? stylesheet.outcomeWarning : null]} numberOfLines={1}>
                        {`· ${t(reference.outcome === 'failed' ? 'computerUse.tool.failed' : 'computerUse.tool.mayHaveLanded')}`}
                    </Text>
                ) : null}
            </View>
            {shot || reference.watch ? (
                <View style={stylesheet.shot}>
                    {shot ? (
                        <SessionStoredImageThumbnail
                            sessionId={props.sessionId}
                            serverId={props.serverId}
                            machineId={reference.machineId}
                            storage={shot.file.storage}
                            media={media}
                            mediaPreviewEnabled={props.mediaPreviewEnabled}
                            testID={`${props.testID}-shot`}
                        />
                    ) : null}
                    {reference.watch ? (
                        <ComputerWatchButton sessionId={props.sessionId} serverId={props.serverId} machineId={reference.machineId} testID={`${props.testID}-watch`} />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

function MountedComputerActionReference(props: Readonly<{
    reference: TranscriptComputerActionReference;
    sessionId: string;
    serverId: string | null;
    mediaPreviewEnabled: boolean;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const { reference, sessionId } = props;
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
    const identity = useBrowserSessionAgentIdentity({ sessionId, serverId });
    const [shared, setShared] = React.useState<ComputerApprovalDisplayV1 | null>(null);
    // The row is where this device learns the Session uses this machine for computer use.
    React.useEffect(() => {
        noteSessionComputerMachine({ sessionId, machineId: reference.machineId, machineName: reference.kind === 'choose' ? reference.machineName : null });
    }, [reference, sessionId]);
    const testID = `transcript-computer-action-${reference.actionId}`;
    const machineName = reference.kind === 'choose' ? reference.machineName : reference.machineId;
    const choose = React.useCallback(() => {
        openComputerTargetPickerForSession({
            sessionId,
            serverId,
            accountLifetime,
            machineId: reference.machineId,
            machineName,
            onSelected: (selection) => setShared(selection.approvalDisplay),
        });
    }, [accountLifetime, machineName, serverId, reference.machineId, sessionId]);

    if (reference.kind === 'action') {
        return <ComputerActionLine reference={reference} sessionId={sessionId} serverId={props.serverId} mediaPreviewEnabled={props.mediaPreviewEnabled} testID={testID} />;
    }
    const sharedTitle = shared?.target?.title.trim() || null;
    return (
        // The agent asked for a window and none is shared: the person chooses here (lab `computer` TP).
        <View style={stylesheet.ask} testID={testID} accessibilityRole="summary">
            <Icon name="browsers" size={ICON_SIZE.md} color={theme.colors.text.secondary} />
            <View style={stylesheet.askText}>
                <Text style={stylesheet.askTitle}>
                    {sharedTitle
                        ? t('computerUse.request.shared', { target: sharedTitle })
                        : t('computerUse.request.title', { agent: identity.name, machine: machineName })}
                </Text>
                {sharedTitle ? null : <Text style={stylesheet.askBody}>{t('computerUse.request.body')}</Text>}
                <View style={stylesheet.askActions}>
                    <RoundButton
                        size="small"
                        display={sharedTitle ? 'secondary' : undefined}
                        title={sharedTitle ? t('computerUse.request.change') : t('computerUse.request.choose')}
                        onPress={choose}
                        testID={`${testID}-choose`}
                    />
                    {sharedTitle ? (
                        <ComputerWatchButton sessionId={sessionId} serverId={props.serverId} machineId={reference.machineId} testID={`${testID}-watch`} />
                    ) : null}
                </View>
            </View>
        </View>
    );
}

/**
 * The transcript row's computer-use reference: where an agent asked for a window and none is shared,
 * the person's choice; where it acted on the shared window, Watch. Read only through the canonical
 * Action-result projection; nothing is guessed from the agent's arguments.
 */
export const ComputerActionResultReference = React.memo(function ComputerActionResultReference(props: Readonly<{
    tool: ToolCall;
    sessionId?: string;
    serverId?: string | null;
    mediaPreviewEnabled?: boolean;
}>): React.ReactElement | null {
    const reference = React.useMemo(() => resolveTranscriptComputerActionReference({
        toolName: props.tool.name,
        state: props.tool.state,
        input: props.tool.input,
        result: props.tool.result,
    }), [props.tool.input, props.tool.name, props.tool.result, props.tool.state]);
    if (!reference || !props.sessionId) return null;
    return <MountedComputerActionReference reference={reference} sessionId={props.sessionId} serverId={props.serverId ?? null} mediaPreviewEnabled={props.mediaPreviewEnabled === true} />;
});
