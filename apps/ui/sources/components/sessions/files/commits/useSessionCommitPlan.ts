import * as React from 'react';
import { StrictJsonValueSchema, type ScmDiffSummaryResult, type ScmDiffSummaryResultEdit } from '@happier-dev/protocol';

import { useSessionScmDiffSummaryBinding } from '@/components/sessions/files/comparison/useSessionScmDiffSummaryBinding';
import { useSessionScmWalkthrough } from '@/components/sessions/files/walkthrough/useSessionScmWalkthrough';
import { Modal } from '@/modal';
import { applySavedScmDiffSummaryResult, deleteSavedScmDiffSummaryResults } from '@/sync/ops/scmDiffSummary/generate';
import type { ScmCommitPlanOperationResult } from '@/sync/ops/scmDiffSummary/results';
import { getSessionDraftSnapshot, writeExistingSessionDraft } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { machineScmDiffCommit } from '@/sync/ops/scm/machineScm';
import { t } from '@/text';

import { buildCommitProposal, type CommitProposal, type CommitProposalChange } from './commitProposal';
import { buildCommitPlanAcceptance } from './commitPlanAcceptance';
import { buildCommitHookFixPrompt } from './commitHookFixPrompt';
import type { CommitMoveTarget } from './CommitProposalParts';
import type { CommitProposalActions } from './CommitProposalView';
import type { ReadCommitHookDiff } from './CommitHookChanges';

const PENDING = { kind: 'workingTree' } as const;

/**
 * While an accepted run is in flight, its per-commit progress is read from the saved result (U5 core:
 * "Read/progress uses result.read"); the accept call itself resolves only when the run stops. The read
 * cadence exists only for that in-flight window and ends with it.
 */
const APPLY_PROGRESS_READ_MS = 1_000;

