import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { Avatar } from '@/components/ui/avatar/Avatar';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { DetailsTabHeader, type DetailsTabHeaderMetaFact } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SurfaceFreshnessLine } from '@/components/ui/surfaces/SurfaceFreshnessLine';
import type { ScmCommitLogEntryState } from '@/scm/history/useScmCommitLogEntry';
import { formatScmHistoryTimestamp } from '@/scm/history/historyPresentation';
import { t } from '@/text';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

const SHORT_SHA_LENGTH = 7;

/**
 * A commit's Details header (details lab 2, CM): the commit is its message — the subject as the
 * title, who made it and when, the short SHA to copy, then the body. Shared by the Session and the
 * project commit views so a commit reads the same wherever it is opened.
 */
export const ScmCommitDetailsHeader = React.memo(function ScmCommitDetailsHeader(props: Readonly<{
    sha: string;
    commit: ScmCommitLogEntryState;
    /** Quiet view controls for the stream (split, wrap). */
    actions?: React.ReactNode;
    /** An SCM operation running on this repository ("revert"). */
    runningOperation?: string | null;
    testID?: string;
}>) {
    const entry = props.commit.entry;
    const { theme } = useUnistyles();
    const shortSha = entry?.shortSha?.trim() || props.sha.slice(0, SHORT_SHA_LENGTH);
    const copySha = React.useCallback(() => {
        void setClipboardStringSafe(entry?.sha ?? props.sha);
    }, [entry?.sha, props.sha]);

    const meta = React.useMemo((): DetailsTabHeaderMetaFact[] => {
        const facts: DetailsTabHeaderMetaFact[] = [];
        const when = entry ? formatScmHistoryTimestamp(entry.timestamp) : '';
        if (when) facts.push({ key: 'when', text: when });
        facts.push({ key: 'sha', text: shortSha, tone: 'mono', testID: 'scm-commit-details-short-sha' });
        return facts;
    }, [entry, shortSha]);

    const body = entry?.body?.trim() ? entry.body.trim() : undefined;

    return (
        <DetailsTabHeader
            testID={props.testID ?? 'scm-commit-details-header'}
            title={entry?.subject?.trim() || shortSha}
            titleTextStyle={{ fontSize: 17, lineHeight: 22 }}
            leading={<Icon name="git-commit" size={20} color={theme.colors.text.secondary} />}
            metaLeading={entry?.authorName ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Avatar id={entry.authorEmail || entry.authorName} size={16} />
                    <Text style={{ color: theme.colors.text.primary, fontSize: 12, ...Typography.default('semiBold') }}>{entry.authorName}</Text>
                </View>
            ) : undefined}
            meta={meta}
            body={body}
            metaTrailing={(
                    <IconButton
                        variant="plain"
                        size={28}
                        iconSize={14}
                        iconName="copy"
                        onPress={copySha}
                        accessibilityLabel={t('detailsSurface.history.copyCommitSha')}
                        tooltip={t('detailsSurface.history.copyCommitSha')}
                        testID="scm-commit-details-copy-sha"
                    />
            )}
            actions={props.actions}
            menuActions={[{ id: 'copy-sha', title: t('detailsSurface.history.copyCommitSha'), testID: 'scm-commit-details-menu-copy-sha', onSelect: copySha }]}
            notice={props.runningOperation ? (
                <SurfaceFreshnessLine
                    testID="scm-commit-details-running"
                    reason={t('files.commitDetails.running', { operation: props.runningOperation })}
                    busy
                />
            ) : null}
        />
    );
});
