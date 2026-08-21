import { router } from 'expo-router';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { announceAccessibilityMessage } from '@/components/ui/accessibility/announceAccessibilityMessage';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { CustomModalInjectedProps } from '@/modal';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';
import type {
    SessionForkNativeUnavailableReason,
    SessionForkStrategyAvailability,
} from '@/sync/domains/sessionFork/forkUiSupport';
import type { SessionForkOperationRoute } from '@/sync/domains/sessionFork/sessionForkStrategy';
import {
    useSessionForkStrategyFlow,
    type SessionForkStrategyRequest,
} from '@/sync/domains/sessionFork/useSessionForkStrategyFlow';

export const SESSION_FORK_STRATEGY_MODAL_TEST_ID = 'session-fork-strategy-modal';

const SOURCE_PREVIEW_MAX_CHARS = 120;

export type SessionForkStrategyModalProps = CustomModalInjectedProps & Readonly<{
    request: SessionForkStrategyRequest;
    availability: SessionForkStrategyAvailability;
    /** Short quotation of the message this fork branches from, when there is one. */
    sourcePreview?: string | null;
    navigate: (childSessionId: string, options?: Readonly<{ serverId?: string }>) => void | Promise<void>;
    /**
     * Leaves for the canonical New Session screen with this fork point attached,
     * or `null` when source-context continuation is not offered for this Session.
     */
    onConfigureNewSession: (() => void) | null;
}>;

