import {
    isScmCommitPlanApplicationLocked,
    type ScmCommitPlanApplication,
    type ScmCommitPlanStep,
    type ScmComparison,
    type ScmDiffSummaryCommitPlan,
} from '@happier-dev/protocol';

import { countHunkLines, locateComparisonOccurrences, type LocatedOccurrence } from '@/components/sessions/files/comparison/comparisonOccurrences';

/**
 * The Commits view's projection of one commit proposal over its exact pending comparison (Walkthrough lab
 * WT4-C1/C3/C4). Rows come from captured occurrences only; a file split across commits says which part each
 * commit holds. Applying state and every divergence come from the saved result's application, never from a
 * second UI interpretation of what is running.
 */
export type CommitProposalChange = Readonly<{
    /** Stable within its group: the file path. */
    key: string;
    path: string;
    changeKind: string;
    added: number;
    removed: number;
    /** The exact occurrences of this file that this group (or Left out) holds. */
    changeRefs: readonly string[];
    /** "1 of 2 changes" when the file's other changes sit elsewhere; null when the whole file is here. */
    part: Readonly<{ count: number; of: number }> | null;
    lockfile: boolean;
    generated: boolean;
    /** A paused commit's hook rewrote this file. */
    hookChanged: boolean;
}>;

/**
 * editable: no accepted application holds it · waiting/writing: the accepted run reaches it in order ·
 * landed: published, known SHA · paused: a hook changed content and waits for the person · failed: this
 * commit stopped the run · unknown: published or not cannot be told yet · notCreated: a stopped run left it.
 */
export type CommitProposalGroupState = 'editable' | 'waiting' | 'writing' | 'landed' | 'paused' | 'failed' | 'unknown' | 'notCreated';

export type CommitProposalGroup = Readonly<{
    id: string;
    number: number;
    message: string;
    rationale: string;
    changes: readonly CommitProposalChange[];
    added: number;
    removed: number;
    state: CommitProposalGroupState;
    step: ScmCommitPlanStep | null;
    landedSha: string | null;
    /** The message as Git recorded it, when a hook rewrote it. */
    rewrittenMessage: string | null;
    /** When the landed commit was made (its committer time), from the writer. */
    committedAtMs: number | null;
    /** The writer actually signed it (repository signing ran); false when unknown or unsigned. */
    signed: boolean;
    /** Editing is open for this group (nothing is applying, and it has not landed). */
    editable: boolean;
}>;

/** Each way an accepted run stops or waits, as one typed line (lab WT4-C4). */
export type CommitPlanOutcome =
    | Readonly<{ kind: 'signing'; groupId: string | null; message: string | null; landedCount: number }>
    | Readonly<{ kind: 'hookChanged'; groupId: string; hookName: string | null; paths: readonly string[]; beforeTreeOid: string; afterTreeOid: string; landedCount: number }>
    | Readonly<{ kind: 'hookFailed'; groupId: string | null; hookName: string | null; output: string | null; landedCount: number; remainingCount: number }>
    | Readonly<{ kind: 'headMoved'; landedCount: number; remainingCount: number }>
    | Readonly<{ kind: 'unknown'; groupId: string | null; landedCount: number }>
    | Readonly<{ kind: 'stopped'; landedCount: number; remainingCount: number }>
    | Readonly<{ kind: 'failed'; reason: string; groupId: string | null; message: string | null; landedCount: number; remainingCount: number }>
    | Readonly<{ kind: 'complete'; landedCount: number }>;

export type CommitProposal = Readonly<{
    groups: readonly CommitProposalGroup[];
    leftOut: readonly CommitProposalChange[];
    /** Distinct files the groups commit, and every file of the comparison ("8 of 9 files"). */
    committedFileCount: number;
    totalFileCount: number;
    application: ScmCommitPlanApplication | null;
    /** An accepted run holds the proposal (applying, paused for a hook, or an unresolved outcome). */
    locked: boolean;
    applying: boolean;
    landedCount: number;
    /** The group the accepted run is on now. */
    currentGroupId: string | null;
    outcome: CommitPlanOutcome | null;
    /** Groups a move emptied; Create stays off until each has a change or is merged away. */
    emptyGroupIds: readonly string[];
}>;

export type CommitProposalInput = Readonly<{
    comparison: ScmComparison;
    plan: ScmDiffSummaryCommitPlan;
    application: ScmCommitPlanApplication | null;
}>;

function changesFor(refs: readonly string[], occurrences: ReturnType<typeof locateComparisonOccurrences>, hookPaths: ReadonlySet<string>): CommitProposalChange[] {
    const byPath = new Map<string, LocatedOccurrence[]>();
    for (const ref of refs) {
        const entry = occurrences.located.get(ref);
        if (!entry) continue;
        const list = byPath.get(entry.file.path);
        if (list) list.push(entry);
        else byPath.set(entry.file.path, [entry]);
    }
    return [...byPath.values()].map((entries) => {
        const file = entries[0]!.file;
        const hunks = occurrences.hunksByPath.get(file.path) ?? [];
        const lines = entries.reduce((sum, entry) => {
            if (entry.hunkIndex === null) return sum;
            const next = countHunkLines(hunks[entry.hunkIndex] ?? '');
            return { added: sum.added + next.added, removed: sum.removed + next.removed };
        }, { added: 0, removed: 0 });
        const of = file.occurrences.length;
        return {
            key: file.path,
            path: file.path,
            changeKind: file.changeKind,
            added: lines.added,
            removed: lines.removed,
            changeRefs: entries.map((entry) => entry.occurrence.id),
            part: entries.length < of ? { count: entries.length, of } : null,
            lockfile: file.lockfile,
            generated: file.generated,
            hookChanged: hookPaths.has(file.path),
        };
    });
}

