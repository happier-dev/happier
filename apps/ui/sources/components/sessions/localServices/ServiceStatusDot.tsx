import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import type { ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';

/**
 * Liveness tone for a service row's status dot. `live` pulses; everything else
 * renders static so the pulse only fires "when truly live".
 */
type ServiceLiveness = 'live' | 'idle' | 'gone';

const DOT_SIZE = 8;
const HALO_SIZE = 16;

const stylesheet = StyleSheet.create(() => ({
    halo: {
        width: HALO_SIZE,
        height: HALO_SIZE,
        borderRadius: HALO_SIZE / 2,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));

/**
 * The dot's tone is a projection of the row's canonical status — never a second reading of the raw
 * `LocalServiceLaunchTarget['state']` (SB-F).
 *
 * `resolveStatus` in the row model is the one owner that turns the daemon's launch-target state into
 * a service status; the dot, the pill and the accessibility label are three renderings of that one
 * decision. Taking `ServiceRowStatus` here is what makes the split unrepresentable: the raw state's
 * `'available'` is not a member of this union, so re-pointing the caller back at `target.state` does
 * not compile.
 */
function serviceLiveness(status: ServiceRowStatus): ServiceLiveness {
    switch (status) {
        case 'running':
        case 'starting':
            return 'live';
        case 'stale':
            return 'idle';
        case 'stopped':
        case 'unavailable':
            return 'gone';
    }
}

function useServiceStatusToneColor(liveness: ServiceLiveness): Readonly<{ dot: string; halo: string }> {
    const { theme } = useUnistyles();
    switch (liveness) {
        // Soft success-tinted halo from the themed success background token (robust to
        // user theme customization — no hand-rolled alpha concatenation).
        case 'live':
            return { dot: theme.colors.state.success.foreground, halo: theme.colors.state.success.background };
        case 'gone':
            return { dot: theme.colors.text.tertiary, halo: 'transparent' };
        case 'idle':
            return { dot: theme.colors.state.neutral.foreground, halo: 'transparent' };
    }
}

export function ServiceStatusDot(props: Readonly<{
    status: ServiceRowStatus;
    animationEnabled?: boolean;
    testID: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const liveness = serviceLiveness(props.status);
    const color = useServiceStatusToneColor(liveness);
    const isLive = liveness === 'live';
    return (
        <View
            testID={`${props.testID}-halo`}
            style={[styles.halo, { backgroundColor: isLive ? color.halo : 'transparent' }]}
        >
            <StatusDot
                testID={props.testID}
                color={color.dot}
                size={DOT_SIZE}
                isPulsing={isLive}
                animationEnabled={props.animationEnabled !== false}
                accessibilityLabel={props.accessibilityLabel}
            />
        </View>
    );
}
