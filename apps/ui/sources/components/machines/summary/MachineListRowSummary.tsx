import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';

import { describeMachineAttentionWord, readMachinePublishedResources, selectHeadlineReason } from './machineResourceSentences';
import { resolveMachineAttentionWordColor } from './machineSummaryStripModel';

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
    const chosen = props.online && props.machineId !== null && setting.metrics.length > 0;
    // The strip draws only values it holds: with none yet it would reserve its width as empty tracks and
    // squeeze the name, so a machine without a reading shows no strip.
    const strip = chosen && (availability?.kind === 'monitoring_off' || (availability?.kind === 'reporting' && availability.summary))
        ? <MachineSummaryStrip availability={availability} style={setting.style} metrics={setting.metrics} layout="inline" />
        : null;
    const headline = published && props.online ? selectHeadlineReason(published.attention) : null;
    // The strip's instruments carry no names, so a machine that needs you says why in a word, in the attention tone,
    // beside them (DESIGN-2-1114 #17); colour never speaks without its word.
    const word = headline ? (
        <Text numberOfLines={1} style={[stylesheet.word, { color: resolveMachineAttentionWordColor(theme.colors) }]}>
            {describeMachineAttentionWord(headline)}
        </Text>
    ) : null;
    if (strip || word) return <View testID={props.testID} style={stylesheet.line}>{strip}{word}</View>;
    return props.quietWord ? <Text testID={props.testID} numberOfLines={1} style={stylesheet.quiet}>{props.quietWord}</Text> : null;
});

const stylesheet = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        minWidth: 0,
    },
    word: {
        ...Typography.variant('meta'),
        flexShrink: 1,
    },
    quiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
