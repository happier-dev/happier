import * as React from 'react';
import { ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import type { SimulatorPreviewDeviceOption } from '@/sync/domains/devices/simulator/types';
import { t } from '@/text';

import { simulatorStreamStyles } from './styles';

/** Healthy is quiet: only a device that needs attention says its availability. */
function availabilityDetail(state: SimulatorPreviewDeviceOption['availability']['state']): string | undefined {
    switch (state) {
        case 'available':
            return undefined;
        case 'degraded':
            return t('simulatorPreview.availability.degraded');
        case 'unavailable':
            return t('simulatorPreview.availability.unavailable');
    }
}

/**
 * Discovery: the simulators and emulators running on the Session's Machine, each named with its
 * platform, one press to open. With none running, one cause and the one thing to do about it.
 */
export function SimulatorDevicePicker(props: Readonly<{
    devices: readonly SimulatorPreviewDeviceOption[];
    selectedSimulatorId: string | null;
    onSelectDevice: (simulatorId: string) => void;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    if (props.devices.length === 0) {
        return (
            <ScrollView
                testID={props.testID}
                style={simulatorStreamStyles.stateStage}
                contentContainerStyle={simulatorStreamStyles.stateStageContent}
            >
                <SurfaceStateCard
                    testID={`${props.testID}-empty`}
                    kind="empty"
                    iconName="device-mobile"
                    title={t('simulatorPreview.viewer.emptyTitle')}
                    reason={t('simulatorPreview.viewer.emptyBody')}
                />
            </ScrollView>
        );
    }
    return (
        <ItemList testID={props.testID}>
            <ItemGroup
                title={t('simulatorPreview.viewer.discoveryTitle')}
                description={t('simulatorPreview.viewer.discoveryDescription')}
            >
                {props.devices.map((device) => {
                    const detail = availabilityDetail(device.availability.state);
                    return (
                        <Item
                            key={device.simulatorId}
                            testID={`${props.testID}-device:${device.simulatorId}`}
                            icon={<Icon name="device-mobile" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                            title={device.label}
                            subtitle={device.platformLabel}
                            detail={detail}
                            detailTestID={detail ? `${props.testID}-device:${device.simulatorId}-${device.availability.state}` : undefined}
                            accessibilityRole="button"
                            onPress={() => props.onSelectDevice(device.simulatorId)}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
}
