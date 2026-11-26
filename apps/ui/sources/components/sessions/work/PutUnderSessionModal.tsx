import * as React from 'react';
import { readSessionManagerSessionIdV1, SessionManagerSetResultV1Schema } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';
import { joinHappierFacts } from '@happier-dev/plugin-ui/presentation';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { SessionSelectionList } from '@/components/sessions/selection/SessionSelectionList';
import { projectSessionSelectionRows } from '@/components/sessions/selection/projectSessionSelectionRows';
import type { SelectionListOption } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal, type CustomModalInjectedProps } from '@/modal';
import { useModalCardChrome } from '@/modal/components/card/useModalCardChrome';
import { getStorage } from '@/sync/domains/state/storage';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { setSessionManager } from '@/sync/ops/relations/setSessionManager';
import { t } from '@/text';
import { sessionDisplayTitle } from '@/utils/sessions/sessionDisplayTitle';
import { formatRelativeTime } from '@/utils/time/formatShortRelativeTime';

import { loadSessionManagerEligibility, type SessionManagerEligibilitySnapshot } from '@/sync/ops/relations/sessionManagerEligibility';

import { describeManagerRefusal } from './putSessionUnderLead';
import { buildPutUnderChooserSections, PUT_UNDER_TOP_LEVEL_OPTION_ID } from './putUnderChooser';
import type { PutUnderCandidatePresentation } from './putUnderPresentation';
import { resolvePutUnderEligibility } from './putUnderCandidates';
import { describeSessionListDropReason } from '@/components/sessions/shell/dropPreview/sessionListDropPresentation';
import { selectSessionRelationRecords } from './reportSubtree';
import { readSessionPresentationRecord, readSessionPresentationServerId, readSessionPresentationInputDisplay, readSessionPresentationInputRelations } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation/pageMetrics';

/**
 * "Report to…" (ORC §3.8, R-03; DnD lab K1c): the keyboard, phone and screen-reader equivalent of
 * dragging a Session under a lead. It asks the Home once for the relation facts, lists the Sessions
 * that can lead this one and, under "Can't take reports", the ones that cannot with the owner's
 * reason, and asks the one `session.manager.set` Action with the lead it saw as the expected
 * current lead. The server's fence and compare-and-set decide; a refusal is said in words.
 */

const styles = StyleSheet.create({
    body: {
        minHeight: 320,
        maxHeight: 520,
    },
});

/**
 * The quiet line under a candidate (lab K1c): what it is and what it is doing ("Orchestrator · 1 still
 * working"), otherwise when it last moved. Every candidate has one, so a long title keeps to one line
 * under the list's shared row clamp.
 */
function describeCandidateFacts(session: PutUnderCandidatePresentation): string {
    const activity = session.workingCount ? t('sessionWork.strip.stillWorking', { count: session.workingCount })
        : session.leadsCount ? t('sessionWork.list.subSessions', { count: session.leadsCount })
        : null;
    return joinHappierFacts(session.roleName, activity ?? formatRelativeTime(session.updatedAt));
}

type PutUnderSessionModalProps = CustomModalInjectedProps & Readonly<{
    sessionId: string;
    serverId: string | null;
}>;

