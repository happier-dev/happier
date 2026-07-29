import * as React from 'react';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import type { SimulatorPreviewDeviceOption } from '@/sync/domains/devices/simulator/types';

import { simulatorStreamStyles } from './styles';

function availabilityLabel(state: SimulatorPreviewDeviceOption['availability']['state']): string {
    switch (state) {
        case 'available':
            return t('simulatorPreview.availability.available');
        case 'degraded':
            return t('simulatorPreview.availability.degraded');
        case 'unavailable':
            return t('simulatorPreview.availability.unavailable');
    }
}

export function SimulatorDevicePicker(props: Readonly<{
    devices: readonly SimulatorPreviewDeviceOption[];
    selectedSimulatorId: string | null;
    onSelectDevice: (simulatorId: string) => void;
    testID: string;
}>): React.ReactElement {
    return (
        <View testID={props.testID} style={simulatorStreamStyles.picker}>
            <Text style={simulatorStreamStyles.titleText}>{t('simulatorPreview.picker.title')}</Text>
            {props.devices.length === 0 ? (
                <View testID={`${props.testID}-empty`} style={simulatorStreamStyles.pickerEmpty}>
                    <Text style={simulatorStreamStyles.metaText}>{t('simulatorPreview.picker.empty')}</Text>
                </View>
            ) : (
                <View style={simulatorStreamStyles.pickerList}>
                    {props.devices.map((device) => (
                        <Pressable
                            accessibilityRole="button"
                            accessibilityState={{ selected: device.selected }}
                            key={device.simulatorId}
                            onPress={() => props.onSelectDevice(device.simulatorId)}
                            style={[
                                simulatorStreamStyles.deviceOption,
                                device.selected ? simulatorStreamStyles.deviceOptionSelected : null,
                            ]}
                            testID={`${props.testID}-device:${device.simulatorId}`}
                        >
                            <Text style={simulatorStreamStyles.titleText}>{device.label}</Text>
                            <View style={simulatorStreamStyles.statusRow}>
                                <Text style={simulatorStreamStyles.metaText}>{device.platformLabel}</Text>
                                <View
                                    testID={`${props.testID}-device:${device.simulatorId}-${device.availability.state}`}
                                    style={simulatorStreamStyles.statusBadge}
                                >
                                    <Text style={simulatorStreamStyles.badgeText}>
                                        {availabilityLabel(device.availability.state)}
                                    </Text>
                                </View>
                            </View>
                        </Pressable>
                    ))}
                </View>
            )}
        </View>
    );
}
