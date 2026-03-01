import React from 'react';
import { View, Text, ScrollView, Dimensions, Platform, PixelRatio } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack } from 'expo-router';
import { Typography } from '@/constants/Typography';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import Constants from 'expo-constants';
import { useIsTablet, getDeviceType, calculateDeviceDimensions, useHeaderHeight } from '@/utils/platform/responsive';
import { layout } from '@/components/ui/layout/layout';
import { isRunningOnMac } from '@/utils/platform/platform';

export default function DeviceInfo() {
    const insets = useSafeAreaInsets();
    const { width, height } = Dimensions.get('window');
    const screenDimensions = Dimensions.get('screen');
    const pixelDensity = PixelRatio.get();
    const isTablet = useIsTablet();
    const deviceType = getDeviceType();
    const headerHeight = useHeaderHeight();
    const isRunningOnMacCatalyst = isRunningOnMac();
    const isPad = Platform.OS === 'ios' && (Platform as any).isPad === true;
    
    const dimensions = calculateDeviceDimensions({
        widthPoints: screenDimensions.width,
        heightPoints: screenDimensions.height,
    });

    const screenOptions = React.useMemo(() => {
        return {
            title: 'Device Info',
            headerLargeTitle: false,
        } as const;
    }, []);
    
    return (
        <>
            <Stack.Screen
                options={screenOptions}
            />
            <ItemList>
                <ItemGroup title="Safe Area Insets">
                    <Item
                        title="Top"
                        detail={`${insets.top}px`}
                    />
                    <Item
                        title="Bottom"
                        detail={`${insets.bottom}px`}
                    />
                    <Item
                        title="Left"
                        detail={`${insets.left}px`}
                    />
                    <Item
                        title="Right"
                        detail={`${insets.right}px`}
                    />
                </ItemGroup>

                <ItemGroup title="Device Detection">
                    <Item
                        title="Device Type"
                        detail={deviceType === 'tablet' ? 'Tablet' : 'Phone'}
                    />
                    <Item
                        title="Detection Method"
                        detail={isPad ? 'iOS isPad' : `minEdge>=600 (${dimensions.minEdgePoints}px)`}
                    />
                    <Item
                        title="Mac Catalyst"
                        detail={isRunningOnMacCatalyst ? 'Yes' : 'No'}
                    />
                    <Item
                        title="Header Height"
                        detail={`${headerHeight} points`}
                    />
                    <Item
                        title="Min Edge"
                        detail={`${dimensions.minEdgePoints}px`}
                    />
                    <Item
                        title="Max Edge"
                        detail={`${dimensions.maxEdgePoints}px`}
                    />
                    <Item
                        title="Diagonal (points)"
                        detail={`${dimensions.diagonalPoints.toFixed(2)}`}
                    />
                    <Item
                        title="Pixel Density"
                        detail={`${pixelDensity}x`}
                    />
                    <Item
                        title="Layout Max Width"
                        detail={`${layout.maxWidth}px`}
                    />
                </ItemGroup>

                <ItemGroup title="Screen Dimensions">
                    <Item
                        title="Window Width"
                        detail={`${width} points`}
                    />
                    <Item
                        title="Window Height"
                        detail={`${height} points`}
                    />
                    <Item
                        title="Screen Width"
                        detail={`${screenDimensions.width} points`}
                    />
                    <Item
                        title="Screen Height"
                        detail={`${screenDimensions.height} points`}
                    />
                    <Item
                        title="Physical Pixels (width)"
                        detail={`${Math.round(screenDimensions.width * pixelDensity)}px`}
                    />
                    <Item
                        title="Physical Pixels (height)"
                        detail={`${Math.round(screenDimensions.height * pixelDensity)}px`}
                    />
                    <Item
                        title="Aspect Ratio"
                        detail={`${(height / width).toFixed(3)}`}
                    />
                </ItemGroup>

                <ItemGroup title="Platform Info">
                    <Item
                        title="Platform"
                        detail={Platform.OS}
                    />
                    <Item
                        title="Version"
                        detail={Platform.Version?.toString() || 'N/A'}
                    />
                    {Platform.OS === 'ios' && (
                        <>
                            <Item
                                title="iOS Interface"
                                detail={isPad ? 'iPad' : 'iPhone'}
                            />
                            <Item
                                title="iOS Version"
                                detail={Platform.Version?.toString() || 'N/A'}
                            />
                        </>
                    )}
                    {Platform.OS === 'android' && (
                        <Item
                            title="API Level"
                            detail={Platform.Version?.toString() || 'N/A'}
                        />
                    )}
                </ItemGroup>

                <ItemGroup title="App Info">
                    <Item
                        title="App Version"
                        detail={Constants.expoConfig?.version || 'N/A'}
                    />
                    <Item
                        title="SDK Version"
                        detail={Constants.expoConfig?.sdkVersion || 'N/A'}
                    />
                    <Item
                        title="Build Number"
                        detail={Constants.expoConfig?.ios?.buildNumber || Constants.expoConfig?.android?.versionCode?.toString() || 'N/A'}
                    />
                </ItemGroup>
            </ItemList>
        </>
    );
}
