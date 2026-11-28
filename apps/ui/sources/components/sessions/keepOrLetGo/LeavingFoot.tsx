import * as React from 'react';
import { View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconAction } from '@/components/ui/buttons/IconAction';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { reanimatedMotionTokens as motionTokens } from '@/components/ui/motion/reanimatedMotionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useServerFeaturesRuntimeSnapshot } from '@/sync/domains/features/featureDecisionRuntime';
import { writeLeavingFootDismissal } from '@/sync/domains/session/retention/leavingFootDismissal';
import { useLeavingSessionsValue } from '@/sync/domains/session/retention/leavingSessionsResource';
import { getServerProfileById, isHappierCloudServerUrl } from '@/sync/domains/server/serverProfiles';
import { useLocalSetting } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { openExternalUrl } from '@/utils/url/openExternalUrl';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { formatLeavingDate, movedSessionsTabLabel } from './keepOrLetGoCopy';
import { showKeepOrLetGoSheet, showLocalHistoryKeepOrLetGoSheet } from './KeepOrLetGoSheet';
import { useLeavingSessionsView } from './leavingSessionsView';
import { useLocalHistoryKeepSource } from './localHistoryKeepSource';

/**
 * The session list foot (plan 04 F8, F8b), mounted below the list, never inside it.
 *
 * - Leaving: "4 sessions leaving · the cloud from 31 Dec" → Review opens Keep or let go.
 * - Policy: while the server's retention start date is ahead, one calm sentence saying what will
 *   happen, with Learn more. It reads `startsAt` from the features payload the app already holds.
 *
 * Either is dismissed on this device until a newer batch or a new start date. It follows the
 * server's retention config, not the plan gates: hiding prices must not hide a notice.
 */

/** Where the Cloud retention notice is stated: the Terms of Sale (owner, 2026-11-27; /open has no limits log). */
export const RETENTION_POLICY_URL = 'https://docs.happier.dev/legal/terms-of-sale';

type PolicyNotice = Readonly<{ startsAt: number; days: number }>;

