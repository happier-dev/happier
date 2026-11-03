import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { RelayHostLocalChecklistStep } from '@/components/onboarding/checklists/relayHostLocal/RelayHostLocalChecklistStep';
import { RemoteSshChecklistStep } from '@/components/onboarding/checklists/remoteSsh/RemoteSshChecklistStep';
import { HOMES_ADD_SETTINGS } from '@/components/settings/server/serverSettings';
import { SettingAnchor } from '@/components/settings/shell/SettingRow';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { SegmentedTabBar, type SegmentedTab } from '@/components/ui/navigation/SegmentedTabBar';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { t } from '@/text';

import { PaneHeader } from '../journeys/alreadyUse/journeyPaneKit';

type Where = 'thisComputer' | 'ssh';

type PrimaryAction = Readonly<{
    label: string;
    disabled: boolean;
    onPress: (() => void) | (() => Promise<void>);
}>;

/**
 * "Set up a Home on a server" (desktop app): run a Home on this computer or on a server over SSH, with
 * the Personal Home bootstrap or the SSH host runner. Local setup opens the full bootstrap on Home;
 * SSH setup continues in "Connect to a Home directly" when the remote Home answers.
 */
export function ServerHomePane(props: Readonly<{
    testID: string;
    onHomeReady: (address: string) => void;
}>) {
    const [where, setWhere] = React.useState<Where>('thisComputer');
    const [primary, setPrimary] = React.useState<PrimaryAction | null>(null);
    const tabs = React.useMemo((): ReadonlyArray<SegmentedTab<Where>> => [
        { id: 'thisComputer', label: t('addFlows.pathThisComputerTitle') },
        { id: 'ssh', label: t('addFlows.pathSshTitle') },
    ], []);
    const { onHomeReady } = props;
    const styles = stylesheet;

    return (
        <SettingAnchor setting={HOMES_ADD_SETTINGS.settings.createPersonalHome}>
            <View testID={props.testID} style={styles.pane}>
                <PaneHeader title={t('homesJourneys.addServerHome')} lead={t('homesJourneys.addServerHomeSubtitle')} />
                <SegmentedTabBar
                    tabs={tabs}
                    activeTabId={where}
                    onSelectTab={(next) => { setPrimary(null); setWhere(next); }}
                    testIDPrefix={`${props.testID}.where`}
                    segmentSizing="content"
                    role="radiogroup"
                />
                {where === 'thisComputer' ? (
                    <RelayHostLocalChecklistStep
                        testID={`${props.testID}.thisComputer`}
                        onWizardPrimaryChange={setPrimary}
                    />
                ) : (
                    <RemoteSshChecklistStep
                        testID={`${props.testID}.ssh`}
                        mode="remoteRelayHost"
                        relayUrl={getActiveServerSnapshot().serverUrl ?? ''}
                        initialInstallRelayRuntime
                        onWizardPrimaryChange={setPrimary}
                        onCompleted={(payload) => {
                            const address = payload.relayRuntimeUrl?.trim();
                            if (address) onHomeReady(address);
                        }}
                    />
                )}
                {primary ? (
                    <View style={styles.actions}>
                        <RoundButton
                            testID={`${props.testID}.primary`}
                            size="small"
                            title={primary.label}
                            disabled={primary.disabled}
                            action={async () => { await primary.onPress(); }}
                        />
                    </View>
                ) : null}
            </View>
        </SettingAnchor>
    );
}

const stylesheet = StyleSheet.create(() => ({
    pane: {
        gap: 14,
        minWidth: 0,
    },
    actions: {
        flexDirection: 'row',
        justifyContent: 'flex-start',
    },
}));
