import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useMachineResourceSummary } from '@/sync/domains/machines/resources/useMachineResourceSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';

import { describeMachineAttentionFigure, describeMachineAttentionWord, readMachinePublishedResources, selectHeadlineReason } from './machineResourceSentences';
import { buildMachineSummaryInstruments, resolveMachineAttentionWordColor } from './machineSummaryStripModel';

/** The Machine's published resources only (retained while unchanged), so other daemon publications leave a row alone. */
function useMachinePublishedResources(serverId: string, machineId: string | null) {
    const selectResources = React.useCallback((state: Parameters<typeof resolveServerScopedMachine>[0]): unknown => {
        const daemonState: unknown = resolveServerScopedMachine(state, serverId, machineId ?? '')?.daemonState;
        return daemonState !== null && typeof daemonState === 'object' ? (daemonState as { resources?: unknown }).resources ?? null : null;
    }, [machineId, serverId]);
    const resources = storage(selectResources);
    return React.useMemo(() => resources === null ? null : readMachinePublishedResources({ resources }), [resources]);
}

/**
 * Whether this machine's row has a second line: it needs attention, from the facts its daemon publishes (no read or
 * demand of its own). A calm machine says nothing, so its row keeps the one-line height (OWNER-UI-1115B B2, owner
 * bar 11-16). Selects one boolean, so other publications render nothing.
 */
export function useMachineRowNeedsAttention(serverId: string, machineId: string): boolean {
    const published = useMachinePublishedResources(serverId, machineId);
    return published !== null && selectHeadlineReason(published.attention) !== null;
}

/**
 * The second line of a machine's row (the list column, a phone's All machines): what needs attention, labelled by its
 * word, with the one value behind it in the same attention tone ("Short on memory · 82%"); otherwise the quiet word
 * (Offline, Asleep, the owner's name), or nothing. Rows draw no unlabelled sparklines (owner bar 11-16); the
 * instruments stand where they are labelled (the table, the cards, the popover). Subscribes for this one machine only.
 */
export const MachineListRowSummary = React.memo(function MachineListRowSummary(props: Readonly<{
    serverId: string;
    machineId: string | null;
    online: boolean;
    /** The quiet word when nothing needs attention. */
    quietWord: string | null;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const availability = useMachineResourceSummary({ serverId: props.serverId, machineId: props.machineId ?? '' });
    const published = useMachinePublishedResources(props.serverId, props.machineId);
    const headline = published && props.online ? selectHeadlineReason(published.attention) : null;
    const summary = availability?.kind === 'reporting' ? availability.summary : null;
    const instruments = React.useMemo(() => summary ? buildMachineSummaryInstruments(summary) : null, [summary]);
    if (headline) {
        const figure = describeMachineAttentionFigure(headline, instruments);
        return (
            <View testID={props.testID} style={stylesheet.line}>
                <Text numberOfLines={1} style={[stylesheet.word, { color: resolveMachineAttentionWordColor(theme.colors) }]}>
                    {describeMachineAttentionWord(headline)}
                    {figure ? <Text style={stylesheet.figure}>{` · ${figure}`}</Text> : null}
                </Text>
            </View>
        );
    }
    return props.quietWord ? <Text testID={props.testID} numberOfLines={1} style={stylesheet.quiet}>{props.quietWord}</Text> : null;
});

const stylesheet = StyleSheet.create((theme) => ({
    line: {
        flexDirection: 'row',
        alignItems: 'center',
        minWidth: 0,
    },
    word: {
        ...Typography.variant('meta'),
        flexShrink: 1,
    },
    figure: {
        ...Typography.tabular(),
    },
    quiet: {
        ...Typography.variant('meta'),
        color: theme.colors.text.tertiary,
    },
}));
