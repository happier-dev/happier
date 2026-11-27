import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { COMPUTER_RECORDING_ACTION_IDS_V1 as ids } from '@happier-dev/protocol/actions/actionIds';

import { ComputerRecordingSessionV1Schema } from '@happier-dev/protocol/computer/recording';

import type { ComputerActionExecute } from '@/sync/domains/computer/computerControlClient';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

const alert = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ spies: { alert } }).module);

const { useSessionComputerRecording } = await import('./useSessionComputerRecording');

const base = {
    v: 1, recordingId: 'recording-1', captureKind: 'streamFrameCapture', startedAtMs: 1_000, durationMs: 0, byteSize: 0, frameCount: 0, fps: 0,
    mimeType: 'video/webm', retentionClass: 'preSend', redactionLevel: 'metadataOnly', policyState: 'allowed',
    machineId: 'machine-1', sourceId: 'computer:1', sourceIdentity: { kind: 'session', sessionId: 'session-1' },
    target: { kind: 'display', displayId: ':0' }, mediaTarget: { sessionId: 'session-1', messageLocalId: 'local-1' },
} as const;
const recording = ComputerRecordingSessionV1Schema.parse({ ...base, status: 'recording' });
const finalized = { ...base, status: 'finalized', stoppedAtMs: 2_000, outcomeReason: 'user_stopped', durationMs: 1_000, byteSize: 10, frameCount: 3, fps: 3,
    mediaRef: { refKind: 'sessionMedia', mediaId: 'media-1', mediaKind: 'video', mimeType: 'video/webm', sizeBytes: 10 } } as const;

function createMachine(answers: Partial<Record<string, unknown>>) {
    const calls: Array<Readonly<{ actionId: string; input: Record<string, unknown>; context: Record<string, unknown> }>> = [];
    const execute = vi.fn(async (actionId: string, input: unknown, context: unknown) => {
        calls.push({ actionId, input: input as Record<string, unknown>, context: context as Record<string, unknown> });
        const result = answers[actionId];
        return result === undefined ? { ok: false, errorCode: 'nope', error: 'nope' } : { ok: true, result };
    });
    return { calls, execute: execute as never };
}

async function mount(machine: ReturnType<typeof createMachine>, sourceId: string | null = 'computer:1') {
    const hook = await renderHook((props: { sourceId: string | null }) => useSessionComputerRecording({
        sessionId: 'session-1', machineId: 'machine-1', serverId: 'server-1', sourceId: props.sourceId, enabled: true, execute: machine.execute,
    }), { initialProps: { sourceId } });
    await flushHookEffects();
    return hook;
}

