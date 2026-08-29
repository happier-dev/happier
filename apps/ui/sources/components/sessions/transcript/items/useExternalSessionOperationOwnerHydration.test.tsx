import {
    EXTERNAL_SESSION_OPERATION_TIMELINES_V1,
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationSharedPresentationV1Schema,
    projectExternalSessionOperationSharedPresentationV1,
    type ExternalSessionOperationProgressV1,
    type ExternalSessionOperationSharedPresentationV1,
} from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';

const machineExternalSessionOperationStatusSpy = vi.hoisted(() => vi.fn());

vi.mock('@/sync/ops/machineExternalSessions', () => ({
    machineExternalSessionOperationStatus: machineExternalSessionOperationStatusSpy,
}));

type HookInput = Readonly<{
    presentation: ExternalSessionOperationSharedPresentationV1 | null;
    isExactOwner: boolean;
    machineOnline: boolean;
    machineId?: string | null;
    ownerScopeKey?: string | null;
    serverId?: string | null;
}>;

function createPresentation(
    overrides: Partial<ExternalSessionOperationSharedPresentationV1> = {},
): ExternalSessionOperationSharedPresentationV1 {
    return ExternalSessionOperationSharedPresentationV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        kind: 'materialize',
        status: 'running',
        phase: 'validating',
        ...overrides,
    });
}

function createProgress(
    overrides: Partial<ExternalSessionOperationProgressV1> = {},
): ExternalSessionOperationProgressV1 {
    const request = overrides.request ?? {
        plan: 'materialize',
        targetStorageMode: 'external-linked',
        targetRuntimeMode: null,
    };
    const timeline = request.plan === 'materialize'
        ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.materialize
        : request.targetStorageMode === 'persisted'
            ? EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_persisted
            : EXTERNAL_SESSION_OPERATION_TIMELINES_V1.takeover_external_linked;
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        request,
        status: 'running',
        phase: 'validating',
        timeline,
        updatedAtMs: 1_700_000_000_000,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'machine_only',
        checkpoint: {
            sourcePagesRead: 0,
            stagedItemCount: 0,
            importedItemCount: 0,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: { kind: 'none' },
        ...overrides,
    });
}

function createSameIdentityPresentationChange(
    field: 'kind' | 'status' | 'phase',
): Readonly<{
    presentation: ExternalSessionOperationSharedPresentationV1;
    progress: ExternalSessionOperationProgressV1;
}> {
    const progress = field === 'kind'
        ? createProgress({
            request: {
                plan: 'takeover',
                targetStorageMode: 'external-linked',
                targetRuntimeMode: 'terminal',
            },
        })
        : field === 'status'
            ? createProgress({ status: 'cancel_requested' })
            : createProgress({ phase: 'staging' });
    return {
        presentation: projectExternalSessionOperationSharedPresentationV1(progress),
        progress,
    };
}

async function renderOwnerHydration(input: HookInput) {
    const { useExternalSessionOperationOwnerHydration } = await import(
        './useExternalSessionOperationOwnerHydration'
    );
    return await renderHook((props: HookInput) => {
        const {
            machineId = 'machine-1',
            ownerScopeKey = 'server-1:owner-1',
            serverId = 'server-1',
            ...ownerInput
        } = props;
        return (
            useExternalSessionOperationOwnerHydration({
                ...ownerInput,
                machineId,
                ownerScopeKey,
                serverId,
                sessionId: 'session-1',
            })
        );
    }, {
        initialProps: input,
    });
}

