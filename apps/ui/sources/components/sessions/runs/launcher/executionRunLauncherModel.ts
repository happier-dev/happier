import type { DetailsTab } from '@/components/appShell/panes/model/appPaneReducer';
import { resolveExecutionRunAvailableBackends, type ExecutionRunBackendCapabilityMap } from '@/sync/domains/executionRuns/resolveExecutionRunAvailableBackends';
import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { resolveExecutionRunIntentTitle } from '@/components/sessions/runs/resolveExecutionRunIntentTitle';
import { t } from '@/text';
import { ExecutionRunIntentSchema } from '@happier-dev/protocol/execution/runs/index';
import type { DiscussionSelectionSourceV1 } from '@happier-dev/protocol/discussions/content';
import type { ComparisonReviewDraftInput } from './useComparisonReviewDraft';

export const EXECUTION_RUN_LAUNCH_INTENTS = ['review', 'plan', 'delegate'] as const;

export type ExecutionRunIntent = (typeof EXECUTION_RUN_LAUNCH_INTENTS)[number];

export function resolveExecutionRunLauncherIntent(value: unknown): ExecutionRunIntent | null {
    const normalized = Array.isArray(value) ? value[0] : value;
    const parsed = ExecutionRunIntentSchema.safeParse(normalized);
    if (!parsed.success) return null;
    return EXECUTION_RUN_LAUNCH_INTENTS.includes(parsed.data as ExecutionRunIntent)
        ? (parsed.data as ExecutionRunIntent)
        : null;
}

export function resolveExecutionRunLauncherIntents(
    executionRunsBackends: ExecutionRunBackendCapabilityMap,
): readonly ExecutionRunIntent[] {
    return EXECUTION_RUN_LAUNCH_INTENTS.filter((intent) => resolveExecutionRunAvailableBackends(executionRunsBackends, intent).length > 0);
}

export function resolveExecutionRunLauncherActionId(intent: ExecutionRunIntent): 'review.start' | 'subagents.plan.start' | 'subagents.delegate.start' {
    switch (intent) {
        case 'review':
            return 'review.start';
        case 'plan':
            return 'subagents.plan.start';
        case 'delegate':
            return 'subagents.delegate.start';
    }
}

/** The Action input field that lists who runs the launch: reviewers are engines, everything else Agent targets. */
export function resolveExecutionRunTargetFieldPath(intent: ExecutionRunIntent): 'engineIds' | 'backendTargetKeys' {
    return intent === 'review' ? 'engineIds' : 'backendTargetKeys';
}

export function defaultPermissionModeForExecutionRunIntent(intent: ExecutionRunIntent): PermissionMode {
    if (intent === 'review') return 'read-only';
    if (intent === 'plan') return 'read-only';
    return 'safe-yolo';
}

/** What a launched Run is for, in words: the first line the person wrote, else its intent. */
export function resolveExecutionRunLaunchTitle(input: Readonly<{
    intent: ExecutionRunIntent;
    instructions?: string | null;
}>): string {
    return resolveExecutionRunIntentTitle(input.instructions) ?? t(`runPage.intentTitles.${input.intent}` as const);
}

/** A start that begins with a role already chosen (Second opinion: a review by `second_opinion`). */
export type ExecutionRunStartPreset = Readonly<{
    roleId: string;
    /** What the start's tab is called ("Second opinion"). */
    title: string;
}>;

/** Review acceptance accompanies the resulting Run, including results that started partially. */
export type ExecutionRunReviewPresentation = Readonly<{
    reviewersNotStarted?: readonly string[];
    reviewRunIds?: readonly string[];
    comparisonId?: string;
    narrationError?: string | null;
    walkthrough?: boolean;
}>;

export function createExecutionRunLauncherDetailsTab(intent?: ExecutionRunIntent, preset?: ExecutionRunStartPreset): DetailsTab {
    const baseKey = intent ? `execution-run-launcher:${intent}` : 'execution-run-launcher';
    return {
        key: preset ? `${baseKey}:${preset.roleId}` : baseKey,
        kind: 'executionRunLauncher',
        title: preset ? preset.title : intent === 'plan'
            ? t('executionRuns.newRun.intents.plan')
            : intent === 'delegate'
                ? t('executionRuns.newRun.intents.delegate')
                : intent === 'review'
                    ? t('executionRuns.newRun.intents.review')
                    : t('executionRuns.newRun.headerTitle'),
        resource: {
            kind: 'executionRunLauncher',
            ...(intent ? { intent } : {}),
            ...(preset ? { roleId: preset.roleId } : {}),
        },
    };
}

/** Changes opens the same Run draft with the exact comparison, never a second review presenter. */
export function createComparisonReviewExecutionRunDraftDetailsTab(
    comparisonReview: ComparisonReviewDraftInput,
    detachedWorkspace?: Readonly<{ machineId: string; cwd: string }>,
    sessionId?: string,
): DetailsTab {
    const tab = createExecutionRunLauncherDetailsTab('review');
    return { ...tab, resource: { kind: 'executionRunLauncher', intent: 'review', comparisonReview,
        ...(detachedWorkspace ? { sessionId: null, workspace: detachedWorkspace } : {}),
        ...(sessionId ? { sessionId } : {}) } };
}

/**
 * An empty Agent conversation draft. Unlike the bounded launcher above, this
 * resource does not create a Run until the canonical composer hands off its
 * first outbound message.
 */
export function createInteractiveExecutionRunDraftDetailsTab(input?: Readonly<{
    initialText?: string;
    detachedWorkspace?: Readonly<{ machineId: string; cwd: string }>;
}>): DetailsTab {
    return {
        key: 'execution-run-conversation-draft',
        kind: 'executionRunLauncher',
        title: t('session.subagents.panel.newAgentConversation'),
        resource: {
            kind: 'executionRunLauncher',
            mode: 'conversation',
            ...(input?.initialText !== undefined ? { initialInstructions: input.initialText } : {}),
            ...(input?.detachedWorkspace ? { sessionId: null, workspace: input.detachedWorkspace } : {}),
        },
    };
}

export function createDiscussionSelectionInteractiveExecutionRunDraftDetailsTab(input: Readonly<{
    source: DiscussionSelectionSourceV1 & Readonly<{ draftCorrelationId: string }>;
    initialText: string;
}>): DetailsTab {
    return {
        key: `execution-run-conversation-draft:discussion:${input.source.draftCorrelationId}`,
        kind: 'executionRunLauncher',
        title: t('session.subagents.panel.newAgentConversation'),
        resource: {
            kind: 'executionRunLauncher',
            mode: 'conversation',
            source: input.source,
            initialInstructions: input.initialText,
        },
    };
}

/**
 * A stable Details resource for a materialized execution Run, titled by its intent when the opener
 * knows it ("Is 5 attempts enough during a deploy?") and generically otherwise — never by its id.
 */
export function createExecutionRunDetailsTab(
    runId: string,
    recovery?: Readonly<{ retryInputLocalId: string; initialText?: string }>,
    title?: string | null,
    detachedWorkspace?: Readonly<{ machineId: string; cwd: string }>,
    review?: ExecutionRunReviewPresentation,
): DetailsTab {
    return {
        key: `execution-run:${runId}`,
        kind: 'executionRun',
        title: title?.trim() || t('runPage.untitledRun'),
        resource: { kind: 'executionRun', runId, ...(recovery ?? {}),
            ...(review ?? {}),
            ...(detachedWorkspace ? { sessionId: null, workspace: detachedWorkspace } : {}) },
    };
}
