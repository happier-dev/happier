import * as React from 'react';
import { View, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

export type ScrollEdgeIndicatorVisibility = Readonly<{
    top?: boolean;
    bottom?: boolean;
    left?: boolean;
    right?: boolean;
}>;

export function ScrollEdgeIndicators(props: {
    edges: ScrollEdgeIndicatorVisibility;
    color: string;
    size?: number;
    opacity?: number;
    topStyle?: ViewStyle;
    bottomStyle?: ViewStyle;
    leftStyle?: ViewStyle;
    rightStyle?: ViewStyle;
}) {
    const edges = props.edges;
    const size = typeof props.size === 'number' ? props.size : 14;
    const opacity = typeof props.opacity === 'number' ? props.opacity : 0.35;

    if (!edges.top && !edges.bottom && !edges.left && !edges.right) return null;

    const renderIndicatorIcon = React.useCallback((name: React.ComponentProps<typeof Ionicons>['name']) => {
        return normalizeNodeForView(<Ionicons name={name} size={size} color={props.color} />);
    }, [props.color, size]);

    return (
        <>
            {edges.top ? (
                <View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            top: 6,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            zIndex: 20,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.topStyle,
                    ]}
                >
                    {renderIndicatorIcon('chevron-up')}
                </View>
            ) : null}

            {edges.bottom ? (
                <View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            bottom: 6,
                            left: 0,
                            right: 0,
                            alignItems: 'center',
                            zIndex: 20,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.bottomStyle,
                    ]}
                >
                    {renderIndicatorIcon('chevron-down')}
                </View>
            ) : null}

            {edges.left ? (
                <View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            left: 0,
                            top: 0,
                            bottom: 0,
                            justifyContent: 'center',
                            zIndex: 20,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.leftStyle,
                    ]}
                >
                    <View style={{ width: '100%', alignItems: 'center' }}>
                        {renderIndicatorIcon('chevron-back')}
                    </View>
                </View>
            ) : null}

            {edges.right ? (
                <View
                    pointerEvents="none"
                    style={[
                        {
                            position: 'absolute',
                            right: 0,
                            top: 0,
                            bottom: 0,
                            justifyContent: 'center',
                            zIndex: 20,
                            opacity,
                            pointerEvents: 'none',
                        },
                        props.rightStyle,
                    ]}
                >
                    <View style={{ width: '100%', alignItems: 'center' }}>
                        {renderIndicatorIcon('chevron-forward')}
                    </View>
                </View>
            ) : null}
        </>
    );
}