describe('useExternalSessionOperationOwnerHydration', () => {
    beforeEach(() => {
        machineExternalSessionOperationStatusSpy.mockReset();
    });

    afterEach(async () => {
        await standardCleanup();
    });

    it('loads complete progress once per mounted exact key without rerender polling', async () => {
        const progress4 = createProgress();
        const progress5 = createProgress({ revision: 5, phase: 'staging' });
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: progress4 })
            .mockResolvedValueOnce({ ok: true, progress: progress5 });
        const presentation4 = createPresentation();
        const hook = await renderOwnerHydration({
            presentation: presentation4,
            isExactOwner: true,
            machineOnline: true,
        });

        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            sessionId: 'session-1',
            operationId: 'operation-1',
            revision: 4,
        }, { serverId: 'server-1' });
        expect(hook.getCurrent().progress).toEqual(progress4);

        await hook.rerender({
            presentation: { ...presentation4 },
            isExactOwner: true,
            machineOnline: true,
        });
        await hook.rerender({
            presentation: presentation4,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);

        await hook.rerender({
            presentation: createPresentation({ revision: 5, phase: 'staging' }),
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(progress5);
    });

    it.each([
        ['kind'],
        ['status'],
        ['phase'],
    ] as const)(
        'invalidates and refreshes hydration when exact presentation %s changes at the same operation revision',
        async (field) => {
            const initialProgress = createProgress();
            const changed = createSameIdentityPresentationChange(field);
            const changedRead = createDeferred<{
                ok: true;
                progress: ExternalSessionOperationProgressV1;
            }>();
            machineExternalSessionOperationStatusSpy
                .mockResolvedValueOnce({ ok: true, progress: initialProgress })
                .mockReturnValueOnce(changedRead.promise);
            const initialPresentation = createPresentation();
            const hook = await renderOwnerHydration({
                presentation: initialPresentation,
                isExactOwner: true,
                machineOnline: true,
            });

            expect(hook.getCurrent().progress).toEqual(initialProgress);

            await hook.rerender({
                presentation: changed.presentation,
                isExactOwner: true,
                machineOnline: true,
            });

            expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().progress).toBeNull();

            changedRead.resolve({ ok: true, progress: changed.progress });
            await flushHookEffects();
            expect(hook.getCurrent().progress).toEqual(changed.progress);
        },
    );

    it.each([
        ['kind'],
        ['status'],
        ['phase'],
    ] as const)(
        'rejects a point response whose exact presentation %s differs at the same operation revision',
        async (field) => {
            const changed = createSameIdentityPresentationChange(field);
            machineExternalSessionOperationStatusSpy.mockResolvedValue({
                ok: true,
                progress: createProgress(),
            });
            const hook = await renderOwnerHydration({
                presentation: changed.presentation,
                isExactOwner: true,
                machineOnline: true,
            });

            expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().progress).toBeNull();
        },
    );

    it.each([
        ['kind'],
        ['status'],
        ['phase'],
    ] as const)(
        'ignores an action result whose exact presentation %s differs without erasing matching LKG',
        async (field) => {
            const initialProgress = createProgress();
            machineExternalSessionOperationStatusSpy.mockResolvedValue({
                ok: true,
                progress: initialProgress,
            });
            const hook = await renderOwnerHydration({
                presentation: createPresentation(),
                isExactOwner: true,
                machineOnline: true,
            });
            const changed = createSameIdentityPresentationChange(field);

            await act(async () => {
                hook.getCurrent().onActionResult(changed.progress);
            });

            expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().progress).toEqual(initialProgress);
        },
    );

    it.each([
        ['kind'],
        ['status'],
        ['phase'],
    ] as const)(
        'invalidates retained offline progress and refreshes once after reconnect when presentation %s changes',
        async (field) => {
            const initialProgress = createProgress();
            const changed = createSameIdentityPresentationChange(field);
            const reconnectRead = createDeferred<{
                ok: true;
                progress: ExternalSessionOperationProgressV1;
            }>();
            machineExternalSessionOperationStatusSpy
                .mockResolvedValueOnce({ ok: true, progress: initialProgress })
                .mockReturnValueOnce(reconnectRead.promise);
            const hook = await renderOwnerHydration({
                presentation: createPresentation(),
                isExactOwner: true,
                machineOnline: true,
            });

            await hook.rerender({
                presentation: changed.presentation,
                isExactOwner: true,
                machineOnline: false,
            });

            expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
            expect(hook.getCurrent().progress).toBeNull();

            await hook.rerender({
                presentation: changed.presentation,
                isExactOwner: true,
                machineOnline: true,
            });

            expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
            expect(hook.getCurrent().progress).toBeNull();

            reconnectRead.resolve({ ok: true, progress: changed.progress });
            await flushHookEffects();
            expect(hook.getCurrent().progress).toEqual(changed.progress);
        },
    );

    it('reports a failed status read as recoverable and re-reads once on an explicit check', async () => {
        // A transient read failure used to be indistinguishable from "not the owner": the row
        // degraded to the generic read-only card with no way back short of a remount or an
        // offline -> online flip. The failure is now its own status, recoverable ONCE per press.
        const progress = createProgress();
        machineExternalSessionOperationStatusSpy
            .mockRejectedValueOnce(new Error('status read failed'))
            .mockResolvedValueOnce({ ok: true, progress });
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });

        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().progress).toBeNull();
        expect(hook.getCurrent().status).toBe('unavailable');

        await act(async () => {
            hook.getCurrent().checkAgain();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });

        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().status).toBe('ready');
        expect(hook.getCurrent().progress).toEqual(progress);

        // No polling: a settled read is not re-issued by pressing again.
        await act(async () => {
            hook.getCurrent().checkAgain();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
    });

    it('settles checkAgain as false when the re-read fails again and true only when it succeeds', async () => {
        // The row host owns the armed focus transition for a Check Again press
        // and needs the settlement: a failed re-read must disarm, a successful
        // one may keep it for the exact card replacement.
        const progress = createProgress();
        machineExternalSessionOperationStatusSpy
            .mockRejectedValueOnce(new Error('status read failed'))
            .mockRejectedValueOnce(new Error('re-read failed too'));
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });
        expect(hook.getCurrent().status).toBe('unavailable');

        let failedOutcome: boolean | undefined;
        await act(async () => {
            failedOutcome = await hook.getCurrent().checkAgain();
        });
        expect(failedOutcome).toBe(false);
        expect(hook.getCurrent().status).toBe('unavailable');

        machineExternalSessionOperationStatusSpy.mockResolvedValueOnce({ ok: true, progress });
        let succeededOutcome: boolean | undefined;
        await act(async () => {
            succeededOutcome = await hook.getCurrent().checkAgain();
        });
        expect(succeededOutcome).toBe(true);
        expect(hook.getCurrent().status).toBe('ready');
    });

    it('separates not-owner and offline from a failed read', async () => {
        machineExternalSessionOperationStatusSpy.mockResolvedValue({
            ok: true,
            progress: createProgress(),
        });
        const notOwner = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: false,
            machineOnline: true,
        });
        expect(notOwner.getCurrent().status).toBe('not_owner');
        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();
        await act(async () => {
            notOwner.getCurrent().checkAgain();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();

        const offline = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: false,
        });
        expect(offline.getCurrent().status).toBe('offline');
        await act(async () => {
            offline.getCurrent().checkAgain();
            await flushHookEffects({ cycles: 1, turns: 1 });
        });
        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();
    });

    it('clears private progress and point-reads again when the server scope changes', async () => {
        const initialProgress = createProgress();
        const scopedProgress = createProgress({ updatedAtMs: 1_700_000_000_001 });
        const scopedRead = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: initialProgress })
            .mockReturnValueOnce(scopedRead.promise);
        const presentation = createPresentation();
        const hook = await renderOwnerHydration({
            presentation,
            isExactOwner: true,
            machineOnline: true,
            serverId: 'server-1',
        });

        expect(hook.getCurrent().progress).toEqual(initialProgress);

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
            serverId: 'server-2',
        });

        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenLastCalledWith({
            machineId: 'machine-1',
            sessionId: 'session-1',
            operationId: 'operation-1',
            revision: 4,
        }, { serverId: 'server-2' });
        expect(hook.getCurrent().progress).toBeNull();

        scopedRead.resolve({ ok: true, progress: scopedProgress });
        await flushHookEffects();
        expect(hook.getCurrent().progress).toEqual(scopedProgress);
    });

    it.each([
        ['shared reader', false, true, 'server-1:reader-1'],
        ['offline owner', true, false, 'server-1:owner-1'],
        ['owner without an authenticated account scope', true, true, null],
    ] as const)('keeps %s on generic presentation without a status call', async (
        _label,
        isExactOwner,
        machineOnline,
        ownerScopeKey,
    ) => {
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner,
            machineOnline,
            ownerScopeKey,
        });

        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().progress).toBeNull();
    });

    it('retains exact hydrated progress offline and point-reads once on reconnect', async () => {
        const initialProgress = createProgress();
        const refreshedProgress = createProgress({ updatedAtMs: 1_700_000_000_001 });
        const reconnectRead = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: initialProgress })
            .mockReturnValueOnce(reconnectRead.promise);
        const presentation = createPresentation();
        const hook = await renderOwnerHydration({
            presentation,
            isExactOwner: true,
            machineOnline: false,
        });
        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().progress).toEqual(initialProgress);

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: false,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().progress).toEqual(initialProgress);

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(initialProgress);

        await hook.rerender({
            presentation: { ...presentation },
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);

        reconnectRead.resolve({ ok: true, progress: refreshedProgress });
        await flushHookEffects();
        expect(hook.getCurrent().progress).toEqual(refreshedProgress);
    });

    it.each([
        ['a failed request', 'failure'],
        ['a mismatched response', 'mismatch'],
    ] as const)('permits one new point read after reconnect following %s', async (
        _label,
        initialOutcome,
    ) => {
        if (initialOutcome === 'failure') {
            machineExternalSessionOperationStatusSpy.mockRejectedValueOnce(
                new Error('initial status read failed'),
            );
        } else {
            machineExternalSessionOperationStatusSpy.mockResolvedValueOnce({
                ok: true,
                progress: createProgress({ operationId: 'operation-other' }),
            });
        }
        const matchingProgress = createProgress();
        machineExternalSessionOperationStatusSpy.mockResolvedValueOnce({
            ok: true,
            progress: matchingProgress,
        });
        const presentation = createPresentation();
        const hook = await renderOwnerHydration({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });

        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
        expect(hook.getCurrent().progress).toBeNull();

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: false,
        });
        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(matchingProgress);

        await hook.rerender({
            presentation: { ...presentation },
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
    });

    it('does not let an older online episode erase the reconnect result', async () => {
        const initialRead = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        const reconnectProgress = createProgress();
        machineExternalSessionOperationStatusSpy
            .mockReturnValueOnce(initialRead.promise)
            .mockResolvedValueOnce({ ok: true, progress: reconnectProgress });
        const presentation = createPresentation();
        const hook = await renderOwnerHydration({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: false,
        });
        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(hook.getCurrent().progress).toEqual(reconnectProgress);

        initialRead.reject(new Error('superseded online episode failed'));
        await flushHookEffects();
        expect(hook.getCurrent().progress).toEqual(reconnectProgress);
    });

    it.each([
        ['owner role', { isExactOwner: false }, 1],
        ['account scope', { ownerScopeKey: null }, 1],
        ['server identity', { serverId: null }, 1],
        ['machine identity', { machineId: null }, 1],
        ['presentation', { presentation: null }, 1],
        ['operation identity', {
            presentation: createPresentation({ operationId: 'operation-2' }),
        }, 2],
        ['operation revision', {
            presentation: createPresentation({ revision: 5, phase: 'staging' }),
        }, 2],
    ] as const)('clears immediately when %s is lost and rejects stale completion', async (
        _label,
        changedInput,
        expectedReadCount,
    ) => {
        const staleRead = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        const currentRead = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockReturnValueOnce(staleRead.promise)
            .mockReturnValueOnce(currentRead.promise);
        const initialInput: HookInput = {
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        };
        const hook = await renderOwnerHydration(initialInput);

        await hook.rerender({
            ...initialInput,
            ...changedInput,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(
            expectedReadCount,
        );
        expect(hook.getCurrent().progress).toBeNull();

        staleRead.resolve({ ok: true, progress: createProgress() });
        await flushHookEffects();
        expect(hook.getCurrent().progress).toBeNull();
    });

    it('rejects stale and mismatched point responses', async () => {
        const deferred = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockReturnValueOnce(deferred.promise)
            .mockResolvedValueOnce({
                ok: true,
                progress: createProgress({
                    operationId: 'operation-other',
                    revision: 5,
                }),
            });
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });

        await hook.rerender({
            presentation: createPresentation({ revision: 5, phase: 'staging' }),
            isExactOwner: true,
            machineOnline: true,
        });
        deferred.resolve({ ok: true, progress: createProgress() });
        await flushHookEffects();

        expect(hook.getCurrent().progress).toBeNull();
    });

    it('uses a same-key action result only to trigger one authoritative point revalidation', async () => {
        const initialProgress = createProgress();
        const actionProgress = createProgress({ updatedAtMs: 1_700_000_000_001 });
        const refreshedProgress = createProgress({ updatedAtMs: 1_700_000_000_002 });
        const forcedRefresh = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: initialProgress })
            .mockReturnValueOnce(forcedRefresh.promise);
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });

        await act(async () => {
            hook.getCurrent().onActionResult(actionProgress);
        });
        expect(hook.getCurrent().progress).toEqual(initialProgress);
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        forcedRefresh.resolve({ ok: true, progress: refreshedProgress });
        await flushHookEffects();
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(refreshedProgress);
    });

    it('ignores an ahead action result until the shared presentation advances', async () => {
        const initialProgress = createProgress();
        const progress5 = createProgress({ revision: 5, phase: 'staging' });
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: initialProgress })
            .mockResolvedValueOnce({ ok: true, progress: progress5 });
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });

        await act(async () => {
            hook.getCurrent().onActionResult(createProgress({ revision: 5 }));
        });
        expect(hook.getCurrent().progress).toEqual(initialProgress);
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);

        await hook.rerender({
            presentation: createPresentation({ revision: 5, phase: 'staging' }),
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(progress5);
    });

    it('retains matching last-known-good detail when action revalidation fails', async () => {
        const initialProgress = createProgress();
        const forcedRefresh = createDeferred<{
            ok: true;
            progress: ExternalSessionOperationProgressV1;
        }>();
        machineExternalSessionOperationStatusSpy
            .mockResolvedValueOnce({ ok: true, progress: initialProgress })
            .mockReturnValueOnce(forcedRefresh.promise);
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        });

        await act(async () => {
            hook.getCurrent().onActionResult(createProgress({ updatedAtMs: 1_700_000_000_001 }));
        });
        expect(hook.getCurrent().progress).toEqual(initialProgress);

        forcedRefresh.reject(new Error('offline'));
        await flushHookEffects();
        expect(hook.getCurrent().progress).toEqual(initialProgress);
        expect(hook.getCurrent().status).toBe('ready');
    });

    it('keeps complete progress component-local across unmounts', async () => {
        machineExternalSessionOperationStatusSpy.mockResolvedValue({
            ok: true,
            progress: createProgress(),
        });
        const input = {
            presentation: createPresentation(),
            isExactOwner: true,
            machineOnline: true,
        };
        const first = await renderOwnerHydration(input);
        expect(first.getCurrent().progress).not.toBeNull();
        await first.unmount();

        const second = await renderOwnerHydration(input);
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(second.getCurrent().progress).not.toBeNull();
    });
});