describe('useSessionComputerRecording', () => {
    it('offers nothing until a window is shared', async () => {
        const hook = await mount(createMachine({ [ids.list]: [] }), null);
        expect(hook.getCurrent()).toBeNull();
    });

    it('preserves the typed refusal when the Machine declines Stop', async () => {
        alert.mockClear();
        const { t } = await import('@/text');
        const execute: ComputerActionExecute = async actionId => actionId === ids.list
            ? { ok: true, result: [recording] }
            : { ok: false, errorCode: 'action_forbidden', error: 'Private Machine detail',
                requestId: 'computer-stop-refusal', effectAttempted: false };
        const hook = await renderHook(() => useSessionComputerRecording({
            sessionId: 'session-1', machineId: 'machine-1', serverId: 'server-1', sourceId: 'computer:1', enabled: true, execute,
        }));
        await flushHookEffects();
        await act(async () => { hook.getCurrent()?.onStop(recording); await flushHookEffects(); });
        expect(alert.mock.calls[0]?.[1]).toBe(t('errors.permissionDenied'));
        const details = alert.mock.calls[0]?.[2]?.find((button: { text: string }) => button.text === t('approvals.technicalDetails'));
        expect(details).toBeDefined();
        details?.onPress();
        expect(alert.mock.calls[1]?.[1]).toContain('computer-stop-refusal');
        expect(alert.mock.calls[1]?.[1]).toContain('false');
        expect(hook.getCurrent()?.recording?.recordingId).toBe(recording.recordingId);
    });

    it('shows a recording that is already running when the viewer opens, so it can be stopped', async () => {
        const hook = await mount(createMachine({ [ids.list]: [recording] }));
        expect(hook.getCurrent()?.recording?.recordingId).toBe('recording-1');
    });

    it('starts through computer.recording.start for the Session, on the shared source', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
        try {
            const machine = createMachine({ [ids.list]: [], [ids.start]: { status: 'started', recording } });
            const hook = await mount(machine);
            await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
            const start = machine.calls.find(call => call.actionId === ids.start);
            expect(start?.input).toMatchObject({ machineId: 'machine-1', sourceId: 'computer:1', mediaTarget: { sessionId: 'session-1' } });
            expect(start?.context).toMatchObject({ defaultSessionId: 'session-1', externalActionTarget: { kind: 'machine', machineId: 'machine-1' } });
            expect(hook.getCurrent()?.recording?.status).toBe('recording');
            await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
            const starts = machine.calls.filter(call => call.actionId === ids.start);
            expect(starts[1]?.input.mediaTarget).toMatchObject({ sessionId: 'session-1' });
            expect(starts[1]?.input.mediaTarget).not.toEqual(starts[0]?.input.mediaTarget);
        } finally {
            clock.mockRestore();
        }
    });

    it('stops and leaves the finished video to the Session, showing no running recording', async () => {
        const machine = createMachine({ [ids.list]: [recording], [ids.stop]: { status: 'finalized', recording: finalized } });
        const hook = await mount(machine);
        await act(async () => { hook.getCurrent()?.onStop(hook.getCurrent()!.recording!); await flushHookEffects(); });
        expect(machine.calls.find(call => call.actionId === ids.stop)?.input).toMatchObject({ recordingId: 'recording-1', sourceId: 'computer:1' });
        expect(hook.getCurrent()?.recording).toBeNull();
    });

    it('applies a start that was in flight when the executor identity changed (approval lifecycle)', async () => {
        const started = createDeferred<unknown>();
        const list = createMachine({ [ids.list]: [] });
        const first = vi.fn(async (actionId: string) => actionId === ids.start
            ? { ok: true, result: await started.promise } : { ok: true, result: [] });
        const hook = await renderHook((props: { execute: unknown }) => useSessionComputerRecording({
            sessionId: 'session-1', machineId: 'machine-1', serverId: 'server-1', sourceId: 'computer:1', enabled: true, execute: props.execute as never,
        }), { initialProps: { execute: first } });
        await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
        await hook.rerender({ execute: list.execute });
        await act(async () => { started.resolve({ status: 'started', recording }); await flushHookEffects(); });
        expect(hook.getCurrent()?.recording?.status).toBe('recording');
    });

    it('keeps a started recording when a slower list answers empty after it', async () => {
        const listed = createDeferred<unknown>();
        const execute = vi.fn(async (actionId: string) => actionId === ids.list
            ? { ok: true, result: await listed.promise }
            : { ok: true, result: { status: 'started', recording } });
        const hook = await renderHook(() => useSessionComputerRecording({
            sessionId: 'session-1', machineId: 'machine-1', serverId: 'server-1', sourceId: 'computer:1', enabled: true, execute: execute as never,
        }));
        await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
        await act(async () => { listed.resolve([]); await flushHookEffects(); });
        expect(hook.getCurrent()?.recording?.status).toBe('recording');
    });

    it('says when a start fails instead of pretending it recorded', async () => {
        alert.mockClear();
        const hook = await mount(createMachine({ [ids.list]: [] }));
        await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent()?.recording).toBeNull();
    });

    // The daemon's typed refusal (encoderFailure.ts): a missing encoder is not a moment's wait; one that failed to start may be.
    it.each([
        ['encoder_unavailable', 'browserRecording.failure.encoderUnavailable'],
        ['encoder_failed', 'browserRecording.failure.encoderFailed'],
    ] as const)('says what the Machine answered when it cannot start (%s)', async (code, key) => {
        alert.mockClear();
        const { t } = await import('@/text');
        const hook = await mount(createMachine({ [ids.list]: [], [ids.start]: { status: 'unavailable', reason: { code, message: code } } }));
        await act(async () => { hook.getCurrent()?.onStart(); await flushHookEffects(); });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(alert.mock.calls[0]?.slice(0, 2)).toEqual([t('browserRecording.failure.startTitle'), t(key)]);
        expect(hook.getCurrent()?.recording).toBeNull();
    });

    it('says a stop whose save failed stopped and was not saved, and shows no running recording', async () => {
        alert.mockClear();
        const { t } = await import('@/text');
        const failed = { ...base, status: 'failed', stoppedAtMs: 2_000, outcomeReason: 'media_persistence_failed' } as const;
        const machine = createMachine({ [ids.list]: [recording],
            [ids.stop]: { status: 'failed', recording: failed, reason: 'media_persistence_failed', saveFailure: 'workspace_write_failed' } });
        const hook = await mount(machine);
        await act(async () => { hook.getCurrent()?.onStop(hook.getCurrent()!.recording!); await flushHookEffects(); });
        expect(alert).toHaveBeenCalledTimes(1);
        expect(alert.mock.calls[0]?.slice(0, 2)).toEqual([t('browserRecording.failure.notSavedTitle'), t('browserRecording.failure.notSavedGone')]);
        expect(hook.getCurrent()?.recording).toBeNull();
    });

    it('forgets a recording when the shared source changes', async () => {
        const machine = createMachine({ [ids.list]: [recording] });
        const hook = await mount(machine);
        machine.calls.length = 0;
        await hook.rerender({ sourceId: 'computer:2' });
        await flushHookEffects();
        expect(machine.calls.map(call => [call.actionId, call.input.sourceId])).toEqual([[ids.list, 'computer:2']]);
    });
});
