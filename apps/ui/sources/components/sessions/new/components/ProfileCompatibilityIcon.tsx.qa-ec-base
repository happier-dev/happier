import React from 'react';
import { useAcpCatalog } from '@/sync/store/useAcpCatalog';
import { View, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getResolvedBackendCatalogEntries, type ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCore } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { isLegacyCompatAgentType } from '@/agents/backendCatalog/legacyCompatAgents';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';
import { Icon } from '@/components/ui/icons/Icon';


type Props = {
    profile: Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'>;
    backendEntries?: readonly ResolvedBackendCatalogEntry[] | null;
    size?: number;
    style?: ViewStyle;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    stack: {
        flexDirection: 'row',
        flexWrap: 'wrap',
        alignItems: 'center',
        alignContent: 'center',
        justifyContent: 'center',
        gap: 0,
    },
    cell: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    glyph: {
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
}));

export function ProfileCompatibilityIcon({ profile, backendEntries: backendEntriesOverride, size = 32, style }: Props) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const enabledAgentIds = useEnabledAgentIds();
    const { snapshot: acpCatalog } = useAcpCatalog();
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const backendEntries = React.useMemo(() => {
        if (Array.isArray(backendEntriesOverride)) {
            return backendEntriesOverride;
        }
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSnapshot: acpCatalog?.catalog,
            backendEnabledByTargetKey: backendEnabledByTargetKey as Record<string, boolean> | undefined,
        });
    }, [acpCatalog, backendEnabledByTargetKey, backendEntriesOverride, enabledAgentIds]);

    const glyphs = React.useMemo(() => {
        const items: Array<{ key: string; agentId: string | null; glyph: string }> = [];
        for (const entry of backendEntries) {
            if (!isProfileCompatibleWithBackendTarget(profile, entry.backendTarget)) continue;
            const displayAgentId = entry.agentCatalogEntry.isBuiltIn
                ? (entry.iconAgentId ?? entry.catalogAgentId ?? entry.builtInAgentId)
                : null;
            const core = displayAgentId ? getAgentCore(displayAgentId) : null;
            if (!displayAgentId || !core || isLegacyCompatAgentType(displayAgentId)) {
                items.push({
                    key: entry.backendTargetKey,
                    agentId: null,
                    glyph: '•',
                });
                continue;
            }
            items.push({
                key: entry.backendTargetKey,
                agentId: displayAgentId,
                glyph: '',
            });
        }
        if (items.length === 0) items.push({ key: 'none', agentId: null, glyph: '•' });
        return items;
    }, [backendEntries, profile]);

    // Compatibility is described beside the profile. A broad profile gets one recognizable
    // configuration mark instead of shrinking Agent identities and an ellipsis into one slot.
    if (glyphs.length > 2) {
        return <Icon name="sliders-horizontal" size={size} color={theme.colors.text.secondary} style={style} />;
    }
    const cellSize = glyphs.length === 1 ? size : size / 2;

    return (
        <View style={[styles.container, { width: size, height: size }, style]}>
            <View style={[styles.stack, { width: size, height: size }]}>
                {glyphs.map((item) => (
                    <View key={item.key} style={[styles.cell, {
                        width: cellSize, height: cellSize,
                    }]}>
                        {item.agentId ? (
                            <AgentIcon agentId={item.agentId} size={cellSize} color={theme.colors.text.secondary} />
                        ) : (
                            <Text style={[styles.glyph, { fontSize: cellSize, lineHeight: cellSize }]}>
                                {item.glyph}
                            </Text>
                        )}
                    </View>
                ))}
            </View>
        </View>
    );
}
