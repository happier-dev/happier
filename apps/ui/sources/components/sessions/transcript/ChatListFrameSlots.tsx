import * as React from 'react';
import { View } from 'react-native';
import { ComposerKeyboardScrollInset } from '@/components/sessions/keyboardAvoidance';
import { ChatFooter, type ChatFooterExternalControlState } from './ChatFooter';
import type { ChatListBottomNotice } from '@/components/sessions/transcript/chatListTypes';
import { TRANSCRIPT_TOP_GUTTER_PX } from '@/components/sessions/transcript/_constants';
import { useSessionChatFooterState } from '@/sync/domains/state/storage';
import { TranscriptSessionActivityLine } from './TranscriptSessionActivityLine';
import { ProjectSetupSessionReturn } from '@/components/projects/projectSetup/ProjectSetupReturn';
import { ProjectSetupSessionReviews } from '@/components/projects/projectSetup/ProjectSetupSessionReview';

export const ListHeader = React.memo(() => {
    return (
        <View>
            <View style={{ height: TRANSCRIPT_TOP_GUTTER_PX }} />
        </View>
    );
});

export const ListFooter = React.memo((props: {
    sessionId: string;
    bottomNotice?: ChatListBottomNotice | null;
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
    )
});

export const ChatListFooterWithKeyboardInset = React.memo((props: {
    sessionId: string;
    serverId?: string | null;
    showToolCalls?: boolean;
    bottomNotice?: ChatListBottomNotice | null;
    controlledByUserOverride?: boolean;
    controlSwitchTo?: 'remote' | null;
    onRequestSwitchToRemote?: () => void;
    externalControl?: ChatFooterExternalControlState;
    onComposerInsetHeightChange?: (height: number) => void;
}) => {
    return (
        <View>
            {props.showToolCalls === false && props.serverId ? (
                <TranscriptSessionActivityLine sessionId={props.sessionId} serverId={props.serverId} />
            ) : null}
            {/* A finite command this Session's agent started that is held on setup consent asks here (lab `s-setup` ASK). */}
            <ProjectSetupSessionReviews sessionId={props.sessionId} serverId={props.serverId} />
            {/* A Session started from Project setup ends with its way back (lab `s-setup` DONE). */}
            <ProjectSetupSessionReturn sessionId={props.sessionId} serverId={props.serverId} />
            <ListFooter
                sessionId={props.sessionId}
                bottomNotice={props.bottomNotice}
                controlledByUserOverride={props.controlledByUserOverride}
                controlSwitchTo={props.controlSwitchTo ?? null}
                onRequestSwitchToRemote={props.onRequestSwitchToRemote}
                externalControl={props.externalControl ?? null}
            />
            <ComposerKeyboardScrollInset
                testID="transcript-composer-keyboard-inset"
                onHeightChange={props.onComposerInsetHeightChange}
            />
        </View>
    );
});
