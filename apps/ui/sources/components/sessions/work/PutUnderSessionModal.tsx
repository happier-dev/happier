import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SelectionList } from '@/components/ui/selectionList/SelectionList';
import type { SelectionListStep } from '@/components/ui/selectionList/_types';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { getStorage } from '@/sync/domains/state/storage';
import type { Session } from '@/sync/domains/state/storageTypes';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { setSessionReportsTo } from '@/sync/ops/relations/setSessionReportsTo';
import { t } from '@/text';
import { getSessionName } from '@/utils/sessions/sessionUtils';

import { loadSessionReportsToEligibility, type SessionReportsToEligibilitySnapshot } from '@/sync/ops/relations/sessionReportsToEligibility';

import { describeReportsToRefusal } from './putSessionUnderLead';
import { buildPutUnderChooserSections, PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';
import { resolvePutUnderEligibility } from './putUnderCandidates';
import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';

/**
 * "Put under…" (ORC §3.8, R-03; DnD lab K1c): the keyboard, phone and screen-reader equivalent of
 * dragging a Session under a lead. It asks the Home once for the relation facts, lists the Sessions
 * that can lead this one and, under "Can't take reports", the ones that cannot with the owner's
 * reason, and asks the one `session.reports_to.set` Action with the lead it saw as the expected
 * current lead. The server's fence and compare-and-set decide; a refusal is said in words.
 */

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        minHeight: 320,
        maxHeight: 520,
    },
    error: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.state.danger.foreground,
        paddingHorizontal: 16,
        paddingBottom: 12,
    },
}));

type PutUnderSessionModalProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    serverId: string | null;
}>;

