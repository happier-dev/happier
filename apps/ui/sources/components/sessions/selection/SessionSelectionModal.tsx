import * as React from 'react';
import {
    View,
    useWindowDimensions,
} from 'react-native';
import {
    StyleSheet,
} from 'react-native-unistyles';

import { type SelectionListOption } from '@/components/ui/selectionList';
import { SessionSelectionList } from './SessionSelectionList';
import { projectSessionSelectionRows, type SessionSelectionCandidate } from './projectSessionSelectionRows';
import { useKeyboardHeight } from '@/hooks/ui/useKeyboardHeight';
import type { CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { useSessionListIndexByServerId, useSessionListRowRenderablesForItems, useSessionOrganizationProjections, useSessions } from '@/sync/domains/state/storage';
import { buildSessionOrganizationListViewStateForServers } from '@/sync/domains/session/organization/viewState';
import { useSessionListRecordingPrivacy } from '@/hooks/session/useSessionListRecordingPrivacy';
import { sessionAddressKey, type SessionAddress } from '@/sync/domains/session/sessionAddress';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { collectSessionSelectionCandidates, readSessionListIndexSessionItems } from './sessionSelectionCandidates';
import { sortSessionSelectionCandidates } from './sortSessionSelectionCandidates';
import {
    resolveSessionSelectionModalLayout,
    SESSION_SELECTION_MODAL_SIZE,
    SESSION_SELECTION_MODAL_WIDTH,
} from './resolveSessionSelectionModalLayout';

export type SessionSelectionIdentity = SessionAddress;
export type { SessionSelectionCandidate } from './projectSessionSelectionRows';
export type SessionSelectionModalProps = CustomModalInjectedProps & Readonly<{
    serverIds?: ReadonlyArray<string>;
    selectSessions?: (sessions: ReadonlyArray<SessionSelectionCandidate>) => ReadonlyArray<SessionSelectionCandidate>;
    title: string;
    subtitle?: string;
    searchPlaceholder: string;
    emptyStateLabel: string;
    testID: string;
    leadingOptions?: ReadonlyArray<SelectionListOption>;
    onSelectSession: (selection: SessionSelectionIdentity) => void | Promise<void>;
    onSelectOption?: (optionId: string) => void;
    onDismiss: () => void;
}>;

const styles = StyleSheet.create(() => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
}));

export const SessionSelectionModal = React.memo(function SessionSelectionModal(
    props: SessionSelectionModalProps,
) {
    const sessions = useSessions();
    const windowDimensions = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();

    const modalLayout = React.useMemo(() => resolveSessionSelectionModalLayout({
        windowWidth: windowDimensions.width,
        windowHeight: windowDimensions.height,
        keyboardHeight,
    }), [keyboardHeight, windowDimensions.height, windowDimensions.width]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title,
        testID: `${props.testID}-modal`,
        subtitle: props.subtitle,
        dimensions: {
            width: SESSION_SELECTION_MODAL_WIDTH,
            maxHeightRatio: modalLayout.maxHeightRatio,
            size: SESSION_SELECTION_MODAL_SIZE,
        },
    }), [modalLayout.maxHeightRatio, props.subtitle, props.testID, props.title]);
    useModalCardChrome(props.setChrome, chrome);

    const sessionListIndexByServerId = useSessionListIndexByServerId(props.serverIds);
    const sessionListItems = React.useMemo(
        () => readSessionListIndexSessionItems(sessionListIndexByServerId),
        [sessionListIndexByServerId],
    );
    const sessionListRowRenderablesByKey = useSessionListRowRenderablesForItems(sessionListItems);
    const candidates = React.useMemo(() => collectSessionSelectionCandidates({
            sessions: sessions ?? [], sessionListItems,
            readRow: (serverId, sessionId) => sessionListRowRenderablesByKey.get(sessionAddressKey({ serverId, sessionId })),
        }), [sessions, sessionListItems, sessionListRowRenderablesByKey]);
    const organizationServerIds = React.useMemo(() => [...new Set(candidates.map(session => session.serverId))], [candidates]);
    const projectionsByServerId = useSessionOrganizationProjections(organizationServerIds);
    const organization = React.useMemo(() => buildSessionOrganizationListViewStateForServers({
        serverIds: organizationServerIds, projectionsByServerId,
    }), [organizationServerIds, projectionsByServerId]);
    const hiddenSessionKeys = useSessionListRecordingPrivacy(organization);
    const targets = React.useMemo<ReadonlyArray<SessionSelectionCandidate>>(() => {
        const visible = hiddenSessionKeys.size === 0 ? candidates : candidates.filter(session =>
            !hiddenSessionKeys.has(sessionAddressKey({ serverId: session.serverId, sessionId: session.id })));
        return props.selectSessions ? props.selectSessions(visible) : sortSessionSelectionCandidates(visible);
    }, [props.selectSessions, candidates, hiddenSessionKeys]);

    const rows = React.useMemo(() => projectSessionSelectionRows(targets), [targets]);

    return (
        <View testID={`${props.testID}-modal-body`} style={styles.body}>
            <SessionSelectionList
                rows={rows} testID={props.testID} title={props.title}
                searchPlaceholder={props.searchPlaceholder} emptyStateLabel={props.emptyStateLabel}
                leadingOptions={props.leadingOptions}
                onSelectSession={(address) => {
                    fireAndForget((async () => {
                        await props.onSelectSession(address);
                        props.onClose();
                    })(), { tag: 'SessionSelectionModal.selectSession' });
                }}
                onSelectOption={(id) => {
                    props.onSelectOption?.(id);
                    props.onClose();
                }}
                onRequestClose={() => {
                    props.onDismiss();
                    props.onClose();
                }}
                maxHeight={modalLayout.listMaxHeight}
            />
        </View>
    );
});
