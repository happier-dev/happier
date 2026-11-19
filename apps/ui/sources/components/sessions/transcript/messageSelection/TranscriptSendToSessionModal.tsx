import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { SessionChooserModal, type SessionSelectionCandidate } from '@/components/sessions/selection/SessionChooserModal';
import { Icon } from '@/components/ui/icons/Icon';
import type { SelectionListOption } from '@/components/ui/selectionList';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';

import { resolveReadableSessionPickerTargets, resolveTranscriptSendToSessionTargets } from './resolveTranscriptSendToSessionTargets';
import type { SendTranscriptSelectionDestination } from './sendTranscriptSelectionToSession';
import type { ActionSessionAddressV1 } from '@happier-dev/protocol/actions/sessionTargetV1';

export type TranscriptSendToSessionModalProps = CustomModalInjectedProps & Readonly<{
    sourceServerId: string;
    sessionCandidates?: readonly ActionSessionAddressV1[];
    onResolve: (destination: SendTranscriptSelectionDestination | null) => void;
}> & (Readonly<{ selectionOnly: true; sourceSessionId?: never; previewText?: never; selectedCount?: never;
    /** A destination picker excludes its source and asks for edit access; a reference picker asks for reading. */
    destination?: Readonly<{ excludedSessionId: string; capability: 'editSessionRecords' | 'submitAgentInput'; title: string; allowNewSession?: boolean }> }>
    | Readonly<{ selectionOnly?: false; sourceSessionId: string; previewText: string; selectedCount?: number; destination?: never }>);

export const TranscriptSendToSessionModal = React.memo(function TranscriptSendToSessionModal(
    props: TranscriptSendToSessionModalProps,
) {
    const { theme } = useUnistyles();
    const sourceServerId = props.sourceServerId.trim();
    const serverIds = React.useMemo(() => sourceServerId ? [sourceServerId] : [], [sourceServerId]);
    const selectSessions = React.useCallback((sessions: ReadonlyArray<SessionSelectionCandidate>) =>
        props.selectionOnly ? resolveReadableSessionPickerTargets({ serverId: sourceServerId, sessions,
            ...(props.sessionCandidates === undefined ? {} : { sessionCandidates: props.sessionCandidates }),
            ...(props.destination ? { excludedSessionId: props.destination.excludedSessionId, capability: props.destination.capability } : {}) })
            : resolveTranscriptSendToSessionTargets({
            sourceSessionId: props.sourceSessionId,
            sourceServerId,
            sessions,
        }), [props.selectionOnly, props.sourceSessionId, props.destination?.excludedSessionId, props.destination?.capability, props.sessionCandidates, sourceServerId]);
    const leadingOptions = React.useMemo<ReadonlyArray<SelectionListOption>>(() => props.selectionOnly && !props.destination?.allowNewSession ? [] : [{
        id: 'new-session',
        testID: 'transcript-send-to-session-option-new-session',
        label: t('transcript.selection.sendTo.newSession'),
        subtitle: t('transcript.selection.sendTo.newSessionSubtitle'),
        icon: <View style={{ width: 20, alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="plus-circle" size={20} color={theme.colors.text.secondary} />
        </View>,
    }], [props.selectionOnly, props.destination?.allowNewSession, theme.colors.text.secondary]);
    // Select (owner 2026-11-17 decision 3): only transcript "Send to session" can address several Sessions.
    const { onResolve } = props;
    const multipleSelect = React.useMemo(() => props.selectionOnly ? undefined : {
        subtitle: t('transcript.selection.sendTo.multipleSubtitle', { count: props.selectedCount ?? 1 }),
        submitLabel: t('sessionsList.selectionCompose'),
        onSubmit: (targets: readonly ActionSessionAddressV1[]) => onResolve({ kind: 'bulk', targets }),
    }, [onResolve, props.selectedCount, props.selectionOnly]);

    return <SessionChooserModal
        {...props}
        setChrome={props.selectionOnly ? undefined : props.setChrome}
        testID="transcript-send-to-session"
        serverIds={serverIds}
        selectSessions={selectSessions}
        title={props.selectionOnly ? props.destination?.title ?? t('sessionGettingStarted.title.selectSession') : t('transcript.selection.sendTo.modalTitle')}
        subtitle={props.selectionOnly ? undefined : t('transcript.selection.sendTo.modalSubtitle')}
        searchPlaceholder={t('transcript.selection.sendTo.searchPlaceholder')}
        emptyStateLabel={t('transcript.selection.sendTo.noResults')}
        leadingOptions={leadingOptions}
        multipleSelect={multipleSelect}
        onSelectSession={(selection) => props.onResolve({ kind: 'existingSession', ...selection })}
        onSelectOption={(optionId) => props.onResolve(optionId === 'new-session' ? { kind: 'newSession' } : null)}
        onDismiss={() => props.onResolve(null)}
    />;
});
