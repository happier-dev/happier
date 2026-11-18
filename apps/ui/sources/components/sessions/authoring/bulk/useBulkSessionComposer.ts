import { useCallback, useMemo, useRef, useState } from 'react';
import type { ExistingSessionCapabilityDelta, ExistingSessionChangeSet } from '@happier-dev/protocol/sessions/authoring/existingSessionFieldApplication';
import { SESSION_CAPABILITY_KINDS_V1, readSessionCapabilityOverrideV1, type SessionCapabilitySelectionV1 } from '@happier-dev/protocol/reach/sessionCapabilitySelectionV1';
import { planExistingSessionChanges, type ExistingSessionChangePlan, type ExistingSessionPlanningTarget } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useComposerTextSelector, useComposerTextStore } from '@/components/sessions/agentInput/composerTextStore';
import { bulkChangeTargetKey, executeBulkSessionChanges, isBulkSessionRetryable, orderBulkSessionChangeRows, summarizeBulkSessionChanges, type BulkSessionChangeRow } from './executeBulkSessionChanges';

// Bridge the current shared-selection chip until the screen wires its item callback.
type PendingSelection = ExistingSessionChangeSet & Readonly<{ capabilitySelection?: SessionCapabilitySelectionV1 | null }>;

function readCapabilityDelta(before: SessionCapabilitySelectionV1, after: SessionCapabilitySelectionV1): readonly ExistingSessionCapabilityDelta[] {
    return SESSION_CAPABILITY_KINDS_V1.flatMap(kind => {
        const ids = (value: SessionCapabilitySelectionV1) => kind === 'skill'
            ? [...(value.skills?.forceIncludeSkillIds ?? []), ...(value.skills?.forceExcludeSkillIds ?? [])]
            : kind === 'mcp_server'
                ? [...(value.mcp?.forceIncludeServerIds ?? []), ...(value.mcp?.forceExcludeServerIds ?? [])]
                : value.skills?.excludeNativeSkillNames ?? [];
        return [...new Set([...ids(before), ...ids(after)])].flatMap(id => {
            const state = readSessionCapabilityOverrideV1(after, kind, id);
            return state === readSessionCapabilityOverrideV1(before, kind, id) ? [] : [{ kind, id, state }];
        });
    });
}

type Submission = Readonly<{ selection: ExistingSessionChangeSet; text: string; targets: readonly ExistingSessionPlanningTarget[];
    skippedTargets: ExistingSessionChangePlan['skippedTargets'] }>;

