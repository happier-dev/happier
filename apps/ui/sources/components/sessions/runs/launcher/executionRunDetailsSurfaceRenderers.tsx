import * as React from 'react';
import { DiscussionSelectionSourceV1Schema, type DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import type { DetailsSurfaceRendererV1 } from '@/components/appShell/panes/details/surfaces';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { SessionInteractiveExecutionRunDraftView } from './SessionInteractiveExecutionRunDraftView';
import { SessionExecutionRunDetailsView } from '../details/SessionExecutionRunDetailsView';
import { createExecutionRunDetailsTab, type ExecutionRunReviewPresentation } from './executionRunLauncherModel';
import type { ComparisonReviewDraftInput } from './useComparisonReviewDraft';
import { ComparisonReviewDraftInputSchema } from './useExecutionRunLauncherDraft';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionScmReviewDetailsTab } from '@/components/sessions/panes/details/sessionDetailsTabBuilders';
import { readSessionScmReviewTarget } from '@/components/sessions/panes/url/sessionPaneUrlState';

type Workspace = Readonly<{ machineId: string; cwd: string }>;
type RunResourceScope = Readonly<{ sessionId?: string | null; workspace?: Workspace }>;
const NO_PANE_SUBSCRIPTION = () => null;

/** Acceptance updates the comparison's incumbent pane through its existing command owner. */
function ComparisonReviewOrigin(props: Readonly<{
    comparison: ComparisonReviewDraftInput;
    origin: NonNullable<ComparisonReviewDraftInput['origin']>;
    draft: React.ReactElement<React.ComponentProps<typeof SessionInteractiveExecutionRunDraftView>>;
}>) {
    const pane = useAppPaneScope(props.origin.scopeId, NO_PANE_SUBSCRIPTION);
    return React.cloneElement(props.draft, { onRunStarted: (runId, recovery, presentation) => {
        if (presentation?.reviewRunIds?.length) {
            pane.patchDetailsTabState(props.origin.tab.key, { reviewRunIds: [...presentation.reviewRunIds] });
        }
        props.draft.props.onRunStarted(runId, recovery, presentation);
        if (presentation?.walkthrough && presentation.comparisonId) {
            const tab = createSessionScmReviewDetailsTab({ ...readSessionScmReviewTarget(props.origin.tab.resource),
                comparison: { ...props.comparison.comparison, comparisonId: presentation.comparisonId }, view: 'walkthrough' });
            pane.openDetailsTab({ ...tab, key: props.origin.tab.key }, { intent: 'pinned' });
        }
    } });
}

