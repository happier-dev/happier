import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { StatusDot } from '@/components/ui/status/StatusDot';
import { VoiceMarkArt } from '@/components/voice/presence/VoiceMark';
import { VoiceStatusCell } from '@/components/voice/presence/VoiceStatusCell';

/**
 * How a Voice pipeline (or one of its steps) stands. `ready` is Light, `waiting` is Shadow (waiting
 * on something outside: a computer offline, a server feature off), `working` is the 2×4 dot cell
 * (a real install or check), `needs_you` is the settings attention dot and `blocked` its danger tone.
 * `unknown` (not checked yet) draws nothing: it is neither ready nor a problem.
 *
 * The planet is the presence mark's own art held still (no atmosphere, no clock); the cell is the
 * presence status cell, which steps only while its fact is true and holds still under reduced motion.
 */
export type VoiceReadinessTone = 'ready' | 'needs_you' | 'waiting' | 'working' | 'blocked' | 'unknown';

const GLYPH_PX = 14;

export const VoiceReadinessGlyph = React.memo(function VoiceReadinessGlyph(props: Readonly<{ tone: VoiceReadinessTone }>) {
    const { theme } = useUnistyles();
    switch (props.tone) {
        case 'unknown':
            return null;
        case 'ready':
            return <View style={styles.box}><VoiceMarkArt pose="ready" size={GLYPH_PX} still /></View>;
        case 'waiting':
            return <View style={styles.box}><VoiceMarkArt pose="shadow" size={GLYPH_PX} still /></View>;
        case 'working':
            return <View style={styles.box}><VoiceStatusCell kind="working" size={GLYPH_PX} /></View>;
        case 'blocked':
            return <View style={styles.dotBox}><StatusDot color={theme.colors.state.danger.foreground} size={6} /></View>;
        case 'needs_you':
        default:
            return <View style={styles.dotBox}><StatusDot color={theme.colors.state.warning.foreground} size={6} /></View>;
    }
});

const styles = StyleSheet.create({
    box: {
        width: GLYPH_PX,
        height: GLYPH_PX,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    dotBox: {
        width: 8,
        height: GLYPH_PX,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
});
