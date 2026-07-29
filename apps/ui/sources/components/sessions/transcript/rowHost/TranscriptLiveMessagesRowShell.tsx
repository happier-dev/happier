import * as React from 'react';

import { TranscriptRowShell } from '@/components/sessions/transcript/ChatListRows';
import type { ChatTranscriptListItem } from '@/components/sessions/transcript/chatListTypes';
import type { TranscriptItemHeightValiditySignature } from '@/components/sessions/transcript/measurement/transcriptItemHeightCache';
import type { TranscriptMeasurementReconciler } from '@/components/sessions/transcript/measurement/transcriptMeasurementReconciler';
import type { TranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';
import type { Message } from '@/sync/domains/messages/messageTypes';
import { useMessagesByRefs, type MessageStoreRef } from '@/sync/domains/state/storage';

export const TranscriptLiveMessagesRowShell = React.memo(function TranscriptLiveMessagesRowShell(
    props: Readonly<{
        item: ChatTranscriptListItem;
        messageRefs: readonly MessageStoreRef[];
        initialMessages: readonly Message[];
        buildRowShellSignature: (item: ChatTranscriptListItem) => TranscriptItemHeightValiditySignature;
        measurementReconciler: TranscriptMeasurementReconciler;
        onRowLayoutMutation: (params: Readonly<{
            itemId: string;
            mutation: TranscriptRowLayoutMutation;
            rowKind: string;
        }>) => void;
        onRowMeasured: (params: Readonly<{ itemId: string; rowKind: string; heightPx: number }>) => void;
        children: (messages: readonly Message[]) => React.ReactNode;
    }>,
) {
    const subscribedMessages = useMessagesByRefs(props.messageRefs);
    const messages = React.useMemo(() => {
        const initialById = new Map(props.initialMessages.map((message) => [message.id, message]));
        return subscribedMessages.flatMap((message, index) => {
            const resolved = message ?? initialById.get(props.messageRefs[index]?.messageId ?? '');
            return resolved ? [resolved] : [];
        });
    }, [props.initialMessages, props.messageRefs, subscribedMessages]);

    return (
        <TranscriptRowShell
            reconciler={props.measurementReconciler}
            itemId={props.item.id}
            onRowLayoutMutation={props.onRowLayoutMutation}
            onRowMeasured={props.onRowMeasured}
            signature={props.buildRowShellSignature(props.item)}
        >
            {props.children(messages)}
        </TranscriptRowShell>
    );
});
