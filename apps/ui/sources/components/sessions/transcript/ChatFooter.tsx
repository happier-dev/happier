import * as React from 'react';
import { View, ViewStyle } from 'react-native';
import { t } from '@/text';
import { ComposerAuxiliaryFrame } from '@/components/sessions/shell/view/ComposerAuxiliaryFrame';
import { SessionWarningActionBanner } from '@/components/sessions/shell/SessionWarningActionBanner';
import { isActionOperationCancellationRequested } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';
import type { SessionLocalControlState } from '@/sync/domains/session/control/sessionLocalControl';

export type ChatFooterDirectControlState = Readonly<{
    machineOnline: boolean;
    runnerActive: boolean;
    activity: 'running' | 'active_recently' | 'idle' | 'unknown';
    canTakeOverDirect: boolean;
    canTakeOverPersist: boolean;
    takeoverInFlight: 'direct' | 'persisted' | null;
    importOperation?: ActionOperationSnapshotV1 | null;
    importStatusError?: string | null;
    onCancelImport?: () => void | Promise<void>;
    onRefreshImport?: () => void | Promise<void>;
    onRequestTakeOverDirect?: () => void | Promise<void>;
    onPrepareRetainedConversion?: () => void | Promise<void>;
    onRequestTakeOverPersist?: () => void | Promise<void>;
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
    directControl?: ChatFooterDirectControlState;
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

        const switchingToRemote = props.controlSwitchTo === 'remote';
        if (!derived.attached) return null;

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
        if (derived.remoteWritable && !switchingToRemote && !showSwitchToRemoteButton && !showDetachButton) {
            return null;
        }
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
                <SessionWarningActionBanner
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

    const directModeBanner = React.useMemo(() => {
        if (!props.directControl) return null;
        const operation = props.directControl.importOperation;
        const importing = operation?.state === 'accepted' || operation?.state === 'running';
        if (props.directControl.runnerActive && !importing && operation?.state !== 'failed' && !props.directControl.importStatusError) return null;

        const switchingToDirect = props.directControl.takeoverInFlight === 'direct';
        const switchingToPersisted = props.directControl.takeoverInFlight === 'persisted';
        const showDirectAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverDirect
            && typeof props.directControl.onRequestTakeOverDirect === 'function';
        const showPersistAction =
            !switchingToDirect
            && !switchingToPersisted
            && props.directControl.machineOnline
            && props.directControl.canTakeOverPersist
            && typeof props.directControl.onRequestTakeOverPersist === 'function';

        const prepareRetainedConversion = props.directControl.onPrepareRetainedConversion;
        const showPrepareRetainedConversion = !switchingToDirect && !switchingToPersisted
            && props.directControl.machineOnline && !showPersistAction && prepareRetainedConversion;

        const textKey = (() => {
            if (operation?.state === 'cancelled') return 'chatFooter.directImportCancelled';
            if (operation?.state === 'failed') return 'chatFooter.directImportFailed';
            if (switchingToPersisted) return 'chatFooter.switchingToPersistedTakeover';
            if (switchingToDirect) return 'chatFooter.switchingToDirectTakeover';
            if (!props.directControl.machineOnline) return 'chatFooter.directSessionMachineOffline';
            return 'chatFooter.directSessionTakeoverAvailable';
        })();

        const phase = operation?.progress?.kind === 'phase' ? operation.progress.phase
            : operation?.progress?.kind === 'determinate' ? 'importing' : 'preparing';
        const phaseLabel = isActionOperationCancellationRequested(operation) ? t('chatFooter.directImportCancelling')
            : phase === 'reading' ? t('chatFooter.directImportReading')
            : phase === 'importing' ? t('chatFooter.directImportImporting')
            : phase === 'starting' ? t('chatFooter.directImportStarting')
            : phase === 'converting' ? t('chatFooter.directImportConverting')
            : t('chatFooter.directImportPreparing');
        const countLabel = operation?.progress?.kind === 'determinate'
            ? t('chatFooter.directImportCountWithTotal', { count: operation.progress.current, total: operation.progress.total }) : '';
        const progress = props.directControl.importStatusError ? t('chatFooter.directImportStatusUnavailable')
            : importing ? [phaseLabel, countLabel].filter(Boolean).join(' ') : t(textKey);
        const canStop = importing && operation?.cancellation === 'supported' && !isActionOperationCancellationRequested(operation)
            && typeof props.directControl.onCancelImport === 'function';
        const body = [progress, operation?.state === 'failed' ? operation.error?.error : null].filter(Boolean).join('\n');

        return (
            <ComposerAuxiliaryFrame>
                <SessionWarningActionBanner
                    testID="session-chatFooter-directControl"
                    iconName="info"
                    tone={importing ? 'neutral' : 'warning'}
                    body={body}
                    secondaryActions={[
                        ...(showPrepareRetainedConversion ? [{
                            key: 'prepareRetainedConversion',
                            testID: 'session-chatFooter-prepareRetainedConversion',
                            label: t('transcriptExport.prepareConversion'),
                            accessibilityLabel: t('transcriptExport.prepareConversion'),
                            onPress: showPrepareRetainedConversion,
                        }] : []),
                        ...(showPersistAction ? [{
                            key: 'takeOverPersist',
                            testID: 'session-chatFooter-takeOverPersist',
                            label: operation?.state === 'failed' || operation?.state === 'cancelled' || props.directControl.importStatusError
                                ? t('common.retry') : t('chatFooter.takeOverPersist'),
                            accessibilityLabel: t('chatFooter.takeOverPersist'),
                            onPress: props.directControl.onRequestTakeOverPersist!,
                        }] : []),
                        ...(props.directControl.importStatusError && props.directControl.onRefreshImport ? [{
                            key: 'refreshImport', testID: 'session-chatFooter-refreshImport', label: t('common.refresh'),
                            accessibilityLabel: t('common.refresh'), onPress: props.directControl.onRefreshImport,
                        }] : []),
                    ]}
                    actionTestID={canStop ? 'session-chatFooter-stopImport' : showDirectAction ? 'session-chatFooter-takeOverDirect' : undefined}
                    actionLabel={canStop ? t('chatFooter.directImportStop') : showDirectAction ? t('chatFooter.takeOverDirect') : undefined}
                    actionAccessibilityLabel={canStop ? t('chatFooter.directImportStop') : showDirectAction ? t('chatFooter.takeOverDirect') : undefined}
                    onActionPress={canStop ? props.directControl.onCancelImport : showDirectAction ? props.directControl.onRequestTakeOverDirect : undefined}
                />
            </ComposerAuxiliaryFrame>
        );
    }, [props.directControl]);

    return (
        <View style={containerStyle}>
            {directModeBanner}
            {localControlBanner}
            {props.notice ? (
                <ComposerAuxiliaryFrame>
                    <SessionWarningActionBanner
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
