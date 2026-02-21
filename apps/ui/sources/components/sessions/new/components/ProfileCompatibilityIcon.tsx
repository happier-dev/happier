import React from 'react';
import { View, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import type { AIBackendProfile } from '@/sync/domains/settings/settings';
import { isProfileCompatibleWithAgent } from '@/sync/domains/settings/settings';
import { getAgentCliGlyph, getAgentCore } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { Text } from '@/components/ui/text/Text';


type Props = {
    profile: Pick<AIBackendProfile, 'compatibility' | 'isBuiltIn'>;
    size?: number;
    style?: ViewStyle;
};

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        alignItems: 'center',
        justifyContent: 'center',
    },
    stack: {
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 0,
    },
    glyph: {
        color: theme.colors.textSecondary,
        ...Typography.default(),
    },
}));

export function ProfileCompatibilityIcon({ profile, size = 32, style }: Props) {
    useUnistyles(); // Subscribe to theme changes for re-render
    const styles = stylesheet;
    const enabledAgents = useEnabledAgentIds();

    const glyphs = React.useMemo(() => {
        const items: Array<{ key: string; glyph: string; factor: number }> = [];
        for (const agentId of enabledAgents) {
            if (!isProfileCompatibleWithAgent(profile, agentId)) continue;
            const core = getAgentCore(agentId);
            items.push({
                key: agentId,
                glyph: getAgentCliGlyph(agentId),
                factor: core.ui.profileCompatibilityGlyphScale ?? 1.0,
            });
        }
        if (items.length === 0) items.push({ key: 'none', glyph: '•', factor: 0.85 });
        return items;
    }, [enabledAgents, profile.compatibility]);

    const multiScale = glyphs.length === 1 ? 1 : glyphs.length === 2 ? 0.6 : 0.5;

    return (
        <View style={[styles.container, { width: size, height: size }, style]}>
            {glyphs.length === 1 ? (
                <Text style={[styles.glyph, { fontSize: Math.round(size * glyphs[0].factor) }]}>
                    {glyphs[0].glyph}
                </Text>
            ) : (
                <View style={styles.stack}>
                    {glyphs.map((item) => {
                        const fontSize = Math.round(size * multiScale * item.factor);
                        return (
                            <Text
                                key={item.key}
                                style={[
                                    styles.glyph,
                                    {
                                        fontSize,
                                        lineHeight: Math.max(10, Math.round(fontSize * 0.92)),
                                    },
                                ]}
                            >
                                {item.glyph}
                            </Text>
                        );
                    })}
                </View>
            )}
        </View>
    );
}
