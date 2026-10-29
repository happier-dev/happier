import * as React from 'react';
import { HappierBreadcrumb, type HappierBreadcrumbItem } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DETAILS_TAB_HEADER_METRICS } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { useSurfaceStateSize } from '@/components/ui/surfaces/surfaceStateSize';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

/** Folders kept at each end before the middle folds into "…" (lab FV1: `apps › ui › … › settings › modal`). */
const KEPT_AT_EACH_END = 2;

export type FilePageCrumb = Readonly<{ key: string; label: string; path: string | null }>;

/**
 * The parent folders of a workspace-relative file path; past five, the middle folds into one "…". A host that
 * names the repository (the Code page) puts its root first, opening the root listing.
 */
export function buildFilePageCrumbs(filePath: string, rootLabel?: string | null): readonly FilePageCrumb[] {
    const root: FilePageCrumb[] = rootLabel ? [{ key: '/', label: rootLabel, path: '' }] : [];
    return [...root, ...buildFolderCrumbs(filePath)];
}

function buildFolderCrumbs(filePath: string): readonly FilePageCrumb[] {
    const folders = filePath.split('/').filter(Boolean).slice(0, -1);
    const crumbs = folders.map((label, index) => {
        const path = folders.slice(0, index + 1).join('/');
        return { key: path, label, path };
    });
    if (crumbs.length <= KEPT_AT_EACH_END * 2 + 1) return crumbs;
    const hidden = crumbs.slice(KEPT_AT_EACH_END, -KEPT_AT_EACH_END);
    return [
        ...crumbs.slice(0, KEPT_AT_EACH_END),
        { key: `…/${hidden.map((crumb) => crumb.label).join('/')}`, label: '…', path: null },
        ...crumbs.slice(-KEPT_AT_EACH_END),
    ];
}

/** Where the file lives: its folders, each opening that folder (the Code page or the Files tree). */
export const FilePageBreadcrumb = React.memo(function FilePageBreadcrumb(props: Readonly<{
    filePath: string;
    rootLabel?: string | null;
    onOpenFolder?: (folderPath: string) => void;
    testID?: string;
}>) {
    const { theme } = useUnistyles();
    const phone = useSurfaceStateSize() === 'phone';
    const textStyle = DETAILS_TAB_HEADER_METRICS[phone ? 'phone' : 'pane'].meta;
    const testID = props.testID ?? 'file-page-breadcrumb';
    const crumbs = React.useMemo(() => buildFilePageCrumbs(props.filePath, props.rootLabel), [props.filePath, props.rootLabel]);
    const onOpenFolder = props.onOpenFolder;
    const items = React.useMemo<HappierBreadcrumbItem[]>(() => crumbs.map((crumb, index) => ({
        key: crumb.key,
        label: crumb.label,
        testID: `${testID}-${index}`,
        ...(crumb.path !== null && onOpenFolder ? { onPress: () => onOpenFolder(crumb.path!) } : {}),
    })), [crumbs, onOpenFolder, testID]);
    if (items.length === 0) return null;
    return (
        <HappierBreadcrumb
            testID={testID}
            accessibilityLabel={t('files.pane.page.folders')}
            items={items}
            style={styles.row}
            linkStyle={styles.link}
            colors={{ focus: theme.colors.border.focus, hover: theme.colors.surface.hover }}
            separator={<Text style={[textStyle, styles.separator]} accessibilityElementsHidden importantForAccessibility="no">›</Text>}
            renderLabel={(item) => <Text numberOfLines={1} style={[textStyle, styles.label]}>{item.label}</Text>}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    row: {
        flexShrink: 1,
        gap: theme.space.s2,
    },
    link: {
        borderRadius: theme.space.s4,
    },
    label: {
        color: theme.colors.text.secondary,
    },
    separator: {
        color: theme.colors.text.tertiary,
    },
}));