export function PutUnderSessionModal(props: PutUnderSessionModalProps) {
    const styles = stylesheet;
    const { onClose } = props;
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const close = React.useCallback(() => onCloseRef.current(), []);
    const [error, setError] = React.useState<string | null>(null);
    const [busy, setBusy] = React.useState(false);
    // A snapshot taken when the sheet opens: the choice is made against what the person saw.
    const [snapshot] = React.useState(() => {
        const sessions = getStorage().getState().sessions as Readonly<Record<string, Session>>;
        const self = sessions[props.sessionId] ?? null;
        return { sessions, currentLeadId: self?.reportsTo?.sessionId ?? null,
            sessionId: props.sessionId, serverId: props.serverId,
            lifetime: captureActiveServerAccountScopeLifetime() };
    });
    React.useEffect(() => {
        if (!snapshot.lifetime || snapshot.lifetime.scope.serverId !== snapshot.serverId || !snapshot.lifetime.isCurrent()) {
            close();
            return;
        }
        const retirement = snapshot.lifetime.onRetire(close);
        return () => retirement.dispose();
    }, [close, snapshot]);
    // One relation-facts batch per open; `undefined` while the Home is being asked.
    const [facts, setFacts] = React.useState<SessionReportsToEligibilitySnapshot | null | undefined>(undefined);
    React.useEffect(() => {
        if (!props.serverId || !snapshot.lifetime?.isCurrent() || snapshot.lifetime.scope.serverId !== props.serverId) {
            setFacts(null);
            return;
        }
        const abort = new AbortController();
        let loaded: SessionReportsToEligibilitySnapshot | null = null;
        const candidateSessionIds = Object.values(snapshot.sessions)
            .filter((session) => (session.serverId ?? null) === props.serverId && session.id !== props.sessionId)
            .map((session) => session.id);
        void loadSessionReportsToEligibility({
            serverId: props.serverId,
            sessionId: props.sessionId,
            candidateSessionIds,
            signal: abort.signal,
        }).then((next) => {
            if (abort.signal.aborted) {
                next?.dispose();
                return;
            }
            if (!snapshot.lifetime?.isCurrent() || (next && (!next.isCurrent()
                || next.serverId !== snapshot.serverId || next.accountId !== snapshot.lifetime.scope.accountId))) {
                next?.dispose();
                close();
                return;
            }
            loaded = next;
            setFacts(next);
        });
        return () => {
            abort.abort();
            loaded?.dispose();
        };
    }, [close, props.serverId, props.sessionId, snapshot]);

    const step = React.useMemo<SelectionListStep>(() => {
        const sections = facts === undefined ? [] : buildPutUnderChooserSections({
            sessions: snapshot.sessions,
            sessionId: props.sessionId,
            facts,
            describeName: (session) => getSessionName(session, session.serverId ?? null),
        });
        return {
            id: 'leads',
            inputPlaceholder: t('sessionWork.putUnder.search'),
            sections: sections.map((section) => ({
                kind: 'static' as const,
                id: section.id,
                ...(section.title ? { title: section.title } : {}),
                options: section.options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    ...(option.detail ? { subtitle: option.detail } : {}),
                    ...(option.disabled ? { disabled: true } : {}),
                })),
            })),
        };
    }, [facts, props.sessionId, snapshot.sessions]);

    const onSelect = React.useCallback((optionId: string) => {
        if (busy) return;
        const sessions = getStorage().getState().sessions as Readonly<Record<string, Session>>;
        const self = sessions[props.sessionId];
        if (!snapshot.lifetime?.isCurrent() || props.serverId !== snapshot.serverId || props.sessionId !== snapshot.sessionId
            || !self || (self.serverId ?? null) !== snapshot.serverId) {
            onClose();
            return;
        }
        if (!facts?.isCurrent() || facts.serverId !== snapshot.serverId || facts.accountId !== snapshot.lifetime.scope.accountId
            || facts.sessionId !== snapshot.sessionId || facts.currentLeadSessionId !== snapshot.currentLeadId
            || (self.reportsTo?.sessionId ?? null) !== snapshot.currentLeadId) {
            setError(describeSessionListDropReason('unavailable').message);
            return;
        }
        const leadSessionId = optionId === PUT_UNDER_TOP_LEVEL_OPTION_ID ? null : optionId;
        if (leadSessionId !== null) {
            const eligibility = resolvePutUnderEligibility(sessions, props.sessionId, leadSessionId, facts, {
                serverId: snapshot.serverId, accountId: snapshot.lifetime.scope.accountId, allowCurrentLead: true,
            });
            if (!eligibility.allowed) {
                setError(describeSessionListDropReason(eligibility.reason).message);
                return;
            }
        } else if (self.archivedAt != null || self.access?.capabilities.readTranscript !== true
            || self.access.capabilities.submitAgentInput !== true) {
            setError(describeSessionListDropReason('unavailable').message);
            return;
        }
        if (leadSessionId === snapshot.currentLeadId) {
            onClose();
            return;
        }
        setBusy(true);
        setError(null);
        void setSessionReportsTo({
            sessionId: props.sessionId,
            leadSessionId,
            expectedLeadSessionId: snapshot.currentLeadId,
            serverId: props.serverId,
            expectedAccountId: snapshot.lifetime.scope.accountId,
        }).then((result) => {
            if (result.ok) {
                onClose();
                return;
            }
            setBusy(false);
            setError(describeReportsToRefusal(result.errorCode));
        }, () => {
            setBusy(false);
            setError(describeReportsToRefusal(undefined));
        });
    }, [busy, facts, onClose, props.serverId, props.sessionId, snapshot]);

    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title: t('sessionWork.putUnder.title'),
        testID: 'session-put-under-modal',
        dimensions: { width: 420, maxHeightRatio: 0.8, size: 'dialog' as const },
    }), []);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            {error ? <Text testID="session-put-under-error" style={styles.error}>{error}</Text> : null}
            <SelectionList
                rootStep={step}
                selectedOptionId={snapshot.currentLeadId}
                listAccessibilityLabel={t('sessionWork.putUnder.title')}
                fillAvailableSpace
                onSelect={onSelect}
                onRequestClose={onClose}
                testID="session-put-under-list"
            />
        </View>
    );
}

export function showPutUnderSessionModal(params: Readonly<{ sessionId: string; serverId: string | null }>): void {
    Modal.show({ component: PutUnderSessionModal, props: params });
}
