import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import type { ScmComparison } from '@happier-dev/protocol';

import { ChangedFilesReview } from '@/components/workspaces/scm/review/ChangedFilesReview';
import { ScmComparisonHeader } from './ScmComparisonHeader';
import { buildCapturedComparisonFiles } from './capturedComparisonFiles';
import { resolveFilesComparisonLabel } from './filesComparison';
import { scmReviewComparisonOfCaptured } from '@/sync/domains/scm/diffSummary/selection';
import { WalkthroughNotice } from '@/components/sessions/files/walkthrough/WalkthroughLifecycle';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

type ReviewProps = React.ComponentProps<typeof ChangedFilesReview>;
const NO_ATTRIBUTED_FILES: ReviewProps['sessionAttributedFiles'] = [];
const NO_FILES: ReviewProps['repositoryOnlyFiles'] = [];
const doNotOpenWorkingFile = () => {};

/** The Files renderer for immutable captured evidence, shared by PR, branch, commit and pinned routes. */
export function CapturedComparisonFilesView(props: Readonly<{
    comparison: ScmComparison;
    sessionId: string;
    comparisonChrome?: ReviewProps['comparisonChrome'];
    maxFiles: number;
    maxChangedLines: number;
    initialCollapsedPaths?: readonly string[] | null;
    onCollapsedPathsChange?: (paths: string[]) => void;
    initialScrollTop?: number | null;
    onScrollTopChange?: (top: number) => void;
}>) {
    const { theme } = useUnistyles();
    const projected = React.useMemo(() => buildCapturedComparisonFiles(props.comparison), [props.comparison]);
    const initiallyCollapsed = React.useMemo(() => props.initialCollapsedPaths ?? props.comparison.inventory.files
        .filter((file) => file.generated || file.lockfile).map((file) => file.path), [props.initialCollapsedPaths, props.comparison]);
    const providedNotes = props.comparisonChrome?.renderFileNotes;
    const renderFileNotes = React.useCallback((path: string, placement: 'column' | 'inline') => {
        const reason = projected.unavailableByPath.get(path);
        const notes = providedNotes?.(path, placement);
        return reason || notes ? <View>
            {reason ? <Text testID={`captured-file-unavailable-${path}`} style={{ color: theme.colors.text.secondary, ...Typography.default(), padding: 12 }}>
                {t('walkthrough.evidence.unavailable', { reason })}
            </Text> : null}
            {notes}
        </View> : null;
    }, [projected.unavailableByPath, providedNotes, theme.colors.text.secondary]);
    const chrome = React.useMemo<NonNullable<ReviewProps['comparisonChrome']>>(() => {
        const source = scmReviewComparisonOfCaptured(props.comparison);
        const scopeLabel = source ? resolveFilesComparisonLabel(source, null) : t('scmComparison.view.files');
        const renderHeader: NonNullable<ReviewProps['comparisonChrome']>['renderHeader'] = props.comparisonChrome?.renderHeader
            ?? ((coverage) => <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel={scopeLabel} coverage={coverage} />);
        return { renderBarLeading: () => null,
            indexPlacement: 'stream', ...props.comparisonChrome, rootPath: props.comparison.repository.rootPath, renderFileNotes,
            renderHeader };
    }, [props.comparison, props.comparisonChrome, renderFileNotes, theme.colors.text.secondary]);
    const fetchCapturedDiff = React.useCallback<NonNullable<ReviewProps['fetchUnifiedDiffForPath']>>(async ({ path }) => {
        const diff = projected.diffByPath.get(path);
        return typeof diff === 'string' ? { success: true, diff }
            : { success: false, error: projected.unavailableByPath.get(path) ?? t('scmComparison.unsupportedReason') };
    }, [projected]);
    return <View testID="captured-comparison-files" style={{ flex: 1, minHeight: 0 }}>
        {props.comparison.inventory.state !== 'complete' ? <WalkthroughNotice testID="captured-inventory-incomplete" tone="warning" icon="warning"
            message={t('walkthrough.evidence.unavailable', { reason: props.comparison.inventory.reasons.join(' · ') })} /> : null}
        {props.comparison.freshness === 'stale' || props.comparison.freshness === 'unknown' ? <WalkthroughNotice testID="captured-comparison-freshness" tone="warning" icon="clock"
            message={t(props.comparison.freshness === 'stale' ? 'scmComparison.capturedStale' : 'scmComparison.capturedFreshnessUnknown')} /> : null}
        <ChangedFilesReview theme={theme} sessionId={props.sessionId} snapshot={projected.snapshot} changedFilesViewMode="repository"
            allRepositoryChangedFiles={projected.files} sessionAttributedFiles={NO_ATTRIBUTED_FILES} repositoryOnlyFiles={NO_FILES}
            maxFiles={props.maxFiles} maxChangedLines={props.maxChangedLines} onFilePress={doNotOpenWorkingFile}
            evidenceOnly comparisonChrome={chrome} providerDiffByPath={projected.diffByPath} fetchUnifiedDiffForPath={fetchCapturedDiff}
            initialCollapsedPaths={initiallyCollapsed} onCollapsedPathsChange={props.onCollapsedPathsChange}
            initialScrollTop={props.initialScrollTop} onScrollTopChange={props.onScrollTopChange} rowDensity="compact" />
    </View>;
}
