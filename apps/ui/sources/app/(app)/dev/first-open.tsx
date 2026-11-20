import React from 'react';
import { Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { useLocalSearchParams } from 'expo-router';

import { GlyphSurface, type GlyphMotion } from '@/components/atmosphere/glyph/GlyphSurface';
import { createOpeningTimeline, openingSceneSeconds } from '@/components/onboarding/firstOpen/openingTimeline';
import { useIsTablet } from '@/utils/platform/responsive';

/** Displays the real scene in the current viewport without consuming this device's first open. */
export default function FirstOpenDevScreen() {
    const { width, height } = useWindowDimensions();
    const { theme } = useUnistyles();
    const { host, t } = useLocalSearchParams<{ host?: string; t?: string }>();
    const appearance = theme.dark ? 'dark' : 'light';
    const tablet = useIsTablet();
    const phone = host ? host === 'phone' : !tablet && Platform.OS !== 'web';
    const desktop = host === 'mac' || host === 'win' || host === 'linux';
    const frameTime = t === undefined ? null : Number(t);
    const held = frameTime !== null && Number.isFinite(frameTime);
    const scene = React.useMemo(() => {
        // Preview the lab's window inside its work area. The real desktop host supplies its frame.
        const previewWidth = Math.min(1180, Math.round(width * 0.82));
        const previewHeight = Math.min(760, Math.round(height * 0.84));
        const windowRect = desktop ? {
            x: Math.round((width - previewWidth) / 2),
            y: Math.round((height - previewHeight) * 0.42),
            width: previewWidth,
            height: previewHeight,
        } : undefined;
        return createOpeningTimeline({ width, height, phone, theme: appearance, windowRect });
    }, [width, height, phone, appearance, desktop]);
    // A held frame is the transition already past its end, so every layer samples the same clock time.
    const heldMotion = React.useMemo<GlyphMotion>(() => (held
        ? { kind: 'transition', epoch: 0, durationS: Math.min(openingSceneSeconds, Math.max(0, frameTime)) }
        : null), [held, frameTime]);
    const [ready, setReady] = React.useState(false);
    const [motion, setMotion] = React.useState<GlyphMotion>(null);
    const play = React.useCallback(() => {
        setMotion({ kind: 'transition', epoch: performance.now(), durationS: openingSceneSeconds });
    }, []);
    return (
        <View style={[styles.page, { backgroundColor: theme.colors.surface.base }]}>
            <GlyphSurface width={width} height={height} scene={scene} motion={held ? heldMotion : motion}
                onReady={status => setReady(status === 'ready')} />
            {!held ? <Pressable disabled={!ready} accessibilityRole="button" onPress={play} style={styles.replay}>
                <Text style={{ color: theme.colors.text.primary }}>Play opening</Text>
            </Pressable> : null}
        </View>
    );
}

const styles = StyleSheet.create({
    page: { flex: 1, overflow: 'hidden' },
    replay: { position: 'absolute', top: 16, left: 16, paddingHorizontal: 16, paddingVertical: 12 },
});
