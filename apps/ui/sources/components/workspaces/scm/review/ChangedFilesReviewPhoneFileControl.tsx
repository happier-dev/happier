import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import type { MenuItemSource } from '@/components/ui/forms/dropdown/selectableMenuTypes';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { useGitDisplaySettings } from '@/components/sessions/panes/git/display/GitDisplayMenu';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { ChangedFilesReviewIndex } from './ChangedFilesReviewIndex';
import type { ChangedFilesReviewFindModel } from './useChangedFilesReviewFind';
import { ChangedFilesReviewFindCount } from './ChangedFilesReviewFind';

import type { ChangedFilesReviewFileIndex } from './changedFilesReviewFileIndex';
export { buildChangedFilesReviewFileIndex, type ChangedFilesReviewFileIndex } from './changedFilesReviewFileIndex';

/** Phone Files' position and jump control, using the same list/tree index and focus owner as the rail. */
export function ChangedFilesReviewPhoneFileControl(props: Readonly<{
    fileIndex: ChangedFilesReviewFileIndex;
    totalFiles?: number;
    listFooter?: React.ReactElement | null;
    findModel?: ChangedFilesReviewFindModel;
    activePath: string | null;
    rootPath: string | null;
    commentCountByPath: ReadonlyMap<string, number>;
    onFocusPath: (path: string) => void;
}>) {
    const { theme } = useUnistyles();
    const display = useGitDisplaySettings();
    const [open, setOpen] = React.useState(false);
    const { files, items, indexById } = props.fileIndex;
    const index = Math.max(0, props.activePath ? indexById.get(props.activePath) ?? -1 : -1);
    const active = files[index];
    const position = t('walkthrough.stopOf', { number: index + 1, total: files.length });
    const loadedCount = props.totalFiles !== undefined && props.totalFiles > files.length ? `${files.length} / ${props.totalFiles}` : null;
    const itemSource: MenuItemSource<DropdownMenuItem> = {
        items, indexById,
        getItem(index) {
            const item = items[index];
            return item ? { ...item, rightElement: <ChangedFilesReviewFindCount model={props.findModel} path={item.id} /> } : undefined;
        },
    };
    const focus = React.useCallback((path: string) => { props.onFocusPath(path); setOpen(false); }, [props.onFocusPath]);
    return <View testID="scm-comparison-file-control" style={styles.control}>
        <DropdownMenu testID="scm-comparison-file-picker" open={open} onOpenChange={setOpen}
            items={[]} itemSource={display.changesLayout === 'tree' ? undefined : itemSource} selectedId={props.activePath} onSelect={focus}
            emptyLabel={null}
            footer={display.changesLayout === 'tree' ? <><ChangedFilesReviewIndex files={files} totalFiles={props.totalFiles} activePath={props.activePath}
                findModel={props.findModel}
                commentCountByPath={props.commentCountByPath} onFocusPath={focus} rootPath={props.rootPath} placement="comparisonStream" />{props.listFooter}</> : props.listFooter}
            trigger={({ toggle }) => <HappierPressable testID="scm-comparison-file-trigger" accessibilityRole="button"
                accessibilityLabel={`${position}${loadedCount ? ` · ${loadedCount}` : ''} · ${active?.fullPath ?? ''}`} onPress={toggle}
                style={(state) => [styles.trigger, focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}>
                <Text style={styles.position}>{position}</Text>
                {loadedCount ? <Text style={styles.position}>{loadedCount}</Text> : null}
                <Text numberOfLines={1} style={styles.name}>{active?.fileName}</Text>
                <Icon name="caret-down" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            </HappierPressable>} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    control: { backgroundColor: theme.colors.surface.base, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border.default },
    trigger: { minHeight: 40, flexDirection: 'row', alignItems: 'center', gap: theme.space.s12, paddingHorizontal: theme.space.s16 },
    position: { ...Typography.variant('meta'), color: theme.colors.text.tertiary, fontVariant: ['tabular-nums'],  },
    name: { flex: 1, minWidth: 0, ...Typography.variant('body', 'semiBold'), color: theme.colors.text.primary,  },
}));
