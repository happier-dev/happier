import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SessionSelectionModal, type SessionSelectionCandidate } from '@/components/sessions/selection/SessionSelectionModal';
import { Icon } from '@/components/ui/icons/Icon';
import type { SelectionListOption } from '@/components/ui/selectionList';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

import { resolveTranscriptSendToSessionTargets } from './resolveTranscriptSendToSessionTargets';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';

export type TranscriptSendToSessionModalProps = CustomModalInjectedProps & Readonly<{
    sourceSessionId: string;
    sourceServerId: string;
    previewText: string;
    onResolve: (destination: SendTranscriptSelectionDestination | null) => void;
}>;

export const TranscriptSendToSessionModal = React.memo(function TranscriptSendToSessionModal(
    props: TranscriptSendToSessionModalProps,
) {
    const { theme } = useUnistyles();
    const sourceServerId = props.sourceServerId.trim();
    const serverIds = React.useMemo(() => sourceServerId ? [sourceServerId] : [], [sourceServerId]);
    const selectSessions = React.useCallback((sessions: ReadonlyArray<SessionSelectionCandidate>) =>
        resolveTranscriptSendToSessionTargets({
            sourceSessionId: props.sourceSessionId,
            sourceServerId,
            sessions,
        }), [props.sourceSessionId, sourceServerId]);
    const leadingOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(() => [{
        id: 'new-session',
        testID: 'transcript-send-to-session-option-new-session',
        label: t('transcript.selection.sendTo.newSession'),
        subtitle: t('transcript.selection.sendTo.newSessionSubtitle'),
        icon: <View style={{ width: 20, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus-circle" size={20} color={theme.colors.text.secondary} />
        </View>,
    }], [theme.colors.text.secondary]);

    return <SessionSelectionModal
        {...props}
        testID="transcript-send-to-session"
        serverIds={serverIds}
        selectSessions={selectSessions}
        title={t('transcript.selection.sendTo.modalTitle')}
        subtitle={t('transcript.selection.sendTo.modalSubtitle')}
        searchPlaceholder={t('transcript.selection.sendTo.searchPlaceholder')}
        emptyStateLabel={t('transcript.selection.sendTo.noResults')}
        leadingOptions={leadingOptions}
        onSelectSession={(selection) => props.onResolve({ kind: 'existingSession', ...selection })}
        onSelectOption={(optionId) => props.onResolve(optionId === 'new-session' ? { kind: 'newSession' } : null)}
        onDismiss={() => props.onResolve(null)}
    />;
});
