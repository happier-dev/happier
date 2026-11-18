import * as React from 'react';
import {
    View,
    useWindowDimensions,
} from 'react-native';
import {
    StyleSheet,
    useUnistyles,
} from 'react-native-unistyles';

import { type SelectionListOption } from '@/components/ui/selectionList';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionActionBar } from '@/components/ui/selection/SelectionActionBar';
import { t } from '@/text';
import { SessionSelectionList, type SessionSelectionListMode } from './SessionSelectionList';
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
/**
 * A caller that can act on several Sessions at once hands the picker this: a "Select" header action then switches
 * the same list to its multiple arm, with the shared selection bar as its one exit forward.
 */
export type SessionChooserMultipleSelect = Readonly<{
    /** The subtitle while choosing several ("Choose the sessions that should get these 2 messages"). */
    subtitle: string;
    /** The bar's one primary action ("Compose"). */
    submitLabel: string;
    onSubmit: (targets: readonly SessionAddress[]) => void;
}>;
export type SessionChooserModalProps = CustomModalInjectedProps & Readonly<{
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
    multipleSelect?: SessionChooserMultipleSelect;
}>;

const styles = StyleSheet.create((theme) => ({
    body: {
        flex: 1,
        minHeight: 0,
    },
    // The bar sits under the rows, centred, so it never covers the last one.
    bar: {
        alignItems: 'center',
        paddingTop: theme.space.s8,
        paddingBottom: theme.space.s12,
        paddingHorizontal: theme.space.s12,
    },
}));

/**
 * `SessionChooser`'s modal presentation: the same list in a card (a full-height route on a phone), reading the
 * Account's Sessions from the store. Tapping a row chooses it; a caller that can act on several adds Select.
 */
export const SessionChooserModal = React.memo(function SessionChooserModal(
    props: SessionChooserModalProps,
) {
    const { theme } = useUnistyles();
    const [selectedKeys, setSelectedKeys] = React.useState<ReadonlySet<string> | null>(null);
    const selecting = selectedKeys !== null && props.multipleSelect !== undefined;
    const sessions = useSessions();
    const windowDimensions = useWindowDimensions();
    const keyboardHeight = useKeyboardHeight();

    const modalLayout = React.useMemo(() => resolveSessionSelectionModalLayout({
        windowWidth: windowDimensions.width,
        windowHeight: windowDimensions.height,
        keyboardHeight,
    }), [keyboardHeight, windowDimensions.height, windowDimensions.width]);
    const multipleSelect = props.multipleSelect;
    const selectAction = React.useMemo(() => multipleSelect && !selecting ? (
        <RoundButton testID={`${props.testID}-select`} size="small" display="secondary" title={t('sessionsList.selectionSelect')}
            leading={<Icon name="check-circle" size={16} color={theme.colors.text.primary} />}
            onPress={() => setSelectedKeys(new Set())} />
    ) : undefined, [multipleSelect, props.testID, selecting, theme.colors.text.primary]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: props.title,
        testID: `${props.testID}-modal`,
        subtitle: selecting ? multipleSelect?.subtitle : props.subtitle,
        // Null, not absent: the card merges chrome, so an absent key would keep Select drawn while selecting.
        actions: selectAction ?? null,
        dimensions: {
            width: SESSION_SELECTION_MODAL_WIDTH,
            maxHeightRatio: modalLayout.maxHeightRatio,
            size: SESSION_SELECTION_MODAL_SIZE,
        },
    }), [modalLayout.maxHeightRatio, multipleSelect?.subtitle, props.subtitle, props.testID, props.title, selectAction, selecting]);
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
    const toggle = React.useCallback((address: SessionAddress) => setSelectedKeys(previous => {
        const next = new Set(previous ?? []);
        const key = sessionAddressKey(address);
        if (!next.delete(key)) next.add(key);
        return next;
    }), []);
    const selectionMode = React.useMemo<SessionSelectionListMode | undefined>(() => selecting && selectedKeys
        ? { kind: 'multiple', selectedIds: selectedKeys, onToggle: toggle } : undefined, [selectedKeys, selecting, toggle]);
    const { onClose } = props;
    const submit = React.useCallback(() => {
        if (!multipleSelect || !selectedKeys) return;
        const chosen = rows.filter(row => selectedKeys.has(row.id)).map(row => row.address);
        if (chosen.length === 0) return;
        multipleSelect.onSubmit(chosen);
        onClose();
    }, [multipleSelect, onClose, rows, selectedKeys]);
    const count = selectedKeys?.size ?? 0;
    const bar = selecting && multipleSelect ? (
        <View style={styles.bar}>
            <SelectionActionBar
                visible
                testID={`${props.testID}-selection-bar`}
                accessibilityLabel={t('sessionsList.selectionA11ySelectedCount', { count })}
                label={t('sessionsList.selectionSelectedCount', { count })}
                actions={[{
                    id: 'submit',
                    testID: `${props.testID}-selection-submit`,
                    label: multipleSelect.submitLabel,
                    emphasis: 'primary',
                    disabled: count === 0,
                    renderIcon: (color) => <Icon name="pencil" size={14} color={color} />,
                    onPress: submit,
                }]}
                dismiss={{
                    testID: `${props.testID}-selection-cancel`,
                    label: t('common.cancel'),
                    presentation: 'label',
                    onPress: () => setSelectedKeys(null),
                }}
            />
        </View>
    ) : undefined;

    return (
        <View testID={`${props.testID}-modal-body`} style={styles.body}>
            <SessionSelectionList
                rows={rows} testID={props.testID} title={props.title}
                searchPlaceholder={props.searchPlaceholder} emptyStateLabel={props.emptyStateLabel}
                leadingOptions={props.leadingOptions}
                selectionMode={selectionMode}
                pinnedRow={bar}
                onSelectSession={(address) => {
                    fireAndForget((async () => {
                        await props.onSelectSession(address);
                        props.onClose();
                    })(), { tag: 'SessionChooserModal.selectSession' });
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
