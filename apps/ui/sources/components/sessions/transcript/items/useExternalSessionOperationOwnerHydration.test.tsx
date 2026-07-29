import {
    ExternalSessionOperationProgressV1Schema,
    ExternalSessionOperationSharedPresentationV1Schema,
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
    return ExternalSessionOperationProgressV1Schema.parse({
        v: 1,
        operationId: 'operation-1',
        revision: 4,
        request: {
            plan: 'materialize',
            targetStorageMode: 'external-linked',
            targetRuntimeMode: null,
        },
        status: 'running',
        phase: 'validating',
        timeline: ['validating', 'staging', 'importing', 'publishing'],
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

async function renderOwnerHydration(input: HookInput) {
    const { useExternalSessionOperationOwnerHydration } = await import(
        './useExternalSessionOperationOwnerHydration'
    );
    return await renderHook((props: HookInput) => (
        useExternalSessionOperationOwnerHydration({
            ...props,
            machineId: 'machine-1',
            serverId: 'server-1',
            sessionId: 'session-1',
        })
    ), {
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
        ['shared reader', false, true],
        ['offline owner', true, false],
    ] as const)('keeps %s on generic presentation without a status call', async (
        _label,
        isExactOwner,
        machineOnline,
    ) => {
        const hook = await renderOwnerHydration({
            presentation: createPresentation(),
            isExactOwner,
            machineOnline,
        });

        expect(machineExternalSessionOperationStatusSpy).not.toHaveBeenCalled();
        expect(hook.getCurrent().progress).toBeNull();
    });

    it('waits for first online eligibility and never re-polls the same mounted key', async () => {
        machineExternalSessionOperationStatusSpy.mockResolvedValue({
            ok: true,
            progress: createProgress(),
        });
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
        expect(hook.getCurrent().progress).not.toBeNull();

        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: false,
        });
        expect(hook.getCurrent().progress).toBeNull();
        await hook.rerender({
            presentation,
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);
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
        const actionProgress = createProgress({ phase: 'staging' });
        const refreshedProgress = createProgress({ phase: 'importing' });
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
        expect(hook.getCurrent().progress).toBeNull();
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
        expect(hook.getCurrent().progress).toBeNull();
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(1);

        await hook.rerender({
            presentation: createPresentation({ revision: 5, phase: 'staging' }),
            isExactOwner: true,
            machineOnline: true,
        });
        expect(machineExternalSessionOperationStatusSpy).toHaveBeenCalledTimes(2);
        expect(hook.getCurrent().progress).toEqual(progress5);
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
