import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ScmStatus } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import type { KeyboardCommandId } from '@/keyboard/types';
import { useKeyboardShortcutLabel } from '@/keyboard/shortcutLabels';
import { withShortcut } from '@/keyboard/withShortcut';
import { formatExactCount, formatScmDiffBadge } from './tabBadgeModel';

const styles = StyleSheet.create((theme) => ({
    content: { gap: theme.space.s4 },
    label: {  ...Typography.variant('meta'),  color: theme.colors.text.primary },
    branch: {  ...Typography.variant('meta'),  color: theme.colors.text.secondary },
    lines: { flexDirection: 'row', gap: theme.space.s4 },
    added: { color: theme.colors.versionControl.added.foreground },
    removed: { color: theme.colors.versionControl.removed.foreground },
}));

/** Cached summary only; mounted by the tooltip when hovered or keyboard-focused. */
export function GitActionRailTooltip({ scmStatus, shortcutCommandId }: Readonly<{
    scmStatus: ScmStatus | null | undefined;
    shortcutCommandId?: KeyboardCommandId;
}>) {
    const diff = formatScmDiffBadge(scmStatus);
    const shortcut = useKeyboardShortcutLabel(shortcutCommandId);
    const label = scmStatus
        ? `${t('settingsAppearance.tabBarBadges.gitChangedFiles')}: ${formatExactCount(diff?.changedFileCount ?? 0)}`
        : t('session.rightPanel.tabs.git');
    return (
        <View style={styles.content}>
            <Text style={styles.label}>{withShortcut(label, shortcut)}</Text>
            {diff && scmStatus?.isComplete !== false && (diff.added > 0 || diff.removed > 0) ? (
                <View style={styles.lines}>
                    <Text style={[styles.label, styles.added]}>{`+${diff.added}`}</Text>
                    <Text style={[styles.label, styles.removed]}>{`−${diff.removed}`}</Text>
                </View>
            ) : null}
            {(scmStatus?.aheadCount !== undefined || scmStatus?.behindCount !== undefined) ? (
                <View style={styles.lines}>
                    {scmStatus?.aheadCount !== undefined ? <Text style={styles.branch}>{`${t('files.branchSummary.ahead')}: ${formatExactCount(scmStatus.aheadCount)}`}</Text> : null}
                    {scmStatus?.behindCount !== undefined ? <Text style={styles.branch}>{`${t('files.branchSummary.behind')}: ${formatExactCount(scmStatus.behindCount)}`}</Text> : null}
                </View>
            ) : null}
            {scmStatus?.branch ? <Text style={styles.branch}>{t('newSession.checkout.detailBranch', { branch: scmStatus.branch })}</Text> : null}
        </View>
    );
}
