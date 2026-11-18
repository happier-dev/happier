import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionFollowUnavailableNotice } from '@/components/sessions/follow/SessionFollowUnavailableNotice';
import type { SessionTranscriptActions } from '@/components/sessions/transcript/source/types';
import { PermissionAnswerUnconfirmedNotice } from '@/components/tools/shell/permissions/PermissionAnswerUnconfirmedNotice';
import { ValueFieldSelect, type ValueFieldSelectItem } from '@/components/ui/forms/ValueFieldSelect';
import { Icon } from '@/components/ui/icons/Icon';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * Dev-only `/dev/primitive-states`: states that moved onto the shared state owners (PRIMITIVES-DESIGN-1116)
 * and have no other specimen, rendered through their real components. `?only=<frame title>` renders one frame.
 */
const styles = StyleSheet.create((theme) => ({
    root: { flex: 1, backgroundColor: theme.colors.surface.inset },
    content: { padding: theme.space.s24, gap: theme.space.s24 },
    block: { gap: theme.space.s8 },
    caption: { ...Typography.variant('label', 'semiBold'), color: theme.colors.text.secondary },
    frame: {
        backgroundColor: theme.colors.surface.base,
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        overflow: 'hidden',
    },
    footer: { padding: theme.space.s16, maxWidth: 560 },
    page: { height: 520 },
}));

const noop = () => {};
const resolved = async () => {};

/** A Session source whose exact re-read cannot tell (the "could not check" path after Check again). */
const UNREADABLE_SOURCE: SessionTranscriptActions = {
    respondToPermission: resolved,
    answerUserAction: resolved,
    abort: resolved,
    submitMessage: resolved,
    readRequestOutcome: async () => { throw new Error('The Session does not say whether the request is still waiting'); },
};
const NO_READ_SOURCE: SessionTranscriptActions = {
    respondToPermission: resolved,
    answerUserAction: resolved,
    abort: resolved,
    submitMessage: resolved,
};

/** The Isolation "Where sessions run" shape: a field-wide select, one row with a mark and a line under it, then a titled group without marks. */
const WHERE_IT_RUNS: readonly ValueFieldSelectItem[] = [
    { id: 'directly', title: 'Directly', subtitle: 'On this machine itself', icon: <Icon name="desktop" size={15} /> },
    { id: 'box-a', title: 'Docker · default', category: 'Sandboxes' },
    { id: 'box-b', title: 'Lima · build', category: 'Sandboxes' },
];

function FieldSelectFrame(props: Readonly<{ fill: boolean }>) {
    const [selectedId, setSelectedId] = React.useState('directly');
    return (
        <ValueFieldSelect
            fill={props.fill}
            testID={props.fill ? 'specimen-field-select-fill' : 'specimen-field-select'}
            label="Where sessions run"
            items={WHERE_IT_RUNS}
            selectedId={selectedId}
            onSelect={setSelectedId}
        />
    );
}

/** The Artifacts Kind shape: a chip's one-tap list where only one row has a mark, its current choice checked. */
const KINDS = [
    { id: 'files', label: 'Documents & files' },
    { id: 'all', label: 'All kinds' },
    { id: 'documents', label: 'Documents', icon: <Icon name="file-text" size={16} /> },
] as const;

function FilterChipFrame() {
    const [selectedId, setSelectedId] = React.useState<string>('files');
    return (
        <SelectionListFilterChip filter={{
            id: 'specimen-kind',
            testID: 'specimen-kind',
            label: 'Kind',
            options: KINDS,
            selectedId,
            onChange: setSelectedId,
        }} />
    );
}

const FRAMES: readonly Readonly<{ title: string; kind: 'footer' | 'page'; render: () => React.ReactNode }>[] = [
    { title: 'Answer unconfirmed · Check again', kind: 'footer', render: () => (
        <PermissionAnswerUnconfirmedNotice requestKey="specimen:a" requestId="a" actions={UNREADABLE_SOURCE} testIDPrefix="specimen-permission" />
    ) },
    { title: 'Answer unconfirmed · no reader', kind: 'footer', render: () => (
        <PermissionAnswerUnconfirmedNotice requestKey="specimen:b" requestId="b" actions={NO_READ_SOURCE} testIDPrefix="specimen-permission-no-read" />
    ) },
    { title: 'Menu · field-wide select with marks', kind: 'footer', render: () => <FieldSelectFrame fill /> },
    { title: 'Menu · select with marks', kind: 'footer', render: () => <FieldSelectFrame fill={false} /> },
    { title: 'Menu · filter chip with one mark', kind: 'footer', render: () => <FilterChipFrame /> },
    { title: 'Follow · not offered by this Home', kind: 'page', render: () => <SessionFollowUnavailableNotice onBack={noop} /> },
    { title: 'Follow · Home unreachable', kind: 'page', render: () => (
        <SessionFollowUnavailableNotice reason="unreachable" onBack={noop} onRetry={noop} />
    ) },
];

export function PrimitiveStatesSpecimen(props: Readonly<{ only: string | null }>) {
    const frames = props.only ? FRAMES.filter((frame) => frame.title === props.only) : FRAMES;
    return (
        <ScrollView style={styles.root} contentContainerStyle={styles.content}>
            {frames.map((frame) => (
                <View key={frame.title} style={styles.block}>
                    <Text style={styles.caption}>{frame.title}</Text>
                    <View style={[styles.frame, frame.kind === 'page' ? styles.page : styles.footer]}>{frame.render()}</View>
                </View>
            ))}
        </ScrollView>
    );
}
