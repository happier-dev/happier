import * as React from 'react';
import { COMPUTER_RECORDING_ACTION_IDS_V1 as ids } from '@happier-dev/protocol/actions/actionIds';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { ComputerRecordingSessionV1Schema, type ComputerRecordingSessionV1 } from '@happier-dev/protocol/computer/recording';
import { DaemonBrowserRecordingUnavailableReasonV1Schema } from '@happier-dev/protocol/browser/recording/v1';

import { useInPlaceApprovalReview } from '@/components/approvals/ApprovalReviewInPlace';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { presentBrowserRecordingActionFailure, presentRecordingStartRefusal, presentRecordingStopOutcome } from '@/components/browser/recording/recordingActions';
import { randomUUID } from '@/platform/randomUUID';
import type { ComputerActionExecute } from '@/sync/domains/computer/computerControlClient';

/** The person's recorder for the shared source; the viewer's menu and capsule, and the pane's bar, read this one control. */
export type ComputerRecordingControl = Readonly<{
    /** The running recording, or null when Record is what is on offer. */
    recording: ComputerRecordingSessionV1 | null;
    /** Discovery failed; the Machine still owns whether a later Start can run. */
    failure?: ActionExecuteFailure;
    onStart: () => void;
    onStop: (recording: ComputerRecordingSessionV1) => void;
    onDiscard: () => void;
}>;

function isRunning(recording: ComputerRecordingSessionV1): boolean {
    return recording.status === 'starting' || recording.status === 'recording' || recording.status === 'stopping';
}

/** Every recording Action that succeeds answers with the recording's latest state. */
function readRecording(result: ActionExecuteResult): ComputerRecordingSessionV1 | null {
    if (!result.ok || !result.result || typeof result.result !== 'object') return null;
    const parsed = ComputerRecordingSessionV1Schema.safeParse((result.result as { recording?: unknown }).recording);
    return parsed.success ? parsed.data : null;
}

/** A start the Machine refused answers `{ status: 'unavailable', reason }`, the recorder's shared refusal shape. */
function readStartRefusalCode(result: ActionExecuteResult): string | null {
    if (!result.ok || !result.result || typeof result.result !== 'object') return null;
    const answer = result.result as { status?: unknown; reason?: unknown };
    if (answer.status !== 'unavailable') return null;
    return DaemonBrowserRecordingUnavailableReasonV1Schema.safeParse(answer.reason).data?.code ?? null;
}

/**
 * Start, stop and discard for the Session's shared window, through the `computer.recording.*` Actions the
 * Machine's shared recorder owns. A finished recording is delivered to the Session as its media
 * (`mediaTarget`), so the transcript's own player plays it. Only Sessions record: the daemon refuses a
 * Machine-only source.
 */
