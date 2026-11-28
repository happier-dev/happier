import { renderHook } from '@/dev/testkit';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol/sessions/external/operationV1';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const modalAlertSpy = vi.hoisted(() => vi.fn());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { alert: modalAlertSpy } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const { useExternalSessionContinueInNewSession } = await import('./useExternalSessionContinueInNewSession');

type Params = Parameters<typeof useExternalSessionContinueInNewSession>[0];
type Status = ExternalSessionOperationProgressV1['status'];

/** The import owner's start reply: the operation it started or converged on, as the daemon reports it. */
function startedImport(status: Status, operationId = 'operation-new'): ExternalSessionOperationProgressV1 {
    return {
        v: 1,
        operationId,
        revision: 1,
        request: { plan: 'materialize', targetStorageMode: 'external-linked', targetRuntimeMode: null },
        status,
        phase: 'validating',
        timeline: EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize,
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'machine_only',
        checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: { total: 0, record: 0, media: 0, conversion: 0, diagnosticsTruncated: false },
        },
        fence: { kind: 'none' },
    } as ExternalSessionOperationProgressV1;
}

function pushedOperation(status: Status, operationId = 'operation-new'): NonNullable<Params['operation']> {
    return { operationId, status };
}

function createParams(overrides: Partial<Params> = {}): Params {
    return {
        sessionId: 'session-1',
        replayEnabled: true,
        materializeNeeded: true,
        importPublished: false,
        operation: null,
        requestMaterialize: vi.fn(async () => startedImport('running')),
        openReplayFork: vi.fn(),
        ...overrides,
    };
}

async function renderContinue(params: Params) {
    return await renderHook((input: Params) => useExternalSessionContinueInNewSession(input), {
        initialProps: params,
    });
}

describe('useExternalSessionContinueInNewSession', () => {
    beforeEach(() => {
        modalAlertSpy.mockReset();
    });

    it('opens the replay fork directly when the session is already imported', async () => {
        const params = createParams({ materializeNeeded: false, importPublished: true });
        const harness = await renderContinue(params);

        expect(harness.getCurrent().available).toBe(true);
        await act(async () => {
            await harness.getCurrent().requestContinue();
        });

        expect(params.requestMaterialize).not.toHaveBeenCalled();
        expect(params.openReplayFork).toHaveBeenCalledTimes(1);
        expect(harness.getCurrent().inFlight).toBe(false);
        await harness.unmount();
    });

    it('imports first, then opens the replay fork once the imported snapshot is published', async () => {
        const params = createParams();
        const harness = await renderContinue(params);

        await act(async () => {
            await harness.getCurrent().requestContinue();
        });
        expect(params.requestMaterialize).toHaveBeenCalledTimes(1);
        expect(params.openReplayFork).not.toHaveBeenCalled();
        expect(harness.getCurrent().inFlight).toBe(true);

        await harness.rerender({ ...params, operation: pushedOperation('running') });
        expect(params.openReplayFork).not.toHaveBeenCalled();

        // The operation reports completion before the storage state flips: still the success path.
        await harness.rerender({ ...params, operation: pushedOperation('completed') });
        expect(params.openReplayFork).not.toHaveBeenCalled();
        expect(harness.getCurrent().inFlight).toBe(true);

        const published = {
            ...params,
            operation: pushedOperation('completed'),
            materializeNeeded: false,
            importPublished: true,
        };
        await harness.rerender(published);
        expect(params.openReplayFork).toHaveBeenCalledTimes(1);
        expect(harness.getCurrent().inFlight).toBe(false);

        await harness.rerender(published);
        expect(params.openReplayFork).toHaveBeenCalledTimes(1);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await harness.unmount();
    });

    it.each(['failed', 'awaiting_user_resume', 'reconciliation_required', 'cancelled', 'discarded'] as const)(
        'leaves busy and shows the import owner\'s %s outcome when the import settles without a copy',
        async (status) => {
            const params = createParams();
            const harness = await renderContinue(params);

            await act(async () => {
                await harness.getCurrent().requestContinue();
            });
            await harness.rerender({ ...params, operation: pushedOperation('running') });
            await harness.rerender({ ...params, operation: pushedOperation(status) });

            expect(params.openReplayFork).not.toHaveBeenCalled();
            expect(harness.getCurrent().inFlight).toBe(false);
            expect(modalAlertSpy).toHaveBeenCalledTimes(1);
            expect(modalAlertSpy.mock.calls[0]?.[0]).toBe('common.error');
            expect(modalAlertSpy.mock.calls[0]?.[1]).toMatch(/^externalSessions\.operation/);
            await harness.unmount();
        },
    );

    it('settles at once when the start reply converges on an operation that already ended without a copy', async () => {
        const params = createParams({ requestMaterialize: vi.fn(async () => startedImport('cancelled')) });
        const harness = await renderContinue(params);

        await act(async () => {
            await harness.getCurrent().requestContinue();
        });

        expect(params.openReplayFork).not.toHaveBeenCalled();
        expect(harness.getCurrent().inFlight).toBe(false);
        expect(modalAlertSpy).toHaveBeenCalledWith('common.error', 'externalSessions.operationStatusCancelled');
        await harness.unmount();
    });

    it('does not mistake an earlier operation\'s settled state for the import it started', async () => {
        const previous = pushedOperation('failed', 'operation-previous');
        const params = createParams({ operation: previous });
        const harness = await renderContinue(params);

        await act(async () => {
            await harness.getCurrent().requestContinue();
        });
        await harness.rerender({ ...params, operation: previous });

        expect(harness.getCurrent().inFlight).toBe(true);
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await harness.unmount();
    });

    it('stays idle and opens nothing when the import owner refuses to start', async () => {
        const params = createParams({ requestMaterialize: vi.fn(async () => null) });
        const harness = await renderContinue(params);

        await act(async () => {
            await harness.getCurrent().requestContinue();
        });

        expect(params.requestMaterialize).toHaveBeenCalledTimes(1);
        expect(params.openReplayFork).not.toHaveBeenCalled();
        expect(harness.getCurrent().inFlight).toBe(false);
        // The import owner already showed its own refusal.
        expect(modalAlertSpy).not.toHaveBeenCalled();
        await harness.unmount();
    });

    it('is not offered when Replay is off or the transcript is neither importable nor published', async () => {
        const replayOff = createParams({ replayEnabled: false });
        const offHarness = await renderContinue(replayOff);
        expect(offHarness.getCurrent().available).toBe(false);
        await act(async () => {
            await offHarness.getCurrent().requestContinue();
        });
        expect(replayOff.requestMaterialize).not.toHaveBeenCalled();
        expect(replayOff.openReplayFork).not.toHaveBeenCalled();
        await offHarness.unmount();

        const partial = createParams({ materializeNeeded: false, importPublished: false });
        const partialHarness = await renderContinue(partial);
        expect(partialHarness.getCurrent().available).toBe(false);
        await partialHarness.unmount();
    });
});
