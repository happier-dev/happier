import * as React from 'react';
import { View } from 'react-native';

/** The existing fixed metric band, independent of shared card identity and facts geometry. */
export const MACHINE_CARD_METRICS_HEIGHT_PX = 80;

/** Machine-owned metric content. Collection and WidgetFrame own every part of the surrounding card. */
export const MachineCardBody = React.memo(function MachineCardBody(props: Readonly<{
    tiles?: React.ReactNode;
    testID?: string;
}>) {
    return <View testID={props.testID} style={props.tiles === undefined ? undefined : metricsBandStyle}>{props.tiles}</View>;
});

const metricsBandStyle = { minHeight: MACHINE_CARD_METRICS_HEIGHT_PX };
