import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { buildSessionDetailsHref } from '@/components/sessions/panes/url/sessionPaneUrlState';
import { useSessionTranscriptSource } from '@/components/sessions/transcript/source/SessionTranscriptSourceContext';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { requestFinishedReviewWalkthrough } from '@/sync/ops/reviews/reviewWalkthrough';
import { t } from '@/text';
import { StructuredFindText, useStructuredFindState } from '@/components/sessions/transcript/structured/structuredFindText';

/** Pending changes: the comparison a review that captured none (the default uncommitted scope) is read against. */
const PENDING_CHANGES = { kind: 'workingTree' } as const;

/**
 * "Walk me through this" on a finished review (Walkthrough lab WT5-R8, R8b, R8p). Asks the host for the
 * review's walkthrough through `review.walkthrough`, then opens it. Whether the reviewer's own Run
 * continues or one narrator writes from the findings is decided by the host from real Run affordances;
 * the line under the actions says which, from the same retention fact the review's follow-ups use.
 */
export function ReviewWalkMeThroughButton(props: Readonly<{
    sessionId: string;
    serverId: string | null;
    runId: string;
    reviewRunIds: readonly string[];
    comparisonId: string | null;
}>) {
    const { theme } = useUnistyles();
    const source = useSessionTranscriptSource();
    const find = useStructuredFindState();
    const cwd = source.useWorkspacePath();
    const navigate = source.navigate;
    const [busy, setBusy] = React.useState(false);
    const { sessionId, serverId, runId, reviewRunIds, comparisonId } = props;
    const walk = React.useCallback(async () => {
        if (!cwd || !navigate || busy) return;
        setBusy(true);
        const requested = await requestFinishedReviewWalkthrough({
            sessionId, serverId, cwd, runId, reviewRunIds, comparisonId, fallbackComparison: PENDING_CHANGES,
        }).catch((cause: unknown) => ({ ok: false as const, error: cause instanceof Error ? cause.message : t('common.requestFailed') }));
        setBusy(false);
        if (!requested.ok) {
            Modal.alert(t('reviewWalkthrough.finished.walkMeThrough'), requested.error);
            return;
        }
        navigate(buildSessionDetailsHref({
            sessionId, serverId,
            details: { kind: 'scmReview', comparison: requested.comparison, view: 'walkthrough' },
        }));
    }, [busy, comparisonId, cwd, navigate, reviewRunIds, runId, serverId, sessionId]);
    if (!cwd || !navigate) return null;
    return (
        <RoundButton
            testID="review-findings-walk-me-through"
            size="small"
            display="secondary"
            title={<StructuredFindText blockId="structured-review:walk" text={t('reviewWalkthrough.finished.walkMeThrough')} useDefaultTypography={false} />}
            titleNumberOfLines={find.revealBlockId === 'structured-review:walk' ? 'complete' : 1}
            leading={<Icon name="path" size={ICON_SIZE.xs} color={theme.colors.text.primary} />}
            loading={busy}
            disabled={busy}
            onPress={() => { void walk(); }}
        />
    );
}

/** The one honest line under a finished review's actions: continue the review Run, or narrate from its findings. */
export function ReviewWalkthroughEntryHint(props: Readonly<{ continues: boolean; findingsCount: number }>) {
    const { theme } = useUnistyles();
    return (
        <View testID="review-findings-walkthrough-hint" style={styles.hint}>
            <Icon name={props.continues ? 'arrow-elbow-down-right' : 'info'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
            <StructuredFindText blockId="structured-review:hint" text={props.continues ? t('reviewWalkthrough.finished.continues') : t('reviewWalkthrough.finished.narrates', { count: props.findingsCount })} style={styles.hintText} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    hint: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
    hintText: { flex: 1, fontSize: 13.5, lineHeight: 19, color: theme.colors.text.tertiary, ...Typography.default() },
}));
