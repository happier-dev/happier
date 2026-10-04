import {
    getPreferredChangedFilesViewMode,
    isChangedFilesViewModeAvailable,
    type ChangedFilesViewMode,
    type ChangedFilesViewModeAvailability,
} from '@/scm/scmAttribution';
import {
    resolveSessionScmReviewComparisonLabel,
    type SessionScmReviewComparison,
} from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { t } from '@/text';

/**
 * What the Files view draws for a comparison. The comparison (from the link or the scope picker) is
 * the one decision; the changed-files data mode is derived from it, never chosen beside it.
 * `captured`: exact machine-owned evidence, independent of the current checkout.
 */
export type FilesComparisonPresentation =
    | Readonly<{ kind: 'changedFiles'; mode: ChangedFilesViewMode }>
    | Readonly<{ kind: 'captured' }>
    | Readonly<{ kind: 'unsupported' }>;

type Availability = Pick<
    ChangedFilesViewModeAvailability,
    'showTurnViewToggle' | 'showTurnAgentReportedViewToggle' | 'showTurnCheckpointViewToggle' | 'showSessionViewToggle'
>;

export function resolveFilesComparisonPresentation(
    comparison: SessionScmReviewComparison | null,
    availability: Availability,
): FilesComparisonPresentation {
    if (!comparison) return { kind: 'changedFiles', mode: getPreferredChangedFilesViewMode(availability) };
    if (comparison.comparisonId) return { kind: 'captured' };
    switch (comparison.kind) {
        case 'workingTree': return { kind: 'changedFiles', mode: 'repository' };
        case 'session': return { kind: 'captured' };
        case 'turnCheckpoint':
            if (!comparison.turnId) return comparison.checkpointReceiptId ? { kind: 'captured' } : { kind: 'unsupported' };
            return {
                kind: 'changedFiles',
                mode: comparison.evidence === 'checkpoint'
                    ? 'turn_checkpoint'
                    : comparison.evidence === 'agent_reported' ? 'turn_agent_reported' : 'turn',
            };
        case 'branch':
        case 'commit':
        case 'pullRequest':
            return { kind: 'captured' };
    }
}

/** A data mode named as the comparison it shows (a link without a comparison still shows one). */
export function describeChangedFilesModeAsComparison(
    mode: ChangedFilesViewMode,
    latestTurnId: string | null,
): SessionScmReviewComparison | null {
    switch (mode) {
        case 'repository':
        case 'selected':
            return { kind: 'workingTree' };
        case 'session':
            return { kind: 'session' };
        case 'turn':
            return latestTurnId ? { kind: 'turnCheckpoint', turnId: latestTurnId } : null;
        case 'turn_agent_reported':
            return latestTurnId ? { kind: 'turnCheckpoint', turnId: latestTurnId, evidence: 'agent_reported' } : null;
        case 'turn_checkpoint':
            return latestTurnId ? { kind: 'turnCheckpoint', turnId: latestTurnId, evidence: 'checkpoint' } : null;
    }
}

function sourceKey(comparison: SessionScmReviewComparison): string {
    switch (comparison.kind) {
        case 'workingTree':
        case 'session':
            return comparison.kind;
        case 'turnCheckpoint':
            if (comparison.checkpointReceiptId) return JSON.stringify(['turnCheckpoint', comparison.turnId ?? null, comparison.checkpointReceiptId, comparison.evidence ?? null]);
            return comparison.evidence ? `turnCheckpoint:${comparison.turnId}:${comparison.evidence}` : `turnCheckpoint:${comparison.turnId}`;
        case 'branch':
            return `branch:${comparison.head}:${comparison.base}`;
        case 'commit':
            return comparison.parent ? `commit:${comparison.commit}:${comparison.parent}` : `commit:${comparison.commit}`;
        case 'pullRequest': return JSON.stringify(['pullRequest', comparison.locator]);
    }
}

export function scmComparisonKey(comparison: SessionScmReviewComparison): string {
    return comparison.comparisonId ? `${sourceKey(comparison)}:${comparison.comparisonId}` : sourceKey(comparison);
}

export type FilesComparisonScopeOption = Readonly<{
    comparison: SessionScmReviewComparison | null;
    /** An unselected source opens its existing admission UI, not a fabricated comparison. */
    sourceKind: SessionScmReviewComparison['kind'];
    /** Pending changes can be explained and committed; every other scope can only be explained. */
    group: 'explainAndCommit' | 'explainOnly';
    label: string;
    subtitle: string;
    fileCount: number | null;
}>;

