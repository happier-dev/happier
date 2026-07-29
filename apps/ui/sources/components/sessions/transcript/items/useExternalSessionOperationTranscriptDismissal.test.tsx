import { act } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import {
    ExternalSessionOperationProgressV1Schema,
    type ExternalSessionOperationProgressV1,
} from '@happier-dev/protocol';

import { renderHook } from '@/dev/testkit';

import { useExternalSessionOperationTranscriptDismissal } from './useExternalSessionOperationTranscriptDismissal';

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
        status: 'completed',
        phase: 'publishing',
        timeline: ['validating', 'staging', 'importing', 'publishing'],
        updatedAtMs: 1,
        priorStableStorage: { state: 'machine_only' },
        currentStorageState: 'snapshot_complete',
        checkpoint: {
            sourcePagesRead: 1,
            stagedItemCount: 1,
            importedItemCount: 1,
            totalItemEstimate: 1,
            acceptedThroughServerSeq: 1,
            requiredItemFailures: {
                total: 0,
                record: 0,
                media: 0,
                conversion: 0,
                diagnosticsTruncated: false,
            },
        },
        fence: { kind: 'none' },
        publication: {
            materializationPublicationId: 'publication-1',
            materializedThroughSourceAt: 1,
            publishedThroughServerSeq: 1,
        },
        ...overrides,
    });
}

describe('useExternalSessionOperationTranscriptDismissal', () => {
    it('retains one exact terminal dismissal for the mounted session and resets it for another session', async () => {
        const progress = createProgress();
        const hook = await renderHook(
            (props: Readonly<{
                sessionId: string;
                progress: ExternalSessionOperationProgressV1 | null;
            }>) => useExternalSessionOperationTranscriptDismissal(props),
            {
                initialProps: {
                    sessionId: 'session-1',
                    progress,
                },
            },
        );

        act(() => {
            hook.getCurrent().onDismiss({
                operationId: progress.operationId,
                revision: progress.revision,
            });
        });
        expect(hook.getCurrent().dismissal).toEqual({
            sessionId: 'session-1',
            operationId: 'operation-1',
            revision: 4,
        });

        await hook.rerender({
            sessionId: 'session-1',
            progress: { ...progress, revision: 5, updatedAtMs: 2 },
        });
        expect(hook.getCurrent().dismissal).toEqual(expect.objectContaining({
            revision: 4,
        }));

        await hook.rerender({
            sessionId: 'session-2',
            progress,
        });
        expect(hook.getCurrent().dismissal).toBeNull();
        await hook.unmount();
    });

    it('rejects stale and nonterminal dismissal attempts and resets on remount', async () => {
        const running = createProgress({
            status: 'running',
            phase: 'importing',
            currentStorageState: 'machine_only',
            publication: undefined,
        });
        const hook = await renderHook(
            () => useExternalSessionOperationTranscriptDismissal({
                sessionId: 'session-1',
                progress: running,
            }),
        );

        act(() => {
            hook.getCurrent().onDismiss({
                operationId: running.operationId,
                revision: running.revision,
            });
            hook.getCurrent().onDismiss({
                operationId: running.operationId,
                revision: running.revision - 1,
            });
        });
        expect(hook.getCurrent().dismissal).toBeNull();
        await hook.unmount();

        const remounted = await renderHook(
            () => useExternalSessionOperationTranscriptDismissal({
                sessionId: 'session-1',
                progress: createProgress(),
            }),
        );
        expect(remounted.getCurrent().dismissal).toBeNull();
        await remounted.unmount();
    });
});
