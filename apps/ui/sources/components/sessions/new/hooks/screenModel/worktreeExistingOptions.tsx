import * as React from 'react';
import { View } from 'react-native';

import {
    type SelectionListOption,
    type SelectionListStatusVariant,
} from '@/components/ui/selectionList';
import { RelativeTimeText } from '@/components/ui/selectionList/accessories/RelativeTimeText';
import { StatusPill as BaseStatusPill, type StatusPillVariant } from '@/components/ui/status/StatusPill';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import type { ScmWorktree } from '@happier-dev/protocol/scm/workingSnapshot';
import { useSessionListRuntimeDeadlineNowMs } from '@/hooks/session/sessionListRuntimeClock';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { readRelativeTimeShortRefreshAtMs } from '@/utils/time/formatShortRelativeTime';

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

/** Only a mounted row consumes time. The closed picker keeps no clock or timer. */
function WorktreeRowDetails({ worktree }: Readonly<{ worktree: ScmWorktree }>): React.ReactElement {
    const presented = useLayoutPresentationActive();
    const { lastActivityAt, changeCount } = worktree;
    const readNextRefreshAtMs = React.useCallback((nowMs: number) => {
        if (lastActivityAt === undefined) return null;
        const ageAt = readRelativeTimeShortRefreshAtMs(lastActivityAt, nowMs);
        const staleAt = changeCount === 0 ? lastActivityAt + NEW_SESSION_WORKTREE_STALE_THRESHOLD_MS + 1 : null;
        return staleAt !== null && staleAt > nowMs
            ? ageAt === null ? staleAt : Math.min(ageAt, staleAt)
            : ageAt;
    }, [changeCount, lastActivityAt]);
    const nowMs = useSessionListRuntimeDeadlineNowMs(readNextRefreshAtMs, presented);
    const variant = resolveWorktreeStatusVariant({ changeCount, lastActivityAt, nowMs });
    // Count and suffix are separate so the pill never repeats the number.
    const dirtyChangeCount = variant === 'dirty' ? changeCount : undefined;
    const pillLabel = variant === 'dirty'
        ? t('newSession.worktree.statusPill.changesSuffix', { count: dirtyChangeCount ?? 0 })
        : variant === 'stale'
            ? t('newSession.worktree.statusPill.idle')
            : t('newSession.worktree.statusPill.clean');
    return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            {lastActivityAt !== undefined ? (
                <RelativeTimeText atMs={lastActivityAt} nowMs={nowMs} testID={`worktree-row-age:${worktree.path}`} />
            ) : null}
            {variant !== null ? (
                <WorktreeStatusPill variant={variant} label={pillLabel} count={dirtyChangeCount}
                    testID={`worktree-row-status:${worktree.path}`} />
            ) : null}
        </View>
    );
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
                rightAccessory: <WorktreeRowDetails worktree={worktree} />,
                onSelect: () => params.onSelectExistingWorktree(worktree.path),
            } satisfies SelectionListOption;
        });
}