function planSubmission(snapshot: Submission): ExistingSessionChangePlan {
    const planned = planExistingSessionChanges(snapshot.selection, snapshot.targets, snapshot.text);
    return { ...planned, skippedTargets: [...snapshot.skippedTargets, ...planned.skippedTargets] };
}
const hasMessageText = (text: string) => text.length > 0;
/** Pending chips are local intent. Only Send and explicit Retry cross the Action boundary. */
export function useBulkSessionComposer(input: Readonly<{
    targets: readonly ExistingSessionPlanningTarget[];
    skippedTargets?: ExistingSessionChangePlan['skippedTargets'];
    initialText?: string;
    executeConfirmed?: Parameters<typeof executeBulkSessionChanges>[0]['executeConfirmed'];
    context?: UiActionExecutorContext;
}>) {
    const agentSwitchingEnabled = useFeatureEnabled('sessions.agentSwitching');
    const textStore = useComposerTextStore(() => input.initialText ?? '');
    const hasMessage = useComposerTextSelector(textStore, hasMessageText);
    const [selection, setPendingSelection] = useState<PendingSelection>({});
    const baselineCapabilitySelection = input.targets[0]?.capabilitySelection;
    const setSelection = useCallback((next: PendingSelection) => {
        setPendingSelection(previous => {
            if (next.capabilitySelection === previous.capabilitySelection) return { ...next, capabilityDeltas: previous.capabilityDeltas };
            return { ...next, capabilityDeltas: readCapabilityDelta(baselineCapabilitySelection ?? {}, next.capabilitySelection ?? {}) };
        });
    }, [baselineCapabilitySelection]);
    const setCapabilityItem = useCallback((delta: ExistingSessionCapabilityDelta) => {
        setPendingSelection(previous => ({
            ...previous,
            capabilityDeltas: [...(previous.capabilityDeltas ?? []).filter(item => item.kind !== delta.kind || item.id !== delta.id), delta],
        }));
    }, []);
    const [rows, setRows] = useState<readonly BulkSessionChangeRow[]>([]);
    const [submitting, setSubmitting] = useState(false);
    const running = useRef(false);
    const submitted = useRef<Submission | null>(null);
    const frontDoor = useMemo(() => createFrontDoorActionExecute(), []);
    const getPlan = useCallback(() => planSubmission({ selection, targets: input.targets, text: textStore.getPrompt(),
        skippedTargets: input.skippedTargets ?? [] }), [selection, input.targets, textStore, input.skippedTargets]);
    // Consequences depend on empty/nonempty text. The exact text is read only by Send.
    const consequencePlan = useMemo(getPlan, [getPlan, hasMessage]);
    const consequences = useMemo(() => summarizeBulkSessionChanges(consequencePlan), [consequencePlan]);
    const run = useCallback(async (snapshot: Submission) => {
        if (running.current) return;
        running.current = true;
        setSubmitting(true);
        const planned = planSubmission(snapshot);
        const keys = new Set(snapshot.targets.map(target => bulkChangeTargetKey(target.address)));
        setRows(previous => orderBulkSessionChangeRows([
            ...previous.filter(row => !keys.has(bulkChangeTargetKey(row.target))),
            ...snapshot.targets.map(({ address }): BulkSessionChangeRow => ({ target: address, actionId: planned.stages[0]?.actionId ?? 'session.message.send', state: 'applying' })),
        ]));
        try {
            await executeBulkSessionChanges({ plan: planned, executeConfirmed: input.executeConfirmed ?? frontDoor.confirmed,
                context: input.context, onResult: row => setRows(previous => orderBulkSessionChangeRows([
                    ...previous.filter(old => bulkChangeTargetKey(old.target) !== bulkChangeTargetKey(row.target)), row,
                ])) });
        } finally {
            running.current = false;
            setSubmitting(false);
        }
    }, [input.executeConfirmed, input.context, frontDoor]);
    const send = useCallback(() => {
        const plan = getPlan();
        if (running.current || plan.unsupportedFields.length || !plan.stages.length) return Promise.resolve();
        const snapshot = { selection, text: textStore.getPrompt(), targets: input.targets, skippedTargets: input.skippedTargets ?? [] };
        submitted.current = snapshot;
        return run(snapshot);
    }, [run, selection, textStore, input.targets, input.skippedTargets, getPlan]);
    const retryFailed = useCallback((onlyTarget?: BulkSessionChangeRow['target']) => {
        const snapshot = submitted.current;
        if (!snapshot) return Promise.resolve();
        const failed = new Set(rows.filter(row => isBulkSessionRetryable(row)
            && (!onlyTarget || bulkChangeTargetKey(row.target) === bulkChangeTargetKey(onlyTarget))).map(row => bulkChangeTargetKey(row.target)));
        const submittedKeys = new Set(snapshot.targets.map(target => bulkChangeTargetKey(target.address)));
        // Settings intent is frozen, while the planner consumes the current target facts.
        // A successful engine switch must not be requested again with its old expected Agent.
        const targets = input.targets.filter(target => submittedKeys.has(bulkChangeTargetKey(target.address))
            && failed.has(bulkChangeTargetKey(target.address)));
        return targets.length ? run({ ...snapshot, targets }) : Promise.resolve();
    }, [rows, run, input.targets]);
    return { textStore, setText: textStore.setPrompt, selection, setSelection, setCapabilityItem, rows, submitting, getPlan, consequences, agentSwitchingEnabled,
        canSend: !submitting && consequencePlan.stages.length > 0 && consequencePlan.unsupportedFields.length === 0,
        failedTargets: rows.filter(isBulkSessionRetryable).map(row => row.target), send, retryFailed };
}
