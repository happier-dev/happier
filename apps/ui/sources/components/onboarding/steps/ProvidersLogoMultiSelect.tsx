import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/registry/registryCore';

export type ProvidersLogoMultiSelectEntry = Readonly<{
    providerId: string;
    iconAgentId?: AgentId | null;
    setupProviderId?: AgentId | null;
    iconName?: string | null;
}>;

export type ProvidersLogoMultiSelectProps = Readonly<{
    testID: string;
    providerIds?: readonly string[];
    providerEntries?: readonly ProvidersLogoMultiSelectEntry[];
    selectedProviderIds: readonly string[];
    onToggleProvider: { bivarianceHack(providerId: string): void }['bivarianceHack'];
}>;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        width: '100%',
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'center',
        gap: 10,
    },
    tile: {
        width: 46,
        height: 46,
        borderRadius: 14,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    },
    tileSelected: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
}));

export const ProvidersLogoMultiSelect = React.memo(function ProvidersLogoMultiSelect(props: ProvidersLogoMultiSelectProps) {
    useUnistyles();
    const styles = stylesheet;
    const visibleProviderEntries = React.useMemo(
        () => {
            if (props.providerEntries) {
                return props.providerEntries;
            }
            return (props.providerIds?.map((providerId) => ({
                providerId,
                iconAgentId: providerId as AgentId,
                setupProviderId: providerId as AgentId,
                iconName: 'layers-outline',
            })) ?? []);
        },
        [props.providerEntries, props.providerIds],
    );

    const selected = React.useMemo(
        () => new Set(props.selectedProviderIds),
        [props.selectedProviderIds],
    );

    return (
        <View testID={props.testID} style={styles.root}>
            {visibleProviderEntries.map((entry) => {
                const isSelected = selected.has(entry.providerId);
                return (
                    <Pressable
                        key={entry.providerId}
                        testID={`${props.testID}-provider-${entry.providerId}`}
                        accessibilityRole="button"
                        onPress={() => props.onToggleProvider(entry.providerId)}
                        style={[styles.tile, isSelected ? styles.tileSelected : null]}
                    >
                        {entry.iconAgentId ? (
                            <AgentIcon agentId={entry.iconAgentId} size={22} />
                        ) : (
                            <Ionicons name={(entry.iconName ?? 'layers-outline') as any} size={22} />
                        )}
                    </Pressable>
                );
            })}
        </View>
    );
});
