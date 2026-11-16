import * as React from 'react';

import { scmDiffSummaryPrerequisiteOf, useOpenExplainChangesSetting, useSummaryModelChoice } from '@/components/sessions/files/comparison/ScmDiffSummaryStartOptions';
import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { t } from '@/text';
import { SCM_DIFF_SUMMARY_GENERIC_FAILURE, type ScmDiffSummaryFailurePresentation } from '@/sync/domains/scm/diffSummary/state';
import { useSessionScmDraft } from '@/hooks/session/sourceControl/useSessionScmDraft';
import type { SessionScmPullRequestBodyDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';

import { resolveGitPullRequestBodyArrival } from './gitPullRequestBodyDraft';

type Report = Readonly<{ failure: ScmDiffSummaryFailurePresentation | null; message: string | null }>;

/**
 * Drafting a new pull request's description from its changes. The draft is the branch comparison's saved summary
 * (the one diff-summary owner), so progress, model, language, failure and Machine presence all come from that
 * binding; this adds only what is the form's: asking, and where the arriving text goes.
 */
export function useGitPullRequestBodyDraft(params: Readonly<{
    sessionId: string;
    serverId?: string;
    head: string | null;
    base: string | null;
    body: string;
    setBody: (body: string) => void;
}>) {
    const { head, base } = params;
    const comparison = React.useMemo(() => head && base ? { kind: 'branch' as const, head, base } : null, [head, base]);
    const bound = useSessionScmDiffSummaryBinding({ sessionId: params.sessionId, serverId: params.serverId, comparison, output: 'summary' });
    const scmDraft = useSessionScmDraft({ sessionId: params.sessionId, serverId: params.serverId });
    const key = bound.machine && comparison ? JSON.stringify([bound.machine.machineId, bound.machine.basePath, head, base]) : null;
    const retained = scmDraft.draft.pullRequest?.bodyDraft;
    const bodyDraft = retained?.key === key ? retained : null;
    const attempt = bodyDraft?.attempt ?? null;
    const candidate = bodyDraft?.candidate ?? null;
    const setBodyDraft = React.useCallback((update: (previous: SessionScmPullRequestBodyDraft) => SessionScmPullRequestBodyDraft) => {
        if (!key) return;
        scmDraft.setPullRequest(current => {
            const previous = current?.bodyDraft?.key === key ? current.bodyDraft : { key, attempt: null, candidate: null };
            const next = update(previous);
            if (next === previous) return current;
            return { title: '', body: params.body, draft: false, base, ...current, bodyDraft: next };
        });
    }, [key, scmDraft.setPullRequest, params.body, base]);
    const modelChoice = useSummaryModelChoice();
    const openExplainSetting = useOpenExplainChangesSetting();
    const [report, setReport] = React.useState<Report | null>(null);
    const bodyRef = React.useRef(params.body);
    bodyRef.current = params.body;
    const { viewModel } = bound;

    // Another comparison is another draft.
    React.useEffect(() => { setReport(null); }, [key]);

    React.useEffect(() => {
        if (!attempt) return;
        const status = viewModel?.status;
        if (attempt.started === null) return;
        const settle = (next: Report | null, candidate: string | null = null) => {
            setBodyDraft(previous => previous.attempt && previous.attempt.resultId === attempt.resultId ? { ...previous, attempt: null, candidate } : previous);
            setReport(next);
        };
        if (!attempt.resultId) {
            if (!attempt.started) settle({ failure: bound.generationFailure, message: bound.error ?? scmDiffSummaryPrerequisiteOf(bound) ?? t('walkthroughStart.unavailable') });
            return;
        }
        if (viewModel?.resultId !== attempt.resultId) return;
        if (status === 'failed') { settle({ failure: bound.generationFailure ?? SCM_DIFF_SUMMARY_GENERIC_FAILURE, message: null }); return; }
        if (status === 'succeeded') {
            const text = viewModel?.suggestedPrBody ?? null;
            if (!text) { settle({ failure: SCM_DIFF_SUMMARY_GENERIC_FAILURE, message: null }); return; }
            scmDraft.setPullRequest(current => {
                const pending = current?.bodyDraft;
                if (!current || pending?.key !== key || !pending.attempt
                    || pending.attempt.resultId !== attempt.resultId) return current;
                const arrival = resolveGitPullRequestBodyArrival({ bodyAtRequest: pending.attempt.bodyAtRequest,
                    currentBody: current.body, candidate: text });
                return { ...current, body: arrival === 'fill' ? text : current.body,
                    bodyDraft: { ...pending, attempt: null, candidate: arrival === 'offer' ? text : null } };
            });
            setReport(null);
            return;
        }
    }, [attempt, viewModel, bound.error, setBodyDraft, key, scmDraft.setPullRequest]);

    const prerequisite = scmDiffSummaryPrerequisiteOf(bound);
    const ready = Boolean(viewModel) || bound.restoreState === 'ready';
    const drafting = attempt !== null;
    const canDraft = comparison !== null && !drafting && ready && prerequisite === null;

    const draft = React.useCallback(async () => {
        if (!comparison || drafting) return;
        setReport(null);
        // Explain changes being off is the same typed refusal the walkthrough gives, with its way to turn it on.
        if (bound.startBlocker) { setReport({ failure: bound.startBlocker, message: null }); return; }
        if (!canDraft) return;
        const next = { bodyAtRequest: bodyRef.current, baselineResultId: viewModel?.resultId ?? null, baselineRevision: viewModel?.revision ?? null };
        let admitted = false;
        setBodyDraft(previous => {
            if (previous.attempt) return previous;
            admitted = true;
            return { ...previous, candidate: null, attempt: { ...next, started: null } };
        });
        if (!admitted) return;
        const response = await bound.onStart(['summary'], { pullRequestDraft: {} });
        const resultId = response?.resultId ?? null;
        const started = Boolean(response?.ok || resultId);
        // The request belongs to the Session draft even if its originating form unmounted.
        setBodyDraft(previous => previous.attempt?.started === null
            && previous.attempt.baselineResultId === next.baselineResultId && previous.attempt.baselineRevision === next.baselineRevision
            && previous.attempt.bodyAtRequest === next.bodyAtRequest ? { ...previous, attempt: { ...next, started, resultId } } : previous);
    }, [bound, canDraft, comparison, drafting, viewModel?.resultId, viewModel?.revision, setBodyDraft]);

    const admitted = Boolean(attempt?.resultId && viewModel?.resultId === attempt.resultId);
    const runId = admitted ? viewModel?.executionRunId ?? null : null;
    const checkAdmission = React.useCallback(() => bound.checkAdmission(attempt?.resultId ?? undefined), [bound.checkAdmission, attempt?.resultId]);
    const cancel = React.useCallback(async () => {
        if (!attempt?.resultId || !runId || !await bound.cancelGeneration()) return;
        setBodyDraft(previous => previous.attempt?.resultId === attempt.resultId ? { ...previous, attempt: null } : previous);
        setReport(null);
    }, [attempt?.resultId, runId, bound.cancelGeneration, setBodyDraft]);

    return {
        drafting,
        canDraft,
        admission: admitted ? bound.admission : null,
        checkAdmission,
        runId,
        cancel: runId ? cancel : undefined,
        /** Why drafting cannot run right now (Machine away, no usable model), when it cannot. */
        // The saved-read owner supplies loading/failure and Retry. An unreadable prerequisite
        // is not evidence that the Machine is offline or that a different model is needed.
        prerequisite: drafting || (!ready && bound.machineReachability !== 'unreachable') ? null : prerequisite,
        /** A saved draft of this comparison could not be looked up; asking again would risk a duplicate. */
        restoreFailed: !viewModel && bound.restoreState === 'unavailable',
        retryRestore: bound.retryRestore,
        failure: report?.failure ?? null,
        message: report?.message ?? (drafting ? bound.error : null),
        /** A drafted description held beside a body the person had already written or changed. */
        candidate,
        draft,
        useCandidate: React.useCallback(() => { if (candidate !== null) params.setBody(candidate); setBodyDraft(previous => ({ ...previous, candidate: null })); }, [candidate, params.setBody, setBodyDraft]),
        keepMine: React.useCallback(() => setBodyDraft(previous => ({ ...previous, candidate: null })), [setBodyDraft]),
        modelChoice,
        model: bound.model,
        sessionAgentTargetKey: bound.sessionAgentTargetKey,
        setModel: bound.setModel,
        machineId: bound.machine?.machineId ?? null,
        serverId: bound.serverId,
        openExplainSetting,
    } as const;
}
