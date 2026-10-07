import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { PeerMediationPreferencesV1Schema, type PeerMediationPreferencesV1 } from '@happier-dev/protocol/account/settings/peerMediationPreferencesV1';
import type { FeatureId } from '@happier-dev/protocol/features/catalog';

import { ACCOUNT_SETTINGS } from '@/components/settings/account/accountSettings';
import { SettingRow } from '@/components/settings/shell/SettingRow';
import { Switch } from '@/components/ui/forms/Switch';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SegmentedChoiceItem, type SegmentedChoiceOption } from '@/components/ui/lists/SegmentedChoiceItem';
import { useFeatureDecision } from '@/hooks/server/useFeatureDecision';
import {
    readDirectConnectionsEnabled,
    readMachineDirectConnectionChoice,
    withDirectConnectionsEnabled,
    withMachineDirectConnectionChoice,
    type MachineDirectConnectionChoice,
} from '@/sync/domains/settings/peerMediationPreferences';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { t } from '@/text';

/**
 * Whether the Home's server lets any flow connect directly. The server gate is the first input of the
 * fold owner (`resolveEffectivePeerDirectRoutePolicy`); when every direct-peer bit is off, no account
 * or machine choice can change a route, so the rows say so instead of offering a switch that does
 * nothing. A bit that has not been read yet is not a refusal: the rows stay usable until every answer
 * is in and none allows it.
 */
function useServerDeniesDirectConnections(): boolean {
    const rpc = useFeatureDecision('machines.rpc.directPeer' satisfies FeatureId);
    const transfer = useFeatureDecision('machines.transfer.directPeer' satisfies FeatureId);
    const tunnel = useFeatureDecision('machines.tunnel.directPeer' satisfies FeatureId);
    const liveStream = useFeatureDecision('machines.liveStream.directPeer' satisfies FeatureId);
    const decisions = [rpc, transfer, tunnel, liveStream];
    return decisions.every((decision) => decision !== null && (decision.state === 'disabled' || decision.state === 'unsupported'));
}

/**
 * The stored value through its canonical schema (which falls back to the defaults rather than
 * throwing), so a missing or foreign value reads as "never changed" instead of breaking the page.
 */
function usePeerMediationPreferences(): [PeerMediationPreferencesV1, (value: PeerMediationPreferencesV1) => void] {
    const [stored, setStored] = useSettingMutable('peerMediationPreferencesV1');
    const preferences = React.useMemo(() => PeerMediationPreferencesV1Schema.parse(stored), [stored]);
    return [preferences, setStored];
}

/** Account › Connections: one account-wide answer to "may my devices connect to my machines directly?". */
export const AccountDirectConnectionsSection = React.memo(function AccountDirectConnectionsSection() {
    const { theme } = useUnistyles();
    const [preferences, setPreferences] = usePeerMediationPreferences();
    const serverDenies = useServerDeniesDirectConnections();
    const enabled = !serverDenies && readDirectConnectionsEnabled(preferences);
    const subtitle = serverDenies
        ? t('settingsConnections.serverDenied')
        : enabled ? t('settingsConnections.directOnDescription') : t('settingsConnections.directOffDescription');
    return (
        <ItemGroup title={t('settingsConnections.sectionTitle')} description={t('settingsConnections.sectionDescription')}>
            <SettingRow
                testID="settings-account-direct-connections-item"
                setting={ACCOUNT_SETTINGS.settings.directConnections}
                subtitle={subtitle}
                subtitleLines={3}
                disabled={serverDenies}
                showChevron={false}
                rightElement={
                    <Switch
                        testID="settings-account-direct-connections-switch"
                        value={enabled}
                        disabled={serverDenies}
                        onValueChange={(value) => setPreferences(withDirectConnectionsEnabled(preferences, value))}
                        trackColor={{
                            false: theme.colors.switch.track.inactive,
                            true: theme.colors.switch.track.active,
                        }}
                        thumbColor={enabled ? theme.colors.switch.thumb.active : theme.colors.switch.thumb.inactive}
                    />
                }
            />
        </ItemGroup>
    );
});

/**
 * A machine's Connection section: follow the account, or override it for this machine only
 * (`byMachineId`). Three short answers, all visible.
 */
export const MachineDirectConnectionSection = React.memo(function MachineDirectConnectionSection(props: Readonly<{
    machineId: string;
    machineName: string;
}>) {
    const [preferences, setPreferences] = usePeerMediationPreferences();
    const serverDenies = useServerDeniesDirectConnections();
    const choice = serverDenies ? 'relay' : readMachineDirectConnectionChoice(preferences, props.machineId);
    const accountEnabled = readDirectConnectionsEnabled(preferences);
    const machine = props.machineName;
    const options = React.useMemo((): ReadonlyArray<SegmentedChoiceOption<MachineDirectConnectionChoice>> => [
        {
            id: 'default',
            label: t('settingsConnections.machineOptionDefault'),
            description: accountEnabled
                ? t('settingsConnections.machineDefaultDescription', { machine })
                : t('settingsConnections.machineDefaultOffDescription'),
        },
        { id: 'direct', label: t('settingsConnections.machineOptionDirect'), description: t('settingsConnections.machineDirectDescription', { machine }) },
        { id: 'relay', label: t('settingsConnections.machineOptionRelay'), description: t('settingsConnections.machineRelayDescription') },
    ], [accountEnabled, machine]);
    return (
        <ItemGroup title={t('settingsConnections.machineSectionTitle')}>
            <SegmentedChoiceItem<MachineDirectConnectionChoice>
                testID="machine-direct-connection-item"
                testIDPrefix="machine-direct-connection"
                title={t('settingsConnections.machineTitle', { machine })}
                subtitle={serverDenies ? t('settingsConnections.serverDenied') : undefined}
                options={serverDenies ? options.map((option) => ({ ...option, description: undefined })) : options}
                value={choice}
                disabled={serverDenies}
                onChange={(next) => setPreferences(withMachineDirectConnectionChoice(preferences, props.machineId, next))}
            />
        </ItemGroup>
    );
});
