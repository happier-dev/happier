import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { TechnicalDetailsDisclosure } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import { ItemGroupRowPositionBoundary } from '@/components/ui/lists/ItemGroupRowPosition';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { InboxMachineSignInTarget } from '@/components/inbox/inboxItems';
import { presentActionExecutionFailure, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';

/** The row is itself a target: its button keeps to its own gaps (as the approval rows' answers do). */
const ROW_BUTTON_REACH = { top: 0, bottom: 0 } as const;

export type MachineSignInFailure = Readonly<{
    /** The typed cause in words; null when the presenter has none (the code stays in the details). */
    reason: string | null;
    /** What the person does next: Retry setup on the Machine's page, open it, or nothing (the row leaves). */
    next: 'retrySetup' | 'open' | null;
    technicalDetails: ReturnType<typeof presentActionExecutionFailure>['technicalDetails'];
}>;

/** The opener's typed refusal, carried through: its own two causes, then the shared presenter's words. */
export function presentMachineSignInFailure(failure: ActionExecuteFailure): MachineSignInFailure {
    const { technicalDetails } = presentActionExecutionFailure(failure);
    if (failure.errorCode === 'auth_request_expired') return { reason: t('machineSignIn.causeExpired'), next: 'retrySetup', technicalDetails };
    // `no_prompt`: the exact task it was bound to is no longer the one waiting; its row is withdrawn by the data.
    if (failure.errorCode === 'no_prompt') return { reason: t('machineSignIn.notWaiting'), next: null, technicalDetails };
    return { reason: resolveActionExecutionFailureMessage(failure, '') || null, next: 'open', technicalDetails };
}

export type MachineSignInConfirmation = Readonly<{
    phase: 'idle' | 'confirming' | 'confirmed' | 'failed';
    failure: MachineSignInFailure | null;
    run: () => void;
}>;

/**
 * A pending machine sign-in's one answer from its Inbox row, through the member-client approval the Machine's page
 * uses. A refusal settles on the row (its cause and next step), never in an alert; a confirmed row keeps no button
 * while the occurrence's owner withdraws it.
 */
export function useMachineSignInConfirmation(
    target: InboxMachineSignInTarget | undefined,
    confirm: ((target: InboxMachineSignInTarget) => Promise<ActionExecuteResult>) | undefined,
): MachineSignInConfirmation {
    const [state, setState] = React.useState<Pick<MachineSignInConfirmation, 'phase' | 'failure'>>({ phase: 'idle', failure: null });
    const running = React.useRef(false);
    const run = React.useCallback(() => {
        if (!target || !confirm || running.current) return;
        running.current = true;
        setState({ phase: 'confirming', failure: null });
        void confirm(target).catch((): ActionExecuteResult => ({ ok: false, errorCode: 'action_failed', error: 'action_failed' }))
            .then((result) => {
                running.current = false;
                setState(result.ok ? { phase: 'confirmed', failure: null } : { phase: 'failed', failure: presentMachineSignInFailure(result) });
            });
    }, [confirm, target]);
    return React.useMemo(() => ({ ...state, run }), [state, run]);
}

/** Confirm sign-in, or after a refusal the step its cause names; nothing once confirmed or when no step remains. */
export function MachineSignInAction(props: Readonly<{ confirmation: MachineSignInConfirmation; onOpen: () => void; testID: string }>) {
    const { confirmation } = props;
    if (confirmation.phase === 'confirmed') return null;
    if (confirmation.phase === 'failed') {
        const next = confirmation.failure?.next;
        return next ? <RoundButton testID={`${props.testID}.next`} size="small" display="secondary" hitReach={ROW_BUTTON_REACH}
            title={next === 'retrySetup' ? t('machineSignIn.retrySetup') : t('machineSignIn.openMachine')} onPress={props.onOpen} /> : null;
    }
    return <RoundButton testID={props.testID} size="small" display="secondary" hitReach={ROW_BUTTON_REACH}
        title={t('machineSignIn.confirm')} loading={confirmation.phase === 'confirming'} disabled={confirmation.phase !== 'idle'}
        onPress={confirmation.run} />;
}

/** The refusal on its row: what happened in one line, the codes behind the row's own Technical details toggle. */
export function MachineSignInFailureLine(props: Readonly<{ failure: MachineSignInFailure; testID: string }>) {
    return (
        <View testID={props.testID} style={styles.stack} accessibilityLiveRegion="polite">
            <Text style={styles.line}>
                {t('machineSignIn.notConfirmed')}{props.failure.reason ? <>{' '}{props.failure.reason}</> : null}
            </Text>
            {/* Inside a row, not a section's own row: the small inline toggle. */}
            <ItemGroupRowPositionBoundary>
                <TechnicalDetailsDisclosure testID={`${props.testID}.details`} title={t('approvals.technicalDetails')}
                    lines={props.failure.technicalDetails} />
            </ItemGroupRowPositionBoundary>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    stack: { gap: theme.space.s4, marginTop: theme.space.s4 },
    line: { ...Typography.variant('meta'), color: theme.colors.state.danger.textForeground },
}));
