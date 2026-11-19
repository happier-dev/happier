import * as React from 'react';
import { FlatList, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { MessageView } from '@/components/sessions/transcript/MessageView';
import { debugMessages } from '@/dev/messagesDemoData';
import type { Message } from "@happier-dev/session-core/messages";
import { useDemoMessages } from '@/hooks/session/useDemoMessages';
import { SessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { resolveTranscriptHostWakeCountByMessageId } from '@/components/sessions/transcript/events/transcriptEventEmphasis';
import { useShallow } from 'zustand/react/shallow';
import { getStorage } from '@/sync/domains/state/storage';

const SPECIMEN_CREATED_AT = Date.now();

/** Two Sessions this viewer holds, for the `@Session` chip specimens (live title and Agent mark). */
function useHeldSessionIds(): readonly string[] {
    return getStorage()(useShallow((state) => {
        const ids: string[] = [];
        for (const rows of Object.values(state.sessionListRowsByServerId)) {
            for (const id of Object.keys(rows ?? {})) if (ids.length < 2) ids.push(id);
        }
        return ids;
    }));
}

function sessionMention(sessionId: string, label: string) {
    const ref = `session:${sessionId}`;
    return { token: `[${label}](happier-ref:${ref})`, mention: { kind: 'happier.session', ref, token: `[${label}](happier-ref:${ref})`, label } };
}

/** Loaded, unknown and very long `@Session` chips, in a user bubble and in an agent reply. */
function buildSessionReferenceSpecimens(heldIds: readonly string[]): Message[] {
    const held = heldIds.map((id, index) => sessionMention(id, `Authored label ${index + 1}`));
    const unknown = sessionMention('specimen-missing-session', 'Release prep');
    const long = sessionMention('specimen-missing-long', 'Investigate why the relay retries forever after the laptop sleeps on hotel wifi and never recovers');
    const all = [...held, unknown, long];
    const meta = { happierStructuredInputV1: { v: 1, mentions: all.map((entry) => entry.mention) } } as unknown as Message['meta'];
    const text = `Compare ${held.map((entry) => entry.token).join(' with ') || 'nothing held'}, then check ${unknown.token} and ${long.token} before we ship.`;
    return [
        { id: 'specimen-session-refs-user', localId: null, createdAt: SPECIMEN_CREATED_AT - 2, kind: 'user-text', text, meta },
        { id: 'specimen-session-refs-agent', localId: null, createdAt: SPECIMEN_CREATED_AT - 1, kind: 'agent-text', text: `I read ${held[0]?.token ?? unknown.token} and ${long.token}; the second one is still open.`, meta },
    ] as Message[];
}

export default React.memo(function MessagesDemoScreen() {
    const heldSessionIds = useHeldSessionIds();
    const allMessages = React.useMemo(() => [...buildSessionReferenceSpecimens(heldSessionIds), ...debugMessages], [heldSessionIds]);

    const source = useDemoMessages(allMessages);
    const messagesById = source.useMessagesById();
    const hostWakeCountByMessageId = React.useMemo(() => resolveTranscriptHostWakeCountByMessageId({
        messageIdsOldestFirst: allMessages.map((message) => message.id),
        messagesById,
    }), [allMessages, messagesById]);

    return (
        <SessionTranscriptSourceProvider source={source}>
            <View style={styles.container}>
                {allMessages.length > 0 && (
                    <FlatList
                        data={allMessages}
                        keyExtractor={(item) => item.id}
                        renderItem={({ item }) => (
                            <MessageView
                                message={item}
                                metadata={null}
                                sessionId={source.sessionId}
                                getMessageById={(id: string): Message | null => messagesById[id] ?? null}
                                hostWakeCount={hostWakeCountByMessageId[item.id]}
                            />
                        )}
                        style={{ flexGrow: 1, flexBasis: 0 }}
                        contentContainerStyle={{ paddingVertical: 20 }}
                    />
                )}
            </View>
        </SessionTranscriptSourceProvider>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        backgroundColor: theme.colors.surface.base,
    },
}));
