import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    isSidechainHydrationPendingStatus,
    type SidechainHydrationStatus,
} from '@/hooks/session/useEnsureSidechainsLoaded';

/**
 * Decides whether a sidechain tool surface should render an inline hydration status.
 *
 * A status is shown only for an empty transcript with a resolved sidechain id, and only while
 * hydration is either still pending (loading/in_flight/retrying) or has terminally failed
 * (not_ready/error). It is intentionally hidden for `idle` (not requested) and `loaded` (including
 * a loaded-but-empty sidechain, which is valid) so an empty subagent never spins forever.
 */
export function shouldShowSidechainHydrationInlineStatus(params: Readonly<{
    messageCount: number;
    sidechainId: string | null;
    status: SidechainHydrationStatus;
}>): boolean {
    if (!params.sidechainId) return false;
    if (params.messageCount > 0) return false;
    return params.status !== 'idle' && params.status !== 'loaded';
}

/**
 * Shared inline status for sidechain (subagent transcript) tool surfaces. Shows a loader while
 * hydration is pending and a terminal "unavailable" affordance on error/not_ready instead of failing
 * silent. Reuses the app design system (themed `Text`, `ActivitySpinner`, theme tokens) — no
 * hardcoded colors.
 */
export function SidechainHydrationInlineStatus(props: Readonly<{
    status: SidechainHydrationStatus;
    testID: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const isPending = isSidechainHydrationPendingStatus(props.status);
    return (
        <View testID={props.testID} style={styles.container}>
            {isPending ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : null}
            <Text style={styles.text}>
                {isPending ? t('common.loading') : t('common.unavailable')}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    container: {
        minHeight: 28,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingVertical: 4,
    },
    text: {
        color: theme.colors.text.secondary,
    },
}));
