import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Icon } from '@/components/ui/icons/Icon';
import { WordCrossFade } from '@/components/ui/motion/WordCrossFade';
import { StatusDot } from '@/components/ui/status/StatusDot';
import { Text } from '@/components/ui/text/Text';
import { formatPlaybackTime } from '@/components/workspaces/files/file/filePageMediaFacts';

const DOT = { capsule: 8, control: 10 } as const;
const GLYPH_BOX = 14;

/**
 * "● 0:42": the one read-out of a running recording, in the browser's chrome capsule and in the screen
 * recording's control. The dot is steady (no decorative loop); pausing swaps it for the pause glyph.
 * The caller's leaf owns the ticking, so the second hand never re-renders anything around it.
 */
export function RecordingElapsed(props: Readonly<{
    seconds: number;
    paused?: boolean;
    size: keyof typeof DOT;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const paused = props.paused === true;
    const large = props.size === 'control';
    return (
        <View style={styles.row}>
            <WordCrossFade wordKey={paused ? 'paused' : 'running'} style={styles.mark}>
                {paused
                    ? <Icon name="pause" weight="fill" size={GLYPH_BOX} color={theme.colors.text.secondary} />
                    : <View style={large ? styles.halo : null}><StatusDot color={theme.colors.state.danger.foreground} size={DOT[props.size]} /></View>}
            </WordCrossFade>
            <Text
                variant={large ? 'label' : 'meta'}
                emphasis={large ? 'semiBold' : undefined}
                style={[styles.time, large ? styles.timeLarge : null]}
            >
                {formatPlaybackTime(props.seconds)}
            </Text>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    mark: {
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: GLYPH_BOX,
    },
    /** Lab `rc` BAR: the dot stands in a soft ring of its own colour, and never pulses. */
    halo: {
        borderRadius: DOT.control,
        boxShadow: `0 0 0 4px ${theme.colors.state.danger.background}`,
    },
    time: {
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    timeLarge: {
        minWidth: 40,
    },
}));
