import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import {
    describeMachineAttentionWord,
    describeMachineReasonDetail,
    resolveMachineReasonAction,
    selectAttentionSubjects,
    selectHeadlineReason,
} from '@/components/machines/summary/machineResourceSentences';
import { resolveMachineAttentionWordColor } from '@/components/machines/summary/machineSummaryStripModel';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { beginMachinePageTabIntent } from '@/components/machines/page/machinePageIntent';
import { Icon } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { MachineAttentionEntry } from './collectMachineAttention';
import type { MachinePageTabParams } from '@/components/machines/page/machinePageTabQuery';

/**
 * "Needs you" (lab `rm` F, Fp, Hp): each machine that needs you or is worth a look, worst first — its mark,
 * name with the reason in tone, one line of detail, and its one action (the Hub attention anatomy).
 * Absent when every machine is calm. The caller turns a target into the link of its own door.
 */
export const MachinesNeedsYouList = React.memo(function MachinesNeedsYouList(props: Readonly<{
    entries: readonly MachineAttentionEntry[];
    nowMs: number;
    /** Opens the machine (no tab) or the tab its reason leads to. */
    onOpen: (entry: MachineAttentionEntry, tab: MachinePageTabParams | null) => void;
    /** A phone: the row itself takes its reason to the tab it names, with a chevron, instead of a button under each row. */
    compact?: boolean;
    testID?: string;
}>) {
    const subjects = React.useMemo(() => selectAttentionSubjects(props.entries), [props.entries]);
    if (subjects.length === 0) return null;
    return (
        <View testID={props.testID ?? 'machines.needs-you'}>
            <ItemGroup title={t('machineAttention.groups.needsYou')}>
                {subjects.map(entry => <MachineNeedsYouItem key={entry.key} entry={entry} nowMs={props.nowMs} onOpen={props.onOpen} compact={props.compact === true} />)}
            </ItemGroup>
        </View>
    );
});

const MachineNeedsYouItem = React.memo(function MachineNeedsYouItem(props: Readonly<{
    entry: MachineAttentionEntry;
    nowMs: number;
    onOpen: (entry: MachineAttentionEntry, tab: MachinePageTabParams | null) => void;
    compact: boolean;
}>) {
    const { theme } = useUnistyles();
    const { entry } = props;
    const reason = selectHeadlineReason(entry.attention)!;
    const tone = resolveMachineAttentionWordColor(theme.colors);
    const action = resolveMachineReasonAction(reason);
    const word = describeMachineAttentionWord(reason);
    const detail = describeMachineReasonDetail(reason, props.nowMs);
    return (
        <Item
            testID={`machines.needs-you.${entry.serverId}.${entry.machineId}`}
            title={entry.name}
            // On a phone the name keeps its line and the reason leads the line beneath it, so neither the name
            // wraps nor the reason truncates beside it (QA-RERUN-1113 F8); wider rows keep the word on the name's line.
            titleLines={props.compact ? 1 : undefined}
            titleAccessory={props.compact ? undefined : <Text style={[stylesheet.word, { color: tone }]} numberOfLines={1}>{word}</Text>}
            subtitle={props.compact ? <Text style={stylesheet.detail} numberOfLines={2}>
                <Text style={[stylesheet.word, { color: tone }]}>{word}</Text>{` · ${detail}`}
            </Text> : detail}
            accessibilityLabel={`${entry.name}, ${word}. ${detail}`}
            icon={<Icon name="desktop" color={theme.colors.text.secondary} />}
            showChevron={!action || props.compact}
            accessoryLayout="adaptive"
            onPress={() => {
                if (props.compact && action) { beginMachinePageTabIntent(entry, action.tab); props.onOpen(entry, action.tab); return; }
                props.onOpen(entry, null);
            }}
            rightElementOutsidePressable={Boolean(action) && !props.compact}
            rightElement={action && !props.compact ? (
                <View>
                    <RoundButton
                        testID={`machines.needs-you.${entry.serverId}.${entry.machineId}.action`}
                        size="small"
                        display="secondary"
                        title={action.label}
                        onPress={() => { beginMachinePageTabIntent(entry, action.tab); props.onOpen(entry, action.tab); }}
                    />
                </View>
            ) : undefined}
        />
    );
});

const stylesheet = StyleSheet.create((theme) => ({
    detail: {
        ...Typography.variant('meta'),
        color: theme.colors.text.secondary,
    },
    word: {
        ...Typography.variant('meta'),
        ...Typography.default('semiBold'),
    },
}));
