import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ScmComparison } from '@happier-dev/protocol';
import { ScmComparisonBar, ScmComparisonViewSwitch } from '@/components/sessions/files/comparison/ScmComparisonBar';
import { ScmComparisonScopePicker } from '@/components/sessions/files/comparison/ScmComparisonScopePicker';
import { ScmComparisonPhoneHeader } from '@/components/sessions/files/comparison/ScmComparisonPhoneHeader';
import { ScmComparisonHeader } from '@/components/sessions/files/comparison/ScmComparisonHeader';
import { CapturedComparisonFilesView } from '@/components/sessions/files/comparison/CapturedComparisonFilesView';
import { listFilesComparisonScopeOptions, resolveFilesComparisonLabel } from '@/components/sessions/files/comparison/filesComparison';
import { WalkthroughView } from '@/components/sessions/files/walkthrough/WalkthroughView';
import { buildWalkthroughReading, type WalkthroughReadingInput } from '@/components/sessions/files/walkthrough/walkthroughReading';
import { scmReviewComparisonOfCaptured } from '@/sync/domains/scm/diffSummary/selection';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { PullRequestReviewReading } from './ReviewWalkthroughSpecimen';
import { PR_SPECIMEN_ANALYSIS, PR_SPECIMEN_COMPARISON, PR_SPECIMEN_INCOMPLETE, PR_SPECIMEN_WALKTHROUGH } from './pullRequestSpecimenFixture';
import type { WalkthroughSpecimenFrame } from './WalkthroughSpecimen';

const noop = () => {};
const AVAILABILITY = { showTurnViewToggle: true, showTurnAgentReportedViewToggle: false, showTurnCheckpointViewToggle: false, showSessionViewToggle: true };

function PullRequestFrame(props: Readonly<{ phone: boolean; comparison?: ScmComparison; initialView?: 'files' | 'walkthrough'; review?: boolean }>) {
    const comparison = props.comparison ?? PR_SPECIMEN_COMPARISON;
    const scope = scmReviewComparisonOfCaptured(comparison)!;
    const scopeLabel = resolveFilesComparisonLabel(scope, null);
    const [view, setView] = React.useState(props.initialView ?? 'walkthrough');
    const [refs, setRefs] = React.useState<string[]>([]);
    const input = React.useMemo<Omit<WalkthroughReadingInput, 'reviewed'>>(() => ({ comparison,
        walkthrough: { state: 'complete', value: PR_SPECIMEN_WALKTHROUGH }, analysis: PR_SPECIMEN_ANALYSIS }), [comparison]);
    const reading = React.useMemo(() => buildWalkthroughReading({ ...input,
        reviewed: { v: 1, comparisonId: comparison.id, reviewedChangeRefs: refs } }), [comparison.id, input, refs]);
    const options = listFilesComparisonScopeOptions(AVAILABILITY, 'turn-3', scope, { pendingFileCount: 9, sessionFileCount: 9,
        latestTurnFileCount: 4, currentFileCount: comparison.inventory.files.length });
    const selectView = (next: 'files' | 'walkthrough' | 'commits') => { if (next !== 'commits') setView(next); };
    const bar = props.phone ? <ScmComparisonPhoneHeader view={view} views={['files', 'walkthrough']}
        scope={{ options, current: scope, currentLabel: scopeLabel, fileCount: comparison.inventory.files.length, onSelect: noop }}
        onSelectView={selectView} onBack={noop} onStartReview={noop} /> : <ScmComparisonBar leading={<>
        <ScmComparisonViewSwitch view={view} views={['files', 'walkthrough']} onSelect={(next) => { if (next !== 'commits') setView(next); }} />
        <ScmComparisonScopePicker options={options} current={scope}
            currentLabel={scopeLabel} fileCount={comparison.inventory.files.length} onSelect={noop} />
    </>} trailing={<RoundButton size="small" display="secondary" title={t('scmComparison.startReview')}
        leading={<Icon name="shield-check" size={ICON_SIZE.xs} />} onPress={noop} />} />;
    return <View style={styles.fill}>
        {view === 'files' ? <CapturedComparisonFilesView comparison={comparison} sessionId="specimen-session" maxFiles={50} maxChangedLines={5000}
            comparisonChrome={{ renderBarLeading: () => null, renderBar: () => bar, indexPlacement: 'stream',
                renderHeader: (coverage) => <ScmComparisonHeader viewLabel={t('scmComparison.view.files')} scopeLabel={scopeLabel} coverage={coverage} stacked={props.phone} /> }} />
            : props.review ? <PullRequestReviewReading input={input} phone={props.phone} bar={bar} scopeLabel={scopeLabel} />
                : <>{bar}<WalkthroughView reading={reading} layout={props.phone ? 'phone' : 'wide'} scopeLabel={scopeLabel}
                    modelLabel="Opus 5.5" stale={comparison.freshness === 'stale' ? { onRefresh: noop } : null}
                    onToggleReviewed={(stop) => setRefs((current) => stop.reviewed ? current.filter((ref) => !stop.changeRefs.includes(ref)) : [...current, ...stop.changeRefs])}
                    onAsk={noop} /></>}
    </View>;
}

/** Authored PR data, real Files/Walkthrough/Review primitives; not a substitute Triage entrance. */
export const PULL_REQUEST_SPECIMEN_FRAMES: readonly WalkthroughSpecimenFrame[] = [
    { id: 'PR', title: 'WT1 · Pull request complete', render: (phone) => <PullRequestFrame phone={phone} /> },
    { id: 'PRFiles', title: 'WT6-E2 · Captured pull request Files', render: (phone) => <PullRequestFrame phone={phone} initialView="files" /> },
    { id: 'PRIncomplete', title: 'WT2 · Missing hosted patch', render: (phone) => <PullRequestFrame phone={phone} comparison={PR_SPECIMEN_INCOMPLETE} /> },
    { id: 'PRStale', title: 'WT2 · PR changed while paging', render: (phone) => <PullRequestFrame phone={phone} comparison={{ ...PR_SPECIMEN_INCOMPLETE, freshness: 'stale' }} /> },
    { id: 'PRReview', title: 'WT5 · Review over captured PR', render: (phone) => <PullRequestFrame phone={phone} review /> },
];

const styles = StyleSheet.create((theme) => ({ fill: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface.base } }));
