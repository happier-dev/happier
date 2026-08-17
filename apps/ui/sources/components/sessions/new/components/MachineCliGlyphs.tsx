import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { Modal } from '@/modal';
import { useDaemonScopedMachineCapabilitiesCache } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { DetectedClisModal } from '@/components/machines/DetectedClisModal';
import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { buildProviderCliCapabilityId } from '@/capabilities/cliCapabilityId';
import type { AgentId } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { getAgentPickerIconScale } from '@/agents/registry/registryUi';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { Text } from '@/components/ui/text/Text';
import { resolveMachineCliLogoDisplay } from './machineCliLogoDisplay';


type Props = {
    machineId: string;
    isOnline: boolean;
    serverId?: string | null;
    /**
     * When true, the component may trigger capabilities detection fetches.
     * When false, it will render cached results only (no automatic fetching).
     */
    autoDetect?: boolean;
};

// Small, monochrome provider marks — recognizable at a glance without widening the row.
const CLI_LOGO_SIZE = 16;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        paddingHorizontal: 4,
        paddingVertical: 2,
        borderRadius: 6,
    },
    logoSlot: {
        width: CLI_LOGO_SIZE,
        height: CLI_LOGO_SIZE,
        alignItems: 'center',
        justifyContent: 'center',
    },
    overflow: {
        color: theme.colors.text.secondary,
        fontSize: 11,
        ...Typography.default('semiBold'),
    },
    placeholder: {
        color: theme.colors.text.secondary,
        opacity: 0.35,
        ...Typography.default(),
    },
}));

function readCliAvailable(data: unknown): boolean {
    return Boolean(data && typeof data === 'object' && !Array.isArray(data) && (data as { available?: unknown }).available === true);
}

export const MachineCliGlyphs = React.memo(({ machineId, isOnline, serverId, autoDetect = true }: Props) => {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const enabledAgents = useEnabledAgentIds();

    // The daemon-scoped cache owns the machine subscription (narrow + reference-stable). Reading
    // the whole machine record here as well would re-render every picker row on every heartbeat.
    const { state } = useDaemonScopedMachineCapabilitiesCache({
        machineId,
        serverId,
        enabled: autoDetect && isOnline,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
    });

    const onPress = React.useCallback(() => {
        // Cache-first: opening this modal should NOT fetch by default.
        // Users can explicitly refresh inside the modal if needed.
        Modal.show({
            component: DetectedClisModal,
            props: {
                machineId,
                isOnline,
                serverId,
            },
        });
    }, [isOnline, machineId, serverId]);

    // Agents whose CLI is detected as available on this machine, in enabled-agent order.
    const availableAgentIds = React.useMemo<ReadonlyArray<AgentId>>(() => {
        if (state.status !== 'loaded') return [];
        const ids: AgentId[] = [];
        const results = state.snapshot.response.results;
        for (const agentId of enabledAgents) {
            const result = results[buildProviderCliCapabilityId(agentId)];
            if (result?.ok === true && readCliAvailable(result.data)) {
                ids.push(agentId);
            }
        }
        return ids;
    }, [enabledAgents, state]);

    const display = React.useMemo(() => resolveMachineCliLogoDisplay(availableAgentIds), [availableAgentIds]);
    const isLoading = state.status !== 'loaded';

    return (
        <Pressable
            onPress={onPress}
            style={({ pressed }) => [
                styles.container,
                { opacity: !isOnline ? 0.5 : (pressed ? 0.7 : 1) },
            ]}
        >
            {isLoading || availableAgentIds.length === 0 ? (
                <Text style={styles.placeholder}>•</Text>
            ) : (
                <>
                    {display.visible.map((agentId) => (
                        <View key={agentId} style={styles.logoSlot}>
                            <AgentIcon
                                agentId={agentId}
                                size={CLI_LOGO_SIZE}
                                color={theme.colors.text.secondary}
                                style={{ transform: [{ scale: getAgentPickerIconScale(agentId) }] }}
                                testID={`machine-cli-logo:${agentId}`}
                            />
                        </View>
                    ))}
                    {display.overflow > 0 ? (
                        <Text style={styles.overflow}>{`+${display.overflow}`}</Text>
                    ) : null}
                </>
            )}
        </Pressable>
    );
});
