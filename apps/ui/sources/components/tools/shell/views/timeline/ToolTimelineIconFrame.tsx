import * as React from 'react';
import { View } from 'react-native';

type IconLikeProps = {
    size?: number;
};

function normalizeIconNode(icon: React.ReactNode): React.ReactNode {
    if (!React.isValidElement(icon)) {
        return icon;
    }

    const props = icon.props as IconLikeProps | null;
    if (!props || typeof props.size !== 'number' || !Number.isFinite(props.size)) {
        return icon;
    }

    const normalizedSize = Math.min(16, Math.max(14, Math.trunc(props.size)));
    if (normalizedSize === props.size) {
        return icon;
    }

    return React.cloneElement(icon, {
        size: normalizedSize,
    } as Partial<IconLikeProps>);
}

export const ToolTimelineIconFrame = React.memo(function ToolTimelineIconFrame(props: {
    icon: React.ReactNode;
}) {
    return (
        <View style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
            {normalizeIconNode(props.icon)}
        </View>
    );
});
