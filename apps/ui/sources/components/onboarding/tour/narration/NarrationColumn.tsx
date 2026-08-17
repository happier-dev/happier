import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    SlideTransitionSwitch,
} from '@/components/ui/motion/SlideTransitionSwitch';
import type { SlideTransitionDirection } from '@/components/ui/motion';

import type { JourneyBeat } from '../state/journeyBeats';
import { NarrationBeat } from './NarrationBeat';

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

    // The column owns the pane transition; the beat owns its own word-reveal
    // timing (see `NARRATION_TITLE_REVEAL_DELAY_MS`). A JS visibility flag used
    // to live here, and while it was closed every headline word sat at opacity 0
    // with nothing scheduled to reveal it — a headline whose failure state is
    // "absent". The hold now lives inside the reveal animation instead.
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
                    testID={`${testID}-beat`}
                />
            </SlideTransitionSwitch>
        </View>
    );
}
