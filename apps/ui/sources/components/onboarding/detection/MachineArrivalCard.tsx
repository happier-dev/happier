import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CodeBlockView } from '@/components/ui/code/blocks/CodeBlockView';
import { StatusPill, resolveStatusPillVariantForState } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    buildCliInstallAndRunCommandForCurrentApp,
    buildCliInstallAndRunPowershellCommandForCurrentApp,
} from '@/components/onboarding/commands/wizardCliCommands';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useAwaitedMachineArrival } from './useAwaitedMachineArrival';

export type MachineArrivalCardProps =
    | Readonly<{
        mode: 'instructional';
        serverUrl?: string | null;
        testID?: string;
    }>
    | Readonly<{
        mode: 'live';
        serverUrl?: string | null;
        since?: number | null;
        onArrived?: (machine: Machine) => void;
        notSeeingYourMachine?: React.ReactNode;
        testID?: string;
    }>;

type PlatformTab = 'posix' | 'windows';

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: 18,
        gap: 16,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 14,
    },
    rail: {
        width: 2,
        alignSelf: 'stretch',
        borderRadius: 999,
        backgroundColor: theme.colors.border.default,
    },
    content: {
        flex: 1,
        gap: 14,
        minWidth: 0,
    },
    header: {
        gap: 8,
        alignItems: 'flex-start',
    },
    title: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
        fontSize: 20,
        lineHeight: 26,
    },
    body: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    commandShell: {
        gap: 8,
    },
    tabs: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    divider: {
        width: 1,
        height: 16,
        backgroundColor: theme.colors.border.default,
    },
    tabText: {
        color: theme.colors.text.secondary,
        fontSize: 12,
        lineHeight: 16,
    },
    tabTextSelected: {
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    liveStatus: {
        gap: 8,
        alignItems: 'flex-start',
    },
    detailsToggle: {
        alignSelf: 'flex-start',
    },
    detailsText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
        lineHeight: 18,
    },
}));

function buildSetupArgs(serverUrl: string | null | undefined): string[] {
    const trimmed = String(serverUrl ?? '').trim();
    return trimmed ? ['--relay-url', trimmed, '--yes'] : ['--yes'];
}

function useSetupCommands(serverUrl: string | null | undefined): Readonly<{ posix: string; windows: string }> {
    const args = React.useMemo(() => buildSetupArgs(serverUrl), [serverUrl]);
    return React.useMemo(() => ({
        posix: buildCliInstallAndRunCommandForCurrentApp({ action: 'setup', args }),
        windows: buildCliInstallAndRunPowershellCommandForCurrentApp({ action: 'setup', args }),
    }), [args]);
}

function PlatformTabButton(props: Readonly<{
    selected: boolean;
    label: string;
    testID: string;
    onPress: () => void;
}>): React.ReactElement {
    const styles = stylesheet;
    return (
        <Pressable
            testID={props.testID}
            accessibilityRole="button"
            accessibilityState={{ selected: props.selected }}
            onPress={props.onPress}
        >
            <Text
                numberOfLines={1}
                style={[styles.tabText, props.selected ? styles.tabTextSelected : null]}
            >
                {props.label}
            </Text>
        </Pressable>
    );
}

function CommandBlock(props: Readonly<{
    serverUrl?: string | null;
}>): React.ReactElement {
    const styles = stylesheet;
    const commands = useSetupCommands(props.serverUrl);
    const [tab, setTab] = React.useState<PlatformTab>('posix');
    return (
        <View style={styles.commandShell}>
            <View style={styles.tabs}>
                <PlatformTabButton
                    testID="machine-arrival-card-command-setup-platform:macos"
                    label={t('setupOnboarding.handoffPlatformMacosLabel')}
                    selected={tab === 'posix'}
                    onPress={() => setTab('posix')}
                />
                <PlatformTabButton
                    testID="machine-arrival-card-command-setup-platform:linux"
                    label={t('setupOnboarding.handoffPlatformLinuxLabel')}
                    selected={tab === 'posix'}
                    onPress={() => setTab('posix')}
                />
                <View style={styles.divider} />
                <PlatformTabButton
                    testID="machine-arrival-card-command-setup-platform:windows"
                    label={t('setupOnboarding.handoffPlatformWindowsLabel')}
                    selected={tab === 'windows'}
                    onPress={() => setTab('windows')}
                />
            </View>
            <CodeBlockView
                code={tab === 'windows' ? commands.windows : commands.posix}
                language={tab === 'windows' ? 'powershell' : 'bash'}
                // Spec §2 / F-W13-1: the one command must be fully readable —
                // wrap to multiple lines, never fade/cut unread content.
                wrap
                showCopyButton
                scrollTestID="machine-arrival-card-command-setup"
            />
        </View>
    );
}

