import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { OsCommandBlock } from '@/components/ui/code/blocks/OsCommandBlock';
import { StatusPill, resolveStatusPillVariantForState } from '@/components/ui/status/StatusPill';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t, tLoose } from '@/text';
import { getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { buildMachineAddCommand } from '@/components/machines/add/machineAddCommand';
import { useMachineAddHomeTargetAtUrl } from '@/components/machines/add/machineAddHomeTarget';
import type { Machine } from '@/sync/domains/state/storageTypes';

import { useAwaitedMachineArrival, type AwaitedMachineArrivalBaseline } from './useAwaitedMachineArrival';

export type MachineArrivalCardProps =
    | Readonly<{
        mode: 'instructional';
        serverUrl?: string | null;
        testID?: string;
    }>
    | Readonly<{
        mode: 'live';
        serverUrl?: string | null;
        arrivalBaseline?: AwaitedMachineArrivalBaseline | null;
        onArrivalBaselineCaptured?: (baseline: AwaitedMachineArrivalBaseline) => void;
        onArrived?: (machine: Machine) => void;
        notSeeingYourMachine?: React.ReactNode;
        testID?: string;
    }>;

const stylesheet = StyleSheet.create((theme) => ({
    card: {
        width: '100%',
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.elevated,
        padding: 18,
        gap: theme.space.s16,
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
        gap: theme.space.s8,
        alignItems: 'flex-start',
    },
    title: {
        color: theme.colors.text.primary,
        ...Typography.variant('title'),
    },
    body: {
        color: theme.colors.text.secondary,
        fontSize: 14,
        lineHeight: 20,
    },
    liveStatus: {
        gap: theme.space.s8,
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

function useSetupCommands(serverUrl: string | null | undefined): Readonly<{ posix: string; windows: string }> | null {
    const target = useMachineAddHomeTargetAtUrl(serverUrl);
    return React.useMemo(() => {
        const posix = buildMachineAddCommand({ ...target, kind: 'joinHome', os: 'linux', remote: true });
        const windows = buildMachineAddCommand({ ...target, kind: 'joinHome', os: 'windows', remote: true });
        return posix && windows ? { posix, windows } : null;
    }, [target]);
}

function CommandBlock(props: Readonly<{
    serverUrl?: string | null;
}>): React.ReactElement {
    const commands = useSetupCommands(props.serverUrl);
    if (!commands) return <Text>{t('common.unavailable')}</Text>;
    return (
        <OsCommandBlock
            testID="machine-arrival-card-command-setup"
            commands={{ macos: commands.posix, linux: commands.posix, windows: commands.windows }}
        />
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
    arrivalBaseline?: AwaitedMachineArrivalBaseline | null;
    onArrivalBaselineCaptured?: (baseline: AwaitedMachineArrivalBaseline) => void;
    onArrived?: (machine: Machine) => void;
}>): React.ReactElement {
    const styles = stylesheet;
    const arrival = useAwaitedMachineArrival({
        serverUrl: props.serverUrl,
        baseline: props.arrivalBaseline,
        onBaselineCaptured: props.onArrivalBaselineCaptured,
    });
    useArrivalCallback(arrival, props.onArrived);

    if (arrival.status === 'arrived') {
        const machineName = getMachineSentenceName(arrival.machine);
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
                                arrivalBaseline={props.arrivalBaseline}
                                onArrivalBaselineCaptured={props.onArrivalBaselineCaptured}
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