/** The scope name a person reads, for the picker and the header. */
export function resolveFilesComparisonLabel(comparison: SessionScmReviewComparison, latestTurnId: string | null): string {
    if (comparison.kind !== 'turnCheckpoint') return resolveSessionScmReviewComparisonLabel(comparison);
    const base = comparison.turnId === latestTurnId ? t('scmComparison.scope.latestTurn') : t('scmComparison.scope.turn');
    if (comparison.evidence === 'agent_reported') return `${base} · ${t('files.toolbar.agentReportedTurnView')}`;
    if (comparison.evidence === 'checkpoint') return `${base} · ${t('files.toolbar.checkpointTurnView')}`;
    return base;
}

/**
 * All six comparison sources, plus the captured comparison already shown. Unselected refs are
 * admission intents, not pretend evidence. Turn evidence variants use the existing availability owner.
 */
export function listFilesComparisonScopeOptions(
    availability: Availability,
    latestTurnId: string | null,
    current?: SessionScmReviewComparison | null,
    counts: Readonly<{ pendingFileCount?: number; sessionFileCount?: number; latestTurnFileCount?: number; currentFileCount?: number }> = {},
): FilesComparisonScopeOption[] {
    const comparisons: SessionScmReviewComparison[] = [{ kind: 'workingTree' }, { kind: 'session' }];
    const offer = (mode: ChangedFilesViewMode) => isChangedFilesViewModeAvailable({ ...availability, mode });
    if (latestTurnId) {
        comparisons.push({ kind: 'turnCheckpoint', turnId: latestTurnId });
        if (offer('turn_agent_reported')) comparisons.push({ kind: 'turnCheckpoint', turnId: latestTurnId, evidence: 'agent_reported' });
        if (offer('turn_checkpoint')) comparisons.push({ kind: 'turnCheckpoint', turnId: latestTurnId, evidence: 'checkpoint' });
    }
    if (current && !comparisons.some((candidate) => scmComparisonKey(candidate) === scmComparisonKey(current))) {
        comparisons.push(current);
    }
    const options: FilesComparisonScopeOption[] = comparisons.map((comparison) => {
        const fileCount = current && scmComparisonKey(comparison) === scmComparisonKey(current) && counts.currentFileCount !== undefined
            ? counts.currentFileCount
            : comparison.kind === 'workingTree' ? counts.pendingFileCount ?? null
                : comparison.kind === 'session' ? counts.sessionFileCount ?? null
                    : comparison.kind === 'turnCheckpoint' && comparison.turnId === latestTurnId && !comparison.evidence ? counts.latestTurnFileCount ?? null : null;
        const description = comparison.kind === 'workingTree' ? t('scmComparison.scopePicker.pendingDescription')
            : comparison.kind === 'session' ? t('scmComparison.scopePicker.sessionDescription')
                : comparison.kind === 'turnCheckpoint' ? t('scmComparison.scopePicker.turnDescription')
                    : comparison.kind === 'branch' ? t('scmComparison.scopePicker.branchDescription')
                        : comparison.kind === 'commit' ? t('scmComparison.scopePicker.commitDescription')
                            : t('scmComparison.scopePicker.pullRequestDescription');
        return {
            comparison,
            sourceKind: comparison.kind,
            group: comparison.kind === 'workingTree' ? 'explainAndCommit' as const : 'explainOnly' as const,
            label: resolveFilesComparisonLabel(comparison, latestTurnId),
            subtitle: fileCount === null ? description : `${description} · ${t('scmComparison.fileCount', { count: fileCount })}`,
            fileCount,
        };
    });
    if (!latestTurnId && current?.kind !== 'turnCheckpoint') options.push({ comparison: null, sourceKind: 'turnCheckpoint', group: 'explainOnly',
        label: t('scmComparison.scope.turn'), subtitle: t('scmComparison.scopePicker.unavailable'), fileCount: null });
    for (const kind of ['branch', 'commit', 'pullRequest'] as const) {
        const label = kind === 'branch' ? t('scmComparison.scopePicker.branchChoice') : kind === 'commit'
            ? t('scmComparison.scopePicker.commitChoice') : t('scmComparison.scopePicker.pullRequestChoice');
        const subtitle = kind === 'branch' ? t('scmComparison.scopePicker.branchDescription') : kind === 'commit'
            ? t('scmComparison.scopePicker.commitDescription') : t('scmComparison.scopePicker.pullRequestDescription');
        options.push({ comparison: null, sourceKind: kind, group: 'explainOnly', label, subtitle, fileCount: null });
    }
    return options;
}

export function filesComparisonScopeOptionKey(option: FilesComparisonScopeOption): string {
    return option.comparison ? scmComparisonKey(option.comparison) : option.sourceKind;
}
