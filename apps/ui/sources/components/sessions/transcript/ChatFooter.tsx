import * as React from 'react';
import { View, ViewStyle } from 'react-native';
import { t } from '@/text';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { WarningActionBanner } from '@/components/sessions/shell/view/WarningActionBanner';
import type { ExternalSessionRuntimePresentation } from '@/components/sessions/presentation/externalSessionRuntimePresentation';
import type { SessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';
import { useSessionChatFooterState } from '@/sync/domains/state/storage';

export type ChatFooterExternalAgentPresentation = Readonly<{
    state: ExternalSessionRuntimePresentation['externalAgent']['state'];
    labelKey: ExternalSessionRuntimePresentation['externalAgent']['labelKey'];
    /** Decided by the external-Agent presentation owner: only these states tint the footer. */
    needsAttention: boolean;
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
    offersTakeover: boolean,
): string {
    if (presentation.state === 'unknown') {
        // An Agent that reports no status is not a problem: say where the session runs and,
        // when Take over is offered, what it does.
        const where = presentation.agentLabel && presentation.machineLabel
            ? t('externalSessions.externalAgentRunsOnMachine', {
                agent: presentation.agentLabel,
                machine: presentation.machineLabel,
            })
            : t('externalSessions.externalAgentRunsOutsideHappier');
        return offersTakeover ? `${where} ${t('externalSessions.externalAgentTakeOverHint')}` : where;
    }
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
            if (switchingToRemote) return isSharedAttached ? 'common.loading' : 'chatFooter.switchingToRemote';
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
                    iconName="info"
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

    // An external session gets one footer row and one primary: Take over (or Re-check) when offered,
    // with Import into Happier as the secondary beside it; Import leads only when it is the sole action.
    const externalControlBanner = React.useMemo(() => {
        if (!props.externalControl) return null;
        const externalControl = props.externalControl;

        const switchingToDirect = externalControl.takeoverInFlight === 'direct';
        const switchingToPersisted = externalControl.takeoverInFlight === 'persisted';
        const preflightInFlight = externalControl.takeoverPreflightInFlight;
        const hasTakeoverMode =
            externalControl.canTakeOverDirect
            || externalControl.canTakeOverPersist;
        const showTakeoverAction =
            !switchingToDirect
            && !switchingToPersisted
            && (
                !externalControl.statusKnown
                || externalControl.runnerActive
                || hasTakeoverMode
            )
            && typeof externalControl.onRequestTakeoverPreflight === 'function';
        const materialize = externalControl.materialize ?? null;
        const importIsPrimary = materialize !== null && !showTakeoverAction;
        const importLabel = t('externalSessions.operationTitleMaterialize');
        const importDisabled = materialize !== null && (!materialize.requestEnabled || materialize.inFlight);
        const externalAgentStatusBody = resolveExternalAgentStatusBody(
            externalControl.externalAgentPresentation,
            showTakeoverAction && !externalControl.runnerActive,
        );
        const operationInFlight = switchingToDirect || switchingToPersisted || preflightInFlight
            || materialize?.inFlight === true;

        const body = (() => {
            if (switchingToPersisted) return t('chatFooter.switchingToPersistedTakeover');
            if (switchingToDirect) return t('chatFooter.switchingToDirectTakeover');
            if (preflightInFlight) return t('chatFooter.checkingExternalSessionTakeover');
            if (materialize?.inFlight) return t('externalSessions.operationComposerImporting');
            if (externalControl.runnerActive) {
                const guidance = t('chatFooter.externalSessionTakeoverBlocked');
                const safetyGuidance = externalControl.trustedPid === null
                    ? guidance
                    : `${guidance} ${t('runs.detail.pid', {
                        pid: externalControl.trustedPid,
                    })}`;
                return `${externalAgentStatusBody} ${safetyGuidance}`;
            }
            if (importIsPrimary) {
                return `${externalAgentStatusBody} ${t('externalSessions.operationMaterializeAvailable')}`;
            }
            return externalAgentStatusBody;
        })();
        const takeoverLabel = externalControl.runnerActive
            ? t('chatFooter.externalSessionRecheck')
            : t('chatFooter.takeOverDirect');
        const primary = showTakeoverAction
            ? {
                testID: 'session-chatFooter-takeOverDirect',
                label: takeoverLabel,
                busy: preflightInFlight,
                disabled: preflightInFlight,
                onPress: externalControl.onRequestTakeoverPreflight,
            }
            : importIsPrimary && materialize
                ? {
                    testID: 'session-chatFooter-importIntoHappier',
                    label: importLabel,
                    busy: materialize.inFlight,
                    disabled: importDisabled,
                    onPress: materialize.onRequest,
                }
                : null;
        const secondaryActions = materialize && !importIsPrimary
            ? [{
                key: 'import-into-happier',
                testID: 'session-chatFooter-importIntoHappier',
                label: importLabel,
                accessibilityLabel: importLabel,
                disabled: importDisabled,
                variant: 'secondary' as const,
                onPress: materialize.onRequest,
            }]
            : undefined;

        const externalAttention = externalControl.externalAgentPresentation.needsAttention && !operationInFlight;
        return (
            <ComposerAuxiliaryFrame>
                <WarningActionBanner
                    testID="session-chatFooter-externalControl"
                    tone={externalAttention ? 'warning' : 'neutral'}
                    // Where the external Agent runs is information, not a problem: a plain line on the composer's
                    // content edge. Only a state that needs the reader keeps the tinted card (owner 2026-11-11).
                    chrome={externalAttention ? 'card' : 'none'}
                    iconName="info"
                    body={body}
                    actionTestID={primary?.testID}
                    actionLabel={primary?.label}
                    actionAccessibilityLabel={primary?.label}
                    actionBusy={primary?.busy}
                    disabled={primary?.disabled}
                    onActionPress={primary?.onPress}
                    secondaryActions={secondaryActions}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [props.externalControl]);

    return (
        <View style={containerStyle}>
            {externalControlBanner}
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

/**
 * The Session's control and notice banner (local control, an external Agent's runner, a bottom notice), from the
 * Session's footer state. It stands in the composer's banner seat with the Session's other notices (owner
 * 2026-11-11), never in the transcript.
 */
export const SessionChatFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: Readonly<{ title: string; body: string }> | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    externalControl?: ChatFooterExternalControlState;
}) => {
    const footerState = useSessionChatFooterState(props.sessionId);
    if (!footerState) {
        return null;
    }
    return (
        <ChatFooter
            controlledByUser={props.controlledByUserOverride ?? footerState.controlledByUser}
            localControl={footerState.localControl}
            permissionsInUiWhileLocal={footerState.permissionsInUiWhileLocal}
            notice={props.bottomNotice ?? null}
            controlSwitchTo={props.controlSwitchTo ?? null}
            onRequestSwitchToRemote={props.onRequestSwitchToRemote}
            externalControl={props.externalControl ?? null}
        />
    );
});

