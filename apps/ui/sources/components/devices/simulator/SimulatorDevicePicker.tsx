import * as React from 'react';
import { ScrollView } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
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
 * Discovery: the simulators and emulators on the Session's Machine, each named with its platform.
 * A running device opens with one press; a stopped one says so and offers Start (boot) when the
 * producer can boot it. With none at all, one cause and the one thing to do about it.
 */
export function SimulatorDevicePicker(props: Readonly<{
    devices: readonly SimulatorPreviewDeviceOption[];
    selectedSimulatorId: string | null;
    onSelectDevice: (simulatorId: string) => void;
    onStartDevice?: (simulatorId: string) => void;
    /** The device operation in flight, keyed `boot:<simulatorId>` while a device starts. */
    pendingOperation?: string | null;
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
            >
                {props.devices.map((device) => {
                    const stopped = device.state === 'stopped';
                    const canStart = stopped && device.canBoot && Boolean(props.onStartDevice);
                    const starting = props.pendingOperation === `boot:${device.simulatorId}`;
                    const detail = stopped ? t('simulatorPreview.device.stopped') : availabilityDetail(device.availability.state);
                    return (
                        <Item
                            key={device.simulatorId}
                            testID={`${props.testID}-device:${device.simulatorId}`}
                            icon={<Icon name="device-mobile" size={ICON_SIZE.md} color={theme.colors.text.secondary} />}
                            title={device.label}
                            subtitle={canStart ? `${device.platformLabel} · ${t('simulatorPreview.device.stopped')}` : device.platformLabel}
                            detail={canStart ? undefined : detail}
                            detailTestID={detail ? `${props.testID}-device:${device.simulatorId}-${stopped ? 'stopped' : device.availability.state}` : undefined}
                            rightElement={canStart ? (
                                <RoundButton
                                    size="small"
                                    display="secondary"
                                    title={t('simulatorPreview.device.start')}
                                    loading={starting}
                                    disabled={starting}
                                    onPress={() => props.onStartDevice?.(device.simulatorId)}
                                    testID={`${props.testID}-start:${device.simulatorId}`}
                                />
                            ) : undefined}
                            accessibilityRole={stopped ? undefined : 'button'}
                            disabled={stopped && !canStart}
                            // A stopped row's one action is its Start button; a row never nests a button in a button.
                            onPress={stopped ? undefined : () => props.onSelectDevice(device.simulatorId)}
                            showChevron={!stopped}
                        />
                    );
                })}
            </ItemGroup>
        </ItemList>
    );
}