function useArrivalCallback(
    arrival: ReturnType<typeof useAwaitedMachineArrival>,
    onArrived: ((machine: Machine) => void) | undefined,
): void {
    const deliveredKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!onArrived || arrival.status !== 'arrived') return;
        const key = `${arrival.machine.id}:${arrival.machine.activeAt ?? ''}`;
        if (deliveredKeyRef.current) return;
        deliveredKeyRef.current = key;
        onArrived(arrival.machine);
    }, [arrival, onArrived]);
}

function LiveStatus(props: Readonly<{
    serverUrl?: string | null;
    since?: number | null;
    onArrived?: (machine: Machine) => void;
}>): React.ReactElement {
    const styles = stylesheet;
    const arrival = useAwaitedMachineArrival({ serverUrl: props.serverUrl, since: props.since });
    useArrivalCallback(arrival, props.onArrived);

    if (arrival.status === 'arrived') {
        const machineName = getMachineDisplayName(arrival.machine) ?? tLoose('setupOnboarding.machineArrival.unknownMachine');
        return (
            <View style={styles.liveStatus}>
                <StatusPill
                    testID="machine-arrival-card-status"
                    variant={resolveStatusPillVariantForState('live')}
                    label={`${tLoose('setupOnboarding.machineArrival.connected')} - ${machineName}`}
                />
            </View>
        );
    }

    return (
        <View style={styles.liveStatus}>
            <StatusPill
                testID="machine-arrival-card-status"
                variant={resolveStatusPillVariantForState('neutral')}
                isPulsing
                label={tLoose('setupOnboarding.machineArrival.watching')}
            />
        </View>
    );
}

function NotSeeingMachineDetails(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const styles = stylesheet;
    const [expanded, setExpanded] = React.useState(false);
    return (
        <View>
            <Pressable
                testID="machine-arrival-card-details-toggle"
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                style={styles.detailsToggle}
                onPress={() => setExpanded((current) => !current)}
            >
                <Text style={styles.detailsText}>{tLoose('setupOnboarding.machineArrival.notSeeingMachine')}</Text>
            </Pressable>
            {expanded ? (
                <View testID="machine-arrival-card-details">
                    {props.children}
                </View>
            ) : (
                <View testID="machine-arrival-card-details" />
            )}
        </View>
    );
}

export function MachineArrivalCard(props: MachineArrivalCardProps): React.ReactElement {
    const styles = stylesheet;
    useUnistyles();
    const testID = props.testID ?? 'machine-arrival-card';

    return (
        <View testID={testID} style={styles.card}>
            <View style={styles.row}>
                <View style={styles.rail} />
                <View style={styles.content}>
                    <View style={styles.header}>
                        <Text style={styles.title}>{tLoose('setupOnboarding.machineArrival.oneCommand')}</Text>
                        <Text style={styles.body}>
                            {props.mode === 'instructional'
                                ? tLoose('setupOnboarding.machineArrival.detectedAfterSignIn')
                                : tLoose('setupOnboarding.machineArrival.liveBody')}
                        </Text>
                    </View>
                    <CommandBlock serverUrl={props.serverUrl} />
                    {props.mode === 'live' ? (
                        <>
                            <LiveStatus
                                serverUrl={props.serverUrl}
                                since={props.since}
                                onArrived={props.onArrived}
                            />
                            {props.notSeeingYourMachine ? (
                                <NotSeeingMachineDetails>
                                    {props.notSeeingYourMachine}
                                </NotSeeingMachineDetails>
                            ) : null}
                        </>
                    ) : null}
                </View>
            </View>
        </View>
    );
}
