import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { NextComposerPill, PendingAttentionPill } from '@/components/sessions/pendingNavigation/PendingNavigationPill';
import { Text } from '@/components/ui/text/Text';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { t } from '@/text';

const noop = () => {};

/**
 * Dev specimen of Next (Find lab `fnext`: N1 header pill, N1a post-answer capsule, N1p phone capsule) with the
 * real presenters at static props, for side-by-side review against the lab frames.
 */
export function NextPendingSpecimen() {
    const shortcut = useKeyboardShortcutLabel('session.pending.next') ?? 'Alt+Shift+J';
    const [round, setRound] = React.useState(0);
    return (
        <View style={styles.board} testID="dev-find-next">
            <Cell title="N1 · Header" description="Only when another session waits: the count and ⌘⇧J.">
                <View style={styles.header}>
                    <Text style={styles.headerTitle} numberOfLines={1}>Fix settings modal remount</Text>
                    <PendingAttentionPill count={2} phone={false} shortcut={shortcut} onPress={noop} />
                </View>
                <View style={styles.header}>
                    <Text style={styles.headerTitle} numberOfLines={1}>Review #2481</Text>
                    <PendingAttentionPill count={1} phone={false} shortcut={shortcut} onPress={noop} />
                </View>
            </Cell>
            <Cell title="N1p · Phone" description="The amber count capsule in the session nav.">
                <View style={[styles.header, styles.phoneHeader]}>
                    <Text style={styles.headerTitle} numberOfLines={1}>Fix settings modal remount</Text>
                    <PendingAttentionPill count={2} phone shortcut={shortcut} onPress={noop} />
                </View>
            </Cell>
            <Cell title="N1a · After an answer" description="The Next capsule rises above the composer; Go or Not now.">
                <View style={styles.composerStage}>
                    <NextComposerPill key={`one-${round}`} target={{ title: 'Craft pass lab', reason: t('pendingNavigation.waitsForInput') }} shortcut={shortcut} onGo={noop} />
                    <View style={styles.composer} />
                </View>
                <View style={styles.composerStage}>
                    <NextComposerPill key={`many-${round}`} target={{ title: t('pendingNavigation.sessionsWaiting', { count: 3 }), reason: null }} shortcut={shortcut} onGo={noop} />
                    <View style={styles.composer} />
                </View>
                <Text style={styles.replay} onPress={() => setRound((value) => value + 1)}>Replay</Text>
            </Cell>
        </View>
    );
}

function Cell(props: Readonly<{ title: string; description: string; children: React.ReactNode }>) {
    return (
        <View style={styles.cell}>
            <Text style={styles.cellTitle}>{props.title}</Text>
            <Text style={styles.cellDescription}>{props.description}</Text>
            <View style={styles.panel}>{props.children}</View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    board: { flexDirection: 'row', flexWrap: 'wrap', gap: 22, marginTop: 28 },
    cell: { flexGrow: 1, flexShrink: 1, flexBasis: 420, minWidth: 0, maxWidth: 680, gap: 4 },
    cellTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
    cellDescription: { fontSize: 12.5, lineHeight: 17, color: theme.colors.text.secondary, marginBottom: 6 },
    panel: {
        borderRadius: 12,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
        padding: 14,
        gap: 12,
    },
    header: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 44, paddingHorizontal: 8 },
    phoneHeader: { maxWidth: 390 },
    headerTitle: { flex: 1, fontSize: 15, fontWeight: '600', color: theme.colors.text.primary },
    composerStage: { paddingTop: 8, gap: 0 },
    composer: {
        height: 56,
        borderRadius: 18,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.strong,
        backgroundColor: theme.colors.surface.base,
    },
    replay: { alignSelf: 'flex-end', fontSize: 12.5, color: theme.colors.text.link },
}));
