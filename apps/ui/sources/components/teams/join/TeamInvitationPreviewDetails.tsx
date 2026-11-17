import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { TeamInvitationPreviewV1 } from '@happier-dev/protocol/teams';

import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { teamRoleDescription, teamRoleLabel } from '@/components/settings/teams/teamLabels';
import { Icon } from '@/components/ui/icons/Icon';
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
    const { theme } = useUnistyles();

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

    // The inviter, the Home and the expiry are said above (the heading and its facts line), and the
    // masked recipient sits in the identity line beside the action; this block keeps what the role
    // means, what history comes with it, and the Home's own notices.
    const notices = [
        preview.home.hosting === 'personal' ? t('teams.join.personalHomeNotice') : null,
        preview.home.storageMode === 'plain' ? t('teams.join.plainStorageNotice') : null,
    ].filter((line): line is string => line !== null);
    return (
        <View testID="team-join-preview" style={styles.block}>
            <Text testID="team-join-preview-role" variant="reading" style={styles.meaning}>
                {preview.role === 'guest'
                    ? t('teams.join.guestNotice', { team: preview.team.name })
                    : teamRoleDescription(preview.role)}
                {' '}
                <Text testID="team-join-preview-history" variant="reading" style={styles.meaning}>
                    {preview.historyAccess === 'all_existing'
                        ? t('teams.join.historyAllExisting')
                        : t('teams.join.historyFromJoining')}
                </Text>
            </Text>
            {notices.length > 0 ? (
                <View testID="team-join-preview-notice" style={styles.notice}>
                    <Icon name="info" size={14} color={theme.colors.text.secondary} />
                    <Text variant="body" style={styles.noticeText}>{notices.join(' ')}</Text>
                </View>
            ) : null}
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

/**
 * One line of facts under the invitation heading: the role offered, the Home it is on, and when the
 * invitation expires. Each fact comes from the bounded preview; the role leads because it is what
 * joining gives.
 */
export const TeamInvitationFactsLine = React.memo(function TeamInvitationFactsLine(props: Readonly<{
    preview: TeamInvitationPreviewV1;
    homeLabel: string;
}>) {
    const { preview } = props;
    return (
        <Text testID="team-join-preview-facts" variant="label" style={styles.facts}>
            <Text variant="label" emphasis="semiBold" style={styles.factsLead}>{teamRoleLabel(preview.role)}</Text>
            {FACT_SEPARATOR}
            {props.homeLabel}
            {FACT_SEPARATOR}
            <Text testID="team-join-preview-expiry" variant="label" style={styles.facts}>
                {t('teams.join.expiresShort', {
                    when: formatCalendarDate(preview.expiresAt, getPreferredLanguage()),
                })}
            </Text>
        </Text>
    );
});

const FACT_SEPARATOR = '  ·  ';

const styles = StyleSheet.create((theme) => ({
    block: {
        gap: theme.space.s12,
    },
    facts: {
        color: theme.colors.text.secondary,
    },
    factsLead: {
        color: theme.colors.text.primary,
    },
    meaning: {
        color: theme.colors.text.primary,
    },
    notice: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.space.s8,
    },
    noticeText: {
        flex: 1,
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
