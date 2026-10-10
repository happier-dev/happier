import { readSessionDirectoryKind } from '@happier-dev/protocol/sessions/metadata/directory';
import React from 'react';
import { View } from 'react-native';
import { Session } from '@/sync/domains/state/storageTypes';
import { formatSessionPath } from '@/utils/sessions/formatPathRelativeToHome';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { EmptyState } from './EmptyState';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';


const stylesheet = StyleSheet.create(() => ({
    container: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
}));

interface EmptyMessagesProps {
    session: Session;
}

function formatRelativeTime(timestamp: number): string {
    const now = Date.now();
    const diffMs = now - timestamp;
    const diffMinutes = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMinutes / 60);
    const diffDays = Math.floor(diffHours / 24);
    
    if (diffMinutes < 1) {
        return t('time.justNow');
    } else if (diffMinutes < 60) {
        return t('time.minutesAgo', { count: diffMinutes });
    } else if (diffHours < 24) {
        return t('time.hoursAgo', { count: diffHours });
    } else {
        return t('sessionHistory.daysAgo', { count: diffDays });
    }
}

/**
 * A session with no messages yet (A5 `sessionStarting`): the app's one empty state with its Daybreak
 * scene. The line under the title keeps what identifies the session: its machine, its folder, and
 * when it was created.
 */
export function EmptyMessages({ session }: EmptyMessagesProps) {
    const styles = stylesheet;
    const metadata = readSessionOwnerMetadataView(session);
    const identity = [
        metadata?.host || null,
        metadata?.path && readSessionDirectoryKind(metadata) !== 'managed' ? formatSessionPath(metadata.path, metadata.homeDir) : null,
        t('components.emptyMessages.created', { time: formatRelativeTime(session.createdAt) }),
    ].filter((part): part is string => typeof part === 'string' && part.length > 0);

    return (
        <View testID="session-empty-messages" style={styles.container}>
            <EmptyState
                layout="centered"
                scene="sessionStarting"
                title={t('components.emptyMessages.noMessagesYet')}
                subtitle={identity.join(' · ')}
                titleTestID="session-empty-messages.title"
                subtitleTestID="session-empty-messages.identity"
            />
        </View>
    );
}
