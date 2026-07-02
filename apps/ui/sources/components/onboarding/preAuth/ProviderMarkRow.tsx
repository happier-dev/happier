import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { AGENT_IDS } from '@/agents/catalog/catalog';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { t } from '@/text';

import { BRAND_PANE_FOREGROUND_MUTED } from '../unauthShell/brandPaneTokens';

export type ProviderMarkRowProps = Readonly<{
    /**
     * Visual tone of the marks.
     * - 'on-dark' (default): muted brand-pane foreground (white-ish, low opacity).
     *   Use on the unauth left brand pane and the mobile brand hero.
     * - 'on-light': theme `text.secondary` with reduced opacity. Use on any
     *   future on-light placement.
     */
    tone?: 'on-dark' | 'on-light';
    /** Glyph size in pixels. Default 18. */
    size?: number;
    /** Row alignment. Default 'flex-start' (desktop); use 'center' for mobile hero. */
    justify?: 'flex-start' | 'center';
    /** Override the root testID. Default 'provider-mark-row'. */
    testID?: string;
}>;

/**
 * Quiet, monochrome horizontal row of supported AI coding agent marks.
 *
 * Replaces the previous animated 2-row `WelcomeProvidersShowcase`. No animation;
 * each mark is rendered via the canonical `AgentIcon` from `@/agents/registry`,
 * with a single tint derived from `tone`. Wraps to additional rows only when
 * the container is too narrow to fit all `AGENT_IDS` in one line.
 */
export const ProviderMarkRow = React.memo(function ProviderMarkRow(props: ProviderMarkRowProps) {
    const { theme } = useUnistyles();
    const tone: 'on-dark' | 'on-light' = props.tone ?? 'on-dark';
    const size = props.size ?? 18;
    const justify: 'flex-start' | 'center' = props.justify ?? 'flex-start';

    const tintColor = tone === 'on-dark'
        ? BRAND_PANE_FOREGROUND_MUTED
        : theme.colors.text.secondary;

    // 'on-dark' already encodes opacity in the rgba; 'on-light' fades the cell
    // wrapper so the theme.secondary token stays legible without becoming bold.
    const cellOpacity = tone === 'on-dark' ? 1 : 0.65;

    return (
        <View
            style={[styles.root, { justifyContent: justify }]}
            testID={props.testID ?? 'provider-mark-row'}
            accessibilityRole="image"
            accessibilityLabel={t('welcome.providerMarkRowAccessibilityLabel')}
        >
            {AGENT_IDS.map((agentId) => (
                <View
                    key={agentId}
                    style={[styles.cell, { opacity: cellOpacity }]}
                    testID={`provider-mark-${agentId}`}
                >
                    <AgentIcon agentId={agentId} size={size} color={tintColor} />
                </View>
            ))}
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    root: {
        flexDirection: 'row',
        // Force one-line layout: a lone overflow logo wrapping to a second
        // row reads as a layout bug rather than as inclusive coverage. Any
        // logos past the available width are clipped silently — the user
        // still gets a clear "lots of providers supported" signal from the
        // first row, and we never show a lonely second row.
        flexWrap: 'nowrap',
        overflow: 'hidden',
        alignItems: 'center',
        gap: 14,
    },
    cell: {
        alignItems: 'center',
        justifyContent: 'center',
        // Each cell keeps its intrinsic width — no shrink, no growth — so a
        // partial last cell gets cleanly cut off at the container's edge
        // rather than squeezing all icons unevenly.
        flexShrink: 0,
        flexGrow: 0,
    },
}));