export function useSessionComputerRecording(input: Readonly<{
    sessionId: string;
    machineId: string;
    serverId: string | null;
    /** The shared source; null while nothing is shared. */
    sourceId: string | null;
    enabled: boolean;
    execute?: ComputerActionExecute;
}>): ComputerRecordingControl | null {
    const { sessionId, machineId, sourceId } = input;
    const mounted = useMountedActionExecution(input.execute ? null : input.serverId, { retainInvocation: true });
    const approvalReview = useInPlaceApprovalReview(mounted.approval);
    // The executor is re-derived on the approval lifecycle; a run in flight must keep its signal through that.
    const execute = React.useRef<ComputerActionExecute>(input.execute ?? mounted.execute);
    execute.current = input.execute ?? mounted.execute;
    const active = input.enabled && sourceId !== null && (input.execute !== undefined || mounted.ready);
    const [owned, setOwned] = React.useState<Readonly<{ sourceId: string; recording: ComputerRecordingSessionV1 | null; failure?: ActionExecuteFailure }> | null>(null);
    const startPending = React.useRef(false);
    const requestScope = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        if (!active || !sourceId) return undefined;
        const controller = new AbortController();
        requestScope.current = controller;
        startPending.current = false;
        const retainFailure = (value: unknown) => {
            const failure = readActionFailureEnvelope(value);
            if (controller.signal.aborted || !failure) return;
            setOwned(current => ({ sourceId, recording: current?.sourceId === sourceId ? current.recording : null, failure }));
        };
        // One read per shared source: a recording started before this viewer opened stays stoppable.
        void execute.current(ids.list, { machineId, sourceId }, {
            signal: controller.signal, defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId },
        }).then((result) => {
            if (controller.signal.aborted) return;
            if (!result.ok) { retainFailure(result); return; }
            if (!Array.isArray(result.result)) return;
            const running = result.result.flatMap((entry) => {
                const parsed = ComputerRecordingSessionV1Schema.safeParse(entry);
                return parsed.success && isRunning(parsed.data) ? [parsed.data] : [];
            });
            // A slower list never replaces what this viewer just started: the read can predate the start.
            setOwned(current => (current?.sourceId === sourceId && current.recording ? current : { sourceId, recording: running[0] ?? null }));
        }, retainFailure);
        return () => {
            controller.abort();
            if (requestScope.current === controller) requestScope.current = null;
        };
    }, [active, machineId, sessionId, sourceId]);

    const reopenApproval = approvalReview.reopen;
    const onStart = React.useCallback(async () => {
        const signal = requestScope.current?.signal;
        if (!sourceId || !signal) return;
        if (startPending.current) {
            reopenApproval();
            return;
        }
        startPending.current = true;
        try {
            const result = await execute.current(ids.start, {
                machineId,
                sourceId,
                mediaTarget: { sessionId, messageLocalId: randomUUID() },
            }, { signal, defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId } });
            if (signal.aborted) return;
            const recording = readRecording(result);
            const refusal = recording ? null : readStartRefusalCode(result);
            if (recording) setOwned({ sourceId, recording });
            else if (refusal) presentRecordingStartRefusal(refusal);
            else presentBrowserRecordingActionFailure('start', result);
        } catch (error) {
            if (!signal.aborted) presentBrowserRecordingActionFailure('start', error);
        } finally {
            startPending.current = false;
        }
    }, [machineId, reopenApproval, sessionId, sourceId]);

    const settle = React.useCallback(async (
        actionId: typeof ids.stop | typeof ids.cancel,
        recordingId: string,
        failure: 'stop' | 'discard',
    ) => {
        const signal = requestScope.current?.signal;
        if (!sourceId || !signal) return;
        try {
            const result = await execute.current(actionId, { machineId, sourceId, recordingId },
                { signal, defaultSessionId: sessionId, externalActionTarget: { kind: 'machine', machineId } });
            if (signal.aborted) return;
            const recording = readRecording(result);
            if (recording) setOwned({ sourceId, recording: isRunning(recording) ? recording : null });
            if (!result.ok) presentBrowserRecordingActionFailure(failure, result);
            else if (failure === 'stop') presentRecordingStopOutcome(result.result);
            else if (!recording || recording.status === 'failed') presentBrowserRecordingActionFailure(failure);
        } catch (error) {
            if (!signal.aborted) presentBrowserRecordingActionFailure(failure, error);
        }
    }, [machineId, sessionId, sourceId]);

    const recording = owned?.sourceId === sourceId ? owned.recording : null;
    const failure = owned?.sourceId === sourceId ? owned.failure : undefined;
    const onStop = React.useCallback((target: ComputerRecordingSessionV1) => {
        void settle(ids.stop, target.recordingId, 'stop');
    }, [settle]);
    const recordingId = recording?.recordingId ?? null;
    const onDiscard = React.useCallback(() => {
        if (recordingId) void settle(ids.cancel, recordingId, 'discard');
    }, [recordingId, settle]);
    const start = React.useCallback(() => { void onStart(); }, [onStart]);

    return React.useMemo(
        () => (active ? { recording, ...(failure ? { failure } : {}), onStart: start, onStop, onDiscard } : null),
        [active, failure, onDiscard, onStop, recording, start],
    );
}
