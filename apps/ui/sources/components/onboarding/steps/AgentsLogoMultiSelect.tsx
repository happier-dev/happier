import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { getAgentIconSource, getAgentIconSvgXml } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import type { AgentId } from '@/agents/registry/registryCore';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Icon } from '@/components/ui/icons/Icon';

export type AgentsLogoMultiSelectEntry = Readonly<{
    agentId: string;
    icon?: React.ReactNode;
    iconAgentId?: AgentId | null;
    setupAgentId?: AgentId | null;
    iconName?: string | null;
}>;

export type AgentsLogoMultiSelectProps = Readonly<{
    testID: string;
    agentIds?: readonly string[];
    agentEntries?: readonly AgentsLogoMultiSelectEntry[];
    selectedAgentIds: readonly string[];
    /**
     * Providers detected as already installed/ready (D22): they render with a
     * green readiness dot, present as selected, and are locked — tapping them
     * never toggles them off. Readiness truth stays with `useProviderReadiness`
     * at the call site; this is presentation only.
     */
    readyAgentIds?: readonly string[];
    onToggleAgent: { bivarianceHack(agentId: string): void }['bivarianceHack'];
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
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    readyDot: {
        position: 'absolute',
        top: -3,
        right: -3,
        borderWidth: 1.5,
        borderColor: theme.colors.surface.base,
    },
}));

export const AgentsLogoMultiSelect = React.memo(function AgentsLogoMultiSelect(props: AgentsLogoMultiSelectProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const visibleProviderEntries = React.useMemo(
        () => {
            const entries = props.agentEntries ?? (props.agentIds?.map((agentId) => ({
                agentId,
                iconAgentId: agentId as AgentId,
                setupAgentId: agentId as AgentId,
                iconName: 'stack-simple',
            })) ?? []);
            // A logo tile carries no name text, so an agent whose icon cannot resolve
            // would render an empty placeholder tile — skip those entries entirely.
            return entries.filter((entry) => {
                if (entry.icon) return true;
                if (!entry.iconAgentId) return Boolean(entry.iconName);
                return getAgentIconSvgXml(entry.iconAgentId, theme) != null
                    || getAgentIconSource(entry.iconAgentId) != null;
            });
        },
        [props.agentEntries, props.agentIds, theme],
    );

    const selected = React.useMemo(
        () => new Set(props.selectedAgentIds),
        [props.selectedAgentIds],
    );
    const ready = React.useMemo(
        () => new Set(props.readyAgentIds ?? []),
        [props.readyAgentIds],
    );

    return (
        <View testID={props.testID} style={styles.root}>
            {visibleProviderEntries.map((entry) => {
                const isReady = ready.has(entry.agentId);
                const isSelected = isReady || selected.has(entry.agentId);
                return (
                    <Pressable
                        key={entry.agentId}
                        testID={`${props.testID}-provider-${entry.agentId}`}
                        accessibilityRole="button"
                        accessibilityState={isReady ? { selected: true, disabled: true } : { selected: isSelected }}
                        onPress={() => {
                            // Locked-selected: detected providers can never be toggled off.
                            if (isReady) return;
                            props.onToggleAgent(entry.agentId);
                        }}
                        style={[styles.tile, isSelected ? styles.tileSelected : null]}
                    >
                        {entry.icon ?? (entry.iconAgentId ? (
                            <AgentIcon agentId={entry.iconAgentId} size={22} />
                        ) : (
                            <Icon
                                name={(entry.iconName ?? 'stack-simple') as any}
                                size={20}
                                color={isSelected ? theme.colors.text.primary : theme.colors.text.secondary}
                            />
                        ))}
                        {isReady ? (
                            <StatusDot
                                testID={`${props.testID}-provider-${entry.agentId}-ready-dot`}
                                color={theme.colors.state.success.foreground}
                                size={7}
                                style={styles.readyDot}
                            />
                        ) : null}
                    </Pressable>
                );
            })}
        </View>
    );
});
