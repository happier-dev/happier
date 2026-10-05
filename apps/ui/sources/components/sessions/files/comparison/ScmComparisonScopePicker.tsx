import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useCompactAppDestinations, useActivateAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';

import { filesComparisonScopeOptionKey, scmComparisonKey, type FilesComparisonScopeOption } from './filesComparison';

export type ScmComparisonScopePickerProps = Readonly<{
    options: readonly FilesComparisonScopeOption[];
    current: SessionScmReviewComparison | null;
    /** The label of what is shown (the option's own label, or the comparison's name when no option lists it). */
    currentLabel: string;
    fileCount: number | null;
    onSelect: (comparison: SessionScmReviewComparison) => void;
    testID?: string;
    renderTrigger?: (controls: Readonly<{ toggle: () => void; open: boolean }>) => React.ReactNode;
}>;

/**
 * Which changes Files shows (Walkthrough lab WT6-E2): one quiet trigger in the bar ("This session
 * 9 files") opening the scopes, grouped by consequence: Pending changes can be explained and
 * committed, every other scope can only be explained.
 */
export const ScmComparisonScopePicker = React.memo(function ScmComparisonScopePicker(props: ScmComparisonScopePickerProps) {
    const { theme } = useUnistyles();
    const [open, setOpen] = React.useState(false);
    const destinations = useCompactAppDestinations();
    const activateDestination = useActivateAppDestination();
    // PR selection belongs to Triage's source and Session admission, never a host URL/locator parser.
    const pullRequests = destinations.find((destination) => destination.kind === 'plugin'
        && destination.container === 'appPage' && destination.destination.pluginId === 'happier.triage');
    const currentKey = props.current ? scmComparisonKey(props.current) : null;
    const items = React.useMemo<DropdownMenuItem[]>(() => props.options.map((option) => ({
        id: filesComparisonScopeOptionKey(option),
        title: option.label,
        subtitle: option.fileCount === null && filesComparisonScopeOptionKey(option) === currentKey && props.fileCount !== null
            ? `${option.subtitle} · ${t('scmComparison.fileCount', { count: props.fileCount })}` : option.subtitle,
        category: option.group === 'explainAndCommit'
            ? t('scmComparison.scopePicker.explainAndCommit')
            : t('scmComparison.scopePicker.explainOnly'),
        checked: filesComparisonScopeOptionKey(option) === currentKey,
        disabled: !option.comparison && (option.sourceKind === 'turnCheckpoint'
            || (option.sourceKind === 'pullRequest' && pullRequests?.availability !== 'available')),
    })), [currentKey, props.fileCount, props.options, pullRequests?.availability]);
    const byKey = React.useMemo(
        () => new Map(props.options.map((option) => [filesComparisonScopeOptionKey(option), option] as const)),
        [props.options],
    );
    const onSelect = props.onSelect;
    const select = React.useCallback((id: string) => {
        const option = byKey.get(id);
        if (!option) return;
        if (option.comparison) { onSelect(option.comparison); return; }
        if (option.sourceKind === 'pullRequest') {
            if (pullRequests?.availability === 'available') activateDestination(pullRequests);
            return;
        }
        const chooseRefs = async () => {
            if (option.sourceKind === 'branch') {
                const head = await Modal.prompt(t('scmComparison.scopePicker.branchChoice'), t('scmComparison.scopePicker.headRef'));
                if (!head?.trim()) return;
                const base = await Modal.prompt(t('scmComparison.scopePicker.branchChoice'), t('scmComparison.scopePicker.baseRef'));
                if (base?.trim()) onSelect({ kind: 'branch', head: head.trim(), base: base.trim() });
            } else if (option.sourceKind === 'commit') {
                const commit = await Modal.prompt(t('scmComparison.scopePicker.commitChoice'), t('scmComparison.scopePicker.commitDescription'));
                if (!commit?.trim()) return;
                const parent = await Modal.prompt(t('scmComparison.scopePicker.commitChoice'), t('scmComparison.scopePicker.parentRef'));
                if (parent === null) return;
                onSelect({ kind: 'commit', commit: commit.trim(), ...(parent.trim() ? { parent: parent.trim() } : {}) });
            }
        };
        void chooseRefs();
    }, [activateDestination, byKey, onSelect, pullRequests]);
    const testID = props.testID ?? 'scm-comparison-scope';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={currentKey}
            onSelect={select}
            search={false}
            showCategoryTitles
            matchTriggerWidth={false}
            maxWidthCap={280}
            placement="bottom"
            popoverAnchorAlign="start"
            trigger={({ toggle, open: triggerOpen }) => props.renderTrigger ? props.renderTrigger({ toggle, open: triggerOpen }) : (
                <Pressable
                    testID={testID}
                    accessibilityRole="button"
                    accessibilityLabel={t('scmComparison.scopePicker.a11y')}
                    accessibilityValue={{ text: props.currentLabel }}
                    onPress={toggle}
                    style={({ pressed }) => [styles.trigger, { opacity: pressed ? motionTokens.press.opacity : 1 }]}
                >
                    <Icon name="git-diff" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    <Text numberOfLines={1} style={styles.label}>{props.currentLabel}</Text>
                    {props.fileCount !== null ? (
                        <Text style={styles.count}>{t('scmComparison.fileCount', { count: props.fileCount })}</Text>
                    ) : null}
                    <View>
                        <Icon name={triggerOpen ? 'caret-up' : 'caret-down'} size={ICON_SIZE.xs} color={theme.colors.text.tertiary} />
                    </View>
                </Pressable>
            )}
        />
    );
});

const styles = StyleSheet.create((theme) => ({
    trigger: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 7,
        minHeight: 32,
        paddingHorizontal: 10,
        borderRadius: theme.borderRadius.md,
        flexShrink: 1,
        minWidth: 0,
    },
    label: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
        flexShrink: 1,
        minWidth: 0,
    },
    count: {
        fontSize: 13,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
        ...Typography.default(),
    },
}));
