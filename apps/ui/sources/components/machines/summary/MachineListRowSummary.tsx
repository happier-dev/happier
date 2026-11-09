import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';

import { describeMachineAttentionWord, readMachinePublishedResources, selectHeadlineReason } from './machineResourceSentences';
import { type MachineSummaryMetric, resolveMachineAttentionWordColor } from './machineSummaryStripModel';

import { MachineSummaryStrip } from './MachineSummaryStrip';
import { useMachineSummarySettingValue } from './useMachineSummarySetting';

/**
 * The right of a machine list column row (MPG-22): an online machine's strip on the name's line once it has
 * a reading, or one quiet word for a machine that is not (Offline, Asleep, the owner's name). Subscribes for this one
 * machine only, so another machine's update never re-renders this row.
 */
export const MachineListRowSummary = React.memo(function MachineListRowSummary(props: Readonly<{
    serverId: string;
    machineId: string | null;
    online: boolean;
    /** The quiet word when no strip shows. */
    quietWord: string | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const setting = useMachineSummarySettingValue();
    const availability = useMachineResourceSummary({ serverId: props.serverId, machineId: props.machineId ?? '' });
    // Only the published resources (retained while unchanged), so other daemon publications leave this row alone.
    const selectResources = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]): unknown => {
        const daemonState: unknown = resolveServerScopedMachine(state, props.serverId, props.machineId ?? '')?.daemonState;
        return daemonState !== null && typeof daemonState === 'object' ? (daemonState as { resources?: unknown }).resources ?? null : null;
    }, [props.machineId, props.serverId]);
    const resources = storage(selectResources);
    const published = React.useMemo(() => resources === null ? null : readMachinePublishedResources({ resources }), [resources]);
    if (props.online && props.machineId && setting.metrics.length > 0 && availability?.kind === 'monitoring_off') {
        return <MachineSummaryStrip testID={props.testID} availability={availability} style={setting.style} metrics={setting.metrics} layout="inline" />;
    }
    const headline = published && props.online ? selectHeadlineReason(published.attention) : null;
    // A machine that needs you says why in a word, in tone, when its strip has no instrument for it.
    if (headline && !(setting.metrics as readonly string[]).includes(headline.metric as MachineSummaryMetric)) {
        return <Text testID={props.testID} numberOfLines={1} style={[stylesheet.quiet, { color: resolveMachineAttentionWordColor(theme.colors) }]}>
            {describeMachineAttentionWord(headline)}
        </Text>;
    }
    // The strip draws only values it holds: with none yet it would reserve its width as empty tracks and
    // squeeze the name, so a machine without a reading shows its quiet word, or nothing.
    if (props.online && props.machineId && setting.metrics.length > 0 && availability?.kind === 'reporting' && availability.summary) {
        return <MachineSummaryStrip testID={props.testID} availability={availability} style={setting.style} metrics={setting.metrics} layout="inline" />;
    }
    return props.quietWord ? <Text testID={props.testID} numberOfLines={1} style={stylesheet.quiet}>{props.quietWord}</Text> : null;
});

const stylesheet = StyleSheet.create((theme) => ({
    quiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
