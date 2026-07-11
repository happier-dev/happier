import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import type { LocalServiceInventoryRow } from '@/sync/domains/local/services/inventory/store';
import type { LocalServiceLaunchTarget } from '@/sync/domains/local/services/launch';
import type { ManagedLocalServiceRow as ManagedLocalServiceStoreRow } from '@/sync/domains/local/services/managed/store';

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

function inventoryLiveness(state: LocalServiceInventoryRow['state']): ServiceLiveness {
    switch (state) {
        case 'listening':
            return 'live';
        case 'gone':
            return 'gone';
        case 'stale':
        case 'unknown':
            return 'idle';
    }
}

function managedLiveness(phase: ManagedLocalServiceStoreRow['phase']): ServiceLiveness {
    switch (phase) {
        case 'running':
        case 'detecting':
        case 'starting':
            return 'live';
        case 'stopped':
        case 'failed':
            return 'gone';
        case 'unhealthy':
        case 'stopping':
            return 'idle';
    }
}

function launchTargetLiveness(state: LocalServiceLaunchTarget['state']): ServiceLiveness {
    switch (state) {
        case 'available':
        case 'starting':
            return 'live';
        case 'stale':
            return 'idle';
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

function ServiceStatusDotInner(props: Readonly<{
    liveness: ServiceLiveness;
    animationEnabled: boolean;
    testID: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    const styles = stylesheet;
    const color = useServiceStatusToneColor(props.liveness);
    const isLive = props.liveness === 'live';
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
                animationEnabled={props.animationEnabled}
                accessibilityLabel={props.accessibilityLabel}
            />
        </View>
    );
}

export function DetectedServiceStatusDot(props: Readonly<{
    state: LocalServiceInventoryRow['state'];
    animationEnabled?: boolean;
    testID: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    return (
        <ServiceStatusDotInner
            liveness={inventoryLiveness(props.state)}
            animationEnabled={props.animationEnabled !== false}
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
}

export function ManagedServiceStatusDot(props: Readonly<{
    phase: ManagedLocalServiceStoreRow['phase'];
    animationEnabled?: boolean;
    testID: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    return (
        <ServiceStatusDotInner
            liveness={managedLiveness(props.phase)}
            animationEnabled={props.animationEnabled !== false}
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
}

export function LaunchTargetStatusDot(props: Readonly<{
    state: LocalServiceLaunchTarget['state'];
    animationEnabled?: boolean;
    testID: string;
    accessibilityLabel?: string;
}>): React.ReactElement {
    return (
        <ServiceStatusDotInner
            liveness={launchTargetLiveness(props.state)}
            animationEnabled={props.animationEnabled !== false}
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
        />
    );
}
