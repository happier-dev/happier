import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SidechainTranscriptBody } from '@/components/sessions/transcript/sidechain/SidechainTranscriptBody';
import { useSidechainTranscriptMessages } from '@/components/sessions/transcript/sidechain/useSidechainTranscriptMessages';
import type { TranscriptJumpScope } from '@/components/sessions/transcript/viewport/jump/transcriptJumpTargetTypes';
import { Text } from '@/components/ui/text/Text';
import { useSession } from '@/sync/domains/state/storage';
import { t } from '@/text';
import {
    deriveTranscriptInteraction,
    deriveTranscriptInteractionFromSession,
    type TranscriptInteraction,
} from '@/utils/sessions/deriveTranscriptInteraction';

/**
 * A transcript, READ, inside a details tab.
 *
 * The destination an imported workflow-agent sidechain never had. Every other details host anchors
 * on a local `SessionSubagent` or on the tool message that owns a sidechain, and an imported sidecar
 * has neither — so this view addresses the transcript directly, by scope.
 *
 * **The same vocabulary as the main transcript, hosted differently.** It renders through
 * `SidechainTranscriptBody`, which is `ChainTranscriptList` — the same message, turn and tool-call
 * rows the transcript screen draws. What it deliberately does not reuse is the transcript SCREEN:
 * that carries a composer, live-tail following, session entry and direct controls, none of which
 * belong in a read-only detail of work that already happened. Writing a separate "agent transcript
 * renderer" instead would have been the split-brain; inheriting the screen would have been the
 * wrong affordances. So: same rows, different host.
 *
 * **Read-only is stated in the interaction, not implied by omission.** Send, approve and fork are
 * withheld explicitly and tool navigation is off, because this surface already IS the detail — a
 * press that pushed a second detail on top of it would be navigation with no way back to where the
 * reader was.
 */

export type SessionTranscriptDetailsViewProps = Readonly<{
    scope: TranscriptJumpScope;
    /** For the empty/hydration testIDs, so a host can address this surface. */
    testID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        minHeight: 0,
        minWidth: 0,
    },
    empty: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        paddingHorizontal: 20,
        paddingVertical: 24,
    },
    emptyText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        textAlign: 'center',
    },
}));

export const SessionTranscriptDetailsView = React.memo((props: SessionTranscriptDetailsViewProps) => {
    const styles = stylesheet;
    const { scope, testID } = props;

    if (scope.kind !== 'sidechain') {
        // The main transcript has a screen of its own with a composer and a live tail; opening a
        // second, read-only copy of it in a pane would be two surfaces claiming one conversation.
        // The scope type carries the case so a future host can serve it; this one refuses it aloud.
        return (
            <View style={styles.empty} testID={testID ? `${testID}:unsupported` : undefined}>
                <Text style={styles.emptyText}>{t('session.detailsPanel.unsupportedTab')}</Text>
            </View>
        );
    }

    return (
        <SidechainTranscriptDetails
            sessionId={scope.sessionId}
            sidechainId={scope.sidechainId}
            {...(testID ? { testID } : null)}
        />
    );
});

SessionTranscriptDetailsView.displayName = 'SessionTranscriptDetailsView';

const FAIL_CLOSED_INTERACTION = deriveTranscriptInteraction({ kind: 'public', disableToolNavigation: true });

function SidechainTranscriptDetails(props: Readonly<{
    sessionId: string;
    sidechainId: string;
    testID?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const { sessionId, sidechainId, testID } = props;
    const session = useSession(sessionId);
    const messages = useSidechainTranscriptMessages({ sessionId, sidechainId });

    const interaction = React.useMemo<TranscriptInteraction>(() => {
        if (!session) return FAIL_CLOSED_INTERACTION;
        return {
            ...deriveTranscriptInteractionFromSession({
                accessLevel: session.accessLevel,
                canApprovePermissions: session.canApprovePermissions,
                active: session.active,
                presence: session.presence,
            }),
            // The three direct controls, withheld here and nowhere else: this is a detail of work
            // that already ran, reached from a roster, with no recipient of its own to address.
            canSendMessages: false,
            canApprovePermissions: false,
            canFork: false,
            permissionDisabledReason: 'readOnly',
            disableToolNavigation: true,
        };
    }, [session]);

    return (
        <View style={styles.container} testID={testID}>
            <SidechainTranscriptBody
                sessionId={sessionId}
                sidechainId={sidechainId}
                messages={messages}
                metadata={session?.metadata ?? null}
                interaction={interaction}
                hydrationStatusTestID={testID ? `${testID}:hydration` : 'session-transcript-details-hydration'}
                messageWrapperTestIdPrefix={testID ? `${testID}:message` : 'session-transcript-details-message'}
            />
        </View>
    );
}