function record(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function hasValidScope(value: Record<string, unknown>): boolean {
    if (value.sessionId === undefined && value.workspace === undefined) return true;
    if (typeof value.sessionId === 'string' && value.sessionId.trim().length > 0 && value.workspace === undefined) return true;
    const workspace = record(value.workspace);
    return value.sessionId === null && workspace !== null
        && typeof workspace.machineId === 'string' && workspace.machineId.trim().length > 0
        && typeof workspace.cwd === 'string' && workspace.cwd.trim().length > 0;
}

function isLauncher(value: unknown): value is RunResourceScope & Readonly<{
    kind: 'executionRunLauncher'; mode?: 'conversation'; intent?: 'review' | 'plan' | 'delegate';
    source?: DiscussionSelectionSourceV1; initialInstructions?: string; roleId?: string; comparisonReview?: ComparisonReviewDraftInput;
}> {
    const item = record(value);
    if (!item || item.kind !== 'executionRunLauncher' || !hasValidScope(item)) return false;
    if (!(item.mode == null || item.mode === 'conversation')) return false;
    if (item.mode === 'conversation' && item.intent != null) return false;
    if (!(item.intent == null || item.intent === 'review' || item.intent === 'plan' || item.intent === 'delegate')) return false;
    if (item.initialInstructions != null && typeof item.initialInstructions !== 'string') return false;
    if (item.roleId != null && (typeof item.roleId !== 'string' || !item.roleId.trim())) return false;
    if (item.comparisonReview !== undefined && !ComparisonReviewDraftInputSchema.safeParse(item.comparisonReview).success) return false;
    if (item.source == null) return true;
    const source = DiscussionSelectionSourceV1Schema.safeParse(item.source);
    return source.success && (item.mode !== 'conversation'
        || (typeof source.data.draftCorrelationId === 'string' && source.data.draftCorrelationId.trim().length > 0));
}

function isRun(value: unknown): value is RunResourceScope & ExecutionRunReviewPresentation & Readonly<{
    kind: 'executionRun'; runId: string; retryInputLocalId?: string; initialText?: string;
}> {
    const item = record(value);
    return item !== null && item.kind === 'executionRun' && hasValidScope(item)
        && typeof item.runId === 'string' && item.runId.trim().length > 0
        && (item.retryInputLocalId === undefined || typeof item.retryInputLocalId === 'string' && item.retryInputLocalId.trim().length > 0)
        && (item.initialText === undefined || typeof item.initialText === 'string');
}

/** Session and workspace panes consume the same Run resources and lifecycle views. */
export function createExecutionRunDetailsSurfaceRenderers(options: Readonly<{
    owner: 'session' | 'workspace'; sessionId: string | null; serverId?: string | null;
    workspace?: Workspace; closeDetailsTab?: (key: string) => void;
}>): readonly DetailsSurfaceRendererV1[] {
    const scopeFor = (resource: RunResourceScope) => ({
        sessionId: resource.sessionId === undefined ? options.sessionId : resource.sessionId,
        workspace: resource.workspace ?? options.workspace,
    });
    return [{
        id: `${options.owner}-execution-run-launcher`, owner: options.owner, order: 70,
        canRender: input => isLauncher(input.tab.resource),
        render: input => {
            const resource = input.tab.resource;
            if (!isLauncher(resource)) return null;
            if (resource.source && (!options.serverId || !areServerProfileIdentifiersEquivalent(resource.source.serverId, options.serverId))) return null;
            const scope = scopeFor(resource);
            const draft = <SessionInteractiveExecutionRunDraftView {...scope} serverId={options.serverId} autoFocusComposer
                intent={resource.mode === 'conversation' ? null : resource.intent ?? 'review'} roleId={resource.roleId ?? null} heading={resource.roleId ? input.tab.title : null}
                initialText={resource.initialInstructions}
                comparisonReview={resource.comparisonReview}
                launchOrigin={resource.source && 'draftCorrelationId' in resource.source
                    ? resource.source as DiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }> : undefined}
                onRunStarted={(runId, recovery, presentation) => {
                    const tab = createExecutionRunDetailsTab(runId, recovery, presentation?.title,
                        scope.sessionId === null ? scope.workspace : undefined, presentation ? {
                            ...(presentation.reviewersNotStarted?.length ? { reviewersNotStarted: presentation.reviewersNotStarted } : {}),
                            ...(presentation.reviewRunIds?.length ? { reviewRunIds: presentation.reviewRunIds } : {}),
                            ...(presentation.comparisonId ? { comparisonId: presentation.comparisonId } : {}),
                            ...(presentation.narrationError ? { narrationError: presentation.narrationError } : {}),
                        } : undefined);
                    input.callbacks.replaceTab?.(input.tab.key, resource.sessionId !== undefined && resource.sessionId !== null
                        ? { ...tab, resource: { ...record(tab.resource), sessionId: resource.sessionId } } : tab,
                    { intent: input.tab.isPreview ? 'preview' : 'pinned' });
                }} />;
            return resource.comparisonReview?.origin
                ? <ComparisonReviewOrigin comparison={resource.comparisonReview} origin={resource.comparisonReview.origin} draft={draft} />
                : draft;
        },
    }, {
        id: `${options.owner}-execution-run`, owner: options.owner, order: 71,
        canRender: input => isRun(input.tab.resource),
        render: input => {
            const resource = input.tab.resource;
            if (!isRun(resource)) return null;
            return <SessionExecutionRunDetailsView {...scopeFor(resource)} serverId={options.serverId} runId={resource.runId}
                reviewersNotStarted={resource.reviewersNotStarted}
                narrationError={resource.narrationError}
                retryInputLocalId={resource.retryInputLocalId} initialText={resource.initialText} presentation="panel" openingTitle={input.tab.title}
                onRequestClose={() => (options.closeDetailsTab ?? input.callbacks.closeTab)?.(input.tab.key)}
                onTitleResolved={title => input.callbacks.replaceTab?.(input.tab.key,
                    { key: input.tab.key, kind: input.tab.kind, title, resource })} />;
        },
    }];
}
