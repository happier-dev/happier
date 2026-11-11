import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { TeamInvitationPreviewV1 } from '@happier-dev/protocol/teams';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { teamRoleLabel } from '@/components/settings/teams/teamLabels';
import { getPreferredLanguage, t } from '@/text';
import { formatCalendarDate } from '@/utils/datetime/cachedIntlFormatters';

import { presentTeamsDisabledOnHome } from '@/components/teams/entry/teamAuthenticationFailure';

import { resolveTeamJoinPresentation } from './teamJoinOutcome';
import type { TeamInvitationPreviewState } from '@/hooks/teams/useTeamInvitationPreview';

/**
 * What joining this Team actually does, stated before the person confirms.
 *
 * Every line is a projection of the bounded preview the Home returned. Nothing
 * here is inferred from the focused Home, the application origin, the inviter or
 * a default: a consequence this Home did not publish is simply not shown, which
 * is why the inviter, the storage disclosure and the masked recipient are
 * conditional rather than defaulted. The inviter is the Home's own display label
 * for them — the same one its invitation email sends — and never an identifier. The Guest sentence is the one consequence a role carries that
 * the role label alone does not say, so it is stated in full.
 */
const PreviewLine = React.memo(function PreviewLine(props: Readonly<{
    testID: string;
    text: string;
}>) {
    return (
        <Text testID={props.testID} style={styles.line}>
            {props.text}
        </Text>
    );
});

/** A retained terminal invitation reads as its own state, never as a failure. */
function terminalPresentation(state: Exclude<TeamInvitationPreviewV1['state'], 'active'>) {
    switch (state) {
        case 'accepted':
            return resolveTeamJoinPresentation({ outcome: 'used' });
        case 'revoked':
            return resolveTeamJoinPresentation({ outcome: 'revoked' });
        case 'expired':
            return resolveTeamJoinPresentation({ outcome: 'expired' });
    }
}

export const TeamInvitationPreviewDetails = React.memo(function TeamInvitationPreviewDetails(props: Readonly<{
    state: TeamInvitationPreviewState;
    /** Re-reads this exact invitation; the invitation itself is untouched. */
    onRetry?: () => void;
}>) {
    const { state } = props;

    if (state.kind === 'idle') return null;

    if (state.kind === 'loading') {
        // Geometry is preserved rather than replaced by a spinner: the Team
        // lockup above is already rendered, and collapsing the consequences
        // would make the primary action jump under the pointer.
        return (
            <View testID="team-join-preview-loading" style={styles.block}>
                <Text style={styles.pending}>{t('teams.join.previewLoading')}</Text>
            </View>
        );
    }

    if (state.kind === 'unavailable') {
        const presentation = state.reason === 'teams_disabled' ? presentTeamsDisabledOnHome()
            : resolveTeamJoinPresentation({ outcome: state.reason ?? 'not_found' });
        return (
            <SurfaceStateCard
                testID="team-join-preview-unavailable"
                kind="warning"
                title={presentation.title}
                reason={presentation.body ?? undefined}
                accessibilitySemantics="status"
            />
        );
    }

    if (state.kind === 'feature_unavailable') {
        // Teams are turned off on this Home. Asking for a new link would not
        // help, so this says what is actually true instead of borrowing the
        // unusable-link copy.
        const disabled = presentTeamsDisabledOnHome();
        return (
            <SurfaceStateCard
                testID="team-join-preview-feature-unavailable"
                kind="warning"
                title={disabled.title}
                reason={disabled.body}
                accessibilitySemantics="status"
            />
        );
    }

    if (state.kind === 'failed') {
        // The invitation is untouched; only this device's read failed.
        return (
            <SurfaceStateCard
                testID="team-join-preview-failed"
                kind="error"
                title={t('teams.join.offlineTitle')}
                reason={t('teams.join.offlineBody')}
                action={state.retryable && props.onRetry
                    ? { label: t('teams.join.retry'), onPress: props.onRetry }
                    : undefined}
                accessibilitySemantics="status"
            />
        );
    }

    const { preview } = state;
    if (preview.state !== 'active') {
        const presentation = terminalPresentation(preview.state);
        return (
            <SurfaceStateCard
                testID={`team-join-preview-terminal-${preview.state}`}
                kind="warning"
                title={presentation.title}
                reason={presentation.body ?? undefined}
                accessibilitySemantics="status"
            />
        );
    }

    return (
        <View testID="team-join-preview" style={styles.block}>
            {preview.inviterLabel !== null ? (
                <PreviewLine
                    testID="team-join-preview-inviter"
                    text={t('teams.join.invitedBy', { name: preview.inviterLabel })}
                />
            ) : null}
            <PreviewLine
                testID="team-join-preview-role"
                text={t('teams.join.roleOffered', { role: teamRoleLabel(preview.role) })}
            />
            <PreviewLine
                testID="team-join-preview-history"
                text={preview.historyAccess === 'all_existing'
                    ? t('teams.join.historyAllExisting')
                    : t('teams.join.historyFromJoining')}
            />
            {preview.role === 'guest' ? (
                <PreviewLine
                    testID="team-join-preview-guest"
                    text={t('teams.join.guestNotice', { team: preview.team.name })}
                />
            ) : null}
            {preview.home.hosting === 'personal' ? (
                <PreviewLine
                    testID="team-join-preview-hosting"
                    text={t('teams.join.personalHomeNotice')}
                />
            ) : null}
            {preview.home.storageMode === 'plain' ? (
                <PreviewLine
                    testID="team-join-preview-storage"
                    text={t('teams.join.plainStorageNotice')}
                />
            ) : null}
            {preview.recipientEmailMask !== null ? (
                <PreviewLine
                    testID="team-join-preview-recipient"
                    text={t('teams.join.sentTo', { email: preview.recipientEmailMask })}
                />
            ) : null}
            <PreviewLine
                testID="team-join-preview-expiry"
                text={t('teams.join.expiresOn', {
                    when: formatCalendarDate(preview.expiresAt, getPreferredLanguage()),
                })}
            />
            {state.refreshing ? (
                <Text
                    testID="team-join-preview-refreshing"
                    accessibilityLiveRegion="polite"
                    aria-live="polite"
                    role="status"
                    style={styles.pending}
                >
                    {t('teams.join.previewLoading')}
                </Text>
            ) : null}
            {state.refreshFailure ? (
                <View testID="team-join-preview-failed" style={styles.refreshFailure}>
                    <Text accessibilityLiveRegion="polite" aria-live="polite" role="status" style={styles.pending}>
                        {t('teams.join.offlineBody')}
                    </Text>
                    {state.refreshFailure.retryable && props.onRetry ? (
                        <RoundButton
                            testID="team-join-preview-failed-action"
                            size="small"
                            display="secondary"
                            title={t('teams.join.retry')}
                            onPress={props.onRetry}
                        />
                    ) : null}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    block: {
        gap: theme.space.s6,
    },
    line: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    pending: {
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    refreshFailure: {
        gap: theme.space.s6,
        alignItems: 'flex-start',
    },
}));