export function PutUnderSessionModal(props: PutUnderSessionModalProps) {
    const { theme } = useUnistyles();
    const { onClose } = props;
    const onCloseRef = React.useRef(onClose);
    onCloseRef.current = onClose;
    const close = React.useCallback(() => onCloseRef.current(), []);
    const [note, setNote] = React.useState('');
    const [error, setError] = React.useState<string | null>(null);
    // The lead being asked for, shown pending on its own row until the Home answers.
    const [pendingId, setPendingId] = React.useState<string | null>(null);
    const busy = pendingId !== null;
    // A snapshot taken when the sheet opens: the choice is made against what the person saw.
    const [snapshot] = React.useState(() => {
        const state = getStorage().getState();
        const sessions = selectSessionRelationRecords(state.sessions, props.serverId, state.sessionListRowsByServerId);
        const self = sessions[props.sessionId] ?? null;
        return { sessions, currentLeadId: readSessionManagerSessionIdV1(self ? readSessionPresentationInputRelations(self) : null),
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
    const [facts, setFacts] = React.useState<SessionManagerEligibilitySnapshot | null | undefined>(undefined);
    React.useEffect(() => {
        if (!props.serverId || !snapshot.lifetime?.isCurrent() || snapshot.lifetime.scope.serverId !== props.serverId) {
            setFacts(null);
            return;
        }
        const abort = new AbortController();
        let loaded: SessionManagerEligibilitySnapshot | null = null;
        const candidateSessionIds = Object.values(snapshot.sessions)
            .filter((session) => (readSessionPresentationServerId(session) ?? null) === props.serverId && readSessionPresentationRecord(session).id !== props.sessionId)
            .map((session) => readSessionPresentationRecord(session).id);
        void loadSessionManagerEligibility({
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

    const chooser = React.useMemo(() => {
        const ownerSections = facts === undefined ? [] : buildPutUnderChooserSections({
            sessions: snapshot.sessions,
            sessionId: props.sessionId,
            facts,
        });
        const leadingOptions: SelectionListOption[] = [];
        const sections = ownerSections.flatMap(section => {
            const rows = section.options.flatMap(option => {
                if (option.id === PUT_UNDER_TOP_LEVEL_OPTION_ID) {
                    leadingOptions.push({
                        id: option.id, label: option.label,
                        icon: <Icon name="list" size={20} color={theme.colors.text.secondary} />,
                    });
                    return [];
                }
                const source = snapshot.sessions[option.id];
                const serverId = readSessionPresentationServerId(source);
                if (!serverId) return [];
                return projectSessionSelectionRows([{
                    ...readSessionPresentationRecord(source),
                    ...readSessionPresentationInputDisplay(source),
                    serverId,
                }]).map(row => ({
                    ...row,
                    id: option.id,
                    label: option.label,
                    subtitle: option.session ? describeCandidateFacts(option.session) : row.subtitle,
                    disabledReason: option.disabled ? option.detail : undefined,
                    botFace: option.botFace,
                }));
            });
            return rows.length > 0 ? [{ id: section.id, title: section.title, rows }] : [];
        });
        return { leadingOptions, sections };
    }, [facts, props.sessionId, snapshot.sessions, theme.colors.text.secondary]);

    const onSelect = React.useCallback((optionId: string) => {
        if (busy) return;
        const state = getStorage().getState();
        const sessions = selectSessionRelationRecords(state.sessions, props.serverId, state.sessionListRowsByServerId);
        const selfInput = sessions[props.sessionId];
        const self = selfInput ? readSessionPresentationRecord(selfInput) : null;
        if (!snapshot.lifetime?.isCurrent() || props.serverId !== snapshot.serverId || props.sessionId !== snapshot.sessionId
            || !self || !selfInput || (readSessionPresentationServerId(selfInput) ?? null) !== snapshot.serverId) {
            onClose();
            return;
        }
        if (!facts?.isCurrent() || facts.serverId !== snapshot.serverId || facts.accountId !== snapshot.lifetime.scope.accountId
            || facts.sessionId !== snapshot.sessionId || facts.currentManagerSessionId !== snapshot.currentLeadId
            || readSessionManagerSessionIdV1(readSessionPresentationInputRelations(selfInput)) !== snapshot.currentLeadId) {
            setError(describeSessionListDropReason('unavailable').message);
            return;
        }
        const managerSessionId = optionId === PUT_UNDER_TOP_LEVEL_OPTION_ID ? null : optionId;
        if (managerSessionId !== null) {
            const eligibility = resolvePutUnderEligibility(sessions, props.sessionId, managerSessionId, facts, {
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
        if (managerSessionId === snapshot.currentLeadId) {
            onClose();
            return;
        }
        const noteForLead = note.trim() ? note : null;
        const accountId = snapshot.lifetime.scope.accountId;
        setPendingId(optionId);
        setError(null);
        void setSessionManager({
            sessionId: props.sessionId,
            managerSessionId,
            expectedManagerSessionId: snapshot.currentLeadId,
            serverId: props.serverId,
            expectedAccountId: accountId,
        }).then(async (result) => {
            if (!result.ok) {
                setPendingId(null);
                setError(describeManagerRefusal(result.errorCode));
                return;
            }
            const lifetime = snapshot.lifetime;
            if (!lifetime?.isCurrent()) return;
            // An Action may create an approval request without committing a relation.
            const relation = noteForLead ? SessionManagerSetResultV1Schema.safeParse(result.result) : null;
            if (noteForLead && relation?.success && relation.data.ok && relation.data.managerSessionId) {
                const failureTitle = t('sessionWork.putUnder.noteDeliveryUnconfirmed');
                let failureMessage: string | null = null;
                try {
                    const execute = createFrontDoorActionExecute();
                    const sent = await execute('session.message.send', { sessionId: relation.data.managerSessionId, message: noteForLead, reply: 'none' }, {
                        surface: 'ui', serverId: lifetime.scope.serverId, expectedAccountId: accountId,
                    });
                    if (!sent.ok) {
                        failureMessage = resolveActionExecutionFailureMessage(sent, t('transcript.selection.sendTo.sendFailed'));
                    } else if (!ActionApprovalRequestCreatedResultSchema.safeParse(sent.result).success) {
                        const receipt = SessionMessageSendResultV1Schema.safeParse(sent.result);
                        if (!receipt.success || receipt.data.status === 'rejected' || receipt.data.status === 'failed'
                            || receipt.data.status === 'cancelled' || receipt.data.status === 'outcomeUnknown') {
                            failureMessage = receipt.success && 'code' in receipt.data
                                ? resolveActionExecutionFailureMessage({ ok: false, errorCode: receipt.data.code }, failureTitle)
                                : failureTitle;
                        }
                    }
                } catch {
                    failureMessage = failureTitle;
                }
                if (!lifetime.isCurrent()) return;
                onClose();
                if (failureMessage) Modal.alert(failureTitle, failureMessage === failureTitle ? undefined : failureMessage);
                return;
            }
            onClose();
        }, () => {
            setPendingId(null);
            setError(describeManagerRefusal(undefined));
        });
    }, [busy, facts, note, onClose, props.serverId, props.sessionId, snapshot]);

    const title = React.useMemo(() => {
        const self = snapshot.sessions[props.sessionId];
        return self ? t('entityDragDrop.chooser.putUnderTitle', { item: sessionDisplayTitle(readSessionPresentationInputDisplay(self), readSessionPresentationServerId(self)) }) : t('sessionWork.putUnder.title');
    }, [props.sessionId, snapshot.sessions]);
    const chrome = React.useMemo(() => ({
        kind: 'card' as const,
        title,
        testID: 'session-put-under-modal',
        // Lab K1c: on a phone this is the sheet that pickers use, not a centred dialog.
        phonePresentation: 'sheet' as const,
        dimensions: { width: HAPPIER_PAGE_METRICS.dialogWidthPx.default, maxHeightRatio: 0.8, size: 'dialog' as const },
    }), [title]);
    useModalCardChrome(props.setChrome, chrome);

    return (
        <View style={styles.body}>
            <SessionSelectionList
                {...chooser}
                title={title}
                listAccessibilityLabel={title}
                searchPlaceholder={t('sessionWork.putUnder.search')}
                emptyStateLabel={t('transcript.selection.sendTo.noResults')}
                selectedOptionId={snapshot.currentLeadId ?? undefined}
                layout="fill"
                pendingOptionId={pendingId}
                onSelectSession={({ sessionId }) => onSelect(sessionId)}
                onSelectOption={onSelect}
                onRequestClose={onClose}
                testID="session-put-under"
                note={{ label: t('transcript.selection.sendTo.addNote'), value: note, onChangeText: setNote }}
                loading={facts === undefined ? {
                    presentation: 'line',
                    testID: 'session-put-under-loading',
                    label: t('entityDragDrop.chooser.checking'),
                } : undefined}
                error={error ? { testID: 'session-put-under-error', label: error } : undefined}
            />
        </View>
    );
}

export function showPutUnderSessionModal(params: Readonly<{ sessionId: string; serverId: string | null }>): void {
    Modal.show({ component: PutUnderSessionModal, props: params });
}
