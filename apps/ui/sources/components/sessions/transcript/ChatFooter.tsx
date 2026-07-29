import * as React from 'react';
import { View, ViewStyle } from 'react-native';
import { t } from '@/text';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import type { ExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import type { SessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';

export type ChatFooterExternalAgentPresentation = Readonly<{
    state: ExternalSessionRuntimePresentation['externalAgent']['state'];
    labelKey: ExternalSessionRuntimePresentation['externalAgent']['labelKey'];
    agentLabel: string | null;
    machineLabel: string | null;
}>;

export type ChatFooterExternalControlState = Readonly<{
    externalAgentPresentation: ChatFooterExternalAgentPresentation;
    statusKnown: boolean;
    machineOnline: boolean;
    runnerActive: boolean;
    trustedPid: number | null;
    activity: 'running' | 'active_recently' | 'idle' | 'unknown';
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    takeoverPreflightInFlight: boolean;
    takeoverInFlight: 'direct' | 'persisted' | null;
    onRequestTakeoverPreflight?: () => void | Promise<void>;
    materialize: Readonly<{
        requestEnabled: boolean;
        inFlight: boolean;
        onRequest: () => void | Promise<void>;
    }> | null;
}> | null;

type ChatFooterNotice = Readonly<{ title: string; body: string }>;

interface ChatFooterProps {
    controlledByUser?: boolean;
    localControl?: SessionLocalControlState | null;
    permissionsInUiWhileLocal?: boolean;
    notice?: ChatFooterNotice | null;
    /**
     * UI-only ephemeral state while a local-controlled session is switching back to remote.
     * This is intentionally not persisted to the session transcript.
    */
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    externalControl?: ChatFooterExternalControlState;
}

function resolveExternalAgentStatusBody(
    presentation: ChatFooterExternalAgentPresentation,
): string {
    const status = t(presentation.labelKey);
    if (!presentation.agentLabel || !presentation.machineLabel) {
        return status;
    }
    return t('externalSessions.externalAgentStatusOnMachine', {
        agent: presentation.agentLabel,
        machine: presentation.machineLabel,
        status,
    });
}

export const ChatFooter = React.memo((props: ChatFooterProps) => {
    const containerStyle: ViewStyle = {
        // Allow children to take full width so long banners can wrap instead of overflowing
        alignItems: 'stretch',
        paddingTop: 4,
        paddingBottom: 2,
    };

    const localControlBanner = React.useMemo(() => {
        const localControl = props.localControl ?? null;
        if (!localControl && !props.controlledByUser) return null;

        const derived = localControl ?? {
            attached: props.controlledByUser === true,
            topology: 'exclusive',
            remoteWritable: false,
            canAttach: false,
            canDetach: props.controlledByUser === true,
        } satisfies SessionLocalControlState;

        if (!derived.attached) return null;

        const switchingToRemote = props.controlSwitchTo === 'remote';
        const isSharedAttached = derived.attached && derived.topology === 'shared';
        const showSwitchToRemoteButton =
            derived.attached
            && derived.topology === 'exclusive'
            && !switchingToRemote
            && Boolean(props.onRequestSwitchToRemote);
        const showDetachButton =
            derived.attached
            && derived.topology === 'shared'
            && !switchingToRemote
            && derived.canDetach
            && Boolean(props.onRequestSwitchToRemote);
        const textKey = (() => {
            if (switchingToRemote) return 'chatFooter.switchingToRemote';
            if (isSharedAttached) return 'chatFooter.sessionRunningLocallyAndRemotely';
            if (props.permissionsInUiWhileLocal) return 'chatFooter.sessionRunningLocally';
            return 'chatFooter.permissionsTerminalOnly';
        })();

        const actionLabelKey = showSwitchToRemoteButton
            ? 'chatFooter.switchToRemote'
            : showDetachButton
                ? 'chatFooter.detachLocalTerminal'
                : null;
        const actionTestID = showSwitchToRemoteButton
            ? 'session-chatFooter-switchToRemote'
            : showDetachButton
                ? 'session-chatFooter-detachLocalTerminal'
                : undefined;

        return (
            <ComposerAuxiliaryFrame>
                <WarningActionBanner
                    testID="session-chatFooter-localControl"
                    iconName="information-circle"
                    body={t(textKey)}
                    actionTestID={actionTestID}
                    actionLabel={actionLabelKey ? t(actionLabelKey) : undefined}
                    actionAccessibilityLabel={actionLabelKey ? t(actionLabelKey) : undefined}
                    onActionPress={actionLabelKey ? props.onRequestSwitchToRemote : undefined}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [
        props.controlSwitchTo,
        props.controlledByUser,
        props.localControl,
        props.onRequestSwitchToRemote,
        props.permissionsInUiWhileLocal,
    ]);

    const materializeBanner = React.useMemo(() => {
        if (!props.externalControl?.materialize) return null;
        const materialize = props.externalControl.materialize;
        const textKey = materialize.inFlight
            ? 'externalSessions.operationComposerImporting'
            : 'externalSessions.operationMaterializeAvailable';
        const disabled = !materialize.requestEnabled || materialize.inFlight;

        return (
            <ComposerAuxiliaryFrame>
                <WarningActionBanner
                    testID="session-chatFooter-materialize"
                    tone="neutral"
                    iconName="cloud-upload-outline"
                    body={t(textKey)}
                    actionTestID="session-chatFooter-importIntoHappier"
                    actionLabel={t('externalSessions.operationTitleMaterialize')}
                    actionAccessibilityLabel={t('externalSessions.operationTitleMaterialize')}
                    actionBusy={materialize.inFlight}
                    disabled={disabled}
                    onActionPress={materialize.onRequest}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [props.externalControl]);

    const directModeBanner = React.useMemo(() => {
        if (!props.externalControl) return null;

        const switchingToDirect = props.externalControl.takeoverInFlight === 'direct';
        const switchingToPersisted = props.externalControl.takeoverInFlight === 'persisted';
        const preflightInFlight = props.externalControl.takeoverPreflightInFlight;
        const hasTakeoverMode =
            props.externalControl.canTakeOverDirect
            || props.externalControl.canTakeOverPersist;
        const showTakeoverAction =
            !switchingToDirect
            && !switchingToPersisted
            && (
                !props.externalControl.statusKnown
                || props.externalControl.runnerActive
                || hasTakeoverMode
            )
            && typeof props.externalControl.onRequestTakeoverPreflight === 'function';
        const externalAgentStatusBody = resolveExternalAgentStatusBody(
            props.externalControl.externalAgentPresentation,
        );

        const body = (() => {
            if (switchingToPersisted) return t('chatFooter.switchingToPersistedTakeover');
            if (switchingToDirect) return t('chatFooter.switchingToDirectTakeover');
            if (preflightInFlight) return t('chatFooter.checkingExternalSessionTakeover');
            if (props.externalControl.runnerActive) {
                const guidance = t('chatFooter.externalSessionTakeoverBlocked');
                const safetyGuidance = props.externalControl.trustedPid === null
                    ? guidance
                    : `${guidance} ${t('runs.detail.pid', {
                        pid: props.externalControl.trustedPid,
                    })}`;
                return `${externalAgentStatusBody} ${safetyGuidance}`;
            }
            return externalAgentStatusBody;
        })();
        const actionLabel = props.externalControl.runnerActive
            ? t('chatFooter.externalSessionRecheck')
            : t('chatFooter.takeOverDirect');

        return (
            <ComposerAuxiliaryFrame>
                <WarningActionBanner
                    testID="session-chatFooter-externalControl"
                    iconName="information-circle"
                    body={body}
                    actionTestID={showTakeoverAction ? 'session-chatFooter-takeOverDirect' : undefined}
                    actionLabel={showTakeoverAction ? actionLabel : undefined}
                    actionAccessibilityLabel={showTakeoverAction ? actionLabel : undefined}
                    actionBusy={preflightInFlight}
                    disabled={preflightInFlight}
                    onActionPress={showTakeoverAction
                        ? props.externalControl.onRequestTakeoverPreflight
                        : undefined}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [props.externalControl]);

    return (
        <View style={containerStyle}>
            {materializeBanner}
            {directModeBanner}
            {localControlBanner}
            {props.notice ? (
                <ComposerAuxiliaryFrame>
                    <WarningActionBanner
                        testID="session-chatFooter-notice"
                        tone="neutral"
                        iconName={null}
                        title={props.notice.title}
                        body={props.notice.body}
                    />
                </ComposerAuxiliaryFrame>
            ) : null}
        </View>
    );
});
