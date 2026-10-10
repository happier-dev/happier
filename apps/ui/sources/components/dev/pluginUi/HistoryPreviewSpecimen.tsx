import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ConversationPreview, type ConversationHighlight } from '@/components/appShell/search/ExternalConversationSearchResults';
import { Text } from '@/components/ui/text/Text';

const noop = () => {};
const QUERY = 'flaky e2e';

const HIGHLIGHT: ConversationHighlight = {
    key: 'dev-hit',
    title: 'Stabilise CI on the release branch',
    meta: 'Claude Code · ~/happier · MacBook Pro · 3w ago',
    agentLabel: 'Claude Code',
    candidate: { remoteSessionId: 'dev-hit', title: 'Stabilise CI on the release branch', updatedAtMs: 1,
        match: { snippet: '…the flaky e2e is the settings sheet: it remounts when the viewport changes, so the test sometimes types into a sheet that is about to be replaced.',
            sourceItemId: 'dev-item', messageIndex: 41 } },
    open: noop,
    show: noop,
};

/** Dev specimen of the palette's Conversations preview (Find lab `fhistory` H1r) through the real presenter. */
export function HistoryPreviewSpecimen() {
    return (
        <View style={styles.cell} testID="dev-find-history-preview">
            <Text style={styles.cellTitle}>H1r · Conversations preview</Text>
            <Text style={styles.cellDescription}>The highlighted hit’s exchange, read on demand; Open in Happier lands on the match with Find.</Text>
            <View style={styles.row}>
                <View style={styles.panel}><ConversationPreview highlight={HIGHLIGHT} query={QUERY} disabled={false} exchange={{ failed: false, messages: [
                    { kind: 'user-text', id: 'dev-prompt', localId: null, createdAt: 1, text: 'The flaky e2e fails one run in five. Find out why.' },
                    { kind: 'agent-text', id: 'dev-item', realID: 'dev-item', localId: null, createdAt: 2, text: 'The flaky e2e is the settings sheet: it remounts when the viewport changes, so the test sometimes types into a sheet that is about to be replaced.' },
                ] }} /></View>
                <View style={styles.panel}><ConversationPreview highlight={null} query={QUERY} disabled={false} /></View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    cell: { marginTop: 28, gap: 4 },
    cellTitle: { fontSize: 13, fontWeight: '600', color: theme.colors.text.primary },
    cellDescription: { fontSize: 12.5, lineHeight: 17, color: theme.colors.text.secondary, marginBottom: 6 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    panel: { height: 420, flexDirection: 'row', overflow: 'hidden', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default, backgroundColor: theme.colors.surface.base },
}));
