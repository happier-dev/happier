import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { BrowserPresenceCapsule } from '@/components/browser/copresence/BrowserPresenceCapsule';
import { useBrowserSessionAgentIdentity } from '@/components/browser/copresence/BrowserShellPresence';
import { COMPOSER_CONTENT_HORIZONTAL_INSET } from '@/components/sessions/agentInput/composerContentInset';
import { layout } from '@/components/ui/layout/layout';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionComputerMachine } from '@/sync/domains/computer/sessionComputerMachines';
import { t } from '@/text';
import { useDeviceType } from '@/utils/platform/responsive';
import { useSessionViewerSourceAccountLifetime } from '@/components/sessions/viewer/SessionViewerSourceAccountScope';

import { useComputerSessionControl } from './useComputerSessionControl';
import { useOpenSessionComputerScreen } from './useOpenSessionComputerScreen';

function MountedSessionComputerPresenceLine(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    machineId: string;
    testID: string;
}>): React.ReactElement | null {
    const identity = useBrowserSessionAgentIdentity({ sessionId: props.sessionId, serverId: props.serverId });
    const scope = React.useMemo(
        () => ({ sessionId: props.sessionId, machineId: props.machineId, serverId: props.serverId }),
        [props.machineId, props.serverId, props.sessionId],
    );
    // Share Action answers and, while the viewer is open, source-owned status metadata. Without a
    // viewer stream, refresh at turn boundaries and presses; do not open hidden image subscriptions.
    const control = useComputerSessionControl({ scope, refreshKey: identity.turnActive });
    const open = useOpenSessionComputerScreen({ sessionId: props.sessionId, serverId: props.serverId, machineId: props.machineId });
    const agent = React.useMemo(() => ({ agentId: identity.agentId, name: identity.name }), [identity.agentId, identity.name]);
    const compact = useDeviceType() === 'phone';
    if (!control.selection?.sourceId) return null;
    const target = control.appName ?? control.targetTitle ?? t('computerUse.viewer.tabFallback');
    const machine = control.machineName;
    return (
        <View style={styles.frame}>
            {/* The content width is read at render: the layout owner reads the person's width setting. */}
            <View style={[styles.column, { maxWidth: layout.maxWidth }]}>
                <BrowserPresenceCapsule
                    testID={props.testID}
                    placement="strip"
                    compact={compact}
                    presence={control.presence}
                    agent={agent}
                    agentTitle={control.agentActing
                        ? t('computerUse.strip.using', { target })
                        : t((control.selection.access ?? control.selection.approvalDisplay.access) === 'see'
                            ? 'computerUse.viewer.agentCanSee' : 'computerUse.viewer.agentCanUse', { agent: agent.name, target })}
                    agentDetail={machine ? t('computerUse.strip.on', { machine }) : undefined}
                    humanTitle={t('computerUse.strip.paused', { agent: agent.name })}
                    humanDetail={t('computerUse.strip.pausedDetail', { target })}
                    takeControlLabel={t('computerUse.strip.stop')}
                    checking={control.busy === 'check'}
                    onTakeControl={control.takeControl}
                    onHandBack={control.handBack}
                    onCheckAgain={control.checkAgain}
                    onWatch={open ?? undefined}
                />
            </View>
        </View>
    );
}

const styles = StyleSheet.create(() => ({
    // Under the session header, at the top of the transcript, in the transcript's own width.
    frame: {
        width: '100%',
        alignItems: 'center',
        paddingHorizontal: COMPOSER_CONTENT_HORIZONTAL_INSET,
        paddingTop: 8,
        paddingBottom: 4,
    },
    column: {
        width: '100%',
    },
}));

/**
 * Who is using the Session's shared window, wherever the person is in the Session (lab `computer` HC):
 * the one co-presence capsule as a compact strip at the top of the transcript on every device, with Watch (the viewer) and
 * Take control / Hand back / Check again against the computer owner. It mounts its owner reads only for
 * a Session this device has seen use a computer (an approval, a transcript row, the picker, the viewer),
 * so an ordinary Session issues no machine RPC; it renders only while a window is shared.
 */
export function SessionComputerPresenceLine(props: Readonly<{
    sessionId: string;
    serverId?: string | null;
    testID?: string;
}>): React.ReactElement | null {
    const accountLifetime = useSessionViewerSourceAccountLifetime();
    const serverId = props.serverId ?? accountLifetime?.scope.serverId ?? null;
    const seenComputerUse = useSessionComputerMachine(props.sessionId);
    // The share lives on the Session's own machine (computer use never targets another one).
    const sessionMachineId = useSessionMachineTarget(seenComputerUse && accountLifetime ? props.sessionId : null, serverId)?.machineId ?? null;
    if (!seenComputerUse || !sessionMachineId || seenComputerUse.machineId !== sessionMachineId) return null;
    return (
        <MountedSessionComputerPresenceLine
            sessionId={props.sessionId}
            serverId={serverId}
            machineId={sessionMachineId}
            testID={props.testID ?? 'session-computer-presence'}
        />
    );
}
