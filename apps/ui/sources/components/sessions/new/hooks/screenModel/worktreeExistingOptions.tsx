import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import {
    type SelectionListOption,
    type SelectionListStatusVariant,
} from '@/components/ui/selectionList';
import { StatusPill as BaseStatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { buildWorktreeCheckoutOptionId } from '@/components/sessions/new/modules/worktreeCheckoutOptionId';
import { pathsAreSameWorktree } from '@/components/sessions/new/modules/worktreePathComparison';

import { NEW_SESSION_WORKTREE_STALE_THRESHOLD_MS } from './_constants';
import type { WorktreeSelectionListBuilderParams } from './buildWorktreeSelectionListSteps';

const WORKTREE_ROW_ICON_SIZE = 16;
const STATUS_VARIANT_MAP = {
    clean: 'success',
    dirty: 'warning',
    stale: 'neutral',
    info: 'info',
    neutral: 'neutral',
} as const satisfies Record<SelectionListStatusVariant, StatusPillVariant>;

function formatWorktreeRelativeAge(atMs: number, nowMs: number): string {
    const diffMs = Math.max(0, nowMs - atMs);
    const minutes = Math.max(1, Math.floor(diffMs / 60_000));
    if (minutes < 60) return t('time.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('time.hoursAgo', { count: hours });
    return t('time.daysAgoShort', { count: Math.floor(hours / 24) });
}

function WorktreeRelativeTimeText(props: Readonly<{
    atMs: number;
    nowMs: number;
    testID: string;
}>): React.ReactElement {
    const { theme } = useUnistyles();
    return (
        <Text testID={props.testID} style={[Typography.tabular(), { color: theme.colors.text.secondary }]}>
            {formatWorktreeRelativeAge(props.atMs, props.nowMs)}
        </Text>
    );
}

function WorktreeStatusPill(props: Readonly<{
    variant: SelectionListStatusVariant;
    label: string;
    count?: number;
    testID: string;
}>): React.ReactElement {
    const selectionVariant = props.variant;
    return (
        <BaseStatusPill
            variant={STATUS_VARIANT_MAP[selectionVariant]}
            label={props.label}
            count={props.count}
            testID={props.testID}
            variantTestID={`${props.testID}:variant:${selectionVariant}`}
        />
    );
}

/**
 * Pure derivation: status variant for a worktree row.
 *
 * Returns `null` when:
 *   - The SCM provided neither field (back-compat with older snapshots that don't carry
 *     status enrichment), OR
 *   - `changeCount` is undefined regardless of `lastActivityAt` (FR4-5).
 *
 * The FR4-5 rule is essential when `git status --porcelain -z` fails while `git log` succeeds
 * for the same worktree: without it, we'd render a misleading clean/stale pill despite the
 * dirty state being unknown. The age accessory (`RelativeTimeText`) stays independent and may
 * still render — age is meaningful even when the status pill is suppressed.
 */
export function resolveWorktreeStatusVariant(args: Readonly<{
    changeCount: number | undefined;
    lastActivityAt: number | undefined;
    nowMs: number;
}>): SelectionListStatusVariant | null {
    if (args.changeCount === undefined) {
        return null;
    }
    if (args.changeCount > 0) return 'dirty';
    if (
        args.lastActivityAt !== undefined
        && args.nowMs - args.lastActivityAt > NEW_SESSION_WORKTREE_STALE_THRESHOLD_MS
    ) {
        return 'stale';
    }
    return 'clean';
}

export function buildExistingWorktreeOptions(
    params: WorktreeSelectionListBuilderParams,
): ReadonlyArray<SelectionListOption> {
    const worktrees = params.snapshot?.repo.worktrees ?? [];
    return worktrees
        .filter((worktree) => {
            if (worktree.isMain === true) return false;
            if (worktree.isCurrent === true) return false;
            return !pathsAreSameWorktree(
                worktree.path,
                params.currentDirPath,
                params.machineHomeDir,
                params.machinePlatform,
            );
        })
        .map((worktree) => {
            const label = worktree.branch ?? worktree.path;
            const variant = resolveWorktreeStatusVariant({
                changeCount: worktree.changeCount,
                lastActivityAt: worktree.lastActivityAt,
                nowMs: params.nowMs,
            });
            // Pill rendering: pass `count` xor a short suffix `label` so the pill never
            // duplicates the count (the wrapper renders `<count> <label>`; passing a
            // pre-formatted "3 changes" alongside `count={3}` would print "3 3 changes").
            const dirtyChangeCount = variant === 'dirty' ? worktree.changeCount : undefined;
            const pillLabel = variant === 'dirty'
                ? t('newSession.worktree.statusPill.changesSuffix', { count: dirtyChangeCount ?? 0 })
                : variant === 'stale'
                    ? t('newSession.worktree.statusPill.idle')
                    : t('newSession.worktree.statusPill.clean');
            // The relative-age text and the status pill sit in a gapped row so
            // they read as two distinct accessories (the age is secondary text;
            // the pill carries the status colour) rather than colliding.
            const accessory = (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    {worktree.lastActivityAt !== undefined ? (
                        <WorktreeRelativeTimeText
                            atMs={worktree.lastActivityAt}
                            nowMs={params.nowMs}
                            testID={`worktree-row-age:${worktree.path}`}
                        />
                    ) : null}
                    {variant !== null ? (
                        <WorktreeStatusPill
                            variant={variant}
                            label={pillLabel}
                            count={dirtyChangeCount}
                            testID={`worktree-row-status:${worktree.path}`}
                        />
                    ) : null}
                </View>
            );
            // The row id MUST be derived through the shared
            // `buildWorktreeCheckoutOptionId` owner so it matches the chip
            // model's `selectedOptionId` byte-for-byte; otherwise a selected
            // existing worktree fails to highlight / scroll into view on reopen
            // whenever the raw path needs normalization (trailing slash, mixed
            // separators).
            return {
                id: buildWorktreeCheckoutOptionId(worktree.path, {
                    machineHomeDir: params.machineHomeDir ?? null,
                    machinePlatform: params.machinePlatform ?? null,
                }),
                label,
                subtitle: worktree.path,
                icon: <Icon name="graph" size={WORKTREE_ROW_ICON_SIZE} color={params.rowIconColor} />,
                rightAccessory: accessory,
                onSelect: () => params.onSelectExistingWorktree(worktree.path),
            } satisfies SelectionListOption;
        });
}