/** Collapses and clamps a transcript quotation to one bounded body line. */
export function truncateForkSourcePreview(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const collapsed = value.replace(/\s+/g, ' ').trim();
    if (collapsed.length === 0) return null;
    if (collapsed.length <= SOURCE_PREVIEW_MAX_CHARS) return collapsed;
    return `${collapsed.slice(0, SOURCE_PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

const stylesheet = StyleSheet.create((theme) => ({
    body: {
        paddingHorizontal: 4,
        paddingBottom: 12,
        gap: 4,
    },
    sourcePreview: {
        marginHorizontal: 12,
        marginBottom: 8,
        paddingLeft: 10,
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.border.default,
    },
    sourcePreviewText: {
        ...Typography.default(),
        fontSize: 14,
        lineHeight: 20,
        color: theme.colors.text.secondary,
    },
    recommendedPill: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 999,
        backgroundColor: theme.colors.surface.inset,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    recommendedPillText: {
        ...Typography.default('semiBold'),
        fontSize: 11,
        color: theme.colors.text.secondary,
    },
    notice: {
        marginTop: 8,
        marginHorizontal: 12,
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
    },
    noticeCopy: {
        flex: 1,
        gap: 2,
    },
    noticeTitle: {
        ...Typography.default('semiBold'),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    noticeBody: {
        ...Typography.default(),
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
    noticeActions: {
        marginTop: 12,
        marginHorizontal: 12,
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
    // Tighter than `noticeActions` on purpose: this one is a footnote to the
    // group directly above it rather than the modal's closing action, so it sits
    // symmetrically between the two groups instead of hanging off the last one.
    replaySettingsAction: {
        marginTop: 4,
        marginBottom: 4,
        marginHorizontal: 12,
        flexDirection: 'row',
        justifyContent: 'flex-end',
    },
}));

/**
 * The one-line explanation a disabled Native card carries.
 *
 * An exhaustive switch over the closed reason set the availability owner
 * resolves — deliberately not a registry, a capability-explanation service or a
 * per-Agent copy catalog. Adding an Agent adds no copy here; adding a *reason*
 * is a compiler error until it has one.
 */
function resolveNativeUnavailableCopy(
    reason: SessionForkNativeUnavailableReason | null,
): string | null {
    switch (reason) {
        case 'agent_unsupported':
            return t('session.forking.strategy.unavailable.nativeAgent');
        case 'agent_conversation_only':
            return t('session.forking.strategy.unavailable.nativeFromMessage');
        case null:
            return null;
    }
}

export function SessionForkStrategyModal(props: SessionForkStrategyModalProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const flow = useSessionForkStrategyFlow({
        request: props.request,
        navigate: props.navigate,
        onNavigated: props.onClose,
    });
    const { phase, failure } = flow;

    const { onClose, onConfigureNewSession } = props;
    const handleConfigureNewSession = React.useCallback(() => {
        if (!onConfigureNewSession) return;
        // New Session owns its own create/send progress from here on, so this
        // surface leaves rather than showing a second progress story.
        onClose();
        onConfigureNewSession();
    }, [onClose, onConfigureNewSession]);

    const busyRoute = phase.type === 'submitting'
        ? phase.route
        : phase.type === 'opening' && !phase.stalled
            ? phase.route
            : null;
    // Every choice is inert while an effect is in flight, and once the outcome is
    // unknown the fork must not be reissued at all: a second attempt is exactly
    // how a duplicate provider-side fork gets created.
    const choicesDisabled = flow.isBusy || phase.type === 'unknown' || phase.type === 'opening' || phase.type === 'navigated';

    const submit = React.useCallback((route: SessionForkOperationRoute) => {
        fireAndForget(flow.submit(route), { tag: 'SessionForkStrategyModal.submit' });
    }, [flow]);

    const { native: nativeAvailable, replay: replayAvailable } = props.availability;
    const bothSameEngineRoutes = nativeAvailable && replayAvailable;

    // An unavailable route is shown disabled with the reason in place of its
    // fidelity line, never omitted: a card that vanishes teaches the reader
    // nothing, and on an Agent with no native fork and Replay off it used to
    // take the whole fork affordance down with it.
    const nativeSubtitle = nativeAvailable
        ? t('session.forking.strategy.native.subtitle')
        : resolveNativeUnavailableCopy(props.availability.nativeUnavailableReason)
            ?? t('session.forking.strategy.native.subtitle');
    const replaySubtitle = replayAvailable
        ? t('session.forking.strategy.replay.subtitle')
        : t('session.forking.strategy.unavailable.replayOff');

    // Replay has exactly one closable cause, and it is the reader's own setting.
    // Settings owns that toggle, so this leaves for it rather than growing a
    // second place to flip it.
    const handleOpenReplaySettings = React.useCallback(() => {
        onClose();
        router.push('/(app)/settings/session/resume');
    }, [onClose]);

    const recommendedPill = (
        <View style={styles.recommendedPill}>
            <Text style={styles.recommendedPillText}>{t('session.forking.strategy.recommended')}</Text>
        </View>
    );

    // The quotation identifies the branch point, but it is user content of
    // unbounded length. The card's shared subtitle has no line clamp, so at 200%
    // dynamic type an unclamped quotation there pushes every strategy below the
    // fold. It lives in the body, collapsed and clamped, instead.
    const sourcePreview = truncateForkSourcePreview(props.sourcePreview);

    const statusLine = resolveStatusLine(phase);

    // A live region on the visible node is Android/web only, so on iOS the
    // states a blind user most needs — an effect in flight, a definite failure,
    // an unconfirmed outcome — would be silent. Route every transition through
    // the one canonical announcer instead of publishing a second, partial
    // announcement channel next to it.
    const failureAnnouncement = failure && phase.type === 'choosing'
        ? (failure.kind === 'update_required'
            ? t('session.forking.strategy.failure.updateRequired')
            : failure.message ?? t('session.forking.strategy.failure.generic'))
        : null;
    const announcement = failureAnnouncement
        ?? (statusLine ? [statusLine.title, statusLine.body].filter(Boolean).join('. ') : null);
    React.useEffect(() => {
        if (!announcement) return;
        announceAccessibilityMessage(announcement);
    }, [announcement]);

    return (
        <View style={styles.body} testID={`${SESSION_FORK_STRATEGY_MODAL_TEST_ID}-body`}>
            {/* The group needs no heading of its own: the card chrome already
                carries `session.forking.strategy.title` as the modal title. */}
            {sourcePreview ? (
                <View style={styles.sourcePreview}>
                    <Text
                        testID="session-fork-strategy-source-preview"
                        style={styles.sourcePreviewText}
                        numberOfLines={2}
                    >
                        {sourcePreview}
                    </Text>
                </View>
            ) : null}

            <ItemGroup>
                <Item
                    testID="session-fork-strategy-native"
                    title={t('session.forking.strategy.native.title')}
                    subtitle={nativeSubtitle}
                    subtitleLines={0}
                    icon={<Icon name="git-branch" size={20} color={theme.colors.text.secondary} />}
                    rightElement={bothSameEngineRoutes ? recommendedPill : undefined}
                    keepChevronWithRightElement
                    // The chevron is the promise of forward motion, so only a
                    // route that can actually be taken keeps one.
                    showChevron={nativeAvailable}
                    loading={busyRoute === 'native'}
                    disabled={!nativeAvailable || (choicesDisabled && busyRoute !== 'native')}
                    onPress={() => submit('native')}
                />
                <Item
                    testID="session-fork-strategy-replay"
                    title={t('session.forking.strategy.replay.title')}
                    subtitle={replaySubtitle}
                    subtitleLines={0}
                    icon={<Icon name="clock-counter-clockwise" size={20} color={theme.colors.text.secondary} />}
                    showChevron={replayAvailable}
                    loading={busyRoute === 'replay'}
                    disabled={!replayAvailable || (choicesDisabled && busyRoute !== 'replay')}
                    onPress={() => submit('replay')}
                />
            </ItemGroup>

            {!replayAvailable ? (
                <View style={styles.replaySettingsAction}>
                    <RoundButton
                        size="small"
                        display="inverted"
                        testID="session-fork-strategy-replay-settings"
                        title={t('session.forking.strategy.unavailable.replaySettingsAction')}
                        disabled={choicesDisabled}
                        onPress={handleOpenReplaySettings}
                    />
                </View>
            ) : null}

            {onConfigureNewSession ? (
                <ItemGroup>
                    <Item
                        testID="session-fork-strategy-configure"
                        title={t('session.forking.strategy.configure.title')}
                        subtitle={t('session.forking.strategy.configure.subtitle')}
                        subtitleLines={0}
                        icon={<Icon name="sliders-horizontal" size={20} color={theme.colors.text.secondary} />}
                        disabled={choicesDisabled}
                        onPress={handleConfigureNewSession}
                    />
                </ItemGroup>
            ) : null}

            {failure && phase.type === 'choosing' ? (
                <View style={styles.notice} testID="session-fork-strategy-failure">
                    <Icon name="warning" size={16} color={theme.colors.state.danger.foreground} />
                    <View style={styles.noticeCopy}>
                        <Text style={styles.noticeBody}>
                            {failure.kind === 'update_required'
                                ? t('session.forking.strategy.failure.updateRequired')
                                : failure.message ?? t('session.forking.strategy.failure.generic')}
                        </Text>
                    </View>
                </View>
            ) : null}

            {statusLine ? (
                <View style={styles.notice} testID="session-fork-strategy-status">
                    {statusLine.tone === 'warning' ? (
                        <Icon name="warning" size={16} color={theme.colors.state.warning.foreground} />
                    ) : null}
                    <View style={styles.noticeCopy}>
                        {statusLine.title ? (
                            <Text style={styles.noticeTitle}>{statusLine.title}</Text>
                        ) : null}
                        <Text style={styles.noticeBody}>{statusLine.body}</Text>
                    </View>
                </View>
            ) : null}

            {phase.type === 'unknown' ? (
                <View style={styles.noticeActions}>
                    <RoundButton
                        size="small"
                        testID="session-fork-strategy-check"
                        title={t('session.forking.strategy.unknown.checkAction')}
                        loading={phase.checking}
                        disabled={phase.checking}
                        onPress={() => fireAndForget(flow.checkForFork(), {
                            tag: 'SessionForkStrategyModal.checkForFork',
                        })}
                    />
                </View>
            ) : null}

            {phase.type === 'opening' && phase.stalled ? (
                <View style={styles.noticeActions}>
                    <RoundButton
                        size="small"
                        testID="session-fork-strategy-open"
                        title={t('session.forking.strategy.progress.openAction')}
                        onPress={() => fireAndForget(flow.retryOpen(), {
                            tag: 'SessionForkStrategyModal.retryOpen',
                        })}
                    />
                </View>
            ) : null}
        </View>
    );
}

type StatusLine = Readonly<{ tone: 'progress' | 'warning'; title: string | null; body: string }>;

/**
 * Every line here names a locally observable milestone — the request promise or
 * real child hydration. There is no percentage and no internal daemon phase,
 * because the client cannot know either.
 */
function resolveStatusLine(
    phase: ReturnType<typeof useSessionForkStrategyFlow>['phase'],
): StatusLine | null {
    switch (phase.type) {
        case 'choosing':
        case 'navigated':
            return null;
        case 'submitting':
            return {
                tone: 'progress',
                title: null,
                body: phase.route === 'native'
                    ? t('session.forking.strategy.progress.creatingNative')
                    : t('session.forking.strategy.progress.creatingReplay'),
            };
        case 'opening':
            return phase.stalled
                ? {
                    tone: 'warning',
                    title: t('session.forking.strategy.progress.stalledTitle'),
                    body: t('session.forking.strategy.progress.stalledBody'),
                }
                : { tone: 'progress', title: null, body: t('session.forking.strategy.progress.opening') };
        case 'unknown': {
            if (phase.checking) {
                return { tone: 'warning', title: null, body: t('session.forking.strategy.unknown.checking') };
            }
            if (phase.lastCheck === 'ambiguous') {
                return {
                    tone: 'warning',
                    title: t('session.forking.strategy.unknown.title'),
                    body: t('session.forking.strategy.unknown.ambiguous'),
                };
            }
            if (phase.lastCheck === 'none') {
                return {
                    tone: 'warning',
                    title: t('session.forking.strategy.unknown.title'),
                    body: t('session.forking.strategy.unknown.noneFound'),
                };
            }
            return {
                tone: 'warning',
                title: t('session.forking.strategy.unknown.title'),
                body: t('session.forking.strategy.unknown.body'),
            };
        }
    }
}

export default SessionForkStrategyModal;
