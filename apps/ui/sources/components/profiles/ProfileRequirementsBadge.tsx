import React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { t } from '@/text';
import { useProfileEnvRequirements } from '@/hooks/session/useProfileEnvRequirements';
import { hasRequiredSecret } from '@/sync/domains/profiles/profileSecrets';
import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierBadge, HappierPressable } from '@happier-dev/plugin-ui/presentation';


export interface ProfileRequirementsBadgeProps {
    profile: AIBackendProfile;
    machineId: string | null;
    /** Optional exact server context for the machine environment preflight. */
    serverId?: string | null;
    onPressIn?: () => void;
    onPress?: () => void;
    /**
     * Optional override when the API key requirement is satisfied via a saved/session key
     * (not the machine environment). Used by New Session flows.
     */
    overrideReady?: boolean;
    /**
     * Optional override for machine-env preflight readiness/loading.
     * When provided, this component will NOT run its own env preflight hook.
     */
    machineEnvOverride?: {
        isReady: boolean;
        isLoading: boolean;
    } | null;
}

export function ProfileRequirementsBadge(props: ProfileRequirementsBadgeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;

    const show = hasRequiredSecret(props.profile);
    const requirements = useProfileEnvRequirements(
        props.machineEnvOverride ? null : props.machineId,
        props.machineEnvOverride ? null : (show ? props.profile : null),
        props.serverId,
    );

    if (!show) {
        return null;
    }

    const machineIsReady = props.machineEnvOverride ? props.machineEnvOverride.isReady : requirements.isReady;
    const machineIsLoading = props.machineEnvOverride ? props.machineEnvOverride.isLoading : requirements.isLoading;

    const isReady = machineIsReady || props.overrideReady === true;
    const isLoading = machineIsLoading && !isReady;

    const statusColor = isLoading
        ? theme.colors.status.connecting
        : isReady
            ? theme.colors.status.connected
            : theme.colors.status.disconnected;

    const label = isReady
        ? t('secrets.badgeReady')
        : t('secrets.badgeRequired');

    const iconName = isLoading
        ? 'time-outline'
        : isReady
            ? 'checkmark-circle-outline'
            : 'key-outline';

    return (
        <HappierPressable
            accessibilityLabel={label}
            onPressIn={(e) => {
                e?.stopPropagation?.();
                props.onPressIn?.();
            }}
            onPress={() => {
                props.onPress?.();
            }}
            style={({ pressed }) => [
                {
                    opacity: pressed ? 0.85 : 1,
                },
            ]}
        >
            <HappierBadge
                color={statusColor}
                backgroundColor={theme.colors.surface.base}
                borderColor={statusColor}
                radius={999}
                horizontalPadding={10}
                verticalPadding={6}
            >
                <View style={styles.badgeRow}>
                    {normalizeNodeForView(<Icon name={iconName as any} size={14} color={statusColor} />)}
                    <Text style={[styles.badgeText, { color: statusColor }]} numberOfLines={1}>
                        {label}
                    </Text>
                </View>
            </HappierBadge>
        </HappierPressable>
    );
}


const stylesheet = StyleSheet.create((theme) => ({
    badgeRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    badgeText: {
        fontSize: 12,
        fontWeight: '600',
    },
}));
