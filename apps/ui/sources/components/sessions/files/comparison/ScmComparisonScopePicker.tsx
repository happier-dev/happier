import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import type { SessionScmReviewComparison } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useHappierInputPicker, useHappierInputPickerPort } from '@happier-dev/plugin-ui/presentation';
import { ScmComparisonSourceSchema } from '@happier-dev/protocol/scm/comparison';
import { resolveSemanticInputTypePickerReference } from '@/components/sessions/actions/inputTypePickerPort';
import { useInputTypePickerProjectionDemand } from '@/components/sessions/actions/InputTypePickerHostProvider';

import { filesComparisonScopeOptionKey, type FilesComparisonScopeOption } from './filesComparison';

/** Each source's glyph, so the six read apart at a glance (lab WT6-E2). */
const SOURCE_ICON: Readonly<Record<FilesComparisonScopeOption['sourceKind'], IconName>> = {
    workingTree: 'file-text',
    session: 'clock-counter-clockwise',
    turnCheckpoint: 'clock',
    branch: 'git-branch',
    commit: 'git-commit',
    pullRequest: 'git-pull-request',
};

export type ScmComparisonScopePickerProps = Readonly<{
    options: readonly FilesComparisonScopeOption[];
    current: SessionScmReviewComparison | null;
    currentEvidenceSessionId?: string;
    /** The label of what is shown (the option's own label, or the comparison's name when no option lists it). */
    currentLabel: string;
    fileCount: number | null;
    onSelect: (comparison: SessionScmReviewComparison, evidenceSessionId?: string) => void;
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
    useInputTypePickerProjectionDemand(open);
    const inputType = resolveSemanticInputTypePickerReference(useHappierInputPickerPort(), 'scmPullRequestComparison', { path: 'comparison' });
    // The contributed source picker returns into this mounted comparison; the host never parses a PR URL.
    const pullRequests = useHappierInputPicker({
        field: { path: 'comparison', title: t('scmComparison.scopePicker.pullRequestChoice'),
            ...(inputType ? { inputType } : {}) },
        value: props.current,
        onSelect: (value) => {
            const source = ScmComparisonSourceSchema.safeParse(value);
            if (source.success && source.data.kind === 'pullRequest') props.onSelect(source.data);
        },
    });
    const currentKey = props.current ? filesComparisonScopeOptionKey({ comparison: props.current,
        evidenceSessionId: props.current.kind === 'session' || props.current.kind === 'turnCheckpoint' ? props.currentEvidenceSessionId : undefined,
        sourceKind: props.current.kind }) : null;
    const items = React.useMemo<DropdownMenuItem[]>(() => props.options.filter(option =>
        option.comparison || option.sourceKind !== 'pullRequest' || pullRequests.affordance !== null,
    ).map((option) => ({
        id: filesComparisonScopeOptionKey(option),
        title: option.label,
        icon: <Icon name={SOURCE_ICON[option.sourceKind]} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
        subtitle: option.fileCount === null && filesComparisonScopeOptionKey(option) === currentKey && props.fileCount !== null
            ? `${option.subtitle} · ${t('scmComparison.fileCount', { count: props.fileCount })}` : option.subtitle,
        category: option.group === 'explainAndCommit'
            ? t('scmComparison.scopePicker.explainAndCommit')
            : t('scmComparison.scopePicker.explainOnly'),
        checked: filesComparisonScopeOptionKey(option) === currentKey,
        disabled: !option.comparison && option.sourceKind === 'turnCheckpoint',
    })), [currentKey, props.fileCount, props.options, pullRequests.affordance, theme.colors.text.secondary]);
    const byKey = React.useMemo(
        () => new Map(props.options.map((option) => [filesComparisonScopeOptionKey(option), option] as const)),
        [props.options],
    );
    const onSelect = props.onSelect;
    const select = React.useCallback((id: string) => {
        const option = byKey.get(id);
        if (!option) return;
        if (option.comparison) { onSelect(option.comparison, option.evidenceSessionId); return; }
        if (option.sourceKind === 'pullRequest') {
            if (pullRequests.affordance) void pullRequests.open();
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
    }, [byKey, onSelect, pullRequests.affordance, pullRequests.open]);
    const testID = props.testID ?? 'scm-comparison-scope';

    return (
        <DropdownMenu
            open={open}
            onOpenChange={setOpen}
            items={items}
            selectedId={currentKey}
            onSelect={select}
            footer={pullRequests.error ? <Text accessibilityRole="alert" variant="meta">{pullRequests.error}</Text> : undefined}
            search={false}
            showCategoryTitles
            matchTriggerWidth={false}
            maxWidthCap={360}
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
        gap: theme.space.s6,
        minHeight: 32,
        paddingHorizontal: theme.space.s10,
        borderRadius: theme.borderRadius.md,
        flexShrink: 1,
        minWidth: 0,
    },
    label: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
        flexShrink: 1,
        minWidth: 0,
    },
    count: {
        ...Typography.variant('body'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
