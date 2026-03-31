import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/registry/registryCore';

export type ProvidersLogoMultiSelectProps = Readonly<{
    testID: string;
    providerIds: readonly AgentId[];
    selectedProviderIds: readonly AgentId[];
    onToggleProvider: (providerId: AgentId) => void;
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
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface,
    },
    tileSelected: {
        borderColor: theme.colors.accent.blue,
        backgroundColor: theme.colors.surfacePressedOverlay,
    },
}));

export const ProvidersLogoMultiSelect = React.memo(function ProvidersLogoMultiSelect(props: ProvidersLogoMultiSelectProps) {
    useUnistyles();
    const styles = stylesheet;

    const selected = React.useMemo(() => new Set(props.selectedProviderIds), [props.selectedProviderIds]);

    return (
        <View testID={props.testID} style={styles.root}>
            {props.providerIds.map((providerId) => {
                const isSelected = selected.has(providerId);
                return (
                    <Pressable
                        key={providerId}
                        testID={`${props.testID}-provider-${providerId}`}
                        accessibilityRole="button"
                        onPress={() => props.onToggleProvider(providerId)}
                        style={[styles.tile, isSelected ? styles.tileSelected : null]}
                    >
                        <AgentIcon agentId={providerId} size={22} />
                    </Pressable>
                );
            })}
        </View>
    );
});

