import { Typography } from '@/constants/Typography';
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
    agentId: 'claude',
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
                <View style={styles.panel}><ConversationPreview highlight={HIGHLIGHT} query={QUERY} disabled={false} exchange={{ failed: false, matchedMessageId: 'dev-item', elidedMessageCount: 43, messages: [
                    { kind: 'user-text', id: 'dev-prompt', localId: null, createdAt: 1, text: 'The flaky e2e fails one run in five. Find out why, and keep the fix small: the release branch is cut on Friday and I would rather not touch the settings sheet unless it is the cause. Start from the last red run on main and work backwards through what changed in the viewport handling.' },
                    { kind: 'agent-text', id: 'dev-item', realID: 'dev-item', localId: null, createdAt: 2, text: 'The flaky e2e is the settings sheet: it remounts when the viewport changes, so the test sometimes types into a sheet that is about to be replaced.' },
                ] }} /></View>
                <View style={styles.panel}><ConversationPreview highlight={null} query={QUERY} disabled={false} /></View>
                <View style={styles.panel} testID="dev-find-history-preview-failed"><ConversationPreview highlight={HIGHLIGHT} query={QUERY} disabled={false}
                    exchange={{ failed: true, messages: [] }} onRetry={noop} /></View>
            </View>
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    cell: { marginTop: 28, gap: theme.space.s4 },
    cellTitle: { ...Typography.variant('body', 'semiBold'),  color: theme.colors.text.primary },
    cellDescription: { fontSize: 12.5, lineHeight: 17, color: theme.colors.text.secondary, marginBottom: theme.space.s6 },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: 22 },
    panel: { height: 420, flexDirection: 'row', overflow: 'hidden', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default, backgroundColor: theme.colors.surface.base },
}));
