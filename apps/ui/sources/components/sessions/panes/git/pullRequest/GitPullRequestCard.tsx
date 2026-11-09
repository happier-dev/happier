import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ScmPullRequestChecksState, ScmPullRequestState } from '@happier-dev/protocol/scm/pullRequests';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedMotionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { motionTokens } from '@/components/ui/motion';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useClipboardWrite } from '@/hooks/ui/useClipboardWrite';
import { useOpenResource } from '@/utils/url/openResource';
import { t } from '@/text';

import { GitPullRequestProviderMark } from './GitPullRequestProviderMark';

export type GitPullRequestCardModel = Readonly<{
    number: number | null;
    url: string;
    title: string;
    base: string | null;
    state: ScmPullRequestState;
    /** The provider's aggregate check state; the snapshot carries one summary, not individual runs. */
    checks: ScmPullRequestChecksState | null;
    providerKind: string | null;
    providerName: string;
}>;

/**
 * The pull request this branch has (Git lab PR, round 3 "PR created"): its provider, number, state and base, the
 * title, the checks summary and the two things to do with it. It arrives with a short rise-and-fade when it has
 * just been created (`animateIn`), and without motion when the pane opens on it.
 */
export const GitPullRequestCard = React.memo(function GitPullRequestCard(props: Readonly<{
    model: GitPullRequestCardModel;
    animateIn?: boolean;
    sessionId?: string;
    serverId?: string;
}>) {
    const { theme } = useUnistyles();
    const { model } = props;
    const { openResource } = useOpenResource({ sessionId: props.sessionId, serverId: props.serverId });
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(props.animateIn ? 0 : 1);
    React.useEffect(() => {
        if (!props.animateIn) return;
        progress.value = withTiming(1, {
            duration: reducedMotion ? motionTokens.inPlaceMorph.reducedCrossFadeMs : reanimatedMotionTokens.durationMs.slow,
            easing: reanimatedMotionTokens.easing.standard,
        });
    }, [progress, props.animateIn, reducedMotion]);
    const enterStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: reducedMotion ? [] : [{ translateY: (1 - progress.value) * 6 }],
    }));
    const [copied, setCopied] = React.useState(false);
    const writeClipboard = useClipboardWrite();
    const copy = React.useCallback(() => {
        void writeClipboard(model.url).then((ok) => setCopied(ok));
    }, [model.url, writeClipboard]);
    const stateLabel = t(`sessionGitPullRequest.card.state.${model.state}` as const);
    const checksColor = model.checks === 'success'
        ? theme.colors.state.success.foreground
        : model.checks === 'failure'
            ? theme.colors.state.danger.foreground
            : model.checks === 'pending'
                ? theme.colors.state.warning.foreground
                : theme.colors.text.tertiary;
    return (
        <Animated.View testID="git-pull-request-card" accessibilityLiveRegion={props.animateIn ? 'polite' : 'none'} style={[styles.card, enterStyle]}>
            <View style={styles.row}>
                <GitPullRequestProviderMark kind={model.providerKind} size={16} />
                {model.number !== null ? (
                    <Text style={styles.number}>{t('sessionGitPullRequest.card.number', { number: model.number })}</Text>
                ) : null}
                <Text numberOfLines={1} style={styles.meta}>
                    {[stateLabel, model.base ? t('sessionGitPullRequest.card.intoBase', { base: model.base }) : null].filter(Boolean).join(' · ')}
                </Text>
            </View>
            {model.title ? <Text numberOfLines={2} style={styles.title}>{model.title}</Text> : null}
            {model.checks ? (
                <View testID={`git-pull-request-card-checks:${model.checks}`} style={styles.row}>
                    <StatusDot color={checksColor} size={8} />
                    <Text style={styles.meta}>{t(`sessionGitPullRequest.card.checks.${model.checks}` as const)}</Text>
                </View>
            ) : null}
            <View style={styles.actions}>
                <ToolbarButton
                    testID="git-pull-request-card-open"
                    label={t('common.open')}
                    icon={<Icon name="arrow-square-out" size={14} color={theme.colors.text.secondary} />}
                    onPress={() => {
                        void openResource({ kind: 'pullRequest', url: model.url });
                    }}
                />
                <ToolbarButton
                    testID="git-pull-request-card-copy"
                    label={copied ? t('sessionGitPullRequest.card.copied') : t('sessionGitPullRequest.card.copyLink')}
                    icon={<Icon name={copied ? 'check' : 'link'} size={14} color={theme.colors.text.secondary} />}
                    onPress={copy}
                />
            </View>
        </Animated.View>
    );
});

const styles = StyleSheet.create((theme) => ({
    card: {
        marginHorizontal: theme.space.s12,
        marginTop: theme.space.s8,
        marginBottom: theme.space.s4,
        padding: theme.space.s12,
        gap: theme.space.s8,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, minWidth: 0 },
    number: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary, fontVariant: ['tabular-nums'],  },
    meta: { flexShrink: 1, ...Typography.variant('meta'), color: theme.colors.text.secondary,  },
    title: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.primary,  },
    actions: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8, flexWrap: 'wrap' },
}));
