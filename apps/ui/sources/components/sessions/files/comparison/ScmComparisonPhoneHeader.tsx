import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { DetailsTabHeader } from '@/components/appShell/panes/details/header/DetailsTabHeader';
import { useLentHeaderMenuRows } from '@/components/navigation/stackHeaderActions';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveSessionScmReviewViewLabel, type SessionScmReviewView } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';
import { ScmComparisonScopePicker, type ScmComparisonScopePickerProps } from './ScmComparisonScopePicker';
import { scmComparisonMenuSectionItems, selectScmComparisonMenuItem, type ScmComparisonMenuSection } from './ScmComparisonMoreMenu';

export type { ScmComparisonMenuSection } from './ScmComparisonMoreMenu';

/**
 * Phone comparison header: the Details tab header every phone Details page wears (the file viewer's too), with
 * the same scope and actions as the wide bar. Its title is the scope picker, drawn at the header's own title
 * size. The comparison is always a Details tab, so it draws no Back: the tab closes from its tab (the strip,
 * or on a phone the Session's tabs rail), and the Session header keeps the screen's one Back (owner ruling
 * 2026-10-30). While the tab's group gives way to it, the group's own controls join the header as on any tab.
 */
export function ScmComparisonPhoneHeader(props: Readonly<{
    view: SessionScmReviewView;
    views: readonly SessionScmReviewView[];
    scope: ScmComparisonScopePickerProps;
    onSelectView: (view: SessionScmReviewView) => void;
    /** Null when the comparison has nothing to review: the row is not offered. */
    onStartReview: (() => void) | null;
    reviewDisabled?: boolean;
    reviewDisabledReason?: string | null;
    onProposeCommits?: (() => void) | null;
    /** The view's own menu rows, after the comparison's actions and its view choice. */
    sections?: readonly ScmComparisonMenuSection[];
    /** View-owned content that is not a menu row (a walkthrough's review progress), under the rows. */
    extraActions?: React.ReactNode;
}>) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    // One menu, in the order it is used: what to do with these changes, which view of them, how they are drawn.
    const sections = props.sections ?? [];
    const untitled = sections.filter((section) => !section.title);
    const titled = sections.filter((section) => section.title);
    const sectionItems = scmComparisonMenuSectionItems;
    // The tab's own rows (pin, close), which its strip carried before giving way to this header.
    const tabRows = useLentHeaderMenuRows() ?? [];
    const items: DropdownMenuItem[] = [
        ...untitled.flatMap((section) => sectionItems(section, '')),
        ...(props.onStartReview ? [{ id: 'start-review', testID: 'scm-comparison-start-review', title: t('scmComparison.startReview'), category: '',
            icon: <Icon name="shield-check" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
            disabled: props.reviewDisabled, subtitle: props.reviewDisabledReason ?? undefined }] : []),
        ...(props.onProposeCommits ? [{ id: 'propose-commits', title: t('scmComparison.proposeCommits'), category: '',
            icon: <Icon name="git-commit" size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> }] : []),
        ...tabRows.map((row) => ({ id: `tab:${row.id}`, testID: row.testID, title: row.title, category: '',
            icon: <Icon name={row.iconName} size={ICON_SIZE.sm} color={theme.colors.text.secondary} /> })),
        ...props.views.map((view) => ({ id: `view:${view}`, title: resolveSessionScmReviewViewLabel(view),
            checked: props.view === view, category: t('scmComparison.viewA11y') })),
        ...titled.flatMap((section) => sectionItems(section, section.title!)),
    ];
    const meta = [
        { key: 'scope', text: props.scope.currentLabel },
        ...(props.scope.fileCount === null ? [] : [{ key: 'files', text: t('scmComparison.fileCount', { count: props.scope.fileCount }) }]),
    ];
    return <DetailsTabHeader testID="scm-comparison-phone-header" title={resolveSessionScmReviewViewLabel(props.view)} meta={meta}
        titleControl={(title) => <ScmComparisonScopePicker {...props.scope} renderTrigger={({ toggle, open: scopeOpen }) => (
            <HappierPressable testID="scm-comparison-phone-scope" style={styles.titleTrigger} onPress={toggle}
                accessibilityRole="button" accessibilityLabel={t('scmComparison.scopePicker.a11y')}
                accessibilityValue={{ text: props.scope.currentLabel }}>
                {title}
                <Icon name={scopeOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />
            </HappierPressable>
        )} />}
        menu={<DropdownMenu testID="scm-comparison-phone-actions" open={open} onOpenChange={setOpen}
            items={items} search={false} matchTriggerWidth={false} placement="bottom" popoverAnchorAlign="end"
            showCategoryTitles
            footer={props.extraActions ? <View style={styles.extraActions}>{props.extraActions}</View> : undefined}
            onSelect={(id) => {
                const view = props.views.find((candidate) => id === `view:${candidate}`);
                if (selectScmComparisonMenuItem(sections, id)) return;
                const tabRow = tabRows.find((row) => id === `tab:${row.id}`);
                if (tabRow) { tabRow.onSelect(); return; }
                if (view) props.onSelectView(view);
                else if (id === 'start-review' && !props.reviewDisabled) props.onStartReview?.();
                else if (id === 'propose-commits') props.onProposeCommits?.();
            }}
            trigger={({ toggle }) => <IconButton testID="scm-comparison-phone-more" iconName="dots-three" variant="plain"
                accessibilityLabel={t('common.more')} onPress={toggle} />} />} />;
}

const styles = StyleSheet.create((theme) => ({
    // The title and its caret read as one control, the caret on the title's line.
    titleTrigger: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6, flexShrink: 1, minWidth: 0 },
    extraActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 12 },
}));