/** The latest step for a group; a renewed acceptance appends after the landed prefix. */
function stepFor(application: ScmCommitPlanApplication | null, groupId: string): ScmCommitPlanStep | null {
    if (!application) return null;
    for (let index = application.steps.length - 1; index >= 0; index -= 1) {
        if (application.steps[index]!.groupId === groupId) return application.steps[index]!;
    }
    return null;
}

function groupState(application: ScmCommitPlanApplication | null, step: ScmCommitPlanStep | null, current: boolean): CommitProposalGroupState {
    if (!application) return 'editable';
    if (!step) return application.status === 'applying' ? 'waiting' : 'notCreated';
    switch (step.state) {
        case 'published': return 'landed';
        case 'writing': return 'writing';
        case 'unknown': return 'unknown';
        case 'pending': return application.status === 'applying' || application.status === 'paused' ? 'waiting' : 'notCreated';
        case 'not_published':
            if (!current) return 'notCreated';
            return application.status === 'paused' ? 'paused' : application.status === 'applying' ? 'writing' : 'failed';
    }
}

function resolveOutcome(application: ScmCommitPlanApplication, current: ScmCommitPlanStep | null, landedCount: number, remainingCount: number): CommitPlanOutcome | null {
    const groupId = current?.groupId ?? null;
    switch (application.status) {
        case 'applying': return null;
        case 'complete': return { kind: 'complete', landedCount };
        case 'unknown': return { kind: 'unknown', groupId, landedCount };
        case 'stopped': return { kind: 'stopped', landedCount, remainingCount };
        case 'paused': {
            const changes = current?.hookContentChanges;
            if (application.reason === 'hook_content_changed' && current && changes) {
                return {
                    kind: 'hookChanged',
                    groupId: current.groupId,
                    hookName: current.publication?.hookName ?? null,
                    paths: changes.changes.map((change) => change.path),
                    beforeTreeOid: changes.beforeTreeOid,
                    afterTreeOid: changes.afterTreeOid,
                    landedCount,
                };
            }
            return { kind: 'failed', reason: application.reason ?? 'writer_failed', groupId, message: current?.error ?? null, landedCount, remainingCount };
        }
        case 'failed':
            switch (application.reason) {
                case 'signing_failed': return { kind: 'signing', groupId, message: current?.error ?? null, landedCount };
                case 'hook_failed': return { kind: 'hookFailed', groupId, hookName: current?.publication?.hookName ?? null, output: current?.error ?? null, landedCount, remainingCount };
                case 'head_moved': return { kind: 'headMoved', landedCount, remainingCount };
                case 'outcome_unknown': return { kind: 'unknown', groupId, landedCount };
                case 'stopped':
                case 'cancelled': return { kind: 'stopped', landedCount, remainingCount };
                default: return { kind: 'failed', reason: application.reason ?? 'writer_failed', groupId, message: current?.error ?? null, landedCount, remainingCount };
            }
    }
}

export function buildCommitProposal(input: CommitProposalInput): CommitProposal {
    const occurrences = locateComparisonOccurrences(input.comparison);
    const application = input.application;
    const locked = isScmCommitPlanApplicationLocked(application ?? undefined);
    const currentStep = application && application.status !== 'complete' ? application.steps[application.nextGroupIndex] ?? null : null;
    const hookPaths = new Set(currentStep?.hookContentChanges?.changes.map((change) => change.path) ?? []);
    const groups = input.plan.groups.map((group, index): CommitProposalGroup => {
        const step = stepFor(application, group.id);
        const current = currentStep?.groupId === group.id;
        const state = groupState(application, step, current);
        const changes = changesFor(group.changeRefs, occurrences, current ? hookPaths : new Set());
        const landedSha = state === 'landed' ? step?.commitSha ?? step?.publication?.candidateOid ?? null : null;
        const actualMessage = step?.actualMessage ?? step?.publication?.actualMessage ?? null;
        return {
            id: group.id,
            number: index + 1,
            message: group.message,
            rationale: group.rationale,
            changes,
            added: changes.reduce((sum, change) => sum + change.added, 0),
            removed: changes.reduce((sum, change) => sum + change.removed, 0),
            state,
            step,
            landedSha,
            rewrittenMessage: state === 'landed' && actualMessage !== null && actualMessage.trim() !== group.message.trim() ? actualMessage : null,
            committedAtMs: state === 'landed' ? step?.publication?.committedAtMs ?? null : null,
            signed: state === 'landed' && step?.publication?.signed === true,
            editable: !locked && state !== 'landed',
        };
    });
    const landedCount = groups.filter((group) => group.state === 'landed').length;
    const committed = new Set(groups.flatMap((group) => group.changes.map((change) => change.path)));
    return {
        groups,
        leftOut: changesFor(input.plan.leftOutChangeRefs, occurrences, new Set()),
        committedFileCount: committed.size,
        totalFileCount: input.comparison.inventory.files.length,
        application,
        locked,
        applying: application?.status === 'applying',
        landedCount,
        currentGroupId: locked ? currentStep?.groupId ?? null : null,
        outcome: application ? resolveOutcome(application, currentStep, landedCount, groups.length - landedCount) : null,
        emptyGroupIds: groups.filter((group) => group.changes.length === 0 && group.state !== 'landed').map((group) => group.id),
    };
}
