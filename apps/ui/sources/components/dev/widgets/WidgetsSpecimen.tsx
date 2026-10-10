import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { ADD_SPECIMEN_FRAMES } from './addSpecimens';
import { AREA_SPECIMEN_FRAMES } from './areaSpecimens';
import { DATA_SPECIMEN_FRAMES } from './dataSpecimens';
import { FRAME_SPECIMEN_FRAMES } from './frameSpecimens';
import { GLANCE_SPECIMEN_FRAMES } from './glanceSpecimens';
import { CUSTOMIZE_SPECIMEN_FRAMES } from './customizeSpecimens';
import { GROUP_SPECIMEN_FRAMES } from './groupSpecimens';
import { LAYOUT_SPECIMEN_FRAMES } from './layoutSpecimens';
import { SETUP_SPECIMEN_FRAMES } from './setupSpecimens';
import type { WidgetSpecimenFrames } from './widgetSpecimenTypes';

/**
 * Dev-only fixtures for the widgets lab (`cwidgets`): the real frame, add popover, glances and states
 * at static props on the lab's session, so the build can be paired against the lab frames without a
 * live session on the QA account. Each part owns its own frames module.
 */

const stylesheet = StyleSheet.create((theme) => ({
    page: { flex: 1, backgroundColor: theme.colors.background.canvas },
    pageContent: { padding: 24, gap: 24, flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start' },
    pageOnly: { padding: 0 },
    frame: { gap: 8 },
    caption: { ...Typography.default('semiBold'), fontSize: 12, color: theme.colors.text.tertiary },
}));

export function WidgetsSpecimen(props: Readonly<{ only: string | null; phone: boolean }>) {
    useUnistyles();
    const frames: WidgetSpecimenFrames = {
        ...FRAME_SPECIMEN_FRAMES,
        ...ADD_SPECIMEN_FRAMES,
        ...GLANCE_SPECIMEN_FRAMES,
        ...SETUP_SPECIMEN_FRAMES,
        ...DATA_SPECIMEN_FRAMES,
        ...GROUP_SPECIMEN_FRAMES,
        ...LAYOUT_SPECIMEN_FRAMES,
        ...CUSTOMIZE_SPECIMEN_FRAMES,
    };
    const ids = props.only ? [props.only] : Object.keys(frames);
    return (
        <ScrollView
            style={stylesheet.page}
            contentContainerStyle={[stylesheet.pageContent, props.only ? stylesheet.pageOnly : null]}
        >
            {ids.map((id) => {
                const render = frames[id];
                return (
                    <View key={id} style={stylesheet.frame} testID={`widgets-specimen-${id}`}>
                        {props.only ? null : <Text style={stylesheet.caption}>{id}</Text>}
                        {render ? render({ phone: props.phone }) : null}
                    </View>
                );
            })}
        </ScrollView>
    );
}
