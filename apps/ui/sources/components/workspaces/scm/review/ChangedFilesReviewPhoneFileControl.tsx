import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { Typography } from '@/constants/Typography';
import type { ScmFileStatus } from '@/scm/scmStatusFiles';
import { t } from '@/text';
import { ChangedFilesReviewIndex } from './ChangedFilesReviewIndex';

/** Phone Files' position and jump control, using the same list/tree index and focus owner as the rail. */
export function ChangedFilesReviewPhoneFileControl(props: Readonly<{
    files: readonly ScmFileStatus[];
    activePath: string | null;
    rootPath: string | null;
    commentCountByPath: ReadonlyMap<string, number>;
    onFocusPath: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const display = useGitDisplaySettings();
    const [open, setOpen] = React.useState(false);
    const index = Math.max(0, props.files.findIndex((file) => file.fullPath === props.activePath));
    const active = props.files[index];
    const position = t('walkthrough.stopOf', { number: index + 1, total: props.files.length });
    const items = React.useMemo(() => props.files.map((file) => ({
        id: file.fullPath, title: file.fileName, subtitle: file.filePath, accessibilityLabel: file.fullPath,
    })), [props.files]);
    const focus = React.useCallback((path: string) => { props.onFocusPath(path); setOpen(false); }, [props.onFocusPath]);
    return <View testID="scm-comparison-file-control" style={styles.control}>
        <DropdownMenu testID="scm-comparison-file-picker" open={open} onOpenChange={setOpen}
            items={display.changesLayout === 'tree' ? [] : items} selectedId={props.activePath} onSelect={focus}
            emptyLabel={null}
            footer={display.changesLayout === 'tree' ? <ChangedFilesReviewIndex files={props.files} activePath={props.activePath}
                commentCountByPath={props.commentCountByPath} onFocusPath={focus} rootPath={props.rootPath} placement="comparisonStream" /> : null}
            trigger={({ toggle }) => <HappierPressable testID="scm-comparison-file-trigger" accessibilityRole="button"
                accessibilityLabel={`${position} · ${active?.fullPath ?? ''}`} onPress={toggle}
                style={(state) => [styles.trigger, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                <Text style={styles.position}>{position}</Text>
                <Text numberOfLines={1} style={styles.name}>{active?.fileName}</Text>
                <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            </HappierPressable>} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    control: { backgroundColor: theme.colors.surface.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default },
    trigger: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
    position: { fontSize: 12, color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'], ...Typography.default() },
    name: { flex: 1, minWidth: 0, fontSize: 13, color: theme.colors.text.primary, ...Typography.default('semiBold') },
}));
