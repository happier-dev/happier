import * as React from 'react';
import { ScrollView, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SessionFollowUnavailableNotice } from '@/components/sessions/follow/SessionFollowUnavailableNotice';
import type { SessionTranscriptActions } from '@/components/sessions/transcript/source/types';
import { PermissionAnswerUnconfirmedNotice } from '@/components/tools/shell/permissions/PermissionAnswerUnconfirmedNotice';
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

const FRAMES: readonly Readonly<{ title: string; kind: 'footer' | 'page'; render: () => React.ReactNode }>[] = [
    { title: 'Answer unconfirmed · Check again', kind: 'footer', render: () => (
        <PermissionAnswerUnconfirmedNotice requestKey="specimen:a" requestId="a" actions={UNREADABLE_SOURCE} testIDPrefix="specimen-permission" />
    ) },
    { title: 'Answer unconfirmed · no reader', kind: 'footer', render: () => (
        <PermissionAnswerUnconfirmedNotice requestKey="specimen:b" requestId="b" actions={NO_READ_SOURCE} testIDPrefix="specimen-permission-no-read" />
    ) },
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
