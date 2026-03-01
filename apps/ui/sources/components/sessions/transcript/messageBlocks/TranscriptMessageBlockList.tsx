import * as React from 'react';
import { View } from 'react-native';

import type { Message } from '@/sync/domains/messages/messageTypes';
import type { Metadata } from '@/sync/domains/state/storageTypes';

import { MessageView } from '@/components/sessions/transcript/MessageView';

type TranscriptInteraction = {
    canSendMessages: boolean;
    canApprovePermissions: boolean;
    permissionDisabledReason?: 'public' | 'readOnly' | 'notGranted' | 'inactive';
    disableToolNavigation?: boolean;
};

export const TranscriptMessageBlockList = React.memo(function TranscriptMessageBlockList(props: {
    messages: Message[];
    sessionId: string;
    metadata: Metadata | null;
    interaction: TranscriptInteraction;
    jumpToMessageId?: string | null;
    onResolvedJumpToMessageY?: (y: number) => void;
    messageWrapperTestIdPrefix?: string;
}) {
    const didJumpRef = React.useRef(false);
    const normalizedJumpToMessageId =
        typeof props.jumpToMessageId === 'string' && props.jumpToMessageId.length > 0 ? props.jumpToMessageId : null;
    const testIdPrefix =
        typeof props.messageWrapperTestIdPrefix === 'string' && props.messageWrapperTestIdPrefix.length > 0
            ? props.messageWrapperTestIdPrefix
            : 'transcript-message';

    return (
        <>
            {props.messages.map((message) => (
                <View
                    key={message.id}
                    testID={`${testIdPrefix}-${message.id}`}
                    onLayout={(e) => {
                        if (!normalizedJumpToMessageId) return;
                        if (didJumpRef.current) return;
                        if (message.id !== normalizedJumpToMessageId) return;
                        const y = e?.nativeEvent?.layout?.y;
                        if (typeof y !== 'number' || !Number.isFinite(y)) return;
                        didJumpRef.current = true;
                        props.onResolvedJumpToMessageY?.(y);
                    }}
                >
                    <MessageView
                        message={message}
                        metadata={props.metadata}
                        sessionId={props.sessionId}
                        interaction={props.interaction}
                    />
                </View>
            ))}
        </>
    );
});