function newGroupId(): string {
    return `commit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function fileName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The pending comparison's commit proposal bound to its Session: the projection, every structured edit and the
 * explicit accept / stop / include / cancel / recover controls, all through the saved result's one owner and
 * the shared Action confirmation. Mounted only while a surface showing the proposal is in front.
 */
export function useSessionCommitPlan(params: Readonly<{
    sessionId: string;
    serverId?: string | null;
    enabled: boolean;
    branch: string | null;
    /** Hands the person to the Session composer (the same seam as the Walkthrough's "Ask this session"). */
    onOpenComposer?: () => void;
}>) {
    const bound = useSessionScmDiffSummaryBinding({
        sessionId: params.sessionId,
        serverId: params.serverId,
        comparison: params.enabled ? PENDING : null,
        output: 'commitPlan',
    });
    const { viewModel, operations, binding, cwd, setError } = bound;
    const saved = viewModel?.savedResult ?? null;
    const comparison = viewModel?.comparison ?? null;
    const planOutput = viewModel?.outputs?.commitPlan ?? null;
    const plan = planOutput?.value ?? null;
    const application = saved?.application ?? null;
    const proposal = React.useMemo<CommitProposal | null>(() => (comparison && plan && comparison.source.kind === 'workingTree'
        ? buildCommitProposal({ comparison, plan, application })
        : null), [application, comparison, plan]);
    const phase: 'none' | 'writing' | 'ready' = proposal ? 'ready'
        : planOutput && (planOutput.state === 'pending' || planOutput.state === 'writing') ? 'writing' : 'none';
    const [busy, setBusy] = React.useState(false);
    const key = viewModel?.requestKey ?? null;

    const current = React.useCallback(() => binding?.isCurrent() === true, [binding]);
    const apply = React.useCallback((result: ScmDiffSummaryResult) => {
        if (key && current()) applySavedScmDiffSummaryResult(key, result);
    }, [current, key]);
    const reread = React.useCallback(async () => {
        if (!operations || !cwd || !saved) return;
        const latest = await operations.read({ cwd, resultId: saved.resultId });
        if (latest.success) apply(latest.result);
    }, [apply, cwd, operations, saved]);
    const report = React.useCallback(async (response: ScmCommitPlanOperationResult) => {
        if (!current()) return null;
        if (response.success) { apply(response.result); setError(null); return response.result; }
        if (response.errorCode === 'approval_required') { setError(t('commitProposal.approvalPending')); return null; }
        if (response.errorCode === 'revision_conflict') { setError(t('commitProposal.conflict')); await reread(); return null; }
        setError(response.error);
        await reread();
        return null;
    }, [apply, current, reread, setError]);

    const edit = React.useCallback(async (change: ScmDiffSummaryResultEdit, base: ScmDiffSummaryResult | null = saved) => {
        if (!operations || !cwd || !base) return null;
        return report(await operations.edit({ cwd, resultId: base.resultId, expectedRevision: base.revision, edit: change }));
    }, [cwd, operations, report, saved]);

    const groupIds = React.useMemo(() => plan?.groups.map((group) => group.id) ?? [], [plan]);
    const onMove = React.useCallback(async (change: CommitProposalChange, target: CommitMoveTarget) => {
        if (target.kind !== 'newGroupAfter') {
            await edit({ kind: 'moveCommitChanges', changeRefs: [...change.changeRefs], target });
            return;
        }
        const id = newGroupId();
        const moved = await edit({ kind: 'moveCommitChanges', changeRefs: [...change.changeRefs],
            target: { kind: 'newGroup', group: { id, message: t('commitProposal.move.newCommitMessage', { file: fileName(change.path) }), rationale: '' } } });
        const groups = moved?.output.outputs?.commitPlan?.value?.groups.map((group) => group.id);
        if (!moved || !groups) return;
        // A new group lands last; place it right after the commit the person chose.
        const without = groups.filter((groupId) => groupId !== id);
        const at = without.indexOf(target.groupId);
        if (at < 0 || at === without.length - 1) return;
        await edit({ kind: 'reorderCommitGroups', groupIds: [...without.slice(0, at + 1), id, ...without.slice(at + 1)] }, moved);
    }, [edit]);

    const acceptance = React.useMemo(() => (comparison && plan
        ? buildCommitPlanAcceptance({ comparison, plan, application })
        : null), [application, comparison, params.branch, plan]);

    /** Runs an accept-like call while reading its per-commit progress until it settles. */
    const runApplication = React.useCallback(async (call: () => Promise<ScmCommitPlanOperationResult>) => {
        if (!operations || !cwd || !saved) return;
        setBusy(true); setError(null);
        let settled = false;
        const progress = setInterval(() => { if (!settled) void reread(); }, APPLY_PROGRESS_READ_MS);
        try {
            await report(await call());
        } finally {
            settled = true;
            clearInterval(progress);
            if (current()) setBusy(false);
        }
    }, [current, cwd, operations, reread, report, saved, setError]);

    // A discarded proposal stays one revision-checked Undo away until the person does something else.
    const [discarded, setDiscarded] = React.useState<Readonly<{ key: string; cwd: string; resultId: string; revision: number }> | null>(null);
    const undoDiscard = React.useMemo(() => (discarded && operations ? async () => {
        const restored = await operations.undo({ cwd: discarded.cwd, resultId: discarded.resultId, expectedRevision: discarded.revision });
        if (!current()) return;
        setDiscarded(null);
        if (restored.success) applySavedScmDiffSummaryResult(discarded.key, restored.result);
        else setError(restored.errorCode === 'revision_conflict' ? t('commitProposal.conflict') : restored.error);
    } : null), [current, discarded, operations, setError]);
    const onOpenComposer = params.onOpenComposer;
    const machineId = bound.machine?.machineId;
    const scope = bound.scope;
    const readHookDiff = React.useCallback<ReadCommitHookDiff>(async ({ beforeTreeOid, afterTreeOid }) => {
        if (!current() || !cwd || !machineId || !scope) return { success: false };
        const response = await machineScmDiffCommit(machineId, { cwd, beforeTreeOid, commit: afterTreeOid },
            { serverId: scope.serverId, accountId: scope.accountId });
        return current() ? response : { success: false };
    }, [current, cwd, machineId, scope?.serverId, scope?.accountId]);

    const actions = React.useMemo<CommitProposalActions>(() => {
        if (!saved || !cwd || !operations || !proposal) return {};
        const control = { cwd, resultId: saved.resultId, expectedRevision: saved.revision };
        const outcome = proposal.outcome;
        const onlyCommitPlan = !saved.output.outputs?.walkthrough && !saved.output.outputs?.summary;
        return {
            onEditMessage: (groupId, message) => { void edit({ kind: 'editCommitGroup', groupId, message }); },
            onMove: (change, target) => { void onMove(change, target); },
            onMoveGroup: (groupId, direction) => {
                const at = groupIds.indexOf(groupId);
                const to = at + direction;
                if (at < 0 || to < 0 || to >= groupIds.length) return;
                const next = [...groupIds];
                next.splice(at, 1);
                next.splice(to, 0, groupId);
                void edit({ kind: 'reorderCommitGroups', groupIds: next });
            },
            onMergeWithNext: (groupId) => {
                const next = groupIds[groupIds.indexOf(groupId) + 1];
                if (next) void edit({ kind: 'mergeCommitGroups', groupIds: [groupId, next], targetGroupId: groupId });
            },
            ...(acceptance ? { onCreate: () => { void runApplication(() => operations.acceptCommitPlan({ ...control, acceptance })); } } : {}),
            ...(proposal.applying ? { onStopAfterCurrent: () => { void operations.stopCommitPlan(control).then(report); } } : {}),
            ...(outcome?.kind === 'hookChanged' ? {
                readHookDiff,
                onIncludeHookChanges: () => { void runApplication(() => operations.includeCommitPlanHookChanges({ ...control,
                    groupId: outcome.groupId, beforeTreeOid: outcome.beforeTreeOid, afterTreeOid: outcome.afterTreeOid })); },
            } : {}),
            ...(proposal.locked || outcome?.kind === 'signing' ? { onCancel: () => { void operations.cancelCommitPlan(control).then(report); } } : {}),
            ...(outcome?.kind === 'unknown' ? { onRecover: () => { void runApplication(() => operations.recoverCommitPlan(control)); } } : {}),
            // A fresh capture of what is pending now; the stale proposal cannot authorize it.
            ...(bound.canSend ? { onRegenerate: () => { void bound.onStart(['commitPlan']); }, onProposeAgain: () => { void bound.onStart(['commitPlan']); } } : {}),
            // Discarding removes only the proposal (a revisioned edit with Undo); a result holding nothing else is deleted.
            ...(!proposal.locked && proposal.landedCount === 0 ? {
                onDiscard: () => {
                    void (async () => {
                        const confirmed = await Modal.confirm(t('commitProposal.footer.discard'), t('commitProposal.discardBody'), {
                            confirmText: t('commitProposal.footer.discard'), destructive: true,
                        });
                        if (!confirmed || !current() || !bound.scope) return;
                        if (onlyCommitPlan) {
                            const deleted = await operations.delete({ cwd, resultId: saved.resultId, expectedRevision: saved.revision });
                            if (deleted.success) deleteSavedScmDiffSummaryResults(bound.scope, [deleted.resultId]);
                            else setError(deleted.error);
                            return;
                        }
                        const removed = await edit({ kind: 'removeOutput', output: 'commitPlan' });
                        if (removed && key && current()) setDiscarded({ key, cwd, resultId: removed.resultId, revision: removed.revision });
                    })();
                },
            } : {}),
            // "Ask this session to fix it": the Session agent, seeded with the hook and exactly what it reported.
            ...(outcome?.kind === 'hookFailed' && onOpenComposer && bound.scope && bound.canSend ? {
                onAskSession: () => {
                    const scope = bound.scope;
                    const prompt = buildCommitHookFixPrompt(proposal);
                    if (!scope || !prompt || !current()) return;
                    const existing = getSessionDraftSnapshot(scope, { kind: 'session', sessionId: params.sessionId })?.document.composer.text.value;
                    const text = typeof existing === 'string' && existing.trim() ? `${existing.replace(/\s+$/, '')}\n\n${prompt}` : prompt;
                    writeExistingSessionDraft({ scope, sessionId: params.sessionId, patch: { text,
                        routing: { recipient: StrictJsonValueSchema.parse({ mode: 'manual', recipient: null }) } }, materializationIntent: 'userEdit' });
                    onOpenComposer();
                },
            } : {}),
        };
    }, [acceptance, bound, current, cwd, edit, groupIds, key, onMove, onOpenComposer, operations, params.sessionId, proposal, readHookDiff, report, runApplication, saved, setError]);

    // A walkthrough of the same pending changes already holds captured evidence: add the proposal to it.
    const walkthrough = useSessionScmWalkthrough(params.sessionId, params.enabled && !planOutput ? PENDING : null, 'walkthrough', params.serverId);
    const walkthroughSaved = walkthrough?.savedResult ?? null;
    const walkthroughKey = walkthrough?.requestKey ?? null;
    const addToSaved = React.useMemo(() => (walkthroughSaved && walkthroughKey && cwd && operations && !planOutput
        ? async () => {
            const response = await operations.addOutputs({ cwd, resultId: walkthroughSaved.resultId, expectedRevision: walkthroughSaved.revision, outputs: ['commitPlan'] });
            if (!current()) return;
            if (response.success) applySavedScmDiffSummaryResult(walkthroughKey, response.result);
            else setError(response.errorCode === 'revision_conflict' ? t('commitProposal.conflict') : response.error);
        }
        : null), [current, cwd, operations, planOutput, setError, walkthroughKey, walkthroughSaved]);

    return {
        proposal,
        phase,
        actions,
        busy,
        error: bound.error,
        modelLabel: viewModel?.producer?.modelId ?? null,
        binding: bound,
        hasSavedResult: saved !== null,
        /** The saved result already holds other outputs: propose from its captured evidence on the same run. */
        addToSaved,
        /** Undo of a just-discarded proposal (revision-checked), until something else happens. */
        undoDiscard,
    } as const;
}
