import React from 'react';
import { View, ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { isProfileCompatibleWithBackendTarget, type AIBackendProfile } from '@/sync/domains/profiles/profileCompatibility';
import { getResolvedBackendCatalogEntries } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { getAgentCliGlyph, getAgentCore } from '@/agents/catalog/catalog';
import { useEnabledAgentIds } from '@/agents/hooks/useEnabledAgentIds';
import { Text } from '@/components/ui/text/Text';
import { useSetting } from '@/sync/domains/state/storage';


type Props = {
    profile: Pick<AIBackendProfile, 'compatibility' | 'compatibilityByTargetKey' | 'isBuiltIn'>;
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
    const enabledAgentIds = useEnabledAgentIds();
    const acpCatalogSettingsV1 = useSetting('acpCatalogSettingsV1');
    const backendEnabledByTargetKey = useSetting('backendEnabledByTargetKey');
    const backendEntries = React.useMemo(() => {
        return getResolvedBackendCatalogEntries({
            enabledAgentIds,
            acpCatalogSettingsV1: acpCatalogSettingsV1 as any,
            backendEnabledByTargetKey: backendEnabledByTargetKey as Record<string, boolean> | undefined,
        });
    }, [acpCatalogSettingsV1, backendEnabledByTargetKey, enabledAgentIds]);

    const glyphs = React.useMemo(() => {
        const items: Array<{ key: string; glyph: string; factor: number }> = [];
        for (const entry of backendEntries) {
            if (!isProfileCompatibleWithBackendTarget(profile, entry.target)) continue;
            const core = getAgentCore(entry.iconAgentId);
            items.push({
                key: entry.targetKey,
                glyph: getAgentCliGlyph(entry.iconAgentId),
                factor: core.ui.profileCompatibilityGlyphScale ?? 1.0,
            });
        }
        if (items.length === 0) items.push({ key: 'none', glyph: '•', factor: 0.85 });
        return items;
    }, [backendEntries, profile]);

    const visibleGlyphs = React.useMemo(() => {
        if (glyphs.length <= 2) return glyphs;
        return [
            ...glyphs.slice(0, 2),
            { key: 'more', glyph: '...', factor: 0.75 },
        ];
    }, [glyphs]);

    const multiScale = visibleGlyphs.length === 1 ? 1 : visibleGlyphs.length === 2 ? 0.6 : 0.5;

    return (
        <View style={[styles.container, { width: size, height: size }, style]}>
            {visibleGlyphs.length === 1 ? (
                <Text style={[styles.glyph, { fontSize: Math.round(size * visibleGlyphs[0].factor) }]}>
                    {visibleGlyphs[0].glyph}
                </Text>
            ) : (
                <View style={styles.stack}>
                    {visibleGlyphs.map((item) => {
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
