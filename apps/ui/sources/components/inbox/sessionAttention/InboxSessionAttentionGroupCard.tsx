import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageRowDividerWidth, useHappierPageSection, HAPPIER_WORK_PAGE_ROW_METRICS } from '@happier-dev/plugin-ui/presentation';
import { useRouter } from 'expo-router';

import { readSessionPresentationControl, type SessionPresentationRecord,
    type SessionListPresentationSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import type { PendingPermissionRequest } from '@/utils/sessions/sessionUtils';

import { useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { PermissionPromptCard } from '@/components/tools/shell/permissions/PermissionPromptCard';
import { UserActionPromptCard } from '@/components/tools/shell/userActions/UserActionPromptCard';
import { deriveTranscriptInteractionFromSession } from '@/utils/sessions/deriveTranscriptInteraction';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import { isInboxSessionStatusOnly, readInboxSessionTitle } from './inboxSessionPrivacy';
import { createActivitySurfaceSessionRoute } from '@/activity/actions/activitySurfaceTargets';
import { InboxSessionAttentionHeader } from './InboxSessionAttentionHeader';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { t } from '@/text';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { storage } from '@/sync/domains/state/storage';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { getPendingQueueWakeResumeOptions } from '@/sync/domains/pending/pendingQueueWake';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import { readAgentScopedPluginSettingsSnapshot } from '@/agents/registry/agentScopedPluginSettings';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { resumeSession } from '@/sync/ops/sessions';
import type { SessionListIdentityDisplay } from '@/components/sessions/shell/SessionListIdentity';
import { AppSessionTranscriptSourceProvider } from '@/components/sessions/transcript/source/appSessionTranscriptSource';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';

export const InboxSessionAttentionGroupCard = React.memo(function InboxSessionAttentionGroupCard(props: Readonly<{
    session: SessionPresentationRecord;
    presentationSource?: SessionListPresentationSource;
    serverId: string | null;
    identityDisplay: SessionListIdentityDisplay;
    connected: boolean;
    contextLine?: string | null;
    permissionRequests: readonly PendingPermissionRequest[];
    userActionRequests: readonly PendingPermissionRequest[];
    showDivider?: boolean;
    onBeforeNavigate?: () => void;
    /** The item open beside the list: its row is drawn selected. */
    selected?: boolean;
    /** Beside the Inbox's detail pane the header selects the Session there instead of leaving the Inbox. */
    onSelect?: () => void;
    /** State, age and menu of the row this card draws; the same ones the session row beside it shows. */
    row?: React.ComponentProps<typeof InboxSessionAttentionHeader>['row'];
}>) {
    // A displayed request card is a full control demand; overview/closed rows never enter here.
    const session = readSessionPresentationControl({ record: props.session,
        serverId: props.serverId ?? props.presentationSource?.serverId,
        baseSession: props.presentationSource?.baseSession });
    const router = useRouter();
    const resumeAbort = React.useRef<AbortController | null>(null);
    React.useEffect(() => () => resumeAbort.current?.abort(), [props.serverId, session.id]);
    // On the Inbox page the card is one of the sheet's rows: it draws the sheet's own full-width hairline.
    const pageSection = useHappierPageSection();
    const isRecordingVisible = useSessionRecordingVisibility();
    const recordingVisible = isRecordingVisible({ sessionId: session.id, serverId: props.serverId });
    const statusOnly = !recordingVisible || isInboxSessionStatusOnly(session, props.serverId);
    const ownerMetadata = statusOnly ? null : readSessionOwnerMetadataView(session);
    const machineId = statusOnly ? '' : readDisplayMachineIdForSession({
        // Qualified cards already carry their exact Home metadata. A bare-id store lookup
        // could substitute the active Home's same-id Session.
        sessionId: props.serverId ? null : session.id,
        metadata: ownerMetadata,
    });
    const legacyMachine = useMachine(props.serverId ? '' : machineId);
    const scopedMachine = useServerScopedMachine(props.serverId, props.serverId ? machineId : '');
    const machine = props.serverId ? scopedMachine : legacyMachine;
    const transcriptInteraction = React.useMemo(() => {
        return deriveTranscriptInteractionFromSession({
            access: session.access,
            active: session.active,
            presence: session.presence,
        });
    }, [session.access, session.active, session.presence]);
    const openSession = React.useCallback(() => {
        props.onBeforeNavigate?.();
        router.push(createActivitySurfaceSessionRoute(session.id, props.serverId));
    }, [props.onBeforeNavigate, props.serverId, session.id, router]);
    const stoppedWithPendingRequests = !statusOnly && transcriptInteraction.permissionDisabledReason === 'inactive'
        && (props.permissionRequests.length > 0 || props.userActionRequests.length > 0);
    const [resumeFailed, setResumeFailed] = React.useState(false);
    // Returned to `RoundButton`'s `action`, whose shared pending lifecycle marks the
    // control busy and refuses a second press until this settles.
    const resumeStoppedSession = React.useCallback(async () => {
        // A secondary Home's Account settings are not the focused Home's settings.
        // Open its Session so the focused resume owner can use that Home's scope.
        if (props.serverId && getActiveServerSnapshot().serverId !== props.serverId) {
            openSession();
            return;
        }
        setResumeFailed(false);
        resumeAbort.current?.abort();
        const abort = new AbortController();
        resumeAbort.current = abort;
        try {
            const state = storage.getState();
            const target = readMachineControlTargetForSession(
                props.serverId ? { serverId: props.serverId, sessionId: session.id } : session.id,
            );
            if (!target) throw new Error('resume_target_unavailable');
            const agentId = resolveAgentIdFromSessionMetadata(ownerMetadata);
            const lifetime = captureActiveServerAccountScopeLifetime();
            const pluginSettings = await readAgentScopedPluginSettingsSnapshot({
                agentId,
                machineId: target?.machineId,
                serverId: props.serverId ?? undefined,
                accountLifetime: lifetime,
                accountSettings: state.settings,
                signal: abort.signal,
            });
            if (abort.signal.aborted) return;
            if (lifetime && !lifetime.isCurrent()) throw new Error('account_changed');
            const options = getPendingQueueWakeResumeOptions({
                sessionId: session.id,
                session: session,
                resumeCapabilityOptions: buildResumeCapabilityOptionsFromUiState({
                    settings: state.settings,
                    pluginSettings,
                    results: undefined,
                }),
                resumeTargetOverride: { machineId: target.machineId, directory: target.basePath },
            });
            if (!options) throw new Error('resume_unavailable');
            const result = await resumeSession({
                ...options,
                executionAuthority: 'present_user',
                serverId: props.serverId ?? undefined,
                ...(props.serverId ? { preferRequestedMachineTarget: true, preferScopedMachineRpc: true } : {}),
            });
            if (result.type === 'error') throw new Error('resume_failed');
            openSession();
        } catch {
            if (!abort.signal.aborted) setResumeFailed(true);
        }
    }, [openSession, ownerMetadata, props.serverId, session]);

    return (
        <AppSessionTranscriptSourceProvider sessionId={session.id} serverId={props.serverId} interaction={transcriptInteraction}>
        <View testID={`inbox.session_attention.${session.id}`}>
            <InboxSessionAttentionHeader
                session={session}
                serverId={props.serverId}
                identityDisplay={props.identityDisplay}
                connected={props.connected}
                sessionTitle={readInboxSessionTitle(session, props.serverId)}
                machineLabel={statusOnly ? null : getMachineDisplayName(machine)}
                pathLabel={recordingVisible ? props.contextLine ?? null : null}
                onOpenSession={props.onSelect ?? openSession}
                selected={props.selected}
                row={props.row}
            />

            {/* A card whose requests cannot be shown yet is its header row alone, with no empty band under it. */}
            {stoppedWithPendingRequests || (!statusOnly && (props.permissionRequests.length > 0 || props.userActionRequests.length > 0)) ? (
            <View style={[styles.items, pageSection ? styles.pageSheetItems : null]}>
                {stoppedWithPendingRequests ? (
                    <View testID="inbox.session_attention.stopped" style={styles.stoppedRow}>
                        <Text style={styles.stoppedText}>{t('inbox.stoppedResumeToAnswer')}</Text>
                        <RoundButton
                            testID="inbox.session_attention.resume"
                            size="small"
                            display="secondary"
                            title={t('session.pendingActivation.actions.resume')}
                            accessibilityLabel={t('session.pendingActivation.actions.resume')}
                            action={resumeStoppedSession}
                            style={styles.resumeButton}
                        />
                        {resumeFailed ? <Text testID="inbox.session_attention.resume_error" style={styles.errorText}>{t('session.resumeFailed')}</Text> : null}
                    </View>
                ) : null}
                {(statusOnly || stoppedWithPendingRequests ? [] : props.permissionRequests).map((request) => (
                    <PermissionPromptCard
                        key={request.id}
                        request={request}
                        location={null}
                        sessionId={session.id}
                        serverId={props.serverId ?? undefined}
                        metadata={ownerMetadata}
                        canApprovePermissions={transcriptInteraction.canApprovePermissions}
                        disabledReason={transcriptInteraction.permissionDisabledReason}
                        // In a page sheet the request is part of its row (lab `phone-P4`), not a card inside a card.
                        chrome={pageSection ? 'inline' : undefined}
                    />
                ))}

                {(statusOnly || stoppedWithPendingRequests ? [] : props.userActionRequests).map((request) => (
                    <UserActionPromptCard
                        session={session}
                        key={request.id}
                        request={request}
                        location={null}
                        sessionId={session.id}
                        serverId={props.serverId ?? undefined}
                        metadata={ownerMetadata}
                        canApprovePermissions={transcriptInteraction.canApprovePermissions}
                        disabledReason={transcriptInteraction.permissionDisabledReason}
                        // In a page sheet the request is part of its row (lab `phone-P4`), not a card inside a card.
                        chrome={pageSection ? 'inline' : undefined}
                    />
                ))}
            </View>
            ) : null}
            {props.showDivider ? (
                <View style={pageSection
                    ? { height: happierPageRowDividerWidth(), backgroundColor: pageSection.rowDividerColor }
                    : styles.divider} />
            ) : null}
        </View>
        </AppSessionTranscriptSourceProvider>
    );
});

const styles = StyleSheet.create((theme) => ({
    items: {
        gap: theme.space.s12,
        paddingHorizontal: theme.space.s16,
        paddingBottom: theme.space.s16,
    },
    // In a page sheet the row's requests are part of the row (lab `phone-P4`): their inline prompt's own
    // icon column (the approval chrome's medium inset) lands on the row's text column.
    pageSheetItems: {
        paddingLeft: HAPPIER_WORK_PAGE_ROW_METRICS.textInsetPx - theme.space.s12,
        paddingRight: Math.max(0, HAPPIER_WORK_PAGE_ROW_METRICS.trailingInsetPx - theme.space.s12),
        // The inline prompt closes with its own inset; a second one would leave a band under the decision.
        paddingBottom: 0,
    },
    stoppedRow: { gap: theme.space.s8, minHeight: 44 },
    stoppedText: { color: theme.colors.text.secondary, ...Typography.variant('label', 'regular') },
    resumeButton: { alignSelf: 'flex-start' },
    errorText: { color: theme.colors.status.error, ...Typography.variant('label', 'regular') },
    divider: {
        height: 1,
        marginLeft: theme.space.s16,
        backgroundColor: theme.colors.border.default,
    },
}));
