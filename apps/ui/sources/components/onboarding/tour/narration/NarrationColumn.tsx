import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    SlideTransitionSwitch,
} from '@/components/ui/motion/SlideTransitionSwitch';
import type { SlideTransitionDirection } from '@/components/ui/motion';

import type { JourneyBeat } from '../state/journeyBeats';
import { stageVisualTokens } from '../stage/stageVisualTokens';
import { NarrationBeat } from './NarrationBeat';

/**
 * Delay after a beat change before the title word-reveal is allowed to start.
 * The narration beat cross-fades through the shared soft `SlideTransitionSwitch`;
 * gating the reveal on this settle window keeps the words from animating in while
 * the pane itself is still sliding/blurring in (D18 / spec §2). Tuned to sit just
 * past the soft transition's incoming glide.
 */
export const NARRATION_REVEAL_SETTLE_MS = stageVisualTokens.motion.skipTransitionMs;

export type NarrationColumnProps = Readonly<{
    beat: JourneyBeat;
    direction?: SlideTransitionDirection;
    reducedMotion?: boolean;
    testID?: string;
}>;

const stylesheet = StyleSheet.create(() => ({
    root: {
        width: '100%',
        minWidth: 0,
    },
    transition: {
        width: '100%',
    },
}));

export function NarrationColumn(props: NarrationColumnProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'journey-narration';
    const reducedMotion = props.reducedMotion === true;

    // Visibility gate for the title word-reveal. On every beat change the gate
    // closes, then re-opens once the pane has had the settle window to transition
    // in; reduced motion opens it synchronously.
    const [revealGate, setRevealGate] = React.useState(reducedMotion);
    React.useEffect(() => {
        if (reducedMotion) {
            setRevealGate(true);
            return;
        }
        setRevealGate(false);
        const handle = setTimeout(() => setRevealGate(true), NARRATION_REVEAL_SETTLE_MS);
        return () => clearTimeout(handle);
    }, [props.beat.id, reducedMotion]);

    return (
        <View testID={testID} style={styles.root}>
            <SlideTransitionSwitch
                contentKey={props.beat.id}
                direction={props.direction ?? 'replace'}
                preset="soft"
                blur
                reducedMotion={props.reducedMotion}
                style={styles.transition}
                testID={`${testID}-transition`}
            >
                <NarrationBeat
                    beat={props.beat}
                    reducedMotion={props.reducedMotion}
                    revealGate={revealGate}
                    testID={`${testID}-beat`}
                />
            </SlideTransitionSwitch>
        </View>
    );
}
