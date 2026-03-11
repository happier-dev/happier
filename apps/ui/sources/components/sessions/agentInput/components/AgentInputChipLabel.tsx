import * as React from 'react';

import { Text } from '@/components/ui/text/Text';

export const AgentInputChipLabel = React.memo(function AgentInputChipLabel(props: Readonly<{
    label: string;
    count?: number | null;
    textStyle?: any;
    countTextStyle?: any;
}>) {
    const hasCount = typeof props.count === 'number' && Number.isFinite(props.count) && props.count > 0;

    return (
        <Text numberOfLines={1} style={props.textStyle}>
            {props.label}
            {hasCount ? (
                <Text style={props.countTextStyle}>
                    {` (${props.count})`}
                </Text>
            ) : null}
        </Text>
    );
});
