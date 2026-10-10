import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ComputerGrantStatusV1 } from '@happier-dev/protocol';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { resolveComputerRecovery } from '@/sync/domains/computer/targets';

export { needsComputerPermission } from '@/sync/domains/computer/targets';

/** The daemon-side "open the privacy pane" request (W7 `computer.permissions.openSettings`). */
export type ComputerOpenSettingsState = 'idle' | 'opening' | 'opened' | 'failed';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        alignItems: 'center',
        gap: 12,
        paddingHorizontal: 16,
    },
    liveLine: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        maxWidth: 420,
    },
    liveText: {
        ...Typography.rowMeta(),
        flexShrink: 1,
        color: theme.colors.text.secondary,
        textAlign: 'center',
    },
}));

/**
 * The OS permission the machine needs first (lab `b-mac` P): which one is missing, said as what it
 * unlocks, that it is granted on that machine and not on this device, and **Open privacy settings on
 * {machine}**, which asks that machine's daemon to open the pane there (so it works from a phone
 * too). Happier never changes the permission itself; Check again re-reads the machine. The picker
 * and the viewer's picture draw this one card.
 */
export function ComputerPermissionCard(props: Readonly<{
    machineName: string;
    grants: ComputerGrantStatusV1;
    openSettings: ComputerOpenSettingsState;
    onOpenSettings: (permission: 'capture' | 'input') => void;
    onCheckAgain: () => void;
    testID?: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    const permission = resolveComputerRecovery({ kind: 'ready', targets: [], grants: props.grants }, 'use')?.permission ?? 'capture';
    const machine = props.machineName;
    const unknown = props.grants[permission] === 'unknown';
    const testID = props.testID ?? 'computer-permission';
    const live = props.openSettings === 'opening' || props.openSettings === 'opened';
    return (
        <View style={stylesheet.root} testID={testID} accessibilityLiveRegion="polite">
            <SurfaceStateCard
                kind="denied"
                iconName="shield"
                title={unknown
                    ? t('computerUse.permission.unknownTitle', { machine })
                    : t(permission === 'capture' ? 'computerUse.permission.captureTitle' : 'computerUse.permission.inputTitle', { machine })}
                reason={t(permission === 'capture' ? 'computerUse.permission.separateBody' : 'computerUse.permission.onMachineBody', { machine })}
                action={{
                    label: t('computerUse.permission.openPrivacy', { machine }),
                    onPress: () => props.onOpenSettings(permission),
                    busy: props.openSettings === 'opening',
                    testID: `${testID}-open-settings`,
                }}
                secondaryAction={{
                    label: t('computerUse.permission.checkAgain'),
                    onPress: props.onCheckAgain,
                    testID: `${testID}-check-again`,
                }}
            />
            {live || props.openSettings === 'failed' ? (
                <View style={stylesheet.liveLine}>
                    {live ? <ActivitySpinner size="small" color={theme.colors.text.secondary} /> : null}
                    <Text style={stylesheet.liveText} testID={`${testID}-${live ? 'opened' : 'open-failed'}`}>
                        {live
                            ? t('computerUse.permission.opened', { machine })
                            : t('computerUse.permission.openFailed')}
                    </Text>
                </View>
            ) : null}
        </View>
    );
}