const stylesheet = StyleSheet.create((theme) => ({
    well: {
        marginHorizontal: 12,
        marginTop: 8,
        marginBottom: 12,
        paddingVertical: 10,
        paddingLeft: 14,
        paddingRight: 8,
        borderRadius: 14,
        backgroundColor: theme.colors.surface.inset,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    policyWell: {
        alignItems: 'flex-start',
    },
    text: {
        flex: 1,
        minWidth: 0,
        gap: 2,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    detail: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    policyText: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    policyActions: {
        flexDirection: 'row',
        marginTop: 8,
    },
}));

function selectPolicyNotice(snapshot: ReturnType<typeof useServerFeaturesRuntimeSnapshot>, accountRetentionDays: number | undefined): PolicyNotice | null {
    if (snapshot.status !== 'ready') return null;
    const retention = snapshot.features.capabilities.server.retention;
    if (!retention?.enabled || retention.startsAt === undefined) return null;
    const days = accountRetentionDays ?? (retention.sessions.mode === 'delete_inactive' ? retention.sessions.inactivityDays : undefined);
    return days === undefined ? null : { startsAt: retention.startsAt, days };
}

function usePolicyNotice(): PolicyNotice | null {
    const snapshot = useServerFeaturesRuntimeSnapshot();
    const accountRetentionDays = useLeavingSessionsValue(entry => entry.data?.rule.retentionDays);
    const notice = selectPolicyNotice(snapshot, accountRetentionDays);
    const startsAt = notice?.startsAt;
    const days = notice?.days;
    return React.useMemo(
        () => (startsAt !== undefined && days !== undefined ? { startsAt, days } : null),
        [days, startsAt],
    );
}

/** Rises 8 px with a fade, once per batch (the caller keys it); a fade alone with reduced motion. */
function FootArrival(props: Readonly<{ children: React.ReactNode; style: React.ComponentProps<typeof View>['style']; testID: string }>) {
    const reducedMotion = useReducedMotionPreference();
    const progress = useSharedValue(0);
    React.useEffect(() => {
        progress.value = withTiming(1, { duration: motionTokens.durationMs.base, easing: motionTokens.easing.standard });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const animatedStyle = useAnimatedStyle(() => ({
        opacity: progress.value,
        transform: [{ translateY: reducedMotion ? 0 : (1 - progress.value) * 8 }],
    }));
    return (
        <Animated.View testID={props.testID} style={[props.style, animatedStyle]}>
            {props.children}
        </Animated.View>
    );
}

const LOCAL_HISTORY_SOURCE = { enabled: true } as const;

function LocalHistoryLeavingFoot() {
    const { items, failed, remove, retry } = useLocalHistoryKeepSource(LOCAL_HISTORY_SOURCE);
    if (items.length === 0 && !failed) return null;
    const first = items[0];
    const styles = stylesheet;
    return (
        <FootArrival testID="local-history-leaving-foot" style={styles.well}>
            <View style={styles.text}>
                <Text style={styles.title} numberOfLines={1}>
                    {first ? t('keepOrLetGo.localLeaving', { count: items.length }) : t('keepOrLetGo.loadFailed')}
                </Text>
                {first ? <Text style={styles.detail} numberOfLines={1}>{first.target.machineName}</Text> : null}
            </View>
            <RoundButton
                size="small"
                display="inverted"
                title={first ? t('keepOrLetGo.review') : t('common.retry')}
                onPress={first ? () => showLocalHistoryKeepOrLetGoSheet(items, remove) : retry}
                testID="local-history-leaving-foot-review"
            />
        </FootArrival>
    );
}

export const LeavingFoot = React.memo(function LeavingFoot() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const view = useLeavingSessionsView();
    const policy = usePolicyNotice();
    const cloudNoticeSettled = useLeavingSessionsValue((entry) => entry.status === 'ready' || entry.status === 'off' || entry.status === 'error');
    const activeServer = useActiveServerSnapshot();
    const dismissals = useLocalSetting('leavingFootDismissals');
    const serverId = view?.serverId ?? activeServer.serverId;
    const dismissal = dismissals[serverId];
    const nowMs = Date.now();

    const showLeaving = view !== null
        && !(dismissal?.leavingThrough !== undefined && dismissal.leavingThrough >= view.newestLeavesAt);
    const showPolicy = !showLeaving
        && policy !== null
        && policy.startsAt > nowMs
        && dismissal?.policyStartsAt !== policy.startsAt;

    const dismissLabel = t('keepOrLetGo.dismiss');
    const dismissIcon = <Icon name="x" size={14} color={theme.colors.text.secondary} />;

    if (showLeaving) {
        const newestLeavesAt = view.newestLeavesAt;
        return (
            <FootArrival key={`leaving:${newestLeavesAt}`} testID="leaving-foot" style={styles.well}>
                <View style={styles.text}>
                    <Text style={styles.title} numberOfLines={1}>
                        {t('keepOrLetGo.footLeavingTitle', { count: view.count })}
                    </Text>
                    <Text style={styles.detail} numberOfLines={1}>
                        {t('keepOrLetGo.footLeavingDetail', { date: formatLeavingDate(view.soonestLeavesAt, nowMs) })}
                    </Text>
                </View>
                <RoundButton
                    size="small"
                    display="inverted"
                    title={t('keepOrLetGo.review')}
                    onPress={showKeepOrLetGoSheet}
                    testID="leaving-foot-review"
                />
                <IconAction
                    size="sm"
                    hitSlop={8}
                    accessibilityLabel={dismissLabel}
                    onPress={() => writeLeavingFootDismissal(serverId, { leavingThrough: newestLeavesAt })}
                    testID="leaving-foot-dismiss"
                >
                    {dismissIcon}
                </IconAction>
            </FootArrival>
        );
    }

    if (showPolicy) {
        const startsAt = policy.startsAt;
        const isCloud = isHappierCloudServerUrl(activeServer.serverUrl);
        const serverName = isCloud ? 'Happier Cloud' : getServerProfileById(activeServer.serverId)?.name || activeServer.serverUrl;
        return (
            <FootArrival key={`policy:${startsAt}`} testID="leaving-foot-policy" style={[styles.well, styles.policyWell]}>
                <View style={styles.text}>
                    <Text style={styles.policyText}>
                        {t('keepOrLetGo.policyFoot', {
                            date: formatLeavingDate(startsAt, nowMs),
                            days: policy.days,
                            tab: movedSessionsTabLabel(),
                            serverName,
                        })}
                    </Text>
                    {isCloud ? <View style={styles.policyActions}>
                        <RoundButton
                            size="small"
                            display="inverted"
                            title={t('keepOrLetGo.learnMore')}
                            onPress={() => fireAndForget(openExternalUrl(RETENTION_POLICY_URL), { tag: 'LeavingFoot.learnMore' })}
                            testID="leaving-foot-learn-more"
                        />
                    </View> : null}
                </View>
                <IconAction
                    size="sm"
                    hitSlop={8}
                    accessibilityLabel={dismissLabel}
                    onPress={() => writeLeavingFootDismissal(serverId, { policyStartsAt: startsAt })}
                    testID="leaving-foot-policy-dismiss"
                >
                    {dismissIcon}
                </IconAction>
            </FootArrival>
        );
    }

    return cloudNoticeSettled ? <LocalHistoryLeavingFoot key={serverId} /> : null;
});
