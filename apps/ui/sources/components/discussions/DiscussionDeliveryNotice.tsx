import * as React from 'react';
import { View, type StyleProp, type TextStyle } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { DiscussionOpenedMessageV1 } from '@happier-dev/protocol/discussions/actions';
import { formatApprovalDecisionFailureLabel } from '@/components/approvals/approvalStatusLabel';
import { ToolOutcomeStatus } from '@/components/tools/shell/presentation/ToolOutcomeStatus';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { DiscussionPostOutcome } from '@/sync/api/discussions/discussionActions';
import { discussionFailureLabel } from './discussionFailureLabel';

export function DiscussionDeliveryNotice(props: Readonly<{
    message: DiscussionOpenedMessageV1;
    resolveSessionLabel: (sessionId: string) => string | null;
    onRetry?: () => Promise<DiscussionPostOutcome>;
    textStyle: StyleProp<TextStyle>;
    errorStyle: StyleProp<TextStyle>;
    retryStyle: React.ComponentProps<typeof HappierPressable>['style'];
    retryTextStyle: StyleProp<TextStyle>;
}>) {
    const [sending, setSending] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();
    const pending = props.message.participantDeliveryV1?.some(delivery => delivery.disposition === 'pending');
    return <>
        {props.message.participantDeliveryV1?.map(delivery => delivery.disposition === 'failed'
            && isActionApprovalDeclinedErrorCode(delivery.failure.code)
            ? <View key={delivery.participantSessionId} accessibilityLiveRegion="polite"><ToolOutcomeStatus
                testID={`session-discussion-participant-declined-${props.message.id}-${delivery.participantSessionId}`}
                label={`${props.resolveSessionLabel(delivery.participantSessionId) ?? t('session.collaboration.discussion.heldParticipant')} · ${formatApprovalDecisionFailureLabel(delivery.failure.code)}`}
                glyph="minus-circle" tone="quiet" /></View>
            : <Text key={delivery.participantSessionId}
            testID={`session-discussion-participant-${delivery.disposition}-${props.message.id}-${delivery.participantSessionId}`}
            accessibilityLiveRegion="polite" style={delivery.disposition === 'failed' ? props.errorStyle : props.textStyle}
        >{t(delivery.disposition === 'failed' ? 'session.collaboration.discussion.participantReturnFailed'
            : delivery.disposition === 'held' ? 'session.collaboration.discussion.participantHeld' : 'session.collaboration.discussion.participantPending', {
            participant: props.resolveSessionLabel(delivery.participantSessionId) ?? t('session.collaboration.discussion.heldParticipant'),
        })}</Text>)}
        {pending && props.onRetry ? <HappierPressable testID={`session-discussion-delivery-retry-${props.message.id}`}
            style={props.retryStyle} accessibilityRole="button" disabled={sending} busy={sending}
            accessibilityLabel={t('session.collaboration.discussion.retry')} onPress={async () => {
                if (sending) return;
                setSending(true);
                setError(undefined);
                try {
                    const outcome = await props.onRetry!();
                    if (outcome.kind === 'failed') setError(outcome.errorCode);
                } finally { setSending(false); }
            }}><Text style={props.retryTextStyle}>{t(sending ? 'session.collaboration.discussion.checking' : 'session.collaboration.discussion.retry')}</Text></HappierPressable> : null}
        {pending && error ? <Text accessibilityLiveRegion="polite" style={props.errorStyle}>{discussionFailureLabel(error)}</Text> : null}
    </>;
}
